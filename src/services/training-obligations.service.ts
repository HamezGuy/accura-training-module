import { getRoleByName, ROLES } from '@accura-trial/auth-core';
import { query, queryOne, transaction, TransactionClient } from '../config/database';
import { logAudit,canonicalTrainingEvidence as canonical,trainingEvidenceHash } from './audit.service';
import { authorizeTrainingTargets, resolveObligationScope, observeTrainingInspection, TrainingAuthorityContext, ObligationScopeObservation } from './training-authority.service';
import { TrainingCourse, TrainingDutyPolicy, TrainingDutyReadinessRequest, TrainingObligation, TrainingObligationRequest, TrainingObligationScope, TrainingObligationView, TrainingRecord } from '../types/training.types';
import {assertMaterialUse,publishedMaterial,observePublication,validateInspectionMaterial} from './training-materials.service';
import {mapRecordToDto} from './training-record-dto';
import {verifyRecordAssessment,verifyAssessmentRows,AssessmentHistoryRow} from './training-assessment-evidence';
import {createHash} from 'node:crypto';
import type {TrainingInspectionEvidence,TrainingMaterialSource} from '../types/training.types';

function fail(message: string, statusCode = 409): never { throw Object.assign(new Error(message), { statusCode }); }
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
function reason(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail('A reason of 1 to 2000 characters is required', 400);
}
export function validateObligationRequest(value: TrainingObligationRequest): void {
  if (!value || !id(value.userId) || !id(value.courseId) || !id(value.contentRevision)) fail('Exact learner, course and content revision IDs are required', 400);
  const scope = value.scope;
  if (!scope || Object.keys(scope).some(key => !['studyId','siteId','armId'].includes(key)) || !id(scope.studyId)
    || scope.siteId !== undefined && !id(scope.siteId) || scope.armId !== undefined && !id(scope.armId)) fail('An exact native study, site and arm scope is required', 400);
  if (getRoleByName(value.role).name !== value.role || value.role === ROLES.INVALID.name) fail('A canonical native role is required', 400);
  if (typeof value.dueAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value.dueAt)
    || !Number.isFinite(Date.parse(value.dueAt))) fail('An exact due date and time with time zone is required', 400);
  const day = value.dueAt.slice(0,10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0,10) !== day) fail('The due date must be a valid calendar date', 400);
  reason(value.reason);
}
function canonicalScope(scope: TrainingObligationScope): TrainingObligationScope {
  return { studyId: scope.studyId, ...(scope.siteId === undefined ? {} : { siteId: scope.siteId }), ...(scope.armId === undefined ? {} : { armId: scope.armId }) };
}
async function recordEvent(client: TransactionClient, obligation: TrainingObligation, actor: number, action: 'obligation_assigned' | 'obligation_revised' | 'obligation_withdrawn') {
  await client.query(`INSERT INTO acc_training_obligation_events(obligation_id,revision,actor_user_id,action,snapshot)
    VALUES($1,$2,$3,$4,$5::jsonb)`, [obligation.id, obligation.revision, actor, action, JSON.stringify(obligation)]);
  await logAudit({ userId: actor, courseId: obligation.courseId, action, details: { obligationId: obligation.id, revision: obligation.revision, learnerId: obligation.userId, scope: obligation.scope, reason: obligation.reason } }, client);
}

export async function assignObligation(authority: TrainingAuthorityContext, request: TrainingObligationRequest,
  revise?: { id: number; expectedRevision: number }): Promise<TrainingObligation> {
  validateObligationRequest(request);
  if (revise && (!id(revise.id) || !id(revise.expectedRevision))) fail('An exact obligation and expected revision are required', 400);
  const scope = canonicalScope(request.scope);
  const observed = await resolveObligationScope(authority, 'obligations:manage', request.userId, scope);
  if (!observed.eligible || !observed.roles.includes(request.role)) fail('The learner does not hold this role in the exact active study or site');
  try {
    return await transaction(client => assignObligationInTransaction(client, authority, request, revise, observed));
  } catch (error) {
    if ((error as {code?: string}).code === '23505') fail('An active obligation already exists for this learner, course, role and scope; refresh and revise it');
    throw error;
  }
}

