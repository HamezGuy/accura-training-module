// Opt-in only: an owner-provisioned, empty disposable PostgreSQL database.
// No existing application database or credential variable is ever selected.
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import trainingRoutes from '../../src/routes/training.routes';
import { errorHandler } from '../../src/middleware/errorHandler.middleware';
import { pool } from '../../src/config/database';
import { runMigrations } from '../../src/config/migrations';
import { expireOverdueRecords } from '../../src/services/training.service';

jest.mock('../../src/config/environment', () => ({ config: {
  database: { url: process.env['TRAINING_AUDIT_TEST_DATABASE_URL'] ?? 'postgresql://127.0.0.1:1/disabled', ssl: false },
  jwt: { secret: 'owned-training-postgres-test' }, training: { certificateValidityDays: 365 },
} }));
jest.mock('../../src/config/logger', () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));

const runOwned = process.env['TRAINING_AUDIT_TEST_DATABASE_URL'] ? describe : describe.skip;
runOwned('owned PostgreSQL training audit atomicity', () => {
  const app = express(); app.use(express.json()); app.use('/api/training', trainingRoutes); app.use(errorHandler);
  const token = jwt.sign({ userId: 111, username: 'owned-fixture-admin', role: 'admin' }, 'owned-training-postgres-test');
  let ready = false, courseId: number, questionId: number, recordId: number;
  const cases = ['create', 'update', 'questions', 'start', 'quiz-pass', 'quiz-fail', 'verify'] as const;
  const options = [{ text: 'yes', isCorrect: true }, { text: 'no', isCorrect: false }];
  const expected = { create: 'course_created', update: 'course_updated', questions: 'questions_added', start: 'training_started',
    'quiz-pass': 'quiz_passed', 'quiz-fail': 'quiz_failed', verify: 'training_verified' };

  beforeAll(async () => {
    const url = new URL(process.env['TRAINING_AUDIT_TEST_DATABASE_URL']!);
    if (process.env['TRAINING_AUDIT_TEST_OWNED'] !== 'yes' || !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.search || url.hash || !/^\/training_audit_test_[a-z0-9_]+$/.test(url.pathname)) {
      throw new Error('Requires an explicitly owned loopback training_audit_test_* disposable database.');
    }
    // Refuse a populated database before DDL or cleanup, even if its name matches.
    const existing = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' LIMIT 1");
    if (existing.rowCount) throw new Error('The owned PostgreSQL test database must initially be empty.');
    await runMigrations(); await runMigrations(); // Additive DDL is idempotent.
    await pool.query(`CREATE FUNCTION reject_owned_training_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Owned injected audit storage failure'; END; $$`);
    ready = true;
  }, 30_000);
  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    if (!ready) throw new Error('Owned test database preparation did not complete.');
    await pool.query('DROP TRIGGER IF EXISTS reject_owned_training_audit ON acc_training_audit_log');
    await pool.query('TRUNCATE acc_training_questions, acc_training_records, acc_training_audit_log, acc_training_courses RESTART IDENTITY CASCADE');
    const course = await pool.query(`INSERT INTO acc_training_courses
      (course_code, course_name, version, passing_score, required_for_roles, validity_period_days)
      VALUES ('OWNED-FIXTURE', 'Owned training fixture', '1', 80, '["admin"]'::jsonb, 365) RETURNING id`);
    courseId = course.rows[0].id;
    const question = await pool.query(`INSERT INTO acc_training_questions
      (course_id, question_text, question_type, options, order_index) VALUES ($1, 'Owned fixture?', 'true_false', $2, 0) RETURNING id`, [courseId, JSON.stringify(options)]);
    questionId = question.rows[0].id;
    const record = await pool.query(`INSERT INTO acc_training_records
      (user_id, course_id, status, score, attempts, completed_at, expiration_date)
      VALUES (222, $1, 'completed', 100, 1, NOW(), NOW() + INTERVAL '1 day') RETURNING id`, [courseId]);
    recordId = record.rows[0].id;
  });

  async function snapshot() {
    const state: Record<string, unknown> = {};
    for (const table of ['acc_training_courses', 'acc_training_questions', 'acc_training_records', 'acc_training_audit_log']) {
      state[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    }
    return state;
  }
  async function refuseAudit() {
    await pool.query(`CREATE TRIGGER reject_owned_training_audit BEFORE INSERT ON acc_training_audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_owned_training_audit()`);
  }
  async function send(kind: typeof cases[number]) {
    const client = request(app);
    const pending = kind === 'create' ? client.post('/api/training/courses').send({ courseCode: 'OWNED-NEW', courseName: 'Owned new fixture', version: '1', passingScore: 80, requiredForRoles: ['admin'] })
      : kind === 'update' ? client.put(`/api/training/courses/${courseId}`).send({ courseName: 'Owned renamed fixture' })
      : kind === 'questions' ? client.post(`/api/training/courses/${courseId}/questions`).send({ questions: [{ questionText: 'Second owned question', questionType: 'true_false', options, orderIndex: 1 }] })
      : kind === 'start' ? client.post(`/api/training/start/${courseId}`).send({})
      : kind === 'verify' ? client.post(`/api/training/verify/${recordId}`).send({ notes: 'Owned verification note' })
      : client.post(`/api/training/submit-quiz/${courseId}`).send({ answers: [{ questionId, selectedOptions: [kind === 'quiz-pass' ? 0 : 1] }] });
    return pending.set('Authorization', `Bearer ${token}`);
  }

  test.each(cases)('%s leaves all business and audit rows unchanged when PostgreSQL rejects the audit insert', async kind => {
    await refuseAudit(); const before = await snapshot();
    const response = await send(kind);
    expect(response.status).toBe(500); expect(response.body.success).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
  test.each(cases)('%s commits the native rows and actor-bound audit together', async kind => {
    const before = await snapshot(), response = await send(kind);
    expect(response.status).toBeLessThan(300); expect(response.body.success).toBe(true);
    expect(await snapshot()).not.toEqual(before);
    const audit = await pool.query('SELECT user_id, action, record_id, course_id FROM acc_training_audit_log');
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ user_id: 111, action: expected[kind] });
    if (kind === 'verify') expect(audit.rows[0].record_id).toBe(recordId);
    else if (kind === 'create') expect(audit.rows[0].course_id).toBe(response.body.data.id);
    else expect(audit.rows[0].course_id).toBe(courseId);
  });
  test('expiry rollback and null system actor survive real PostgreSQL constraints and remain visible', async () => {
    await pool.query("UPDATE acc_training_records SET expiration_date = '2000-01-01' WHERE id = $1", [recordId]);
    await refuseAudit(); const before = await snapshot();
    await expect(expireOverdueRecords()).rejects.toThrow('Owned injected audit storage failure');
    expect(await snapshot()).toEqual(before);
    await pool.query('DROP TRIGGER reject_owned_training_audit ON acc_training_audit_log');
    expect(await expireOverdueRecords()).toBe(1);
    const audit = await pool.query('SELECT * FROM acc_training_audit_log');
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ user_id: null, record_id: recordId, course_id: courseId, action: 'training_expired',
      details: { actor: 'scheduled-expiration', affectedUserId: 222, previousStatus: 'completed', status: 'expired' } });
    expect(await expireOverdueRecords()).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM acc_training_audit_log')).rows[0].count).toBe(1);
  });
  test('migration rejects anonymous interactive and incomplete system events, including SQL-null JSON fields', async () => {
    for (const [action, details] of [['course_created', {}], ['training_expired', null], ['training_expired', {}],
      ['training_expired', { actor: 'scheduled-expiration' }], ['training_expired', { actor: 'scheduled-expiration', affectedUserId: '222' }]]) {
      await expect(pool.query('INSERT INTO acc_training_audit_log (user_id, action, details) VALUES (NULL, $1, $2)',
        [action, details === null ? null : JSON.stringify(details)])).rejects.toMatchObject({ code: '23514' });
    }
  });
});
