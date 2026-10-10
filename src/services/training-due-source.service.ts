import {transaction,TransactionClient} from '../config/database';
import {inspectImpactSource,resolveImpactSource,resolveObligationScope,TrainingAuthorityContext,ObligationScopeObservation,ImpactSourceObservation} from './training-authority.service';
import {obligationReadiness,trainingDutyHash} from './training-obligations.service';
import {TrainingCourse,TrainingObligation,TrainingRecord,TrainingImpactSource} from '../types/training.types';
import {assertMaterialUse} from './training-materials.service';

/** Exact native training obligations for a future authenticated CC task adapter.
 * No worker token, external delivery, or completed clinical action is inferred. */
export async function getObligationDueSource(authority:TrainingAuthorityContext,scope:{studyId:number;siteId?:number},originals:TrainingImpactSource['originals']){
  return observeObligationDueSource(scope,originals,{
    inspect:()=>inspectImpactSource(authority,scope,originals),
    obligation:(userId,selected,retained,expected)=>resolveObligationScope(authority,retained?'obligations:withdraw':'obligations:read',userId,selected,expected),
    material:(client,course,row)=>assertMaterialUse(authority,client,course,{userId:row.userId,scope:row.scope}),
    finish:source=>resolveImpactSource(authority,scope,source.source,source),
  });
}

/** Read-only callbacks make the machine reader use its own restricted authority
 * transport. It never manufactures a human principal or receives write methods. */
export interface DueSourceAuthority {
  inspect():Promise<ImpactSourceObservation>;
  obligation(userId:number,scope:TrainingObligation['scope'],retained:boolean,expected?:ObligationScopeObservation):Promise<ObligationScopeObservation>;
  material(client:TransactionClient,course:TrainingCourse,row:TrainingObligation):Promise<unknown>;
  finish(source:ImpactSourceObservation):Promise<unknown>;
}
export async function observeObligationDueSource(scope:{studyId:number;siteId?:number},originals:TrainingImpactSource['originals'],authority:DueSourceAuthority){
  const source=await authority.inspect();
  if(trainingDutyHash(source.scope)!==trainingDutyHash(scope)||trainingDutyHash(source.source.originals)!==trainingDutyHash(originals))
    throw Object.assign(new Error('The due-source authority differs from the selected scope/originals'),{statusCode:409});
  const snapshot=await transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const obligations=(await client.query<TrainingObligation>(`SELECT * FROM acc_training_obligations
      WHERE (scope->>'studyId')::integer=$1 AND (scope->>'siteId')::integer IS NOT DISTINCT FROM $2::integer ORDER BY id LIMIT 1001`,[scope.studyId,scope.siteId??null])).rows;
    if(obligations.length>1000)throw Object.assign(new Error('The exact scope exceeds 1000 obligations; no partial due census was returned'),{statusCode:413});
    const courseIds=[...new Set(obligations.map(row=>row.courseId))];
    const courses=(await client.query<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=ANY($1::integer[])',[courseIds])).rows;
    // Select only the exact obligation pairs, not the potentially million-row
    // Cartesian product of 1,000 learners and 1,000 unrelated courses.
    const pairs=[...new Map(obligations.map(row=>[`${row.userId}:${row.courseId}`,{user_id:row.userId,course_id:row.courseId}])).values()];
    const records=(await client.query<TrainingRecord>(`SELECT r.* FROM acc_training_records r JOIN
      jsonb_to_recordset($1::jsonb) AS selected(user_id integer,course_id integer)
      ON r.user_id=selected.user_id AND r.course_id=selected.course_id`,[JSON.stringify(pairs)])).rows;
    return {obligations,courses:new Map(courses.map(row=>[row.id,row])),records:new Map(records.map(row=>[`${row.userId}:${row.courseId}`,row]))};
  });
  const observations=new Map<string,{userId:number;scope:TrainingObligation['scope'];observation:ObligationScopeObservation;state:'current'|'changed'}>();
  for(const row of snapshot.obligations){const key=trainingDutyHash({userId:row.userId,scope:row.scope});if(observations.has(key))continue;
    // Retained revoked scopes are still visible to their current managers and
    // remain explicit blocked occurrences; no former learner is silently omitted.
    let state:'current'|'changed'='current';
    let observation:ObligationScopeObservation;
    try{observation=await authority.obligation(row.userId,row.scope,false);}
    catch(error){if((error as {statusCode?:number}).statusCode!==409)throw error;state='changed';observation=await authority.obligation(row.userId,row.scope,true);}
    observations.set(key,{userId:row.userId,scope:row.scope,observation,state:observation.eligible?state:'changed'});
  }
  for(const observed of observations.values())await authority.obligation(observed.userId,observed.scope,true,observed.observation);
  const materialReadiness=new Map<number,boolean>();
  for(const row of snapshot.obligations){const course=snapshot.courses.get(row.courseId);if(course?.materialScope&&row.status!=='withdrawn'){
    try{await transaction(client=>authority.material(client,{...course},row));materialReadiness.set(row.id,true);}
    catch(error){if(![403,404,409].includes((error as {statusCode?:number}).statusCode??0))throw error;materialReadiness.set(row.id,false);}
  }}
  await authority.finish(source);
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
