import { getRoleByName, ROLES } from '@accura-trial/auth-core';
import { query, queryOne, transaction, TransactionClient } from '../config/database';
import { logAudit,canonicalTrainingEvidence as canonical,trainingEvidenceHash } from './audit.service';
import { authorizeTrainingTargets, resolveObligationScope, observeTrainingInspection, TrainingAuthorityContext, ObligationScopeObservation } from './training-authority.service';
import { TrainingCourse, TrainingDutyPolicy, TrainingDutyReadinessRequest, TrainingObligation, TrainingObligationRequest, TrainingObligationScope, TrainingObligationView, TrainingRecord } from '../types/training.types';
import {assertMaterialUse,publishedMaterial,observePublication,validateInspectionMaterial} from './training-materials.service';
import {mapRecordToDto} from './training-record-dto';
import {verifyRecordAssessment,verifyAssessmentRows,AssessmentHistoryRow} from './training-assessment-evidence';
import {bindingFor,recordDecisionSubject,signatureBindings,signatureReference} from './training-signatures.service';
// The impact plan service reaches the signature leaf through this module: the EDC's native suites compile it with
// replacements for this module only (tests/helpers/synthetic-training-readiness.ts there).
export {bindingStatus,bindSignatureReceipt,checkSignedDecision,impactReviewBinding,impactReviewSubject,readSignatureReceipt,signatureAuditDetails} from './training-signatures.service';
import {createHash,randomUUID} from 'node:crypto';
import type {TrainingInspectionEvidence,TrainingInspectionManifest,TrainingInspectionSegment,TrainingInspectionSegmentDescriptor,TrainingMaterialSource,TrainingRecordSignatureDecision,TrainingSignatureBinding,TrainingSignatureReference} from '../types/training.types';

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

/** The records of exact learner and course pairs in the caller's snapshot, keyed `userId:courseId`, each verified
 * against its retained assessment history. Only the selected pairs are read, never the Cartesian product of their
 * learners and courses. One integrity failure refuses the whole read. */
export async function verifiedRecords(client: TransactionClient, rows: Array<{ userId: number; courseId: number }>): Promise<Map<string, TrainingRecord>> {
  const pairs = [...new Map(rows.map(row => [`${row.userId}:${row.courseId}`, { user_id: row.userId, course_id: row.courseId }])).values()];
  const records = (await client.query<TrainingRecord>(`SELECT r.* FROM acc_training_records r JOIN
      jsonb_to_recordset($1::jsonb) AS selected(user_id integer,course_id integer)
      ON r.user_id=selected.user_id AND r.course_id=selected.course_id`, [JSON.stringify(pairs)])).rows;
  for (const record of records) await verifyRecordAssessment(client, record);
  return new Map(records.map(row => [`${row.userId}:${row.courseId}`, row]));
}

/** Readiness of assigned obligations from retained rows alone, in the caller's snapshot (the T-4 arm lead time): the
 * learner's verified record and the course, with a governed course current while its retained publication is
 * (publishedMaterial). The native scope and material source are not re-observed, so this is never duty readiness. */
export async function retainedObligationReadiness(client: TransactionClient, obligations: TrainingObligation[], now: number) {
  const courses = new Map((await client.query<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=ANY($1::integer[])',
    [[...new Set(obligations.map(row => row.courseId))]])).rows.map(row => [row.id, row]));
  const records = await verifiedRecords(client, obligations);
  const custody = new Map<number, boolean>();
  for (const course of courses.values()) if (course.materialScope) {
    try { await publishedMaterial(client, course); custody.set(course.id, true); }
    catch (error) { if (![404, 409].includes((error as {statusCode?: number}).statusCode ?? 0)) throw error; custody.set(course.id, false); }
  }
  return new Map(obligations.map(row => {
    const course = courses.get(row.courseId); if (!course) fail('Training course evidence is missing');
    const record = records.get(`${row.userId}:${row.courseId}`) ?? null;
    return [row.id, { readiness: obligationReadiness(row, { ...course, materialReady: custody.get(course.id) }, record, 'current', now), record }] as const;
  }));
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

/** Privileged constituent of the existing EDC inspection copy. /1 never persists a second package and never widens
 * ordinary learner history. /2 (FX-TRN-04; off unless TRAINING_INSPECTION_SEGMENTS_ENABLED=true, read at every request)
 * answers the same snapshot, plus the signature bindings and effort intervals, as a manifest of hashed segments, and
 * keeps one append-only capture row: the segment census and each segment's primary keys, never the rows. A segment
 * is re-read from the current rows on request and refused when its hash changed, so no copy of privileged rows is kept. */
