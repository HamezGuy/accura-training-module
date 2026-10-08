import { getRoleByName, ROLES } from '@accura-trial/auth-core';
import { query, queryOne, transaction, TransactionClient } from '../config/database';
import { logger } from '../config/logger';
import { logAudit } from './audit.service';
import { generateCertificateNumber, calculateExpirationDate } from './certificate.service';
import { authorizeTrainingTargets, readTrainingDirectory, revalidateTrainingDirectory, TrainingAuthorityContext } from './training-authority.service';
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

export async function getUserRecords(userId: number, authority: TrainingAuthorityContext): Promise<TrainingRecord[]> {
  requireUserId(userId);
  const admission = await authorizeTrainingTargets(authority, 'records:read', [userId]);
  if (!admission.decisions[0].allowed) throw Object.assign(new Error('Training user is outside your organization scope'), { statusCode: 403 });
  const records = await getMyRecords(userId);
  const current = await authorizeTrainingTargets(authority, 'records:read', [userId], { scopeFingerprint: admission.scopeFingerprint });
  if (!current.decisions[0].allowed) throw Object.assign(new Error('Training user is outside your organization scope'), { statusCode: 403 });
  return records;
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
  authority: TrainingAuthorityContext,
  notes?: string,
  client: TransactionClient = database
): Promise<{ verified: boolean }> {
  if (!Number.isSafeInteger(recordId) || recordId < 1) {
    throw Object.assign(new Error('An exact positive training record ID is required'), { statusCode: 400 });
  }
  const admission = await authorizeTrainingTargets(authority, 'records:verify', []);
  const owner = await client.queryOne<{ userId: number }>('SELECT user_id FROM acc_training_records WHERE id = $1', [recordId]);
  if (!owner) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
  const initialTarget = await authorizeTrainingTargets(authority, 'records:verify', [owner.userId], { scopeFingerprint: admission.scopeFingerprint });
  if (!initialTarget.decisions[0].allowed) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
  const record = await client.queryOne<TrainingRecord>(
    'SELECT r.* FROM acc_training_records r WHERE r.id = $1 AND r.user_id = $2 FOR UPDATE',
    [recordId, owner.userId]
  );

  if (!record) {
    throw Object.assign(new Error('Training record not found'), { statusCode: 404 });
  }

  // Authorization is a remote observation while this record is locked. Only
  // the training update and its caller's audit share the local transaction.
  const target = await authorizeTrainingTargets(authority, 'records:verify', [record.userId], { scopeFingerprint: admission.scopeFingerprint });
  if (!target.decisions[0].allowed) throw Object.assign(new Error('Training record not found'), { statusCode: 404 });

  if (record.status !== 'completed') {
    throw Object.assign(new Error('Can only verify completed training'), { statusCode: 400 });
  }

  if (record.userId === authority.actorUserId) {
    throw Object.assign(new Error('Cannot verify your own training'), { statusCode: 403 });
  }

  await client.query(
    `UPDATE acc_training_records 
     SET verified_by = $1, verified_at = NOW(), notes = $2, updated_at = NOW()
     WHERE id = $3`,
    [authority.actorUserId, notes ?? null, recordId]
  );

  return { verified: true };
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