/** Shared writer for one assignment and atomic reviewed impact plans. */
export async function assignObligationInTransaction(client: TransactionClient, authority: TrainingAuthorityContext,
  request: TrainingObligationRequest, revise: {id:number;expectedRevision:number}|undefined, observed: ObligationScopeObservation): Promise<TrainingObligation> {
      validateObligationRequest(request);
      const scope=canonicalScope(request.scope);
      if(!observed.eligible||!observed.roles.includes(request.role))fail('The learner no longer holds the declared role');
      const course = await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 AND active=true FOR SHARE', [request.courseId]);
      if (!course || course.contentRevision !== request.contentRevision) fail('Select the current active course revision before assigning training');
      await assertMaterialUse(authority,client,course,{userId:request.userId,scope});
      let previous: TrainingObligation | null = null;
      if (revise) {
        previous = await client.queryOne<TrainingObligation>('SELECT * FROM acc_training_obligations WHERE id=$1 FOR UPDATE', [revise.id]);
        if (!previous || previous.revision !== revise.expectedRevision || previous.status !== 'assigned') fail('The obligation changed; refresh before revising');
        if (previous.userId !== request.userId || previous.courseId !== request.courseId || previous.role !== request.role
          || JSON.stringify(canonicalScope(previous.scope)) !== JSON.stringify(scope)) fail('Learner, course and native scope are immutable; withdraw and assign a new obligation');
      }
      const current = await resolveObligationScope(authority, 'obligations:manage', request.userId, scope, observed);
      const values = [request.userId, request.courseId, course.version, request.contentRevision, request.role, JSON.stringify(scope),
        JSON.stringify(current), new Date(request.dueAt), request.reason.trim(), authority.actorUserId];
      const obligation = previous ? await client.queryOne<TrainingObligation>(`UPDATE acc_training_obligations SET
        course_version=$3,content_revision=$4,scope_observation=$7::jsonb,due_at=$8,reason=$9,assigned_by=$10,revision=revision+1,updated_at=NOW()
        WHERE id=$11 AND user_id=$1 AND course_id=$2 AND role=$5 AND scope=$6::jsonb RETURNING *`, [...values, previous.id])
        : await client.queryOne<TrainingObligation>(`INSERT INTO acc_training_obligations
          (user_id,course_id,course_version,content_revision,role,scope,scope_observation,due_at,reason,assigned_by)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10) RETURNING *`, values);
      if (!obligation) fail('The obligation could not be saved');
      await recordEvent(client, obligation, authority.actorUserId, previous ? 'obligation_revised' : 'obligation_assigned');
      return obligation;
}

export async function withdrawObligation(authority: TrainingAuthorityContext, obligationId: number, expectedRevision: number, explanation: string) {
  if (!id(obligationId) || !id(expectedRevision)) fail('An exact obligation and expected revision are required', 400);
  reason(explanation);
  return transaction(client => withdrawObligationInTransaction(client,authority,obligationId,expectedRevision,explanation));
}

export async function withdrawObligationInTransaction(client: TransactionClient, authority: TrainingAuthorityContext,
  obligationId: number, expectedRevision: number, explanation: string): Promise<TrainingObligation> {
    if (!id(obligationId) || !id(expectedRevision)) fail('An exact obligation and expected revision are required', 400);
    reason(explanation);
    const previous = await client.queryOne<TrainingObligation>('SELECT * FROM acc_training_obligations WHERE id=$1 FOR UPDATE', [obligationId]);
    if (!previous) fail('Obligation not found', 404);
    // Closed scope may be withdrawn, but organization membership alone never
    // authorizes management of another site's training requirements.
    const admission = await resolveObligationScope(authority, 'obligations:withdraw', previous.userId, canonicalScope(previous.scope));
    if (previous.revision !== expectedRevision || previous.status !== 'assigned') fail('The obligation changed; refresh before withdrawing');
    const updated = await client.queryOne<TrainingObligation>(`UPDATE acc_training_obligations SET status='withdrawn',
      reason=$2,scope_observation=$3::jsonb,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *`, [obligationId, explanation.trim(), JSON.stringify(admission)]);
    if (!updated) fail('The obligation could not be withdrawn');
    await recordEvent(client, updated, authority.actorUserId, 'obligation_withdrawn');
    return updated;
}

export function obligationReadiness(obligation: TrainingObligation, course: TrainingCourse, record: TrainingRecord | null,
  scope: 'current' | 'changed' | 'unavailable', now = Date.now()): TrainingObligationView['readiness'] {
  if (obligation.status === 'withdrawn') return 'withdrawn';
  if (scope !== 'current') return scope === 'changed' ? 'scope_changed' : 'scope_unavailable';
  if (!course.active) return 'course_inactive';
  if(course.materialScope&&course.materialReady!==true)return 'retraining_required';
  if (course.version !== obligation.courseVersion || course.contentRevision !== obligation.contentRevision) return 'retraining_required';
  if (!record) return 'pending';
  if (record.courseVersion !== obligation.courseVersion || record.contentRevision !== obligation.contentRevision || record.status === 'expired'
    || record.expirationDate !== null && (!Number.isFinite(new Date(record.expirationDate).getTime()) || new Date(record.expirationDate).getTime() <= now)) return 'retraining_required';
  if (record.status !== 'completed') return record.status === 'in_progress' ? 'in_progress' : 'pending';
  if ((record.assessmentCycleId||record.assessmentReceipt)&&record.assessmentEvidenceVerified!==true) return 'pending';
  if (!record.completedAt || !Number.isFinite(new Date(record.completedAt).getTime()) || !record.certificateNumber) return 'pending';
  if (!record.verifiedAt || !record.verifiedBy || record.verifiedBy === obligation.userId || !Number.isFinite(new Date(record.verifiedAt).getTime())
    || new Date(record.verifiedAt).getTime() < new Date(record.completedAt).getTime() || new Date(record.verifiedAt).getTime() > now) return 'awaiting_verification';
  return 'complete';
}