let activeInspectionReads=0;
export const inspectionSegmentsEnabled=()=>process.env.TRAINING_INSPECTION_SEGMENTS_ENABLED==='true';
const INSPECTION_REQUEST_2='training-inspection-evidence-request/2',SEGMENT_REQUEST='training-inspection-segment-request/1';
/** The declared /2 bounds (contracts/training-inspection-evidence-v2.schema.json). The segment count replaces the /1 table, row and byte budgets. */
const INSPECTION_LIMITS={maxSegments:256,maxSegmentRows:10000,maxSegmentBytes:8*1024*1024};
const INSPECTION_PAGE_ROWS=1000;
/** Every table of the inspection copy in declared order: its primary key, its total row order (with SQL types) and
 * its projection. /1 reads the first 13 tables; /2 all 15. */
const INSPECTION_TABLES:Record<string,{key:[string,string];order:Array<[string,string]>;projection:string}>={
 acc_training_obligations:{key:['id','int'],order:[['id','int']],projection:'*'},
 acc_training_obligation_events:{key:['id','bigint'],order:[['obligation_id','int'],['revision','int']],projection:'*'},
 acc_training_impact_plans:{key:['id','uuid'],order:[['id','uuid']],projection:'*'},
 acc_training_impact_events:{key:['id','bigint'],order:[['plan_id','uuid'],['revision','int']],projection:'*'},
 acc_training_courses:{key:['id','int'],order:[['id','int']],projection:'*'},
 acc_training_slides:{key:['id','int'],order:[['course_id','int'],['order_index','int'],['id','int']],projection:'*'},
 acc_training_questions:{key:['id','int'],order:[['course_id','int'],['order_index','int'],['id','int']],projection:'*'},
 acc_training_records:{key:['id','int'],order:[['id','int']],projection:'*'},
 acc_training_record_history:{key:['history_id','bigint'],order:[['history_id','bigint']],projection:'*'},
 acc_training_material_drafts:{key:['id','uuid'],order:[['id','uuid']],projection:'*'},
 acc_training_material_publications:{key:['id','uuid'],order:[['id','uuid']],projection:'*'},
 acc_training_material_events:{key:['id','bigint'],order:[['id','bigint']],projection:'*'},
 // IP addresses and user agents are never part of the copy.
 acc_training_audit_log:{key:['id','int'],order:[['id','int']],projection:'id,user_id,action,record_id,course_id,details,created_at'},
 acc_training_decision_signatures:{key:['id','bigint'],order:[['id','bigint']],projection:'*'},
 acc_training_effort_intervals:{key:['id','bigint'],order:[['id','bigint']],projection:'*'},
};
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex');
const UUID_TEXT=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function inspectionSlot<T>(read:()=>Promise<T>):Promise<T>{
 if(activeInspectionReads>=4)fail('Training inspection capacity is unavailable; retry without requesting a partial copy',503);
 activeInspectionReads++;
 try{return await read();}finally{activeInspectionReads--;}
}
export async function getTrainingInspectionEvidence(authority:TrainingAuthorityContext,value:unknown):Promise<TrainingInspectionEvidence|TrainingInspectionManifest>{
 // A /2 request is refused before anything else while the switch is off; every other body is answered as before.
 if((value as {schemaVersion?:unknown}|null)?.schemaVersion===INSPECTION_REQUEST_2&&!inspectionSegmentsEnabled())fail('Segmented training inspection evidence is not enabled on this service',503);
 return inspectionSlot(()=>collectTrainingInspectionEvidence(authority,value));
}
/** The /2 reader of one table inside the capture snapshot: pages in the table's total order (keyset, so a page
 * never rescans earlier rows), cuts segments at the declared row and byte bounds, keeps each segment's primary keys
 * and hash, and returns parsed rows only for the tables the closure checks need. */
