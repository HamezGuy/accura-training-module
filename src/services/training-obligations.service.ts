import { getRoleByName, ROLES } from '@accura-trial/auth-core';
import { query, queryOne, transaction, TransactionClient } from '../config/database';
import { logAudit } from './audit.service';
import { authorizeTrainingTargets, resolveObligationScope, TrainingAuthorityContext } from './training-authority.service';
import { TrainingCourse, TrainingObligation, TrainingObligationRequest, TrainingObligationScope, TrainingObligationView, TrainingRecord } from '../types/training.types';

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
    return await transaction(async client => {
      const course = await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 AND active=true FOR SHARE', [request.courseId]);
      if (!course || course.contentRevision !== request.contentRevision) fail('Select the current active course revision before assigning training');
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
    });
  } catch (error) {
    if ((error as {code?: string}).code === '23505') fail('An active obligation already exists for this learner, course, role and scope; refresh and revise it');
    throw error;
  }
}

export async function withdrawObligation(authority: TrainingAuthorityContext, obligationId: number, expectedRevision: number, explanation: string) {
  if (!id(obligationId) || !id(expectedRevision)) fail('An exact obligation and expected revision are required', 400);
  reason(explanation);
  return transaction(async client => {
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
  });
}

export function obligationReadiness(obligation: TrainingObligation, course: TrainingCourse, record: TrainingRecord | null,
  scope: 'current' | 'changed' | 'unavailable', now = Date.now()): TrainingObligationView['readiness'] {
  if (obligation.status === 'withdrawn') return 'withdrawn';
  if (scope !== 'current') return scope === 'changed' ? 'scope_changed' : 'scope_unavailable';
  if (!course.active) return 'course_inactive';
  if (course.version !== obligation.courseVersion || course.contentRevision !== obligation.contentRevision) return 'retraining_required';
  if (!record) return 'pending';
  if (record.courseVersion !== obligation.courseVersion || record.contentRevision !== obligation.contentRevision || record.status === 'expired'
    || record.expirationDate !== null && (!Number.isFinite(new Date(record.expirationDate).getTime()) || new Date(record.expirationDate).getTime() <= now)) return 'retraining_required';
  if (record.status !== 'completed') return record.status === 'in_progress' ? 'in_progress' : 'pending';
  if (!record.completedAt || !Number.isFinite(new Date(record.completedAt).getTime()) || !record.certificateNumber) return 'pending';
  if (!record.verifiedAt || !record.verifiedBy || record.verifiedBy === obligation.userId || !Number.isFinite(new Date(record.verifiedAt).getTime())
    || new Date(record.verifiedAt).getTime() < new Date(record.completedAt).getTime()) return 'awaiting_verification';
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
    const record = await queryOne<TrainingRecord>('SELECT * FROM acc_training_records WHERE user_id=$1 AND course_id=$2', [userId, row.courseId]);
    let scope: 'current' | 'changed' | 'unavailable' = 'current';
    if (row.status !== 'withdrawn') {
      try {
        const observed = await resolveObligationScope(authority, 'obligations:read', userId, canonicalScope(row.scope));
        if (!observed.eligible || !observed.roles.includes(row.role)) scope = 'changed';
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
  const records = await query(`SELECT id,user_id,course_id,course_version,content_revision,status,started_at,completed_at,
    score,attempts,certificate_number,expiration_date,verified_by,verified_at,notes FROM acc_training_records WHERE user_id=$1 ORDER BY id`, [userId]);
  const history = await query(`SELECT history_id,archived_at,record_snapshot - 'contentSnapshot' AS record
    FROM acc_training_record_history WHERE user_id=$1 ORDER BY history_id`, [userId]);
  const audit = await query(`SELECT id,user_id,action,record_id,course_id,details,created_at FROM acc_training_audit_log
    WHERE (user_id=$1 AND action IN('training_started','quiz_submitted','quiz_passed','quiz_failed'))
      OR record_id IN(SELECT id FROM acc_training_records WHERE user_id=$1)
      OR (action IN('obligation_assigned','obligation_revised','obligation_withdrawn') AND details->>'learnerId'=$1::text)
      OR (action='training_expired' AND details->>'affectedUserId'=$1::text) ORDER BY id`, [userId]);
  const checked = await authorizeTrainingTargets(authority, 'records:read', [userId], {scopeFingerprint: admitted.scopeFingerprint});
  if (!checked.decisions[0]?.allowed) fail('The learner is outside your current scope', 403);
  return {schemaVersion: 'training-obligation-history/1', learnerId: userId, exportedAt: new Date().toISOString(), events: rows, records: records.rows, history: history.rows, audit: audit.rows};
}