async function admitRead(authority: TrainingAuthorityContext, userId: number) {
  if (!id(userId)) fail('An exact learner ID is required', 400);
  const admitted = await authorizeTrainingTargets(authority, 'records:read', [userId]);
  if (!admitted.decisions[0]?.allowed) fail('The learner is outside your current scope', 403);
  return admitted;
}
export async function getObligations(authority: TrainingAuthorityContext, userId: number): Promise<TrainingObligationView[]> {
  const admitted = await admitRead(authority, userId);
  const { rows } = await query<TrainingObligation>('SELECT * FROM acc_training_obligations WHERE user_id=$1 ORDER BY id', [userId]);
  const results: TrainingObligationView[] = [];
  for (const row of rows) {
    const course = await queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1', [row.courseId]);
    if (!course) fail('Training course evidence is missing');
    const record = await transaction(async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const retained=await client.queryOne<TrainingRecord>('SELECT * FROM acc_training_records WHERE user_id=$1 AND course_id=$2', [userId, row.courseId]);
      if(retained)await verifyRecordAssessment(client,retained);return retained;
    });
    let scope: 'current' | 'changed' | 'unavailable' = 'current';
    if (row.status !== 'withdrawn') {
      try {
        const observed = await resolveObligationScope(authority, 'obligations:read', userId, canonicalScope(row.scope));
        if (!observed.eligible || !observed.roles.includes(row.role)) scope = 'changed';
        if(scope==='current')await assertMaterialUse(authority,{query,queryOne},course,{userId,scope:row.scope});
      } catch (error) {
        const code = (error as {statusCode?: number}).statusCode;
        if (code === 401 || code === 403) throw error;
        scope = code === 409 || code === 404 ? 'changed' : 'unavailable';
      }
    }
    const readiness = obligationReadiness(row, course, record, scope);
    results.push({ ...row, courseName: course.courseName, currentContentRevision: course.contentRevision!, readiness,
      overdue: row.status === 'assigned' && readiness !== 'complete' && new Date(row.dueAt).getTime() < Date.now(),
      completedLate: record?.completedAt != null && new Date(record.completedAt).getTime() > new Date(row.dueAt).getTime(),
      verifiedLate: record?.verifiedAt != null && new Date(record.verifiedAt).getTime() > new Date(row.dueAt).getTime(),
      recordId: record?.id ?? null, certificateNumber: record?.certificateNumber ?? null, completedAt: record?.completedAt ?? null,
      verifiedAt: record?.verifiedAt ?? null, verifiedBy: record?.verifiedBy ?? null });
  }
  const checked = await authorizeTrainingTargets(authority, 'records:read', [userId], {scopeFingerprint: admitted.scopeFingerprint});
  if (!checked.decisions[0]?.allowed) fail('The learner is outside your current scope', 403);
  return results;
}

/** The export preserves the original obligations and attempt history without exposing quiz answers. */
export async function getObligationHistory(authority: TrainingAuthorityContext, userId: number) {
  const admitted = await admitRead(authority, userId);
  const {rows} = await query(`SELECT e.id,e.obligation_id,e.revision,e.actor_user_id,e.action,e.snapshot,e.created_at
    FROM acc_training_obligation_events e JOIN acc_training_obligations o ON o.id=e.obligation_id WHERE o.user_id=$1 ORDER BY e.id`, [userId]);
  const records = await query<TrainingRecord>(`SELECT id,user_id,course_id,course_version,content_revision,status,started_at,completed_at,
    score,attempts,certificate_number,expiration_date,verified_by,verified_at,notes,assessment_cycle_id,assessment_receipt FROM acc_training_records WHERE user_id=$1 ORDER BY id`, [userId]);
  const history = await query<{historyId:number;archivedAt:string;eventKind:string;record:TrainingRecord}>(`SELECT history_id,archived_at,event_kind,record_snapshot AS record
    FROM acc_training_record_history WHERE user_id=$1 ORDER BY history_id`, [userId]);
  const audit = await query(`SELECT id,user_id,action,record_id,course_id,details,created_at FROM acc_training_audit_log
    WHERE (user_id=$1 AND action IN('training_started','quiz_submitted','quiz_passed','quiz_failed'))
      OR record_id IN(SELECT id FROM acc_training_records WHERE user_id=$1)
      OR (action IN('obligation_assigned','obligation_revised','obligation_withdrawn') AND details->>'learnerId'=$1::text)
      OR (action='training_expired' AND details->>'affectedUserId'=$1::text) ORDER BY id`, [userId]);
  const checked = await authorizeTrainingTargets(authority, 'records:read', [userId], {scopeFingerprint: admitted.scopeFingerprint});
  if (!checked.decisions[0]?.allowed) fail('The learner is outside your current scope', 403);
  return {schemaVersion: 'training-obligation-history/1', learnerId: userId, exportedAt: new Date().toISOString(), events: rows,
    records: records.rows.map(mapRecordToDto), history: history.rows.map(row=>({...row,record:mapRecordToDto(row.record)})), audit: audit.rows};
}