function inspectionSegmenter(client:TransactionClient){
 const segments:TrainingInspectionSegmentDescriptor[]=[],keys:string[][]=[];
 const read=async(table:string,select:string,values:unknown[],keep:boolean)=>{
  const spec=INSPECTION_TABLES[table]!,order=spec.order.map(([column])=>`t.${column}`).join(','),parsed:any[]=[];
  let open={rows:[] as Array<{nativeJson:string;sha256:string}>,keys:[] as string[],bytes:0};let after:string[]|null=null;
  const seal=()=>{
   if(segments.length>=INSPECTION_LIMITS.maxSegments)fail(`Training inspection exceeds ${INSPECTION_LIMITS.maxSegments} segments; no partial evidence returned`,413);
   segments.push({ordinal:segments.length,table,count:open.rows.length,contentHash:trainingEvidenceHash(open.rows),bytes:open.bytes});keys.push(open.keys);
   open={rows:[],keys:[],bytes:0};
  };
  for(;;){
   const keyset:string=after?` WHERE (${order})>(${spec.order.map(([,type],i)=>`$${values.length+i+1}::${type}`).join(',')})`:'';
   const page:Array<Record<string,string>>=(await client.query<Record<string,string>>(`SELECT row_to_json(t)::text AS native_json,t.${spec.key[0]}::text AS row_key,
     ${spec.order.map(([column],i)=>`t.${column}::text AS k${i}`).join(',')} FROM (${select}) t${keyset} ORDER BY ${order} LIMIT ${INSPECTION_PAGE_ROWS}`,
     after?[...values,...after]:values)).rows;
   for(const row of page){
    const text=row.nativeJson!,size=Buffer.byteLength(text);
    if(size>INSPECTION_LIMITS.maxSegmentBytes)fail('A retained training row exceeds the segment byte bound; no partial evidence returned',413);
    if(open.rows.length===INSPECTION_LIMITS.maxSegmentRows||open.bytes+size>INSPECTION_LIMITS.maxSegmentBytes)seal();
    open.rows.push({nativeJson:text,sha256:sha256(text)});open.keys.push(row.rowKey!);open.bytes+=size;
    if(keep)parsed.push(JSON.parse(text));
   }
   if(page.length<INSPECTION_PAGE_ROWS)break;
   const last:Record<string,string>=page.at(-1)!;after=spec.order.map((_,i):string=>last[`k${i}`]!);
  }
  seal();return parsed;
 };
 return {segments,keys,read};
}
async function collectTrainingInspectionEvidence(authority:TrainingAuthorityContext,value:unknown):Promise<TrainingInspectionEvidence|TrainingInspectionManifest>{
 const segmented=(value as {schemaVersion?:unknown}|null)?.schemaVersion===INSPECTION_REQUEST_2;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>![...['nativeStudyId','nonce'],...(segmented?['schemaVersion']:[])].includes(k)))fail('Exact inspection scope and nonce required',400);
 const input=value as {nativeStudyId:number;nonce:string};if(!id(input.nativeStudyId)||typeof input.nonce!=='string'||! /^[a-f0-9]{32}$/.test(input.nonce))fail('Exact inspection scope and nonce required',400);
 const admitted=await observeTrainingInspection(authority,input.nativeStudyId);
 const captured=await transaction(async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL TIME ZONE 'UTC'");
  let bytes=0,count=0;const tables:TrainingInspectionEvidence['tables']=[];
  const segmenter=segmented?inspectionSegmenter(client):null;
  const read=async(table:string,sql:string,values:unknown[],keep=true)=>{
   if(segmenter)return segmenter.read(table,sql,values,keep);
   const rows=(await client.query<{nativeJson:string}>(`SELECT row_to_json(t)::text AS native_json FROM (${sql} ORDER BY ${INSPECTION_TABLES[table]!.order.map(([column])=>column).join(',')}) t LIMIT 10001`,values)).rows;
   if(rows.length>10000)fail('Training inspection exceeds a complete table budget; no partial evidence returned',413);
   count+=rows.length;const copies=rows.map(row=>{bytes+=Buffer.byteLength(row.nativeJson);return {...row,sha256:createHash('sha256').update(row.nativeJson).digest('hex')};});
   if(count>100000||bytes>16*1024*1024)fail('Training inspection exceeds the complete evidence budget; no partial evidence returned',413);
   tables.push({table,count:copies.length,contentHash:trainingEvidenceHash(copies),rows:copies});return rows.map(row=>JSON.parse(row.nativeJson));};
  const nativeScopes=JSON.stringify(admitted.scopes);
  const scopeWhere=`EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) s WHERE t.scope->>'studyId'=s->>'studyId' AND t.scope->>'siteId' IS NOT DISTINCT FROM s->>'siteId')`;
  const obligations=await read('acc_training_obligations',`SELECT t.* FROM acc_training_obligations t WHERE ${scopeWhere}`,[nativeScopes]);
  const obligationIds=obligations.map(r=>r.id);
  const obligationEvents=await read('acc_training_obligation_events','SELECT * FROM acc_training_obligation_events WHERE obligation_id=ANY($1::int[])',[obligationIds]);
  for(const obligation of obligations){const history=obligationEvents.filter(e=>e.obligation_id===obligation.id);
   if(history.length!==obligation.revision||history.some((e,i)=>e.revision!==i+1||e.snapshot.id!==obligation.id||e.snapshot.userId!==obligation.user_id||e.snapshot.courseId!==obligation.course_id||canonical(e.snapshot.scope)!==canonical(obligation.scope)))fail('Retained obligation history is incomplete or inconsistent');
   const last=history.at(-1)?.snapshot;if(!last||last.revision!==obligation.revision||last.status!==obligation.status||last.courseVersion!==obligation.course_version||last.contentRevision!==obligation.content_revision)fail('Retained obligation head differs from its history');}
  const plans=await read('acc_training_impact_plans',`SELECT t.* FROM acc_training_impact_plans t WHERE EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) s WHERE t.plan->'scope'=s)`,[nativeScopes]);
  const impactEvents=await read('acc_training_impact_events','SELECT * FROM acc_training_impact_events WHERE plan_id=ANY($1::uuid[])',[plans.map(r=>r.id)]);
  for(const plan of plans){if(trainingEvidenceHash(plan.plan)!==plan.plan_hash)fail('Retained training impact integrity failed');
   const history=impactEvents.filter(e=>e.plan_id===plan.id);if(history.length!==plan.revision||history.some((e,i)=>e.revision!==i+1||e.snapshot.id!==plan.id||trainingEvidenceHash(e.snapshot.plan)!==plan.plan_hash||e.snapshot.planHash!==plan.plan_hash)||history.at(-1)?.snapshot.status!==plan.status)fail('Retained training impact history is incomplete or inconsistent');}
  const selectedCourseIds=[...new Set([...obligations.map(r=>r.course_id),...plans.flatMap(p=>p.plan.actions.filter((a:any)=>a.kind!=='withdraw').map((a:any)=>a.request.courseId))])];
  const courses=await read('acc_training_courses',`SELECT t.* FROM acc_training_courses t WHERE id=ANY($2::int[]) OR EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) s WHERE material_scope=s)`,[nativeScopes,selectedCourseIds]);
  if(selectedCourseIds.some(id=>!courses.some(c=>c.id===id)))fail('A referenced training course is missing from retained custody');
  for(const course of courses)if(course.material_scope&&!admitted.scopes.some(s=>canonical(s)===canonical(course.material_scope)))fail('Training material closure requires an authorized parent-family copy');
  const courseIds=courses.map(r=>r.id);
  await read('acc_training_slides','SELECT * FROM acc_training_slides WHERE course_id=ANY($1::int[])',[courseIds],false);
  await read('acc_training_questions','SELECT * FROM acc_training_questions WHERE course_id=ANY($1::int[])',[courseIds],false);
  const pairs=JSON.stringify(obligations.map(r=>({userId:r.user_id,courseId:r.course_id})));
  const pairsWhere=`EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) p WHERE t.user_id=(p->>'userId')::int AND t.course_id=(p->>'courseId')::int)`;
  const records=await read('acc_training_records',`SELECT t.* FROM acc_training_records t WHERE ${pairsWhere}`,[pairs]);
  const recordHistory=await read('acc_training_record_history',`SELECT t.* FROM acc_training_record_history t WHERE ${pairsWhere}`,[pairs]);
  const drafts=await read('acc_training_material_drafts','SELECT * FROM acc_training_material_drafts WHERE course_id=ANY($1::int[])',[courseIds]);
  const publications=await read('acc_training_material_publications','SELECT * FROM acc_training_material_publications WHERE course_id=ANY($1::int[])',[courseIds]);
  const materialEvents=await read('acc_training_material_events','SELECT * FROM acc_training_material_events WHERE draft_id=ANY($1::uuid[])',[drafts.map(r=>r.id)]);
  const camel=(row:any)=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
  const assessmentRows=recordHistory.map(camel) as unknown as AssessmentHistoryRow[];
  verifyAssessmentRows(assessmentRows);
  for(const record of records)verifyAssessmentRows(assessmentRows,camel(record) as unknown as TrainingRecord);
  await validateInspectionMaterial(client,drafts.map(camel) as any,publications.map(camel) as any,materialEvents.map(camel) as any);
  // A generic course can serve learners in other studies. Include its authored
  // changes, but never another scope's learner activity merely by course ID.
  // A material approval signature row names its draft (training-materials.service.ts); it is selected by a
  // selected draft, never by its course alone (RF-073).
  await read('acc_training_audit_log',`SELECT t.id,t.user_id,t.action,t.record_id,t.course_id,t.details,t.created_at FROM acc_training_audit_log t WHERE
    (course_id=ANY($1::int[]) AND action IN ('course_created','course_updated','questions_added','training_material_drafted','training_material_reviewed','training_material_rejected','training_material_published'))
    OR record_id=ANY($2::int[]) OR details->>'planId'=ANY($3::text[]) OR details->>'obligationId'=ANY($4::text[])
    OR action='training_signature_bound' AND details->>'draftId'=ANY($6::text[])
    OR EXISTS(SELECT 1 FROM jsonb_array_elements($5::jsonb) p WHERE t.course_id=(p->>'courseId')::int AND
      (t.user_id=(p->>'userId')::int AND t.action IN ('training_started','quiz_submitted','quiz_passed','quiz_failed') OR t.action='training_expired' AND t.details->>'affectedUserId'=p->>'userId'))
    `,[courseIds,records.map(r=>r.id),plans.map(r=>r.id),obligationIds.map(String),pairs,drafts.map(r=>r.id)],false);
  // /2 only: the bindings of selected records, drafts and plans, and the effort intervals of selected records. A row
  // that names a study or site outside this inspection (a signature context, a served obligation's scope) is
  // withheld whole and counted as a gap, so the copy never reaches another study's obligations or arms.
  const withheld:string[]=[];
  if(segmenter){
   const signed=`(t.record_id=ANY($2::int[]) OR t.draft_id=ANY($3::uuid[]) OR t.impact_plan_id=ANY($4::uuid[]))`;
   const inside=`EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) s WHERE t.context->>'studyId'=s->>'studyId' AND t.context->>'siteId' IS NOT DISTINCT FROM s->>'siteId')`;
   const signatureValues=[nativeScopes,records.map(r=>r.id),drafts.map(r=>r.id),plans.map(r=>r.id)];
   await read('acc_training_decision_signatures',`SELECT t.* FROM acc_training_decision_signatures t WHERE ${signed} AND ${inside}`,signatureValues,false);
   const signatures=(await client.queryOne<{n:number}>(`SELECT count(*)::int AS n FROM acc_training_decision_signatures t WHERE ${signed} AND NOT ${inside}`,signatureValues))!.n;
   if(signatures)withheld.push(`${signatures} Part 11 signature binding(s) of selected training decisions name a study or site outside this inspection and are withheld whole.`);
   const outside=`EXISTS(SELECT 1 FROM jsonb_array_elements(t.served) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) s
     WHERE x->'scope'->>'studyId'=s->>'studyId' AND x->'scope'->>'siteId' IS NOT DISTINCT FROM s->>'siteId'))`;
   const effortValues=[nativeScopes,records.map(r=>r.id)];
   await read('acc_training_effort_intervals',`SELECT t.* FROM acc_training_effort_intervals t WHERE t.record_id=ANY($2::int[]) AND NOT ${outside}`,effortValues,false);
   const intervals=(await client.queryOne<{n:number}>(`SELECT count(*)::int AS n FROM acc_training_effort_intervals t WHERE t.record_id=ANY($2::int[]) AND ${outside}`,effortValues))!.n;
   if(intervals)withheld.push(`${intervals} training effort interval(s) of selected records also served obligations outside this inspection and are withheld whole.`);
  }
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
  gaps.push(...withheld);
  const pins=new Map<string,{fileId:string;sha256:string;nativeStudyId:number}>();
  for(const source of [...materialSources,...plans.map(p=>({...p.plan.source,scope:p.plan.scope}))])for(const pin of source.originals){const entry={fileId:pin.fileId,sha256:pin.sha256,nativeStudyId:source.scope.siteId??source.scope.studyId},old=pins.get(pin.fileId);if(old&&canonical(old)!==canonical(entry))fail('Conflicting training original custody');pins.set(pin.fileId,entry);}
  const at=(await client.queryOne<{at:string}>('SELECT transaction_timestamp()::text AS at'))!;
  return {tables,common:{materialSources,impactSources,gaps,originalPins:[...pins.values()].sort((a,b)=>a.fileId.localeCompare(b.fileId)),capturedAt:new Date(at.at).toISOString()},
   segments:segmenter?.segments,keys:segmenter?.keys};
 });
 const current=await observeTrainingInspection(authority,input.nativeStudyId,captured.common.materialSources,admitted.scopeFingerprint,captured.common.impactSources);
 if(canonical(current.studyIds)!==canonical(admitted.studyIds)||canonical(current.scopes)!==canonical(admitted.scopes))fail('Native inspection scope changed');
 const limitations=['Complete retained obligations and scoped material; this is not a complete staff curriculum census.','Learner/course attempts may support several scoped obligations; their existence does not prove duty applicability.','New assessment cycles retain immutable quiz definitions, answer selections and grading receipts. Legacy summary-only completions have no reconstructed attempt transcript; existing qualification policy remains unchanged.','Certificate identifiers and independent verification are retained records, not clinical competency or regulated approval.','Snapshot evidence can be historical or superseded. Source currentness is a separate native observation; no distributed atomic snapshot is claimed.','Training audit IP addresses and user agents are excluded; retained audit details and actor identities remain.'];
 if(!captured.segments){
  const body={nativeStudyId:input.nativeStudyId,actorUserId:authority.actorUserId,studyIds:admitted.studyIds,scopes:admitted.scopes,tables:captured.tables,...captured.common,sourceChecks:current.sourceChecks,impactChecks:current.impactChecks,
   authorityHash:current.authorityHash,complete:true as const,limitations};
  await logAudit({userId:authority.actorUserId,action:'training_inspection_read',details:{nativeStudyId:input.nativeStudyId,evidenceHash:trainingEvidenceHash(body)}});
  return {schemaVersion:'training-inspection-evidence/1',nonce:input.nonce,observedAt:new Date().toISOString(),consistency:'training-snapshot-with-separate-native-observations',...body,evidenceHash:trainingEvidenceHash(body)};
 }
 const common=captured.common,captureId=randomUUID(),segments=captured.segments;
 const manifestHash=trainingEvidenceHash({captureId,capturedAt:common.capturedAt,segments});
 const body={nativeStudyId:input.nativeStudyId,actorUserId:authority.actorUserId,studyIds:admitted.studyIds,scopes:admitted.scopes,captureId,limits:INSPECTION_LIMITS,segments,manifestHash,
  ...common,sourceChecks:current.sourceChecks,impactChecks:current.impactChecks,authorityHash:current.authorityHash,complete:true as const,limitations:[...limitations,
   'Segments are re-read from current rows when requested and refused (409) once their content changed after capture; this service keeps the segment census and row keys of a capture, never a copy of its rows.',
   'Part 11 signature bindings and training effort intervals are included only when every study or site they name is in this inspection; others are withheld whole and counted in gaps.']};
 const evidenceHash=trainingEvidenceHash(body);
 await transaction(async client=>{
  await client.query(`INSERT INTO acc_training_inspection_captures(capture_id,actor_user_id,nonce_sha256,native_study_id,scope_fingerprint,study_ids,scopes,
    segments,segment_keys,manifest_hash,evidence_hash,captured_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)`,
   [captureId,authority.actorUserId,sha256(input.nonce),input.nativeStudyId,admitted.scopeFingerprint,JSON.stringify(admitted.studyIds),JSON.stringify(admitted.scopes),
    JSON.stringify(segments),JSON.stringify(captured.keys),manifestHash,evidenceHash,common.capturedAt]);
  await logAudit({userId:authority.actorUserId,action:'training_inspection_read',details:{nativeStudyId:input.nativeStudyId,evidenceHash,schemaVersion:'training-inspection-evidence/2',captureId,manifestHash}},client);
 });
 return {schemaVersion:'training-inspection-evidence/2',nonce:input.nonce,observedAt:new Date().toISOString(),consistency:'training-snapshot-with-separate-native-observations',...body,evidenceHash};
}

