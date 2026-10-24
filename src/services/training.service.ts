import { getRoleByName, ROLES } from '@accura-trial/auth-core';
import { query, queryOne, transaction, TransactionClient } from '../config/database';
import { logger } from '../config/logger';
import { logAudit, trainingEvidenceHash } from './audit.service';
import { generateCertificateNumber, calculateExpirationDate } from './certificate.service';
import { getObligations } from './training-obligations.service';
import { authorizeTrainingTargets, readTrainingDirectory, revalidateTrainingDirectory, resolveObligationScope, resolveSignature, TrainingAuthorityContext } from './training-authority.service';
import {assertMaterialUse,materialCourseVisible} from './training-materials.service';
import {bindingFor,bindingStatus,bindSignatureReceipt,checkSignedDecision,readSignatureReceipt,recordDecisionSubject,signatureAuditDetails,signatureBindings,signatureContext} from './training-signatures.service';
import {recordEffortInterval} from './training-effort.service';
import {randomUUID} from 'node:crypto';
import {assessmentContentHash,assessmentReference,assessmentRequestHash,assertStartedContent,canonicalAnswers,gradeAssessment,sealAssessment,validateSubmission,verifyAssessmentRows,verifyRecordAssessment,AssessmentHistoryRow} from './training-assessment-evidence';
import {
  TrainingCourse,
  TrainingRecord,
  TrainingQuizQuestion,
  TrainingQuizAnswer,
  TrainingQuizResult,
  TrainingQuizSubmission,
  TrainingObligation,
  TrainingComplianceStatus,
  TrainingComplianceCheck,
  CreateCourseRequest,
  UpdateCourseRequest,
  CreateQuestionRequest,
  TrainingRecordSignatureDecision,
  TrainingSignatureContext,
  TrainingEffortInput,
} from '../types/training.types';

const database: TransactionClient = { query, queryOne };

async function recheckMaterialUse(initial: string | undefined, authority: TrainingAuthorityContext | undefined, client: TransactionClient, course: TrainingCourse, learner?: {userId:number;scope:import('../types/training.types').TrainingObligationScope}) {
  if (initial !== await assertMaterialUse(authority, client, course, learner)) {
    throw Object.assign(new Error('Training material or current authority changed during the request; retry'), {statusCode:409});
  }
}

function requireUserId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw Object.assign(new Error('An exact positive user ID is required'), { statusCode: 400 });
  }
}

/** Course configuration retains the legacy manager alias; token authority does not. */
function canonicalCourseRoles(value: unknown, statusCode: number): string[] {
  if (!Array.isArray(value) || value.some(role => typeof role !== 'string')) {
    throw Object.assign(new Error('Invalid required training role configuration'), { statusCode });
  }
  return value.map(name => {
    const role = name.trim().toLowerCase() === 'manager' ? ROLES.DATA_MANAGER : getRoleByName(name);
    if (role.id === ROLES.INVALID.id) {
      throw Object.assign(new Error('Unknown required training role configuration'), { statusCode });
    }
    return role.name;
  });
}


// ============================================================================
// Course Operations
// ============================================================================

export async function getCourses(options?: {
  activeOnly?: boolean;
  role?: string;
},authority?:TrainingAuthorityContext): Promise<TrainingCourse[]> {
  let sql = 'SELECT * FROM acc_training_courses WHERE 1=1';
  const params: unknown[] = [];

  if (options?.activeOnly !== false) {
    params.push(true);
    sql += ` AND active = $${params.length}`;
  }

  const role = options?.role !== undefined ? canonicalCourseRoles([options.role], 400)[0] : undefined;

  sql += ' ORDER BY course_code ASC';

  const { rows } = await query<TrainingCourse>(sql, params);
  const visible:TrainingCourse[]=[];for(const course of rows)if(await materialCourseVisible(authority,course))visible.push(course);
  return role === undefined ? visible : visible.filter(course => canonicalCourseRoles(course.requiredForRoles, 409).includes(role));
}

export async function getCourseById(
  courseId: number,
  includeQuestions: boolean = false,
  client: TransactionClient = database,
  authority?:TrainingAuthorityContext
): Promise<TrainingCourse | null> {
  const course = await client.queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1',
    [courseId]
  );

  if (!course) return null;
  if(course.materialScope)await assertMaterialUse(authority,client,course);

  if (includeQuestions) {
    const { rows: questions } = await client.query<TrainingQuizQuestion>(
      `SELECT id, course_id, question_text, question_type, options, explanation, order_index
       FROM acc_training_questions 
       WHERE course_id = $1 AND active = true 
       ORDER BY order_index ASC, id ASC`,
      [courseId]
    );

    // Strip isCorrect from options when returning to client
    course.questions = questions.map((q) => ({
      ...q,
      explanation: null,
      options: (q.options as unknown as Array<{ text: string; isCorrect?: boolean }>).map(
        (opt) => ({ text: opt.text })
      ),
    }));
  }

  return course;
}