/** Privileged constituent of the existing EDC inspection copy. This endpoint
 * never persists a second package and never widens ordinary learner history. */
let activeInspectionReads=0;
export async function getTrainingInspectionEvidence(authority:TrainingAuthorityContext,value:unknown):Promise<TrainingInspectionEvidence>{
 if(activeInspectionReads>=4)fail('Training inspection capacity is unavailable; retry without requesting a partial copy',503);
 activeInspectionReads++;
 try{return await collectTrainingInspectionEvidence(authority,value);}finally{activeInspectionReads--;}
}
async function collectTrainingInspectionEvidence(authority:TrainingAuthorityContext,value:unknown):Promise<TrainingInspectionEvidence>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['nativeStudyId','nonce'].includes(k)))fail('Exact inspection scope and nonce required',400);
 const input=value as {nativeStudyId:number;nonce:string};if(!id(input.nativeStudyId)||typeof input.nonce!=='string'||! /^[a-f0-9]{32}$/.test(input.nonce))fail('Exact inspection scope and nonce required',400);
 const admitted=await observeTrainingInspection(authority,input.nativeStudyId);
 const captured=await transaction(async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL TIME ZONE 'UTC'");
  let bytes=0,count=0;const tables:TrainingInspectionEvidence['tables']=[];
  const read=async(table:string,sql:string,values:unknown[])=>{const rows=(await client.query<{nativeJson:string}>(`SELECT row_to_json(t)::text AS native_json FROM (${sql}) t LIMIT 10001`,values)).rows;
   if(rows.length>10000)fail('Training inspection exceeds a complete table budget; no partial evidence returned',413);
   count+=rows.length;const copies=rows.map(row=>{bytes+=Buffer.byteLength(row.nativeJson);return {...row,sha256:createHash('sha256').update(row.nativeJson).digest('hex')};});
   if(count>100000||bytes>16*1024*1024)fail('Training inspection exceeds the complete evidence budget; no partial evidence returned',413);
   tables.push({table,count:copies.length,contentHash:trainingEvidenceHash(copies),rows:copies});return rows.map(row=>JSON.parse(row.nativeJson));};
  const nativeScopes=JSON.stringify(admitted.scopes);
  const scopeWhere=`EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) s WHERE t.scope->>'studyId'=s->>'studyId' AND t.scope->>'siteId' IS NOT DISTINCT FROM s->>'siteId')`;
  const obligations=await read('acc_training_obligations',`SELECT t.* FROM acc_training_obligations t WHERE ${scopeWhere} ORDER BY id`,[nativeScopes]);
  const obligationIds=obligations.map(r=>r.id);
  const obligationEvents=await read('acc_training_obligation_events','SELECT * FROM acc_training_obligation_events WHERE obligation_id=ANY($1::int[]) ORDER BY obligation_id,revision',[obligationIds]);
  for(const obligation of obligations){const history=obligationEvents.filter(e=>e.obligation_id===obligation.id);
   if(history.length!==obligation.revision||history.some((e,i)=>e.revision!==i+1||e.snapshot.id!==obligation.id||e.snapshot.userId!==obligation.user_id||e.snapshot.courseId!==obligation.course_id||canonical(e.snapshot.scope)!==canonical(obligation.scope)))fail('Retained obligation history is incomplete or inconsistent');
   const last=history.at(-1)?.snapshot;if(!last||last.revision!==obligation.revision||last.status!==obligation.status||last.courseVersion!==obligation.course_version||last.contentRevision!==obligation.content_revision)fail('Retained obligation head differs from its history');}
  const plans=await read('acc_training_impact_plans',`SELECT t.* FROM acc_training_impact_plans t WHERE EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) s WHERE t.plan->'scope'=s) ORDER BY id`,[nativeScopes]);
  const impactEvents=await read('acc_training_impact_events','SELECT * FROM acc_training_impact_events WHERE plan_id=ANY($1::uuid[]) ORDER BY plan_id,revision',[plans.map(r=>r.id)]);
  for(const plan of plans){if(trainingEvidenceHash(plan.plan)!==plan.plan_hash)fail('Retained training impact integrity failed');
   const history=impactEvents.filter(e=>e.plan_id===plan.id);if(history.length!==plan.revision||history.some((e,i)=>e.revision!==i+1||e.snapshot.id!==plan.id||trainingEvidenceHash(e.snapshot.plan)!==plan.plan_hash||e.snapshot.planHash!==plan.plan_hash)||history.at(-1)?.snapshot.status!==plan.status)fail('Retained training impact history is incomplete or inconsistent');}
  const selectedCourseIds=[...new Set([...obligations.map(r=>r.course_id),...plans.flatMap(p=>p.plan.actions.filter((a:any)=>a.kind!=='withdraw').map((a:any)=>a.request.courseId))])];
  const courses=await read('acc_training_courses',`SELECT t.* FROM acc_training_courses t WHERE id=ANY($2::int[]) OR EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) s WHERE material_scope=s) ORDER BY id`,[nativeScopes,selectedCourseIds]);
  if(selectedCourseIds.some(id=>!courses.some(c=>c.id===id)))fail('A referenced training course is missing from retained custody');
  for(const course of courses)if(course.material_scope&&!admitted.scopes.some(s=>canonical(s)===canonical(course.material_scope)))fail('Training material closure requires an authorized parent-family copy');
  const courseIds=courses.map(r=>r.id);
  await read('acc_training_slides','SELECT * FROM acc_training_slides WHERE course_id=ANY($1::int[]) ORDER BY course_id,order_index,id',[courseIds]);
  await read('acc_training_questions','SELECT * FROM acc_training_questions WHERE course_id=ANY($1::int[]) ORDER BY course_id,order_index,id',[courseIds]);
  const pairs=JSON.stringify(obligations.map(r=>({userId:r.user_id,courseId:r.course_id})));
  const pairsWhere=`EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) p WHERE t.user_id=(p->>'userId')::int AND t.course_id=(p->>'courseId')::int)`;
  const records=await read('acc_training_records',`SELECT t.* FROM acc_training_records t WHERE ${pairsWhere} ORDER BY id`,[pairs]);
  const recordHistory=await read('acc_training_record_history',`SELECT t.* FROM acc_training_record_history t WHERE ${pairsWhere} ORDER BY history_id`,[pairs]);
  const drafts=await read('acc_training_material_drafts','SELECT * FROM acc_training_material_drafts WHERE course_id=ANY($1::int[]) ORDER BY id',[courseIds]);
  const publications=await read('acc_training_material_publications','SELECT * FROM acc_training_material_publications WHERE course_id=ANY($1::int[]) ORDER BY id',[courseIds]);
  const materialEvents=await read('acc_training_material_events','SELECT * FROM acc_training_material_events WHERE draft_id=ANY($1::uuid[]) ORDER BY id',[drafts.map(r=>r.id)]);
  const camel=(row:any)=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
  const assessmentRows=recordHistory.map(camel) as unknown as AssessmentHistoryRow[];
  verifyAssessmentRows(assessmentRows);
  for(const record of records)verifyAssessmentRows(assessmentRows,camel(record) as unknown as TrainingRecord);
  await validateInspectionMaterial(client,drafts.map(camel) as any,publications.map(camel) as any,materialEvents.map(camel) as any);
  // A generic course can serve learners in other studies. Include its authored
  // changes, but never another scope's learner activity merely by course ID.
  await read('acc_training_audit_log',`SELECT t.id,t.user_id,t.action,t.record_id,t.course_id,t.details,t.created_at FROM acc_training_audit_log t WHERE
    (course_id=ANY($1::int[]) AND action IN ('course_created','course_updated','questions_added','training_material_drafted','training_material_reviewed','training_material_rejected','training_material_published'))
    OR record_id=ANY($2::int[]) OR details->>'planId'=ANY($3::text[]) OR details->>'obligationId'=ANY($4::text[])
    OR EXISTS(SELECT 1 FROM jsonb_array_elements($5::jsonb) p WHERE t.course_id=(p->>'courseId')::int AND
      (t.user_id=(p->>'userId')::int AND t.action IN ('training_started','quiz_submitted','quiz_passed','quiz_failed') OR t.action='training_expired' AND t.details->>'affectedUserId'=p->>'userId'))
    ORDER BY id`,[courseIds,records.map(r=>r.id),plans.map(r=>r.id),obligationIds.map(String),pairs]);
  const materialSources:TrainingMaterialSource[]=[...new Map(drafts.map(row=>[canonical(row.request.source),row.request.source as TrainingMaterialSource])).values()];
  if(materialSources.length>500)fail('Training inspection exceeds 500 retained material sources',413);
  const impactSources=[...new Map(plans.map(p=>[canonical({scope:p.plan.scope,source:p.plan.source}),{scope:p.plan.scope,source:p.plan.source}])).values()];
  if(impactSources.length>500)fail('Training inspection exceeds 500 retained impact sources',413);
  const gaps:string[]=[];
  const revisions=[...obligationEvents.map(e=>({courseId:e.snapshot.courseId,revision:e.snapshot.contentRevision})),...plans.flatMap(p=>p.plan.actions.filter((a:any)=>a.kind!=='withdraw').map((a:any)=>({courseId:a.request.courseId,revision:a.request.contentRevision})))];
  for(const pin of new Map(revisions.map(p=>[`${p.courseId}:${p.revision}`,p])).values()){
   if(!courses.some(c=>c.id===pin.courseId&&c.content_revision===pin.revision)&&!publications.some(p=>p.course_id===pin.courseId&&p.content_revision===pin.revision)
    &&!records.some(r=>r.course_id===pin.courseId&&r.content_revision===pin.revision&&r.content_snapshot)&&!recordHistory.some(r=>r.course_id===pin.courseId&&r.record_snapshot.contentRevision===pin.revision&&r.record_snapshot.contentSnapshot))gaps.push(`Historical course ${pin.courseId}, content revision ${pin.revision}: no retained material or learner snapshot is available.`);
  }
  for(const record of records)if(!record.content_snapshot)gaps.push(`Legacy training record ${record.id}: viewed material snapshot was not retained.`);
  for(const record of records)if(!record.assessment_cycle_id)gaps.push(`Legacy training record ${record.id}: individual graded-attempt receipts were not retained; completion remains summary evidence.`);
  const pins=new Map<string,{fileId:string;sha256:string;nativeStudyId:number}>();
  for(const source of [...materialSources,...plans.map(p=>({...p.plan.source,scope:p.plan.scope}))])for(const pin of source.originals){const entry={fileId:pin.fileId,sha256:pin.sha256,nativeStudyId:source.scope.siteId??source.scope.studyId},old=pins.get(pin.fileId);if(old&&canonical(old)!==canonical(entry))fail('Conflicting training original custody');pins.set(pin.fileId,entry);}
  const at=(await client.queryOne<{at:string}>('SELECT transaction_timestamp()::text AS at'))!;
  return {tables,materialSources,impactSources,gaps,originalPins:[...pins.values()].sort((a,b)=>a.fileId.localeCompare(b.fileId)),capturedAt:new Date(at.at).toISOString()};
 });
 const current=await observeTrainingInspection(authority,input.nativeStudyId,captured.materialSources,admitted.scopeFingerprint,captured.impactSources);
 if(canonical(current.studyIds)!==canonical(admitted.studyIds)||canonical(current.scopes)!==canonical(admitted.scopes))fail('Native inspection scope changed');
 const body={nativeStudyId:input.nativeStudyId,actorUserId:authority.actorUserId,studyIds:admitted.studyIds,scopes:admitted.scopes,...captured,sourceChecks:current.sourceChecks,impactChecks:current.impactChecks,
  authorityHash:current.authorityHash,complete:true as const,limitations:['Complete retained obligations and scoped material; this is not a complete staff curriculum census.','Learner/course attempts may support several scoped obligations; their existence does not prove duty applicability.','New assessment cycles retain immutable quiz definitions, answer selections and grading receipts. Legacy summary-only completions have no reconstructed attempt transcript; existing qualification policy remains unchanged.','Certificate identifiers and independent verification are retained records, not clinical competency or regulated approval.','Snapshot evidence can be historical or superseded. Source currentness is a separate native observation; no distributed atomic snapshot is claimed.','Training audit IP addresses and user agents are excluded; retained audit details and actor identities remain.']};
 await logAudit({userId:authority.actorUserId,action:'training_inspection_read',details:{nativeStudyId:input.nativeStudyId,evidenceHash:trainingEvidenceHash(body)}});
 return {schemaVersion:'training-inspection-evidence/1',nonce:input.nonce,observedAt:new Date().toISOString(),consistency:'training-snapshot-with-separate-native-observations',...body,evidenceHash:trainingEvidenceHash(body)};
}

