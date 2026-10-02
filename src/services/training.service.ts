import { ADMIN_USER_TYPE_IDS, getRoleByName, getHighestRole, ROLES } from '@accura-trial/auth-core';
import { query, queryOne, transaction, TransactionClient } from '../config/database';
import { logger } from '../config/logger';
import { logAudit } from './audit.service';
import { generateCertificateNumber, calculateExpirationDate } from './certificate.service';
import {
  TrainingCourse,
  TrainingRecord,
  TrainingQuizQuestion,
  TrainingQuizAnswer,
  TrainingQuizResult,
  TrainingComplianceStatus,
  TrainingComplianceCheck,
  CreateCourseRequest,
  UpdateCourseRequest,
  CreateQuestionRequest,
} from '../types/training.types';

const database: TransactionClient = { query, queryOne };

function requireUserId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw Object.assign(new Error('An exact positive user ID is required'), { statusCode: 400 });
  }
}

interface TrainingReadScope { callerUserId: number; organizationIds: number[] | null }

// Native API constants/roles.ts isAdminIdentity contract. Generic auth-core
// aliases include additional study-role names and must not widen this exception.
const NATIVE_PLATFORM_ADMIN_IDENTITIES = new Set([
  'admin', 'sysadmin', 'tech-admin', 'tech_admin',
  'system_administrator', 'technical administrator', 'system administrator',
]);

// Match the native audit/user-reader exception: only an authoritative platform
// administrator with a successful empty membership lookup has global scope.
// A study-derived admin role, token claims, and lookup failures cannot grant it.
async function trainingReadScope(callerUserId: number, client: TransactionClient = database): Promise<TrainingReadScope> {
  requireUserId(callerUserId);
  try {
    const identity = await client.queryOne<{ userId: number; statusId: number; userTypeId: number | null; platformRole: string | null }>(
      `SELECT ua.user_id, ua.status_id, ua.user_type_id, extended.platform_role
       FROM user_account ua LEFT JOIN user_account_extended extended ON extended.user_id = ua.user_id
       WHERE ua.user_id = $1`, [callerUserId]
    );
    if (!identity || identity.userId !== callerUserId || identity.statusId !== 1) {
      throw Object.assign(new Error('Training oversight identity is unavailable'), { statusCode: 403 });
    }
    const { rows } = await client.query<{ organizationId: number }>(
      `SELECT DISTINCT organization_id FROM acc_organization_member
       WHERE user_id = $1 AND status = 'active'`, [callerUserId]
    );
    if (rows.some(row => !Number.isSafeInteger(row.organizationId) || row.organizationId < 1)) {
      throw new Error('Invalid organization membership');
    }
    const organizationIds = rows.map(row => row.organizationId);
    const platformAdmin = ADMIN_USER_TYPE_IDS.includes(identity.userTypeId as number)
      || (typeof identity.platformRole === 'string' && NATIVE_PLATFORM_ADMIN_IDENTITIES.has(identity.platformRole.toLowerCase().trim()));
    return { callerUserId, organizationIds: platformAdmin && organizationIds.length === 0 ? null : organizationIds };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 403) throw error;
    throw Object.assign(new Error('Training organization scope could not be verified'), { statusCode: 503, cause: error });
  }
}

function trainingScopePredicate(scope: TrainingReadScope, params: unknown[], userColumn: string): string {
  if (scope.organizationIds === null) return 'TRUE';
  params.push(scope.callerUserId, scope.organizationIds);
  return `(${userColumn} = $${params.length - 1} OR EXISTS (
    SELECT 1 FROM acc_organization_member training_scope
    WHERE training_scope.user_id = ${userColumn} AND training_scope.status = 'active'
      AND training_scope.organization_id = ANY($${params.length}::integer[])))`;
}

async function requireTrainingTarget(callerUserId: number, userId: number): Promise<void> {
  requireUserId(callerUserId); requireUserId(userId);
  if (callerUserId === userId) return;
  const scope = await trainingReadScope(callerUserId);
  if (scope.organizationIds === null) return;
  let member: { userId: number } | null;
  try {
    member = await queryOne<{ userId: number }>(`SELECT user_id FROM acc_organization_member
      WHERE user_id = $1 AND status = 'active' AND organization_id = ANY($2::integer[]) LIMIT 1`,
    [userId, scope.organizationIds]);
  } catch (error) {
    throw Object.assign(new Error('Training organization scope could not be verified'), { statusCode: 503, cause: error });
  }
  if (!member || member.userId !== userId) throw Object.assign(new Error('Training user is outside your organization scope'), { statusCode: 403 });
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
}): Promise<TrainingCourse[]> {
  let sql = 'SELECT * FROM acc_training_courses WHERE 1=1';
  const params: unknown[] = [];

  if (options?.activeOnly !== false) {
    params.push(true);
    sql += ` AND active = $${params.length}`;
  }

  const role = options?.role !== undefined ? canonicalCourseRoles([options.role], 400)[0] : undefined;

  sql += ' ORDER BY course_code ASC';

  const { rows } = await query<TrainingCourse>(sql, params);
  return role === undefined ? rows : rows.filter(course => canonicalCourseRoles(course.requiredForRoles, 409).includes(role));
}