export async function createCourse(
  dto: CreateCourseRequest,
  createdBy: number,
  client: TransactionClient = database
): Promise<TrainingCourse> {
  canonicalCourseRoles(dto.requiredForRoles, 400);
  const result = await client.queryOne<TrainingCourse>(
    `INSERT INTO acc_training_courses 
     (course_code, course_name, description, version, duration_minutes, 
      passing_score, required_for_roles, regulatory_reference, validity_period_days, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      dto.courseCode,
      dto.courseName,
      dto.description ?? null,
      dto.version,
      dto.durationMinutes ?? null,
      dto.passingScore,
      JSON.stringify(dto.requiredForRoles),
      dto.regulatoryReference ?? null,
      dto.validityPeriodDays ?? 365,
      createdBy,
    ]
  );

  if (!result) throw new Error('Failed to create course');
  return result;
}

export async function updateCourse(
  courseId: number,
  dto: UpdateCourseRequest,
  client: TransactionClient = database
): Promise<TrainingCourse | null> {
  if(dto.requiredForRoles!==undefined)canonicalCourseRoles(dto.requiredForRoles,400);
  const retained=await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 FOR UPDATE',[courseId]);
  if(!retained)return null;
  if(retained?.materialScope)throw Object.assign(new Error('Governed material changes require a new independently reviewed draft'),{statusCode:409});
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (dto.courseName !== undefined) {
    setClauses.push(`course_name = $${paramIdx++}`);
    params.push(dto.courseName);
  }
  if (dto.description !== undefined) {
    setClauses.push(`description = $${paramIdx++}`);
    params.push(dto.description);
  }
  if (dto.version !== undefined) {
    setClauses.push(`version = $${paramIdx++}`);
    params.push(dto.version);
  }
  if (dto.durationMinutes !== undefined) {
    setClauses.push(`duration_minutes = $${paramIdx++}`);
    params.push(dto.durationMinutes);
  }
  if (dto.passingScore !== undefined) {
    setClauses.push(`passing_score = $${paramIdx++}`);
    params.push(dto.passingScore);
  }
  if (dto.requiredForRoles !== undefined) {
    setClauses.push(`required_for_roles = $${paramIdx++}`);
    params.push(JSON.stringify(dto.requiredForRoles));
  }
  if (dto.regulatoryReference !== undefined) {
    setClauses.push(`regulatory_reference = $${paramIdx++}`);
    params.push(dto.regulatoryReference);
  }
  if (dto.active !== undefined) {
    setClauses.push(`active = $${paramIdx++}`);
    params.push(dto.active);
  }
  if (dto.validityPeriodDays !== undefined) {
    setClauses.push(`validity_period_days = $${paramIdx++}`);
    params.push(dto.validityPeriodDays);
  }

  if (setClauses.length === 0) return getCourseById(courseId, false, client);

  setClauses.push(`updated_at = NOW()`);
  params.push(courseId);

  const sql = `UPDATE acc_training_courses SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
  return client.queryOne<TrainingCourse>(sql, params);
}

export async function addQuestions(
  courseId: number,
  questions: CreateQuestionRequest[],
  client: TransactionClient = database
): Promise<TrainingQuizQuestion[]> {
  const retained=await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 FOR UPDATE',[courseId]);
  if(retained?.materialScope)throw Object.assign(new Error('Governed questions must be published from the reviewed material draft'),{statusCode:409});
  const results: TrainingQuizQuestion[] = [];

  for (const q of questions) {
    const row = await client.queryOne<TrainingQuizQuestion>(
      `INSERT INTO acc_training_questions 
       (course_id, question_text, question_type, options, explanation, order_index)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [courseId, q.questionText, q.questionType, JSON.stringify(q.options), q.explanation ?? null, q.orderIndex]
    );
    if (row) results.push(row);
  }

  return results;
}

// ============================================================================
// Training Record Operations
// ============================================================================

export async function getMyRecords(userId: number): Promise<TrainingRecord[]> {
  const { rows } = await query<TrainingRecord>(
    `SELECT r.*, c.course_name, c.course_code
     FROM acc_training_records r
     JOIN acc_training_courses c ON c.id = r.course_id
     WHERE r.user_id = $1
     ORDER BY r.updated_at DESC`,
    [userId]
  );
  return rows;
}

export async function getUserRecords(userId: number, authority: TrainingAuthorityContext): Promise<TrainingRecord[]> {
  requireUserId(userId);
  const admission = await authorizeTrainingTargets(authority, 'records:read', [userId]);
  if (!admission.decisions[0].allowed) throw Object.assign(new Error('Training user is outside your organization scope'), { statusCode: 403 });
  const records = await getMyRecords(userId);
  const current = await authorizeTrainingTargets(authority, 'records:read', [userId], { scopeFingerprint: admission.scopeFingerprint });
  if (!current.decisions[0].allowed) throw Object.assign(new Error('Training user is outside your organization scope'), { statusCode: 403 });
  return records;
}

export async function startTraining(userId: number, courseId: number, client?: TransactionClient, expectedRevision?: number,authority?:TrainingAuthorityContext): Promise<TrainingRecord> {
  if (!client) return transaction(tx => startTraining(userId, courseId, tx, expectedRevision,authority));
  requireUserId(userId);
  requireUserId(courseId);
  const course = await client.queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1 AND active = true FOR SHARE',
    [courseId]
  );

  if (!course) {
    throw Object.assign(new Error('Course not found or inactive'), { statusCode: 404 });
  }
  if(course.materialScope){if(authority?.actorUserId!==userId)throw Object.assign(new Error('Start governed training only for the authenticated learner'),{statusCode:403});
    await client.query("SELECT id FROM acc_training_obligations WHERE user_id=$1 AND course_id=$2 AND status='assigned' ORDER BY id FOR SHARE",[userId,courseId]);}
  const materialProof = await assertMaterialUse(authority,client,course);

  if (!Number.isSafeInteger(course.contentRevision) || Number(course.contentRevision) < 1) {
    throw Object.assign(new Error('Training content revision is unavailable'), { statusCode: 409 });
  }
  if (expectedRevision !== undefined && expectedRevision !== course.contentRevision) {
    throw Object.assign(new Error('Training content changed; reload it before starting'), { statusCode: 409 });
  }
  await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [userId, courseId]);

  const existing = await client.queryOne<TrainingRecord>(
    'SELECT * FROM acc_training_records WHERE user_id = $1 AND course_id = $2 FOR UPDATE',
    [userId, courseId]
  );

  const current = existing?.contentRevision === course.contentRevision && existing?.courseVersion === course.version;
  const expired = existing?.expirationDate != null && Date.parse(existing.expirationDate) <= Date.now();
  if (existing && existing.status === 'completed' && current && !expired) {
    throw Object.assign(new Error('Training already completed'), { statusCode: 409 });
  }

  if (existing?.status === 'in_progress' && current && existing.assessmentCycleId) {
    await verifyRecordAssessment(client,existing);
    await recheckMaterialUse(materialProof,authority,client,course);
    return existing;
  }
  const {rows: slides} = await client.query<SlideContent>(
    'SELECT * FROM acc_training_slides WHERE course_id = $1 ORDER BY order_index, id', [courseId]);
  const {rows: questions} = await client.query<TrainingQuizQuestion>(
    'SELECT * FROM acc_training_questions WHERE course_id = $1 AND active = true ORDER BY order_index, id', [courseId]);
  const {materialReady:_requestLocalMaterialReadiness,...snapshotCourse}=course;
  const snapshot = JSON.stringify({ course:snapshotCourse, slides, questions });
  const cycleId=randomUUID();
  const retainStart=async(record:TrainingRecord)=>client.query(`INSERT INTO acc_training_record_history
    (record_id,user_id,course_id,record_snapshot,event_kind,assessment_cycle_id)
    VALUES($1,$2,$3,$4::jsonb,'cycle_started',$5)`,[record.id,userId,courseId,JSON.stringify(record),cycleId]);

  if (existing) {
    await client.query(
      `INSERT INTO acc_training_record_history (record_id, user_id, course_id, record_snapshot)
       VALUES ($1, $2, $3, $4::jsonb)`, [existing.id, userId, courseId, JSON.stringify(existing)]);
    const updated = await client.queryOne<TrainingRecord>(
      `UPDATE acc_training_records 
       SET status = 'in_progress', started_at = NOW(), updated_at = NOW(),
           course_version = $2, content_revision = $3, content_snapshot = $4::jsonb,
           completed_at = NULL, score = NULL, attempts = 0, certificate_number = NULL,
           expiration_date = NULL, verified_by = NULL, verified_at = NULL, notes = NULL,
           assessment_cycle_id=$5,assessment_receipt=NULL
       WHERE id = $1 RETURNING *`,
      [existing.id, course.version, course.contentRevision, snapshot,cycleId]
    );
    if (!updated) throw new Error('Failed to update record');
    await retainStart(updated);
    await recheckMaterialUse(materialProof,authority,client,course);
    return updated;
  }

  const record = await client.queryOne<TrainingRecord>(
    `INSERT INTO acc_training_records (user_id, course_id, status, started_at, course_version, content_revision, content_snapshot,assessment_cycle_id)
     VALUES ($1, $2, 'in_progress', NOW(), $3, $4, $5::jsonb,$6)
     RETURNING *`,
    [userId, courseId, course.version, course.contentRevision, snapshot,cycleId]
  );

  if (!record) throw new Error('Failed to create training record');
  await retainStart(record);
  await recheckMaterialUse(materialProof,authority,client,course);
  return record;
}

export async function submitQuiz(
  userId:number, courseId:number, answers:TrainingQuizAnswer[], client?:TransactionClient,
  expectedRevision?:number, authority?:TrainingAuthorityContext, submission?:TrainingQuizSubmission,
  auditContext?:{ipAddress?:string;userAgent?:string}, effort?:TrainingEffortInput
):Promise<TrainingQuizResult> {
  if(!client)return transaction(tx=>submitQuiz(userId,courseId,answers,tx,expectedRevision,authority,submission,auditContext,effort));
  requireUserId(userId);requireUserId(courseId);validateSubmission(submission);
  // PostgreSQL UUID identity is case-insensitive; keep request meaning and
  // retained-key comparisons identical to its canonical representation.
  submission={recordId:submission.recordId,cycleId:submission.cycleId.toLowerCase(),requestId:submission.requestId.toLowerCase()};
  if(authority?.actorUserId!==userId)throw Object.assign(new Error('An authenticated learner must submit their own assessment'),{statusCode:403});
  if(!Number.isSafeInteger(expectedRevision)||Number(expectedRevision)<1)throw Object.assign(new Error('An exact content revision is required'),{statusCode:400});
  const admission=await authorizeTrainingTargets(authority,'records:read',[userId]);
  if(!admission.decisions[0]?.allowed)throw Object.assign(new Error('Training record is outside current access'),{statusCode:403});
  const finalAccess=async()=>{const current=await authorizeTrainingTargets(authority,'records:read',[userId],{scopeFingerprint:admission.scopeFingerprint});
    if(!current.decisions[0]?.allowed)throw Object.assign(new Error('Training access changed during the request'),{statusCode:403});};
  const requestHash=assessmentRequestHash(userId,courseId,expectedRevision!,submission,answers);
  // Keep the existing course -> obligations -> record lock order. An exact
  // historical retry needs present read authority, not obsolete course currency.
  const course=await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 FOR SHARE',[courseId]);
  const obligations=(await client.query<TrainingObligation>("SELECT * FROM acc_training_obligations WHERE user_id=$1 AND course_id=$2 AND status='assigned' ORDER BY id FOR SHARE",[userId,courseId])).rows;
  const record=await client.queryOne<TrainingRecord>('SELECT * FROM acc_training_records WHERE id=$1 AND user_id=$2 AND course_id=$3 FOR UPDATE',[submission.recordId,userId,courseId]);
  if(!record)throw Object.assign(new Error('Training record not found'),{statusCode:404});
  const history=(await client.query<AssessmentHistoryRow>(`SELECT * FROM acc_training_record_history WHERE record_id=$1 AND user_id=$2 AND assessment_cycle_id=$3 ORDER BY history_id`,[record.id,userId,submission.cycleId])).rows;
  const prior=history.find(row=>row.eventKind==='quiz_attempt'&&row.requestKey===submission.requestId);
  if(prior){verifyAssessmentRows(history,record.assessmentCycleId===submission.cycleId?record:undefined);
    if(prior.requestHash!==requestHash)throw Object.assign(new Error('This request key was already used with different assessment answers'),{statusCode:409});
    await finalAccess();return {...prior.assessment!.result,receipt:assessmentReference(prior.assessment!),replayed:true,evidenceStatus:'historical_assessment'};
  }
  if(!course?.active||record.status!=='in_progress'||record.assessmentCycleId!==submission.cycleId||expectedRevision!==course.contentRevision
    ||record.contentRevision!==course.contentRevision||record.courseVersion!==course.version)throw Object.assign(new Error('Start or restart the current training content before submitting this quiz'),{statusCode:409});
  verifyAssessmentRows(history,record);
  const materialProof=await assertMaterialUse(authority,client,course);
  const assignments:Array<{obligation:TrainingObligation;observation:Awaited<ReturnType<typeof resolveObligationScope>>}>=[];
  for(const obligation of obligations){const observation=await resolveObligationScope(authority,'obligations:read',userId,obligation.scope);
    if(!observation.eligible||!observation.roles.includes(obligation.role))throw Object.assign(new Error('Current learner assignment authority is unavailable'),{statusCode:409});
    assignments.push({obligation,observation});}
  const slides=(await client.query<SlideContent>('SELECT * FROM acc_training_slides WHERE course_id=$1 ORDER BY order_index,id',[courseId])).rows;
  const questions=(await client.query<TrainingQuizQuestion>('SELECT * FROM acc_training_questions WHERE course_id=$1 AND active=true ORDER BY order_index,id',[courseId])).rows;
  const snapshot=assertStartedContent(record,{course,slides,questions});
  const graded=gradeAssessment(snapshot,answers);
  const assessedAt=new Date().toISOString();
  const result:TrainingQuizResult={...graded.result,...(graded.result.passed?{
    certificateNumber:generateCertificateNumber(course.courseCode,userId),expirationDate:calculateExpirationDate(course.validityPeriodDays).toISOString()}: {})};
  const receipt=sealAssessment({schemaVersion:'training-assessment/1',id:randomUUID(),grader:'exact-option-set/1',actorUserId:userId,
    recordId:record.id,courseId,cycleId:submission.cycleId,attemptNumber:record.attempts+1,requestId:submission.requestId,requestHash,
    contentRevision:course.contentRevision!,courseVersion:course.version,contentHash:assessmentContentHash(snapshot),startedAt:new Date(record.startedAt!).toISOString(),assessedAt,
    answers:canonicalAnswers(answers),grades:graded.grades,result,materialProof:materialProof??null,assignments,authorityFingerprint:admission.scopeFingerprint});
  const updated=await client.queryOne<TrainingRecord>(`UPDATE acc_training_records SET status=$2,score=$3,attempts=attempts+1,
    completed_at=$4,certificate_number=$5,expiration_date=$6,assessment_receipt=$7::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`,
    [record.id,result.passed?'completed':'in_progress',result.score,result.passed?assessedAt:null,result.certificateNumber??null,result.expirationDate??null,JSON.stringify(assessmentReference(receipt))]);
  if(!updated)throw new Error('Assessment record update failed');
  await client.query(`INSERT INTO acc_training_record_history(record_id,user_id,course_id,record_snapshot,event_kind,assessment_cycle_id,request_key,request_hash,assessment)
    VALUES($1,$2,$3,$4::jsonb,'quiz_attempt',$5,$6,$7,$8::jsonb)`,[record.id,userId,courseId,JSON.stringify(updated),submission.cycleId,submission.requestId,requestHash,JSON.stringify(receipt)]);
  await logAudit({userId,action:result.passed?'quiz_passed':'quiz_failed',recordId:record.id,courseId,
    details:{contentRevision:expectedRevision,score:result.score,passed:result.passed,totalQuestions:result.totalQuestions,assessment:assessmentReference(receipt)},...auditContext},client);
  // T-4: the attempt's learning interval in this transaction (nothing unless TRAINING_EFFORT_LEDGER_ENABLED=true).
  // A replay returned above and records none.
  await recordEffortInterval(client,{kind:'learning',actorUserId:userId,learnerUserId:userId,recordId:record.id,courseId,assessmentCycleId:submission.cycleId,
    requestKey:submission.requestId,input:effort,endedAt:assessedAt,served:obligations,
    cycle:{startedAt:record.startedAt,previousAssessedAt:history.filter(row=>row.eventKind==='quiz_attempt').at(-1)?.assessment?.assessedAt??null}});
  await verifyRecordAssessment(client,updated);
  for(const assignment of assignments){const current=await resolveObligationScope(authority,'obligations:read',userId,assignment.obligation.scope,assignment.observation);
    if(!current.eligible||!current.roles.includes(assignment.obligation.role))throw Object.assign(new Error('Learner assignment changed during assessment'),{statusCode:409});}
  await recheckMaterialUse(materialProof,authority,client,course);await finalAccess();
  return {...result,receipt:assessmentReference(receipt),replayed:false,evidenceStatus:'recorded_assessment'};
}

/** Independent verification, written with its audit row. With an EDC signature receipt the same transaction also
 * binds the verifier's Part 11 signature over the exact completion; without one it is the existing unsigned update. */
export async function verifyTraining(
  recordId: number,
  authority: TrainingAuthorityContext,
  notes?: string,
  client: TransactionClient = database,
  options: { signatureReceipt?: unknown; auditContext?: { ipAddress?: string; userAgent?: string }; effort?: TrainingEffortInput } = {}
): Promise<{ verified: boolean; replayed?: boolean; signature?: { signatureId: number; subjectHash: string; signedAt: string } }> {
  if (!Number.isSafeInteger(recordId) || recordId < 1) {
    throw Object.assign(new Error('An exact positive training record ID is required'), { statusCode: 400 });
  }
  // A malformed receipt refuses the verification; it is never dropped into an unsigned one.
  const receipt = options.signatureReceipt === undefined ? undefined : readSignatureReceipt(options.signatureReceipt);
  const admission = await authorizeTrainingTargets(authority, 'records:verify', []);
  const owner = await client.queryOne<{ userId: number; courseId: number }>('SELECT user_id,course_id FROM acc_training_records WHERE id = $1', [recordId]);
  if (!owner) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
  const initialTarget = await authorizeTrainingTargets(authority, 'records:verify', [owner.userId], { scopeFingerprint: admission.scopeFingerprint });
  if (!initialTarget.decisions[0].allowed) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
  const course = await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 AND active=true FOR SHARE', [owner.courseId]);
  const record = await client.queryOne<TrainingRecord>(
    'SELECT r.* FROM acc_training_records r WHERE r.id = $1 AND r.user_id = $2 FOR UPDATE',
    [recordId, owner.userId]
  );

  if (!record) {
    throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
  }
  const materialProofs:Array<{scope:import('../types/training.types').TrainingObligationScope;role:string;proof:string|undefined}>=[];
  if(course?.materialScope){const obligations=(await client.query<any>("SELECT scope,role FROM acc_training_obligations WHERE user_id=$1 AND course_id=$2 AND status='assigned' ORDER BY id FOR SHARE",[record.userId,course.id])).rows;
    if(!obligations.length)throw Object.assign(new Error('Current governed training obligation required'),{statusCode:409});
    for(const obligation of obligations){const current=await resolveObligationScope(authority,'duties:read',record.userId,obligation.scope);
      if(!current.eligible||!current.roles.includes(obligation.role))throw Object.assign(new Error('Current governed learner role required'),{statusCode:409});
      materialProofs.push({...obligation,proof:await assertMaterialUse(authority,client,course,{userId:record.userId,scope:obligation.scope})});}}

  // Authorization is a remote observation while this record is locked. Only
  // the training update and its caller's audit share the local transaction.
  const target = await authorizeTrainingTargets(authority, 'records:verify', [record.userId], { scopeFingerprint: admission.scopeFingerprint });
  if (!target.decisions[0].allowed) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });

  await verifyRecordAssessment(client,record);
  if (record.status !== 'completed') {
    throw Object.assign(new Error('Can only verify completed training'), { statusCode: 400 });
  }

  if (record.userId === authority.actorUserId) {
    throw Object.assign(new Error('Cannot verify your own training'), { statusCode: 403 });
  }

  if (!course || record.courseVersion !== course.version || record.contentRevision !== course.contentRevision
    || record.expirationDate !== null && (!Number.isFinite(new Date(record.expirationDate).getTime()) || new Date(record.expirationDate).getTime() <= Date.now())) {
    throw Object.assign(new Error('Only current, unexpired course completion can be verified'), {statusCode:409});
  }
  if (record.verifiedAt || record.verifiedBy) {
    // An uncertain signed verification is reconciled by repeating the same receipt; it replays, never re-verifies.
    const prior = receipt && record.verifiedBy === authority.actorUserId ? bindingFor(await signatureBindings(client, { recordIds: [record.id], draftIds: [] }),
      'verification', { recordId: record.id, assessmentCycleId: record.assessmentCycleId }) : undefined;
    if (receipt && prior && prior.signatureId === receipt.signatureId && prior.subjectHash === receipt.subjectHash) {
      return { verified: true, replayed: true, signature: { signatureId: prior.signatureId, subjectHash: prior.subjectHash, signedAt: prior.signedAt } };
    }
    throw Object.assign(new Error('This completion has already been verified; its evidence cannot be overwritten'), {statusCode:409});
  }
  const signed = receipt ? await recordSignatureSubject(client, 'verification', record, course, receipt.context) : undefined;
  if (receipt && signed) checkSignedDecision(receipt, 'verification', authority.actorUserId, signed.subjectHash);

  await client.query(
    `UPDATE acc_training_records 
     SET verified_by = $1, verified_at = NOW(), notes = $2, updated_at = NOW()
     WHERE id = $3`,
    [authority.actorUserId, notes ?? null, recordId]
  );
  const bound = receipt && signed ? await bindSignatureReceipt(client, receipt, await resolveSignature(authority, receipt, signed.subject),
    { decision: 'verification', ...signed, signerUserId: authority.actorUserId, recordId: record.id, assessmentCycleId: signed.subject.assessmentCycleId }) : undefined;

  const finalTarget=await authorizeTrainingTargets(authority,'records:verify',[record.userId],{scopeFingerprint:admission.scopeFingerprint});
  if(!finalTarget.decisions[0].allowed)throw Object.assign(new Error('Training verification authority changed'),{statusCode:409});
  for(const proof of materialProofs){const current=await resolveObligationScope(authority,'duties:read',record.userId,proof.scope);
    if(!current.eligible||!current.roles.includes(proof.role))throw Object.assign(new Error('Current governed learner role changed'),{statusCode:409});
    await recheckMaterialUse(proof.proof,authority,client,course!,{userId:record.userId,scope:proof.scope});}
  if(record.expirationDate!==null&&Date.parse(record.expirationDate)<=Date.now())throw Object.assign(new Error('Completion expired during verification'),{statusCode:409});

  // The audit names the exact completion verified; a restart reuses the record ID with a new cycle.
  await logAudit({ userId: authority.actorUserId, action: 'training_verified', recordId, courseId: record.courseId,
    details: { notes, courseId: record.courseId, courseVersion: record.courseVersion ?? null, contentRevision: record.contentRevision ?? null,
      assessmentCycleId: record.assessmentCycleId ?? null }, ...options.auditContext }, client);
  if (bound && !bound.replayed) await logAudit({ userId: authority.actorUserId, action: 'training_signature_bound', recordId, courseId: record.courseId,
    details: signatureAuditDetails(bound.binding), ...options.auditContext }, client);
  // T-4: the verifier's interval in this transaction (nothing unless TRAINING_EFFORT_LEDGER_ENABLED=true): signed, it
  // ends at the EDC signature and takes the receipt's effort; unsigned, it ends now and takes the stated start.
  if (!bound?.replayed) await recordEffortInterval(client, { kind: 'verification', actorUserId: authority.actorUserId, learnerUserId: record.userId,
    recordId: record.id, courseId: record.courseId, assessmentCycleId: record.assessmentCycleId ?? null, receipt, input: options.effort });
  if (!bound) return { verified: true };
  return { verified: true, replayed: bound.replayed, signature: { signatureId: bound.binding.signatureId, subjectHash: bound.binding.subjectHash, signedAt: bound.binding.signedAt } };
}

// ============================================================================
// Part 11 Signatures (training-signature-subject/1)
// ============================================================================

function requireRecordId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw Object.assign(new Error('An exact positive training record ID is required'), { statusCode: 400 });
}

/** A current, unexpired completion with its verified retained assessment, signed in the study or site of one of
 * the learner's assigned obligations for the course (the arm is not part of the context). The caller has run
 * verifyRecordAssessment on the record it holds. */
async function recordSignatureSubject(client: TransactionClient, kind: TrainingRecordSignatureDecision, record: TrainingRecord,
  course: TrainingCourse | null, context: TrainingSignatureContext) {
  const expiration = record.expirationDate === null ? null : new Date(record.expirationDate).getTime();
  if (record.status !== 'completed' || !record.assessmentEvidenceVerified || !course?.active || record.courseVersion !== course.version
    || record.contentRevision !== course.contentRevision || expiration !== null && (!Number.isFinite(expiration) || expiration <= Date.now())) {
    throw Object.assign(new Error('Only a current, unexpired completion with its retained assessment can be signed'), { statusCode: 409 });
  }
  const assigned = (await client.query<TrainingObligation>("SELECT * FROM acc_training_obligations WHERE user_id=$1 AND course_id=$2 AND status='assigned' ORDER BY id",
    [record.userId, record.courseId])).rows;
  if (!assigned.some(row => row.scope.studyId === context.studyId && row.scope.siteId === context.siteId)) {
    throw Object.assign(new Error('Sign in the study or site of an assigned obligation for this course'), { statusCode: 409 });
  }
  const subject = recordDecisionSubject(kind, record, context);
  return { subject, subjectHash: trainingEvidenceHash(subject) };
}

/** The subject the EDC asks this person to sign for a completion, and whether it is already bound. A learner reads
 * their own attestation; a verifier reads an unverified completion, or one they verified themselves. */
export async function readRecordSignatureSubject(authority: TrainingAuthorityContext,
  input: { kind: TrainingRecordSignatureDecision; recordId: number; context: unknown }) {
  requireRecordId(input.recordId);
  const context = signatureContext(input.context), learner = input.kind === 'completion-attestation';
  const action = learner ? 'records:read' : 'records:verify';
  const admission = await authorizeTrainingTargets(authority, action, learner ? [authority.actorUserId] : []);
  if (learner && !admission.decisions[0]?.allowed) throw Object.assign(new Error('Training record is outside current access'), { statusCode: 403 });
  const owner = await queryOne<{ userId: number; courseId: number }>('SELECT user_id,course_id FROM acc_training_records WHERE id=$1', [input.recordId]);
  if (!owner || learner && owner.userId !== authority.actorUserId) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
  const targets = learner ? [authority.actorUserId] : [owner.userId];
  if (!learner) {
    const target = await authorizeTrainingTargets(authority, action, targets, { scopeFingerprint: admission.scopeFingerprint });
    if (!target.decisions[0]?.allowed) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
    if (owner.userId === authority.actorUserId) throw Object.assign(new Error('Cannot verify your own training'), { statusCode: 403 });
  }
  const read = await transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const course = await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1', [owner.courseId]);
    const record = await client.queryOne<TrainingRecord>('SELECT * FROM acc_training_records WHERE id=$1 AND user_id=$2', [input.recordId, owner.userId]);
    if (!record) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
    if (!learner && record.verifiedBy !== null && record.verifiedBy !== authority.actorUserId) {
      throw Object.assign(new Error('This completion was verified by another person'), { statusCode: 409 });
    }
    await verifyRecordAssessment(client, record);
    const signed = await recordSignatureSubject(client, input.kind, record, course, context);
    const binding = bindingFor(await signatureBindings(client, { recordIds: [record.id], draftIds: [] }), input.kind,
      { recordId: record.id, assessmentCycleId: record.assessmentCycleId });
    return { ...signed, binding: bindingStatus(binding) };
  });
  const current = await authorizeTrainingTargets(authority, action, targets, { scopeFingerprint: admission.scopeFingerprint });
  if (!current.decisions[0]?.allowed) throw Object.assign(new Error('Training access changed during the request'), { statusCode: 409 });
  return read;
}

/** The learner's Part 11 completion attestation (POST /attest/:recordId, receipt required). It changes no record
 * field: the decision is the append-only binding and its audit row. */
export async function attestTraining(recordId: number, authority: TrainingAuthorityContext, value: unknown,
  auditContext: { ipAddress?: string; userAgent?: string } = {}, effort?: TrainingEffortInput) {
  requireRecordId(recordId);
  const receipt = readSignatureReceipt(value);
  const admission = await authorizeTrainingTargets(authority, 'records:read', [authority.actorUserId]);
  if (!admission.decisions[0]?.allowed) throw Object.assign(new Error('Training record is outside current access'), { statusCode: 403 });
  return transaction(async client => {
    const owner = await client.queryOne<{ courseId: number }>('SELECT course_id FROM acc_training_records WHERE id=$1 AND user_id=$2', [recordId, authority.actorUserId]);
    if (!owner) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
    // The existing course -> record lock order of verification.
    const course = await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 FOR SHARE', [owner.courseId]);
    const record = await client.queryOne<TrainingRecord>('SELECT * FROM acc_training_records WHERE id=$1 AND user_id=$2 FOR UPDATE', [recordId, authority.actorUserId]);
    if (!record) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
    await verifyRecordAssessment(client, record);
    const signed = await recordSignatureSubject(client, 'completion-attestation', record, course, receipt.context);
    checkSignedDecision(receipt, 'completion-attestation', record.userId, signed.subjectHash);
    const bound = await bindSignatureReceipt(client, receipt, await resolveSignature(authority, receipt, signed.subject),
      { decision: 'completion-attestation', ...signed, signerUserId: record.userId, recordId: record.id, assessmentCycleId: signed.subject.assessmentCycleId });
    if (!bound.replayed) await logAudit({ userId: authority.actorUserId, action: 'training_completion_attested', recordId: record.id, courseId: record.courseId,
      details: { ...signatureAuditDetails(bound.binding), courseVersion: record.courseVersion, contentRevision: record.contentRevision, assessmentCycleId: record.assessmentCycleId },
      ...auditContext }, client);
    // T-4: the learner's attestation interval, ending at the EDC signature with the receipt's effort (nothing unless
    // TRAINING_EFFORT_LEDGER_ENABLED=true); the same receipt again replays and records none.
    if (!bound.replayed) await recordEffortInterval(client, { kind: 'attestation', actorUserId: record.userId, learnerUserId: record.userId, recordId: record.id,
      courseId: record.courseId, assessmentCycleId: record.assessmentCycleId ?? null, receipt, input: effort });
    const current = await authorizeTrainingTargets(authority, 'records:read', [authority.actorUserId], { scopeFingerprint: admission.scopeFingerprint });
    if (!current.decisions[0]?.allowed) throw Object.assign(new Error('Training access changed during the request'), { statusCode: 409 });
    return { attested: true, replayed: bound.replayed, signature: { signatureId: bound.binding.signatureId, subjectHash: bound.binding.subjectHash, signedAt: bound.binding.signedAt } };
  });
}

/** The recorded verifier signs a verification already made (POST /verify/:recordId/signature, receipt required).
 * Binding only: verified_by and verified_at are never rewritten, so a scope can adopt training-duty-policy/2
 * without its learners retraining. */
export async function signTrainingVerification(recordId: number, authority: TrainingAuthorityContext, value: unknown,
  auditContext: { ipAddress?: string; userAgent?: string } = {}) {
  requireRecordId(recordId);
  const receipt = readSignatureReceipt(value);
  const admission = await authorizeTrainingTargets(authority, 'records:verify', []);
  return transaction(async client => {
    const owner = await client.queryOne<{ userId: number; courseId: number }>('SELECT user_id,course_id FROM acc_training_records WHERE id = $1', [recordId]);
    if (!owner) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
    const target = await authorizeTrainingTargets(authority, 'records:verify', [owner.userId], { scopeFingerprint: admission.scopeFingerprint });
    if (!target.decisions[0].allowed) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
    const course = await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 FOR SHARE', [owner.courseId]);
    const record = await client.queryOne<TrainingRecord>('SELECT r.* FROM acc_training_records r WHERE r.id = $1 AND r.user_id = $2 FOR UPDATE', [recordId, owner.userId]);
    if (!record) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
    if (record.userId === authority.actorUserId) throw Object.assign(new Error('Cannot verify your own training'), { statusCode: 403 });
    if (record.verifiedBy !== authority.actorUserId || !record.verifiedAt) {
      throw Object.assign(new Error('Only the person who recorded this verification can sign it'), { statusCode: 409 });
    }
    await verifyRecordAssessment(client, record);
    const signed = await recordSignatureSubject(client, 'verification', record, course, receipt.context);
    checkSignedDecision(receipt, 'verification', authority.actorUserId, signed.subjectHash);
    const bound = await bindSignatureReceipt(client, receipt, await resolveSignature(authority, receipt, signed.subject),
      { decision: 'verification', ...signed, signerUserId: authority.actorUserId, recordId: record.id, assessmentCycleId: signed.subject.assessmentCycleId });
    if (!bound.replayed) await logAudit({ userId: authority.actorUserId, action: 'training_signature_bound', recordId: record.id, courseId: record.courseId,
      details: signatureAuditDetails(bound.binding), ...auditContext }, client);
    const current = await authorizeTrainingTargets(authority, 'records:verify', [record.userId], { scopeFingerprint: admission.scopeFingerprint });
    if (!current.decisions[0].allowed) throw Object.assign(new Error('Training verification authority changed'), { statusCode: 409 });
    return { signed: true, replayed: bound.replayed, signature: { signatureId: bound.binding.signatureId, subjectHash: bound.binding.subjectHash, signedAt: bound.binding.signedAt } };
  });
}

// ============================================================================
// Compliance Operations
// ============================================================================

export async function getComplianceStatus(authority: TrainingAuthorityContext, options?: {
  userId?: number;
  studyId?: number;
}): Promise<TrainingComplianceStatus[]> {
  for (const [field, value] of Object.entries(options ?? {})) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw Object.assign(new Error(`An exact positive ${field} is required`), { statusCode: 400 });
    }
  }
  const directory = await readTrainingDirectory(authority, options);
  const users = directory.users;

  const { rows: activeCourses } = users.length
    ? await query<TrainingCourse>('SELECT * FROM acc_training_courses WHERE active = true')
    : { rows: [] };
  // Validate every active course before assigning requirements, so corrupt or
  // unknown configuration cannot disappear and manufacture complete compliance.
  const rolesByCourse = new Map(activeCourses.map(course => [course.id, canonicalCourseRoles(course.requiredForRoles, 409)]));
  const statuses: TrainingComplianceStatus[] = [];
  const now = Date.now();
  for (const user of users) {
    // Native account/membership and primary-role resolution remain with EDC.
    const role = getRoleByName(user.role);
    if (role.id === ROLES.INVALID.id) {
      throw Object.assign(new Error('Unknown native platform role for training compliance'), { statusCode: 409 });
    }
    const requiredCourses = activeCourses.filter(course => rolesByCourse.get(course.id)!.includes(role.name));
    const records=await transaction(async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const {rows}=await client.query<TrainingRecord>('SELECT * FROM acc_training_records WHERE user_id = $1 AND course_id = ANY($2::integer[])',
        [user.userId,requiredCourses.map(course=>course.id)]);
      for(const record of rows)await verifyRecordAssessment(client,record);return rows;
    });
    const byCourse = new Map<number, TrainingRecord>();
    for (const record of records) {
      if (!requiredCourses.some(course => course.id === record.courseId)) continue;
      if (byCourse.has(record.courseId)) {
        throw Object.assign(new Error('Ambiguous training records for required course'), { statusCode: 409 });
      }
      byCourse.set(record.courseId, record);
    }
    const completedIds = new Set<number>(), expiredIds = new Set<number>();
    for (const course of requiredCourses) {
      const record = byCourse.get(course.id);
      if (!record) continue;
      // An old, unbound or changed-content completion cannot satisfy today's requirement.
      if (!Number.isSafeInteger(course.contentRevision) || Number(course.contentRevision) < 1
          || record.contentRevision !== course.contentRevision || record.courseVersion !== course.version) continue;
      const expiration = record.expirationDate ? new Date(record.expirationDate).getTime() : null;
      if (expiration !== null && !Number.isFinite(expiration)) {
        throw Object.assign(new Error('Invalid training expiration date'), { statusCode: 409 });
      }
      if (record.status === 'expired' || (expiration !== null && expiration <= now)) expiredIds.add(course.id);
      else if (record.status === 'completed') completedIds.add(course.id);
    }
    const missingCourses = requiredCourses.filter(course => !completedIds.has(course.id)).map(course => ({
      courseCode: course.courseCode, courseName: course.courseName,
      requiredBy: course.regulatoryReference ?? 'Organization Policy',
    }));
    const totalRequired = requiredCourses.length, completed = completedIds.size, expired = expiredIds.size;
    const obligations = (await getObligations(authority, user.userId)).filter(row => row.status === 'assigned'
      && (options?.studyId === undefined || row.scope.studyId === options.studyId || row.scope.siteId === options.studyId));
    const completedObligations = obligations.filter(row => row.readiness === 'complete').length;
    const allRequired = totalRequired + obligations.length;
    statuses.push({
      userId: user.userId, username: user.username, userFullName: `${user.firstName} ${user.lastName}`.trim(),
      role: role.name, totalRequired, completed, expired, pending: totalRequired - completed - expired,
      compliancePercentage: allRequired ? Math.round((completed + completedObligations) / allRequired * 100) : 100,
      isCompliant: completed === totalRequired && completedObligations === obligations.length, missingCourses,
      totalObligations: obligations.length, completedObligations, overdueObligations: obligations.filter(row => row.overdue).length,
    });
  }

  await revalidateTrainingDirectory(authority, directory);
  return statuses;
}

export async function getExpiringTraining(authority: TrainingAuthorityContext, daysAhead: number = 30): Promise<TrainingRecord[]> {
  if (!Number.isSafeInteger(daysAhead) || daysAhead < 1) {
    throw Object.assign(new Error('An exact positive number of days is required'), { statusCode: 400 });
  }
  const admission = await authorizeTrainingTargets(authority, 'records:expiring', []);
  return transaction(async client => {
    // Local rows share one snapshot even if expiry/status changes while remote
    // authorization is checked between pages. EDC observations are still remote.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const bounds = await client.queryOne<{ referenceTime: string; upperRecordId: number }>(
      'SELECT CURRENT_TIMESTAMP::text AS reference_time, COALESCE(MAX(id), 0) AS upper_record_id FROM acc_training_records');
    if (!bounds || typeof bounds.referenceTime !== 'string' || !Number.isFinite(Date.parse(bounds.referenceTime))
      || !Number.isSafeInteger(bounds.upperRecordId) || bounds.upperRecordId < 0) {
      throw Object.assign(new Error('Training expiry bounds are unavailable'), { statusCode: 503 });
    }
    const visible: TrainingRecord[] = [];
    const permitted = new Set<number>();
    let afterExpiration: string | null = null;
    let afterId = 0;
    while (true) {
      const page: { rows: Array<TrainingRecord & { authorityCursorExpiration: string }> } = await client.query<TrainingRecord & { authorityCursorExpiration: string }>(
        `SELECT r.*, c.course_name, c.course_code, r.expiration_date::text AS authority_cursor_expiration
         FROM acc_training_records r JOIN acc_training_courses c ON c.id = r.course_id
         WHERE r.status = 'completed' AND r.id <= $3
           AND r.expiration_date <= $2::timestamptz + INTERVAL '1 day' * $1
           AND r.expiration_date > $2::timestamptz
           AND ($4::timestamptz IS NULL OR (r.expiration_date, r.id) > ($4::timestamptz, $5::integer))
         ORDER BY r.expiration_date, r.id LIMIT 200`,
        [daysAhead, bounds.referenceTime, bounds.upperRecordId, afterExpiration, afterId]);
      const rows: Array<TrainingRecord & { authorityCursorExpiration: string }> = page.rows;
      if (rows.length > 200 || rows.some(row => !Number.isSafeInteger(row.id) || row.id < 1 || row.id > bounds.upperRecordId
        || typeof row.authorityCursorExpiration !== 'string' || !Number.isFinite(Date.parse(row.authorityCursorExpiration)))) {
        throw Object.assign(new Error('Training expiry page is invalid'), { statusCode: 503 });
      }
      const checked = await authorizeTrainingTargets(authority, 'records:expiring', [...new Set(rows.map(row => row.userId))], { scopeFingerprint: admission.scopeFingerprint });
      const pageAllowed = new Set(checked.decisions.filter(decision => decision.allowed).map(decision => decision.userId));
      for (const row of rows) if (pageAllowed.has(row.userId)) {
        const { authorityCursorExpiration: _cursor, ...record } = row;
        visible.push(record); permitted.add(row.userId);
      }
      if (rows.length < 200) break;
      const last: TrainingRecord & { authorityCursorExpiration: string } = rows[rows.length - 1];
      if (last.authorityCursorExpiration === afterExpiration && last.id === afterId) {
        throw Object.assign(new Error('Training expiry page did not advance'), { statusCode: 503 });
      }
      // Keep PostgreSQL's timestamp text: JavaScript Date would lose microseconds.
      afterExpiration = last.authorityCursorExpiration; afterId = last.id;
    }
    const current = await authorizeTrainingTargets(authority, 'records:expiring', [...permitted], { scopeFingerprint: admission.scopeFingerprint });
    if (current.decisions.some(decision => !decision.allowed)) {
      throw Object.assign(new Error('Training authority changed during the request; retry the report'), { statusCode: 409 });
    }
    return visible;
  });
}

export async function checkUserCompliance(userId: number, authority: TrainingAuthorityContext): Promise<TrainingComplianceCheck> {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw Object.assign(new Error('An exact positive user ID is required'), { statusCode: 400 });
  }
  const statuses = await getComplianceStatus(authority, { userId });
  const status = statuses[0];

  if (!status) {
    throw Object.assign(new Error('User not found for training compliance'), { statusCode: 404 });
  }
  if (statuses.length !== 1 || status.userId !== userId) {
    throw Object.assign(new Error('Training compliance user identity is ambiguous'), { statusCode: 409 });
  }

  return {
    userId,
    isCompliant: status.isCompliant,
    missingCount: status.missingCourses.length + (status.totalObligations ?? 0) - (status.completedObligations ?? 0),
    expiredCount: status.expired,
  };
}

export async function expireOverdueRecords(): Promise<number> {
  const count = await transaction(async (client) => {
    const result = await client.query<{ id: number; userId: number; courseId: number; expirationDate: string }>(
      `UPDATE acc_training_records
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'completed'
         AND expiration_date IS NOT NULL
         AND expiration_date < NOW()
       RETURNING id, user_id, course_id, expiration_date`
    );
    for (const record of result.rows) {
      await logAudit({ userId: null, action: 'training_expired', recordId: record.id, courseId: record.courseId,
        details: { actor: 'scheduled-expiration', affectedUserId: record.userId, expirationDate: record.expirationDate,
          previousStatus: 'completed', status: 'expired' } }, client);
    }
    return result.rows.length;
  });
  if (count > 0) {
    logger.info(`Expired ${count} overdue training records`);
  }
  return count;
}

// ============================================================================
// Course Content (Slides) Operations
// ============================================================================

export interface SlideContent {
  id: number;
  courseId: number;
  title: string;
  content: string;
  slideType: string;
  orderIndex: number;
  mediaUrl: string | null;
  interactiveConfig: Record<string, unknown> | null;
}

export interface CourseContentResponse {
  course: TrainingCourse;
  slides: SlideContent[];
  questions: TrainingQuizQuestion[];
}

export async function getCourseContent(courseId: number, client?: TransactionClient,authority?:TrainingAuthorityContext): Promise<CourseContentResponse | null> {
  if (!client) return transaction(tx => getCourseContent(courseId, tx,authority));
  const course = await client.queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1 AND active = true FOR SHARE',
    [courseId]
  );

  if (!course) return null;
  await assertMaterialUse(authority,client,course);

  const { rows: slides } = await client.query<SlideContent>(
    `SELECT id, course_id, title, content, slide_type, order_index, media_url, interactive_config
     FROM acc_training_slides
     WHERE course_id = $1
     ORDER BY order_index ASC, id ASC`,
    [courseId]
  );

  const { rows: questions } = await client.query<TrainingQuizQuestion>(
    `SELECT id, course_id, question_text, question_type, options, explanation, order_index
     FROM acc_training_questions
     WHERE course_id = $1 AND active = true
     ORDER BY order_index ASC, id ASC`,
    [courseId]
  );

  // Strip isCorrect from options for client delivery
  const safeQuestions = questions.map((q) => ({
    ...q,
    explanation: null,
    options: (q.options as unknown as Array<{ text: string; isCorrect?: boolean }>).map(
      (opt) => ({ text: opt.text })
    ),
  }));

  return { course, slides, questions: safeQuestions };
}

/** Historical evidence is separate from the current user/course attempt. */
export async function getMyRecordHistory(userId: number): Promise<Array<{historyId: number; archivedAt: string; eventKind:string; record: TrainingRecord}>> {
  requireUserId(userId);
  const {rows} = await query<{historyId: number; archivedAt: string; eventKind:string; record: TrainingRecord}>(
    'SELECT history_id, archived_at,event_kind, record_snapshot AS record FROM acc_training_record_history WHERE user_id = $1 ORDER BY archived_at DESC, history_id DESC', [userId]);
  return rows;
}
