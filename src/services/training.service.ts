import { query, queryOne, transaction } from '../config/database';
import { logger } from '../config/logger';
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

  if (options?.role) {
    params.push(options.role);
    sql += ` AND required_for_roles @> $${params.length}::jsonb`;
    params[params.length - 1] = JSON.stringify([options.role]);
  }

  sql += ' ORDER BY course_code ASC';

  const { rows } = await query<TrainingCourse>(sql, params);
  return rows;
}

export async function getCourseById(
  courseId: number,
  includeQuestions: boolean = false
): Promise<TrainingCourse | null> {
  const course = await queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1',
    [courseId]
  );

  if (!course) return null;

  if (includeQuestions) {
    const { rows: questions } = await query<TrainingQuizQuestion>(
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
  createdBy: number
): Promise<TrainingCourse> {
  const result = await queryOne<TrainingCourse>(
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
  dto: UpdateCourseRequest
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

  if (setClauses.length === 0) return getCourseById(courseId);

  setClauses.push(`updated_at = NOW()`);
  params.push(courseId);

  const sql = `UPDATE acc_training_courses SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
  return queryOne<TrainingCourse>(sql, params);
}

export async function addQuestions(
  courseId: number,
  questions: CreateQuestionRequest[]
): Promise<TrainingQuizQuestion[]> {
  const results: TrainingQuizQuestion[] = [];

  for (const q of questions) {
    const row = await queryOne<TrainingQuizQuestion>(
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

export async function getUserRecords(userId: number): Promise<TrainingRecord[]> {
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

export async function startTraining(userId: number, courseId: number): Promise<TrainingRecord> {
  const course = await queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1 AND active = true',
    [courseId]
  );

  if (!course) {
    throw Object.assign(new Error('Course not found or inactive'), { statusCode: 404 });
  }

  const existing = await queryOne<TrainingRecord>(
    'SELECT * FROM acc_training_records WHERE user_id = $1 AND course_id = $2',
    [userId, courseId]
  );

  if (existing && existing.status === 'completed') {
    throw Object.assign(new Error('Training already completed'), { statusCode: 409 });
  }

  if (existing) {
    const updated = await queryOne<TrainingRecord>(
      `UPDATE acc_training_records 
       SET status = 'in_progress', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [existing.id]
    );
    if (!updated) throw new Error('Failed to update record');
    return updated;
  }

  const record = await queryOne<TrainingRecord>(
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
  answers: TrainingQuizAnswer[]
): Promise<TrainingQuizResult> {
  const course = await queryOne<TrainingCourse>(
    'SELECT * FROM acc_training_courses WHERE id = $1',
    [courseId]
  );

  if (!course) {
    throw Object.assign(new Error('Course not found'), { statusCode: 404 });
  }

  const { rows: questions } = await query<TrainingQuizQuestion & { options: Array<{ text: string; isCorrect?: boolean }> }>(
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
  const result = await transaction(async (client) => {
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
  });

  return result;
}

export async function verifyTraining(
  recordId: number,
  verifierId: number,
  notes?: string
): Promise<{ verified: boolean }> {
  const record = await queryOne<TrainingRecord>(
    'SELECT * FROM acc_training_records WHERE id = $1',
    [recordId]
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

  await query(
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

export async function getComplianceStatus(options?: {
  userId?: number;
  studyId?: number;
}): Promise<TrainingComplianceStatus[]> {
  let userFilter = '';
  const params: unknown[] = [];

  if (options?.userId) {
    params.push(options.userId);
    userFilter = `WHERE u.user_id = $${params.length}`;
  }

  // Get users from the main acc_users table (shared DB)
  const { rows: users } = await query<{
    userId: number;
    username: string;
    firstName: string;
    lastName: string;
    role: string;
  }>(
    `SELECT user_id, username, first_name, last_name, role 
     FROM acc_users ${userFilter}
     ORDER BY username`,
    params
  );

  const statuses: TrainingComplianceStatus[] = [];

  for (const user of users) {
    const { rows: requiredCourses } = await query<TrainingCourse>(
      `SELECT * FROM acc_training_courses 
       WHERE active = true AND required_for_roles @> $1::jsonb`,
      [JSON.stringify([user.role])]
    );

    const { rows: records } = await query<TrainingRecord>(
      `SELECT r.*, c.course_code, c.course_name
       FROM acc_training_records r
       JOIN acc_training_courses c ON c.id = r.course_id
       WHERE r.user_id = $1`,
      [user.userId]
    );

    const completed = records.filter(
      (r) => r.status === 'completed' && (!r.expirationDate || new Date(r.expirationDate) > new Date())
    ).length;

    const expired = records.filter(
      (r) => r.status === 'expired' || (r.expirationDate && new Date(r.expirationDate) <= new Date())
    ).length;

    const completedCodes = records
      .filter((r) => r.status === 'completed' && (!r.expirationDate || new Date(r.expirationDate) > new Date()))
      .map((r) => r.courseCode);

    const missingCourses = requiredCourses
      .filter((c) => !completedCodes.includes(c.courseCode))
      .map((c) => ({
        courseCode: c.courseCode,
        courseName: c.courseName,
        requiredBy: (c.regulatoryReference ?? 'Organization Policy'),
      }));

    const totalRequired = requiredCourses.length;
    const pending = totalRequired - completed - expired;
    const compliancePercentage = totalRequired > 0 ? Math.round((completed / totalRequired) * 100) : 100;

    statuses.push({
      userId: user.userId,
      username: user.username,
      userFullName: `${user.firstName} ${user.lastName}`.trim(),
      role: user.role,
      totalRequired,
      completed,
      expired,
      pending: Math.max(0, pending),
      compliancePercentage,
      isCompliant: missingCourses.length === 0 && expired === 0,
      missingCourses,
    });
  }

  return statuses;
}

export async function getExpiringTraining(daysAhead: number = 30): Promise<TrainingRecord[]> {
  const { rows } = await query<TrainingRecord>(
    `SELECT r.*, c.course_name, c.course_code
     FROM acc_training_records r
     JOIN acc_training_courses c ON c.id = r.course_id
     WHERE r.status = 'completed'
       AND r.expiration_date IS NOT NULL
       AND r.expiration_date <= NOW() + INTERVAL '1 day' * $1
       AND r.expiration_date > NOW()
     ORDER BY r.expiration_date ASC`,
    [daysAhead]
  );
  return rows;
}

export async function checkUserCompliance(userId: number): Promise<TrainingComplianceCheck> {
  const statuses = await getComplianceStatus({ userId });
  const status = statuses[0];

  if (!status) {
    return { userId, isCompliant: true, missingCount: 0, expiredCount: 0 };
  }

  return {
    userId,
    isCompliant: status.isCompliant,
    missingCount: status.missingCourses.length,
    expiredCount: status.expired,
  };
}

export async function expireOverdueRecords(): Promise<number> {
  const result = await query(
    `UPDATE acc_training_records 
     SET status = 'expired', updated_at = NOW()
     WHERE status = 'completed'
       AND expiration_date IS NOT NULL
       AND expiration_date < NOW()
     RETURNING id`
  );

  const count = result.rowCount ?? 0;
  if (count > 0) {
    logger.info(`Expired ${count} overdue training records`);
  }
  return count;
}