export async function getCourseById(
  courseId: number,
  includeQuestions: boolean = false,
  client: TransactionClient = database
): Promise<TrainingCourse | null> {
  const course = await client.queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1',
    [courseId]
  );

  if (!course) return null;

  if (includeQuestions) {
    const { rows: questions } = await client.query<TrainingQuizQuestion>(
      `SELECT id, course_id, question_text, question_type, options, explanation, order_index
       FROM acc_training_questions 
       WHERE course_id = $1 AND active = true 
       ORDER BY order_index ASC`,
      [courseId]
    );

    // Strip isCorrect from options when returning to client
    course.questions = questions.map((q) => ({
      ...q,
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
    canonicalCourseRoles(dto.requiredForRoles, 400);
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

export async function getUserRecords(userId: number, callerUserId: number): Promise<TrainingRecord[]> {
  await requireTrainingTarget(callerUserId, userId);
  return getMyRecords(userId);
}

export async function startTraining(userId: number, courseId: number, client: TransactionClient = database): Promise<TrainingRecord> {
  const course = await client.queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1 AND active = true',
    [courseId]
  );

  if (!course) {
    throw Object.assign(new Error('Course not found or inactive'), { statusCode: 404 });
  }

  const existing = await client.queryOne<TrainingRecord>(
    'SELECT * FROM acc_training_records WHERE user_id = $1 AND course_id = $2',
    [userId, courseId]
  );

  if (existing && existing.status === 'completed') {
    throw Object.assign(new Error('Training already completed'), { statusCode: 409 });
  }

  if (existing) {
    const updated = await client.queryOne<TrainingRecord>(
      `UPDATE acc_training_records 
       SET status = 'in_progress', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [existing.id]
    );
    if (!updated) throw new Error('Failed to update record');
    return updated;
  }

  const record = await client.queryOne<TrainingRecord>(
    `INSERT INTO acc_training_records (user_id, course_id, status, started_at)
     VALUES ($1, $2, 'in_progress', NOW())
     RETURNING *`,
    [userId, courseId]
  );

  if (!record) throw new Error('Failed to create training record');
  return record;
}

export async function submitQuiz(
  userId: number,
  courseId: number,
  answers: TrainingQuizAnswer[],
  client?: TransactionClient
): Promise<TrainingQuizResult> {
  const course = await (client ?? database).queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1',
    [courseId]
  );

  if (!course) {
    throw Object.assign(new Error('Course not found'), { statusCode: 404 });
  }

  const { rows: questions } = await (client ?? database).query<TrainingQuizQuestion & { options: Array<{ text: string; isCorrect?: boolean }> }>(
    'SELECT * FROM acc_training_questions WHERE course_id = $1 AND active = true ORDER BY order_index',
    [courseId]
  );

  if (questions.length === 0) {
    throw Object.assign(new Error('No quiz questions found for this course'), { statusCode: 400 });
  }

  // Grade the quiz server-side
  let correctCount = 0;
  for (const question of questions) {
    const answer = answers.find((a) => a.questionId === question.id);
    if (!answer) continue;

    const options = question.options;
    const correctIndices = options
      .map((opt, idx) => (opt.isCorrect ? idx : -1))
      .filter((idx) => idx >= 0);

    const selectedSorted = [...answer.selectedOptions].sort();
    const correctSorted = [...correctIndices].sort();

    if (
      selectedSorted.length === correctSorted.length &&
      selectedSorted.every((v, i) => v === correctSorted[i])
    ) {
      correctCount++;
    }
  }

  const score = Math.round((correctCount / questions.length) * 100);
  const passed = score >= course.passingScore;

  // Update the training record in a transaction
  const updateRecord = async (client: TransactionClient) => {
    const record = await client.queryOne<TrainingRecord>(
      'SELECT * FROM acc_training_records WHERE user_id = $1 AND course_id = $2 FOR UPDATE',
      [userId, courseId]
    );

    let certificateNumber: string | undefined;
    let expirationDate: string | undefined;

    if (passed) {
      certificateNumber = generateCertificateNumber(course.courseCode, userId);
      const expDate = calculateExpirationDate(course.validityPeriodDays);
      expirationDate = expDate.toISOString();

      if (record) {
        await client.query(
          `UPDATE acc_training_records 
           SET status = 'completed', score = $1, attempts = attempts + 1,
               completed_at = NOW(), certificate_number = $2, expiration_date = $3, updated_at = NOW()
           WHERE id = $4`,
          [score, certificateNumber, expDate, record.id]
        );
      } else {
        await client.query(
          `INSERT INTO acc_training_records 
           (user_id, course_id, status, started_at, completed_at, score, attempts, certificate_number, expiration_date)
           VALUES ($1, $2, 'completed', NOW(), NOW(), $3, 1, $4, $5)`,
          [userId, courseId, score, certificateNumber, expDate]
        );
      }
    } else {
      if (record) {
        await client.query(
          `UPDATE acc_training_records 
           SET score = $1, attempts = attempts + 1, updated_at = NOW()
           WHERE id = $2`,
          [score, record.id]
        );
      } else {
        await client.query(
          `INSERT INTO acc_training_records 
           (user_id, course_id, status, started_at, score, attempts)
           VALUES ($1, $2, 'in_progress', NOW(), $3, 1)`,
          [userId, courseId, score]
        );
      }
    }

    return {
      passed,
      score,
      totalQuestions: questions.length,
      correctAnswers: correctCount,
      certificateNumber,
      expirationDate,
    } satisfies TrainingQuizResult;
  };

  return client ? updateRecord(client) : transaction(updateRecord);
}

export async function verifyTraining(
  recordId: number,
  verifierId: number,
  notes?: string,
  client: TransactionClient = database
): Promise<{ verified: boolean }> {
  if (!Number.isSafeInteger(recordId) || recordId < 1) {
    throw Object.assign(new Error('An exact positive training record ID is required'), { statusCode: 400 });
  }
  const scope = await trainingReadScope(verifierId, client);
  const params: unknown[] = [recordId];
  const predicate = trainingScopePredicate(scope, params, 'r.user_id');
  const record = await client.queryOne<TrainingRecord>(
    `SELECT r.* FROM acc_training_records r WHERE r.id = $1 AND ${predicate} FOR UPDATE`,
    params
  );

  if (!record) {
    throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
  }

  if (record.status !== 'completed') {
    throw Object.assign(new Error('Can only verify completed training'), { statusCode: 400 });
  }

  if (record.userId === verifierId) {
    throw Object.assign(new Error('Cannot verify your own training'), { statusCode: 403 });
  }

  await client.query(
    `UPDATE acc_training_records 
     SET verified_by = $1, verified_at = NOW(), notes = $2, updated_at = NOW()
     WHERE id = $3`,
    [verifierId, notes ?? null, recordId]
  );

  return { verified: true };
}

// ============================================================================
// Compliance Operations
// ============================================================================

export async function getComplianceStatus(callerUserId: number, options?: {
  userId?: number;
  studyId?: number;
}): Promise<TrainingComplianceStatus[]> {
  requireUserId(callerUserId);
  const params: unknown[] = [];
  const filters = ['u.status_id = 1'];
  for (const [field, value] of Object.entries(options ?? {})) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw Object.assign(new Error(`An exact positive ${field} is required`), { statusCode: 400 });
    }
  }
  if (options?.userId !== undefined) await requireTrainingTarget(callerUserId, options.userId);
  else filters.push(trainingScopePredicate(await trainingReadScope(callerUserId), params, 'u.user_id'));
  if (options?.studyId !== undefined) {
    const study = await queryOne<{ studyId: number }>('SELECT study_id FROM study WHERE study_id = $1', [options.studyId]);
    if (!study || study.studyId !== options.studyId) {
      throw Object.assign(new Error('Study not found for training compliance'), { statusCode: 404 });
    }
    params.push(options.studyId);
    // Same native parent/site membership scope as EDC notification audiences.
    filters.push(`EXISTS (SELECT 1 FROM study_user_role scoped WHERE scoped.user_name = u.user_name
      AND scoped.status_id = 1 AND (scoped.study_id = $${params.length}
      OR scoped.study_id IN (SELECT study_id FROM study WHERE parent_study_id = $${params.length})))`);
  }
  if (options?.userId !== undefined) {
    params.push(options.userId);
    filters.push(`u.user_id = $${params.length}`);
  }
  const { rows: users } = await query<{
    userId: number; username: string; firstName: string; lastName: string;
    userTypeId: number | null; platformRole: string | null; studyRoles: string[];
  }>(`SELECT u.user_id, u.user_name AS username, u.first_name, u.last_name, u.user_type_id,
      extended.platform_role,
      ARRAY(SELECT DISTINCT sur.role_name FROM study_user_role sur
        WHERE sur.user_name = u.user_name AND sur.status_id = 1 AND sur.role_name IS NOT NULL) AS study_roles
    FROM user_account u LEFT JOIN user_account_extended extended ON extended.user_id = u.user_id
    WHERE ${filters.join(' AND ')} ORDER BY u.user_name`, params);

  const { rows: activeCourses } = users.length
    ? await query<TrainingCourse>('SELECT * FROM acc_training_courses WHERE active = true')
    : { rows: [] };
  // Validate every active course before assigning requirements, so corrupt or
  // unknown configuration cannot disappear and manufacture complete compliance.
  const rolesByCourse = new Map(activeCourses.map(course => [course.id, canonicalCourseRoles(course.requiredForRoles, 409)]));
  const statuses: TrainingComplianceStatus[] = [];
  const now = Date.now();
  for (const user of users) {
    // Match native resolvePrimaryRole precedence; DB failures remain failures.
    const role = ADMIN_USER_TYPE_IDS.includes(user.userTypeId as number) ? ROLES.ADMIN
      : user.platformRole?.trim() ? getRoleByName(user.platformRole)
      : getHighestRole(user.studyRoles ?? []).id !== ROLES.INVALID.id ? getHighestRole(user.studyRoles ?? [])
      : ROLES.COORDINATOR;
    if (role.id === ROLES.INVALID.id) {
      throw Object.assign(new Error('Unknown native platform role for training compliance'), { statusCode: 409 });
    }
    const requiredCourses = activeCourses.filter(course => rolesByCourse.get(course.id)!.includes(role.name));
    const { rows: records } = await query<TrainingRecord>(
      'SELECT * FROM acc_training_records WHERE user_id = $1 AND course_id = ANY($2::integer[])',
      [user.userId, requiredCourses.map(course => course.id)]
    );
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
    statuses.push({
      userId: user.userId, username: user.username, userFullName: `${user.firstName} ${user.lastName}`.trim(),
      role: role.name, totalRequired, completed, expired, pending: totalRequired - completed - expired,
      compliancePercentage: totalRequired ? Math.round(completed / totalRequired * 100) : 100,
      isCompliant: completed === totalRequired, missingCourses,
    });
  }

  return statuses;
}

export async function getExpiringTraining(callerUserId: number, daysAhead: number = 30): Promise<TrainingRecord[]> {
  if (!Number.isSafeInteger(daysAhead) || daysAhead < 1) {
    throw Object.assign(new Error('An exact positive number of days is required'), { statusCode: 400 });
  }
  const params: unknown[] = [daysAhead];
  const predicate = trainingScopePredicate(await trainingReadScope(callerUserId), params, 'r.user_id');
  const { rows } = await query<TrainingRecord>(
    `SELECT r.*, c.course_name, c.course_code
     FROM acc_training_records r
     JOIN acc_training_courses c ON c.id = r.course_id
     WHERE r.status = 'completed'
       AND ${predicate}
       AND r.expiration_date IS NOT NULL
       AND r.expiration_date <= NOW() + INTERVAL '1 day' * $1
       AND r.expiration_date > NOW()
     ORDER BY r.expiration_date ASC`,
    params
  );
  return rows;
}

export async function checkUserCompliance(userId: number, callerUserId: number = userId): Promise<TrainingComplianceCheck> {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw Object.assign(new Error('An exact positive user ID is required'), { statusCode: 400 });
  }
  const statuses = await getComplianceStatus(callerUserId, { userId });
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
    missingCount: status.missingCourses.length,
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

export async function getCourseContent(courseId: number): Promise<CourseContentResponse | null> {
  const course = await queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1 AND active = true',
    [courseId]
  );

  if (!course) return null;

  const { rows: slides } = await query<SlideContent>(
    `SELECT id, course_id, title, content, slide_type, order_index, media_url, interactive_config
     FROM acc_training_slides
     WHERE course_id = $1
     ORDER BY order_index ASC`,
    [courseId]
  );

  const { rows: questions } = await query<TrainingQuizQuestion>(
    `SELECT id, course_id, question_text, question_type, options, explanation, order_index
     FROM acc_training_questions
     WHERE course_id = $1 AND active = true
     ORDER BY order_index ASC`,
    [courseId]
  );

  // Strip isCorrect from options for client delivery
  const safeQuestions = questions.map((q) => ({
    ...q,
    options: (q.options as unknown as Array<{ text: string; isCorrect?: boolean }>).map(
      (opt) => ({ text: opt.text })
    ),
  }));

  return { course, slides, questions: safeQuestions };
}