/** POST /inspection-evidence/segment: one segment of a /2 capture, only to its actor with its nonce, after a current
 * native inspection observation of the captured scope. Its rows are re-read by primary key in one REPEATABLE READ
 * snapshot and refused (409) when they no longer hash to the manifest. 503 before anything else while /2 is off. */
export async function getTrainingInspectionSegment(authority:TrainingAuthorityContext,value:unknown):Promise<TrainingInspectionSegment>{
 if(!inspectionSegmentsEnabled())fail('Segmented training inspection evidence is not enabled on this service',503);
 return inspectionSlot(()=>readTrainingInspectionSegment(authority,value));
}
async function readTrainingInspectionSegment(authority:TrainingAuthorityContext,value:unknown):Promise<TrainingInspectionSegment>{
 const input=value as {schemaVersion:string;captureId:string;nonce:string;ordinal:number};
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['schemaVersion','captureId','nonce','ordinal'].includes(k))
  ||input.schemaVersion!==SEGMENT_REQUEST||typeof input.captureId!=='string'||!UUID_TEXT.test(input.captureId)||typeof input.nonce!=='string'||!/^[a-f0-9]{32}$/.test(input.nonce)
  ||!Number.isSafeInteger(input.ordinal)||input.ordinal<0||input.ordinal>=INSPECTION_LIMITS.maxSegments)fail('An exact capture, nonce and segment ordinal are required',400);
 const capture=await queryOne<{actorUserId:number;nonceSha256:string;nativeStudyId:number;scopeFingerprint:string;studyIds:number[];scopes:Array<{studyId:number;siteId?:number}>;
  manifestHash:string;segment:TrainingInspectionSegmentDescriptor|null;rowKeys:string[]|null}>(`SELECT actor_user_id,nonce_sha256,native_study_id,scope_fingerprint,study_ids,scopes,
  manifest_hash,segments->($2::int) AS segment,segment_keys->($2::int) AS row_keys FROM acc_training_inspection_captures WHERE capture_id=$1`,[input.captureId,input.ordinal]);
 // An unknown capture, another actor and another nonce get one answer, which never discloses that the capture exists.
 if(!capture||capture.actorUserId!==authority.actorUserId||capture.nonceSha256!==sha256(input.nonce))fail('No training inspection capture matches this actor and nonce',404);
 const segment=capture.segment,spec=segment&&Object.prototype.hasOwnProperty.call(INSPECTION_TABLES,segment.table)?INSPECTION_TABLES[segment.table]:undefined;
 if(!segment)fail('The training inspection capture has no segment with this ordinal',404);
 if(!spec||!Array.isArray(capture.rowKeys)||capture.rowKeys.length!==segment.count||segment.ordinal!==input.ordinal)fail('Retained training inspection capture integrity failed');
 const sameScope=(observed:{studyIds:number[];scopes:unknown[]})=>canonical(observed.studyIds)===canonical(capture.studyIds)&&canonical(observed.scopes)===canonical(capture.scopes);
 if(!sameScope(await observeTrainingInspection(authority,capture.nativeStudyId,[],capture.scopeFingerprint)))fail('Native inspection scope changed; capture the training evidence again');
 const rows=await transaction(async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL TIME ZONE 'UTC'");
  return (await client.query<{nativeJson:string}>(`SELECT row_to_json(t)::text AS native_json FROM (SELECT ${spec.projection} FROM ${segment.table}) t
    JOIN unnest($1::${spec.key[1]}[]) WITH ORDINALITY AS k(key,position) ON t.${spec.key[0]}=k.key ORDER BY k.position`,[capture.rowKeys])).rows;
 });
 const copies=rows.map(row=>({nativeJson:row.nativeJson,sha256:sha256(row.nativeJson)}));
 if(copies.length!==segment.count||copies.reduce((n,row)=>n+Buffer.byteLength(row.nativeJson),0)!==segment.bytes||trainingEvidenceHash(copies)!==segment.contentHash)
  fail('The training inspection segment changed after its capture; capture the training evidence again');
 if(!sameScope(await observeTrainingInspection(authority,capture.nativeStudyId,[],capture.scopeFingerprint)))fail('Native inspection scope changed; capture the training evidence again');
 await logAudit({userId:authority.actorUserId,action:'training_inspection_segment_read',details:{nativeStudyId:capture.nativeStudyId,captureId:input.captureId,ordinal:segment.ordinal,table:segment.table,contentHash:segment.contentHash}});
 return {schemaVersion:'training-inspection-segment/1',captureId:input.captureId,ordinal:segment.ordinal,table:segment.table,count:segment.count,contentHash:segment.contentHash,
  bytes:segment.bytes,manifestHash:capture.manifestHash,rows:copies};
}

