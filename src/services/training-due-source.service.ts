import {transaction} from '../config/database';
import {inspectImpactSource,resolveImpactSource,resolveObligationScope,TrainingAuthorityContext,ObligationScopeObservation} from './training-authority.service';
import {obligationReadiness,trainingDutyHash} from './training-obligations.service';
import {TrainingCourse,TrainingObligation,TrainingRecord,TrainingImpactSource} from '../types/training.types';
import {assertMaterialUse} from './training-materials.service';

/** Exact native training obligations for a future authenticated CC task adapter.
 * No worker token, external delivery, or completed clinical action is inferred. */
export async function getObligationDueSource(authority:TrainingAuthorityContext,scope:{studyId:number;siteId?:number},originals:TrainingImpactSource['originals']){
  const source=await inspectImpactSource(authority,scope,originals);
  const snapshot=await transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const obligations=(await client.query<TrainingObligation>(`SELECT * FROM acc_training_obligations
      WHERE (scope->>'studyId')::integer=$1 AND (scope->>'siteId')::integer IS NOT DISTINCT FROM $2::integer ORDER BY id LIMIT 1001`,[scope.studyId,scope.siteId??null])).rows;
    if(obligations.length>1000)throw Object.assign(new Error('The exact scope exceeds 1000 obligations; no partial due census was returned'),{statusCode:413});
    const courseIds=[...new Set(obligations.map(row=>row.courseId))],userIds=[...new Set(obligations.map(row=>row.userId))];
    const courses=(await client.query<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=ANY($1::integer[])',[courseIds])).rows;
    const records=(await client.query<TrainingRecord>('SELECT * FROM acc_training_records WHERE user_id=ANY($1::integer[]) AND course_id=ANY($2::integer[])',[userIds,courseIds])).rows;
    return {obligations,courses:new Map(courses.map(row=>[row.id,row])),records:new Map(records.map(row=>[`${row.userId}:${row.courseId}`,row]))};
  });
  const observations=new Map<string,{userId:number;scope:TrainingObligation['scope'];observation:ObligationScopeObservation;state:'current'|'changed'}>();
  for(const row of snapshot.obligations){const key=trainingDutyHash({userId:row.userId,scope:row.scope});if(observations.has(key))continue;
    // Retained revoked scopes are still visible to their current managers and
    // remain explicit blocked occurrences; no former learner is silently omitted.
    let state:'current'|'changed'='current';
    let observation:ObligationScopeObservation;
    try{observation=await resolveObligationScope(authority,'obligations:read',row.userId,row.scope);}
    catch(error){if((error as {statusCode?:number}).statusCode!==409)throw error;state='changed';observation=await resolveObligationScope(authority,'obligations:withdraw',row.userId,row.scope);}
    observations.set(key,{userId:row.userId,scope:row.scope,observation,state:observation.eligible?state:'changed'});
  }
  for(const observed of observations.values())await resolveObligationScope(authority,'obligations:withdraw',observed.userId,observed.scope,observed.observation);
  const materialReadiness=new Map<number,boolean>();
  for(const row of snapshot.obligations){const course=snapshot.courses.get(row.courseId);if(course?.materialScope&&row.status!=='withdrawn'){
    try{await transaction(client=>assertMaterialUse(authority,client,{...course},{userId:row.userId,scope:row.scope}));materialReadiness.set(row.id,true);}
    catch(error){if(![403,404,409].includes((error as {statusCode?:number}).statusCode??0))throw error;materialReadiness.set(row.id,false);}
  }}
  await resolveImpactSource(authority,scope,source.source,source);
  const cutoff=Date.now();
  const obligations=snapshot.obligations.map(row=>{
    const course=snapshot.courses.get(row.courseId);if(!course)throw Object.assign(new Error('Required course custody is missing'),{statusCode:409});
    const record=snapshot.records.get(`${row.userId}:${row.courseId}`)??null;
    const observation=observations.get(trainingDutyHash({userId:row.userId,scope:row.scope}))!;
    const readiness=obligationReadiness(row,{...course,materialReady:materialReadiness.get(row.id)},record,observation.state==='current'&&observation.observation.roles.includes(row.role)?'current':'changed',cutoff);
    const effectiveStatus=readiness==='withdrawn'?'inactive':readiness==='complete'?'satisfied':readiness==='scope_changed'||readiness==='course_inactive'?'blocked':'open';
    const body={occurrenceId:`training-obligation:${row.id}:${row.revision}`,obligationId:row.id,revision:row.revision,userId:row.userId,role:row.role,
      scope:row.scope,courseId:row.courseId,courseVersion:row.courseVersion,contentRevision:row.contentRevision,currentCourseVersion:course.version,currentContentRevision:course.contentRevision,
      dueAt:new Date(row.dueAt).toISOString(),reason:row.reason,status:row.status,readiness,effectiveStatus,
      overdue:effectiveStatus==='open'&&new Date(row.dueAt).getTime()<=cutoff,
      scopeObservationHash:observation.observation.observationHash,recordId:record?.id??null,certificateNumber:record?.certificateNumber??null,
      completedAt:record?.completedAt?new Date(record.completedAt).toISOString():null,verifiedAt:record?.verifiedAt?new Date(record.verifiedAt).toISOString():null,
      verifiedBy:record?.verifiedBy??null,expirationDate:record?.expirationDate?new Date(record.expirationDate).toISOString():null};
    return {...body,observationHash:trainingDutyHash(body)};
  });
  const body={schemaVersion:'TrainingObligationDueSourceV1@1.0.0',scope,source:source.source,sourceObservationHash:source.sourceObservationHash,
    complete:true,count:obligations.length,obligations,sourceMeaning:'exact retained training obligations; not a complete staff curriculum census',externalDeliveryConfirmed:false};
  return {...body,observedAt:new Date(cutoff).toISOString(),consistency:'current-observations-not-atomic',sourceHash:trainingDutyHash(body)};
}