const dutyNames = ['site_activation', 'participant_enrollment', 'arm_assignment', 'supply_dispensing'];
const dutyTimestamp=(value:unknown):string|null=>value===null||value===undefined||!Number.isFinite(new Date(value as string).getTime())?null:new Date(value as string).toISOString();
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function exactObject(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) fail('An exact duty policy object is required', 400);
}
export const trainingDutyHash = trainingEvidenceHash;

/** Strict, bounded source contract. Empty requirements never mean trained. */
export function validateDutyPolicy(value: unknown): asserts value is TrainingDutyPolicy {
  exactObject(value, ['schemaVersion', 'scope', 'assignments']);
  if (value.schemaVersion !== 'training-duty-policy/1') fail('Unsupported training duty policy', 400);
  exactObject(value.scope, ['studyId', 'siteId']);
  if (!id(value.scope.studyId) || value.scope.siteId !== undefined && !id(value.scope.siteId)) fail('Exact native duty scope is required', 400);
  if (!Array.isArray(value.assignments) || value.assignments.length < 1 || value.assignments.length > 1000) fail('A complete duty census of 1 to 1000 assignments is required', 400);
  const assignments = new Set<string>();
  let total = 0;
  for (const assignment of value.assignments) {
    exactObject(assignment, ['userId', 'role', 'armId', 'disposition', 'rationale', 'duties', 'obligations']);
    if (!id(assignment.userId) || typeof assignment.role !== 'string' || getRoleByName(assignment.role).name !== assignment.role || assignment.role === ROLES.INVALID.name) fail('Each duty needs an exact learner and canonical native role', 400);
    if(assignment.armId!==undefined&&!id(assignment.armId)||!['required','not_required'].includes(assignment.disposition))fail('Explicit native arm applicability and training disposition are required',400);
    reason(assignment.rationale);
    const key = `${assignment.userId}:${assignment.role}:${assignment.armId??'common'}`;
    if (assignments.has(key)) fail('Duplicate learner/role duty assignment', 400);
    assignments.add(key);
    if (!Array.isArray(assignment.duties) || assignment.disposition==='required'&&!assignment.duties.length || assignment.duties.some((d: unknown) => typeof d !== 'string' || !dutyNames.includes(d)) || new Set(assignment.duties).size !== assignment.duties.length) fail('Explicit supported delegated duties are required', 400);
    if (!Array.isArray(assignment.obligations) || assignment.obligations.length > 32 || (assignment.disposition==='required'?assignment.obligations.length<1:assignment.obligations.length!==0)) fail('Required training needs exact obligations; no-extra-training needs an explicit rationale and no obligation pins', 400);
    const obligations = new Set<number>();
    for (const pin of assignment.obligations) {
      exactObject(pin, ['id', 'revision', 'courseId', 'courseVersion', 'contentRevision']);
      if (![pin.id, pin.revision, pin.courseId, pin.contentRevision].every(id) || typeof pin.courseVersion !== 'string' || !pin.courseVersion.trim() || pin.courseVersion.length > 20 || obligations.has(pin.id)) fail('Unique exact obligation and course revision pins are required', 400);
      obligations.add(pin.id);
      if (++total > 1000) fail('Duty policy exceeds the qualified obligation census; no requirements were omitted', 400);
    }
  }
}