const dutyNames = ['site_activation', 'participant_enrollment', 'arm_assignment', 'supply_dispensing', 'data_entry'];
const dutyTimestamp=(value:unknown):string|null=>value===null||value===undefined||!Number.isFinite(new Date(value as string).getTime())?null:new Date(value as string).toISOString();
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function exactObject(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) fail('An exact duty policy object is required', 400);
}
export const trainingDutyHash = trainingEvidenceHash;

/** Strict, bounded source contract. Empty requirements never mean trained. training-duty-policy/2 is /1 plus a
 * reviewed per-scope rule that every complete pin also carries its Part 11 signatures. */
export function validateDutyPolicy(value: unknown): asserts value is TrainingDutyPolicy {
  exactObject(value, ['schemaVersion', 'scope', 'assignments', 'signatures']);
  if (value.schemaVersion === 'training-duty-policy/2') { if (value.signatures !== 'part11-required') fail('A training-duty-policy/2 requires signatures part11-required', 400); }
  else if (value.schemaVersion !== 'training-duty-policy/1' || value.signatures !== undefined) fail('Unsupported training duty policy', 400);
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

type DutyPublication=NonNullable<Awaited<ReturnType<typeof publishedMaterial>>>;
/** The signatures one pin cites under training-duty-policy/2: the learner's attestation and the recorded verifier's
 * signature over the record's current completion, and the reviewer's approval of the current governed publication.
 * A retained binding that no longer matches its completion or publication refuses the observation; it is never
 * read as unsigned. */
function pinSignatures(bindings:TrainingSignatureBinding[],record:TrainingRecord|null,publication:DutyPublication|null){
  const completion=(kind:TrainingRecordSignatureDecision,signer:number|null):TrainingSignatureReference|null=>{
    if(!record||record.status!=='completed'||!record.assessmentCycleId)return null;
    const binding=bindingFor(bindings,kind,{recordId:record.id,assessmentCycleId:record.assessmentCycleId});if(!binding)return null;
    if(binding.signerUserId!==signer||trainingDutyHash(binding.subject)!==binding.subjectHash||trainingDutyHash(recordDecisionSubject(kind,record,binding.context))!==binding.subjectHash)
      fail('A retained training signature no longer matches its completion');
    return signatureReference(binding);
  };
  let materialApproval:TrainingSignatureReference|null=null;
  const approval=publication?bindingFor(bindings,'material-approval',{draftId:publication.draftId}):undefined;
  if(publication&&approval){const r=publication.receipt,s=approval.subject as Record<string,any>;
    if(approval.signerUserId!==r.reviewerUserId||approval.signerUserId===r.authorUserId||trainingDutyHash(s)!==approval.subjectHash||s.kind!=='material-approval'
      ||s.draftId!==publication.draftId||s.requestHash!==r.requestHash||s.courseId!==publication.courseId||s.authorUserId!==r.authorUserId
      ||s.sourceHash!==r.source?.sourceHash||canonical(s.context)!==canonical(r.source?.scope))fail('A retained material approval signature no longer matches its publication');
    materialApproval=signatureReference(approval);}
  return {attestation:completion('completion-attestation',record?.userId??null),verification:completion('verification',record?.verifiedBy??null),materialApproval};
}

/** Assessment of an explicitly supplied policy, not approval of its adequacy.
 * Native clinical decisions retain and independently approve that exact policy.
 * Remote authority and training reads are current observations, not a distributed transaction.
 * Request /2 carries a /2 policy and is answered in training-duty-readiness/2: each pin cites its signatures, and a
 * pin complete by the /1 rules whose signatures are missing reads signature_required. /1 is answered as before. */
export async function getDutyReadiness(authority: TrainingAuthorityContext, value: unknown) {
  exactObject(value, ['schemaVersion', 'nonce', 'policy', 'actorUserId', 'duty', 'armIds']);
  const signed = value.schemaVersion === 'training-duty-readiness-request/2';
  if (!signed && value.schemaVersion !== 'training-duty-readiness-request/1' || typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce)) fail('An exact duty request and fresh nonce are required', 400);
  validateDutyPolicy(value.policy);
  // The versions pair exactly, so a /1 reader is never answered for a /2 policy whose signature rule it cannot see.
  if (signed !== (value.policy.schemaVersion === 'training-duty-policy/2')) fail('A training-duty-readiness-request/2 carries exactly a training-duty-policy/2, and /1 a /1 policy', 400);
  if ((value.actorUserId === undefined) !== (value.duty === undefined) || value.actorUserId !== undefined && (!id(value.actorUserId) || !['participant_enrollment', 'arm_assignment', 'supply_dispensing', 'data_entry'].includes(value.duty))) fail('An actor-specific request requires an exact learner and delegated duty', 400);
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
    // Signature bindings share the snapshot of the completions and publications they sign (/2 only).
    const signatures=signed?await signatureBindings(client,{recordIds:records.rows.map(row=>row.id),draftIds:[...materials.values()].map(pub=>pub.draftId)}):[];
    return {obligations:new Map(obligations.rows.map(row=>[row.id,row])),courses:new Map(courses.rows.map(row=>[row.id,row])),records:new Map(records.rows.map(row=>[`${row.userId}:${row.courseId}`,row])),materials,signatures};
  }):{obligations:new Map<number,TrainingObligation>(),courses:new Map<number,TrainingCourse>(),records:new Map<string,TrainingRecord>(),materials:new Map<number,NonNullable<Awaited<ReturnType<typeof publishedMaterial>>>>(),signatures:[] as TrainingSignatureBinding[]};
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
      const signatures=signed?pinSignatures(local.signatures,record,course?.materialScope?local.materials.get(course.id)??null:null):undefined;
      const result={ ...pin, readiness:'source_changed',retainedScope,retainedScopeObservationHash:retainedAuthority?.observationHash??null, recordId: record?.id ?? null,
        certificateNumber: record?.certificateNumber ?? null, completedAt: dutyTimestamp(record?.completedAt),
        verifiedAt: dutyTimestamp(record?.verifiedAt), verifiedBy: record?.verifiedBy ?? null, ...(signatures?{signatures}:{}) };
      evaluateCompletions.push(cutoff=>{
        result.readiness=exact&&course?obligationReadiness(row,course,record,observation.eligible&&observation.roles.includes(assignment.role)&&retainedAuthority?.eligible&&retainedAuthority.roles.includes(assignment.role)?'current':'changed',cutoff):'source_changed';
        // The blocker names the learner and obligation only, never an arm.
        if(signatures&&result.readiness==='complete'&&(!signatures.attestation||!signatures.verification||course?.materialScope&&!signatures.materialApproval))result.readiness='signature_required';
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
  return { schemaVersion: signed ? 'training-duty-readiness/2' : 'training-duty-readiness/1', nonce: request.nonce, observedAt: new Date(cutoff).toISOString(),
    consistency: 'current-observations-not-atomic', ...evidence, evidenceHash: trainingDutyHash(evidence) };
}