/** Assessment of an explicitly supplied policy, not approval of its adequacy.
 * Native clinical decisions retain and independently approve that exact policy.
 * Remote authority and training reads are current observations, not a distributed transaction. */
export async function getDutyReadiness(authority: TrainingAuthorityContext, value: unknown) {
  exactObject(value, ['schemaVersion', 'nonce', 'policy', 'actorUserId', 'duty', 'armIds']);
  if (value.schemaVersion !== 'training-duty-readiness-request/1' || typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce)) fail('An exact duty request and fresh nonce are required', 400);
  validateDutyPolicy(value.policy);
  if ((value.actorUserId === undefined) !== (value.duty === undefined) || value.actorUserId !== undefined && (!id(value.actorUserId) || !['participant_enrollment', 'arm_assignment', 'supply_dispensing'].includes(value.duty))) fail('An actor-specific request requires an exact learner and delegated duty', 400);
  if (value.actorUserId !== undefined && value.actorUserId !== authority.actorUserId) fail('A clinical duty assessment must identify the authenticated actor', 403);
  if(value.armIds!==undefined&&(value.actorUserId===undefined||!Array.isArray(value.armIds)||value.armIds.length>100||value.armIds.some((n:unknown)=>!id(n))||new Set(value.armIds).size!==value.armIds.length))fail('Exact distinct native arm selection is required',400);
  const request = value as unknown as TrainingDutyReadinessRequest;
  const selected = request.policy.assignments.filter(row => request.actorUserId === undefined || row.userId === request.actorUserId && row.duties.includes(request.duty!)&&(row.armId===undefined||request.armIds?.includes(row.armId)));
  const blockers: string[] = [];
  if (!selected.length) blockers.push('The acting staff member has no approved assignment for this duty.');
  if(request.actorUserId!==undefined){for(const arm of [undefined,...request.armIds??[]])if(!selected.some(a=>a.armId===arm))blockers.push(`The acting staff member has no delegated ${request.duty} assignment for ${arm===undefined?'common duties':`arm ${arm}`}.`);}
  const assignments = [];
  const evaluateCompletions:Array<(cutoff:number)=>void>=[];
  // One short local MVCC snapshot, released before any native HTTP callback.
  // A course and completion can never be assembled from different revisions.
  const pins=selected.flatMap(assignment=>assignment.obligations);
  const local=pins.length?await transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const obligations=await client.query<TrainingObligation>('SELECT * FROM acc_training_obligations WHERE id=ANY($1::integer[])',[[...new Set(pins.map(pin=>pin.id))]]);
    const courses=await client.query<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=ANY($1::integer[])',[[...new Set(pins.map(pin=>pin.courseId))]]);
    const records=await client.query<TrainingRecord>('SELECT * FROM acc_training_records WHERE user_id=ANY($1::integer[]) AND course_id=ANY($2::integer[])',[[...new Set(selected.map(row=>row.userId))],[...new Set(pins.map(pin=>pin.courseId))]]);
    for(const record of records.rows)await verifyRecordAssessment(client,record);
    const materials=new Map<number,NonNullable<Awaited<ReturnType<typeof publishedMaterial>>>>();for(const course of courses.rows){const pub=await publishedMaterial(client,course);if(pub)materials.set(course.id,pub);}
    return {obligations:new Map(obligations.rows.map(row=>[row.id,row])),courses:new Map(courses.rows.map(row=>[row.id,row])),records:new Map(records.rows.map(row=>[`${row.userId}:${row.courseId}`,row])),materials};
  }):{obligations:new Map<number,TrainingObligation>(),courses:new Map<number,TrainingCourse>(),records:new Map<string,TrainingRecord>(),materials:new Map<number,NonNullable<Awaited<ReturnType<typeof publishedMaterial>>>>()};
  const materialObservations=new Map<string,{publication:NonNullable<Awaited<ReturnType<typeof publishedMaterial>>>;learner:{userId:number;scope:TrainingObligationScope};observationHash:string}>();
  // Resolve the retained obligation scope as well as its declared applicability.
  // A parent obligation does not remain valid after its parent's role is revoked.
  const observations=new Map<string,{userId:number;scope:TrainingObligationScope;value:Awaited<ReturnType<typeof resolveObligationScope>>}>();
  const observe=async(userId:number,scope:TrainingObligationScope)=>{const key=canonical({userId,scope});const prior=observations.get(key);if(prior)return prior.value;
    const value=await resolveObligationScope(authority,'duties:read',userId,scope);observations.set(key,{userId,scope,value});return value;};
  for (const assignment of selected) {
    const scope=canonicalScope({...request.policy.scope,...(assignment.armId===undefined?{}:{armId:assignment.armId})});
    const observation = await observe(assignment.userId, scope);
    if (!observation.eligible || !observation.roles.includes(assignment.role)) blockers.push(`Learner ${assignment.userId} no longer holds the assigned native role in this scope.`);
    const evidence = [];
    for (const pin of assignment.obligations) {
      const row = local.obligations.get(pin.id);
      const applicable = row && row.userId === assignment.userId && row.role === assignment.role && row.scope.studyId === request.policy.scope.studyId
        && (row.scope.siteId === undefined || row.scope.siteId === request.policy.scope.siteId)
        && (row.scope.armId === undefined || row.scope.armId === assignment.armId);
      const exact = applicable && row.revision === pin.revision && row.courseId === pin.courseId && row.courseVersion === pin.courseVersion && row.contentRevision === pin.contentRevision;
      const retainedScope=exact?canonicalScope(row.scope):null;
      const retainedAuthority=retainedScope?await observe(assignment.userId,retainedScope):null;
      const course = exact ? local.courses.get(pin.courseId) : null;
      if(course?.materialScope&&row){const publication=local.materials.get(course.id)!;const learner={userId:row.userId,scope:row.scope},key=canonical({courseId:course.id,learner});
        if(!materialObservations.has(key)){const observed=await observePublication(authority,publication,learner);materialObservations.set(key,{publication,learner,observationHash:trainingDutyHash(observed)});}course.materialReady=true;}
      const record = exact ? local.records.get(`${assignment.userId}:${pin.courseId}`)??null : null;
      const result={ ...pin, readiness:'source_changed',retainedScope,retainedScopeObservationHash:retainedAuthority?.observationHash??null, recordId: record?.id ?? null,
        certificateNumber: record?.certificateNumber ?? null, completedAt: dutyTimestamp(record?.completedAt),
        verifiedAt: dutyTimestamp(record?.verifiedAt), verifiedBy: record?.verifiedBy ?? null };
      evaluateCompletions.push(cutoff=>{
        result.readiness=exact&&course?obligationReadiness(row,course,record,observation.eligible&&observation.roles.includes(assignment.role)&&retainedAuthority?.eligible&&retainedAuthority.roles.includes(assignment.role)?'current':'changed',cutoff):'source_changed';
        if(result.readiness!=='complete')blockers.push(`Learner ${assignment.userId}, obligation ${pin.id}: ${result.readiness}.`);
      });
      evidence.push(result);
    }
    assignments.push({ userId: assignment.userId, role: assignment.role, ...(assignment.armId===undefined?{}:{armId:assignment.armId}), disposition:assignment.disposition,rationale:assignment.rationale,duties: assignment.duties,
      scopeObservationHash: observation.observationHash, scopeFingerprint: observation.scopeFingerprint, obligations: evidence });
  }
  // Recheck every distinct source and applicability scope after all local reads.
  for(const observed of observations.values())await resolveObligationScope(authority,'duties:read',observed.userId,observed.scope,observed.value);
  for(const observed of materialObservations.values())if(trainingDutyHash(await observePublication(authority,observed.publication,observed.learner))!==observed.observationHash)throw Object.assign(new Error('Material authority changed during readiness observation'),{statusCode:409});
  // Expiration is evaluated at the response cutoff, after potentially slow
  // native callbacks. A completion expiring during observation cannot be ready.
  const cutoff=Date.now();for(const evaluate of evaluateCompletions)evaluate(cutoff);
  const evidence = { policyHash: trainingDutyHash(request.policy), actorUserId: request.actorUserId ?? null, duty: request.duty ?? 'complete_census',armIds:request.armIds??[], assignments, blockers, ready: !blockers.length };
  return { schemaVersion: 'training-duty-readiness/1', nonce: request.nonce, observedAt: new Date(cutoff).toISOString(),
    consistency: 'current-observations-not-atomic', ...evidence, evidenceHash: trainingDutyHash(evidence) };
}
