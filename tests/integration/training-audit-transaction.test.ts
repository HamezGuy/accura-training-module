import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import trainingRoutes from '../../src/routes/training.routes';
import { errorHandler } from '../../src/middleware/errorHandler.middleware';
import { expireOverdueRecords } from '../../src/services/training.service';

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn(() => ({
  query: (...args: unknown[]) => mockPoolQuery(...args),
  connect: () => mockConnect(), on: jest.fn(),
})) }));
jest.mock('../../src/config/environment', () => ({ config: {
  database: { host: 'unused.invalid', port: 1, name: 'offline-only', user: 'offline', password: '', ssl: false },
  jwt: { secret: 'training-audit-offline-test' }, training: { certificateValidityDays: 365 },
} }));
jest.mock('../../src/config/logger', () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));

const course = { id: 3, course_code: 'OWNED-AUDIT', course_name: 'Audit fixture', version: '1', active: true,
  passing_score: 80, required_for_roles: ['admin'], validity_period_days: 365 };
const record = { id: 12, user_id: 2, course_id: 3, status: 'completed' };
const question = { id: 7, course_id: 3, question_text: 'Fixture?', question_type: 'true_false',
  options: [{ text: 'yes', isCorrect: true }, { text: 'no', isCorrect: false }], order_index: 0 };
const rows = (...values: Record<string, unknown>[]) => ({ rows: values, rowCount: values.length });
const cases = [
  { name: 'course create', method: 'post', route: '/courses', action: 'course_created',
    body: { courseCode: 'OWNED-AUDIT', courseName: 'Audit fixture', version: '1', passingScore: 80, requiredForRoles: ['admin'] }, responses: [rows(course)] },
  { name: 'course update', method: 'put', route: '/courses/3', action: 'course_updated',
    body: { courseName: 'Updated fixture' }, responses: [rows(course)] },
  { name: 'add questions', method: 'post', route: '/courses/3/questions', action: 'questions_added',
    body: { questions: [{ questionText: 'Fixture?', questionType: 'true_false', options: question.options, orderIndex: 0 }] }, responses: [rows(course), rows(question)] },
  { name: 'start training', method: 'post', route: '/start/3', action: 'training_started',
    body: {}, responses: [rows(course), rows(), rows({ ...record, user_id: 1, status: 'in_progress' })] },
  { name: 'passing quiz', method: 'post', route: '/submit-quiz/3', action: 'quiz_passed',
    body: { answers: [{ questionId: 7, selectedOptions: [0] }] }, responses: [rows(course), rows(question), rows(), rows()] },
  { name: 'failed quiz', method: 'post', route: '/submit-quiz/3', action: 'quiz_failed',
    body: { answers: [{ questionId: 7, selectedOptions: [1] }] }, responses: [rows(course), rows(question), rows(), rows()] },
  { name: 'verify training', method: 'post', route: '/verify/12', action: 'training_verified',
    body: { notes: 'Owned test verification' }, responses: [rows(record), rows()] },
] as const;

describe('training mutation and audit share the real database transaction boundary', () => {
  const app = express(); app.use(express.json()); app.use('/api/training', trainingRoutes); app.use(errorHandler);
  const token = jwt.sign({ userId: 1, username: 'owned-test', role: 'admin' }, 'training-audit-offline-test');
  let responses: Array<{ rows: Record<string, unknown>[]; rowCount: number }>;
  let active: boolean, stagedWrites: number, committedWrites: number, stagedAudits: unknown[][], committedAudits: unknown[][];
  let auditAttempts: number, failAuditAt: number, businessAttempts: number, failBusinessAt: number;
  let failure: Error, rollbackFailure: Error | null;

  beforeEach(() => {
    jest.clearAllMocks(); responses = []; active = false; stagedWrites = 0; committedWrites = 0;
    stagedAudits = []; committedAudits = []; auditAttempts = 0; failAuditAt = 0; businessAttempts = 0; failBusinessAt = 0;
    failure = new Error('Injected audit storage refusal'); rollbackFailure = null;
    mockRelease.mockImplementation((destroy?: boolean) => { if (destroy) active = false; });
    mockPoolQuery.mockImplementation(() => { throw new Error('Mutation escaped its transaction connection'); });
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
    mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN') { expect(active).toBe(false); active = true; return rows(); }
      if (sql === 'COMMIT') { expect(active).toBe(true); committedWrites = stagedWrites; committedAudits = [...stagedAudits]; active = false; return rows(); }
      if (sql === 'ROLLBACK') {
        expect(active).toBe(true);
        if (rollbackFailure) throw rollbackFailure;
        stagedWrites = 0; stagedAudits = []; active = false; return rows();
      }
      expect(active).toBe(true);
      if (sql.includes('INSERT INTO acc_training_audit_log')) {
        if (++auditAttempts === failAuditAt) throw failure;
        stagedAudits.push(params!); return rows();
      }
      if (/^\s*(INSERT|UPDATE)\b/.test(sql)) {
        if (++businessAttempts === failBusinessAt) throw new Error('Injected second question refusal');
        stagedWrites++;
      }
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected query: ${sql}`);
      return response;
    });
  });

  async function send(spec: typeof cases[number], body: unknown = spec.body) {
    return request(app)[spec.method](`/api/training${spec.route}`).set('Authorization', `Bearer ${token}`).send(body as object);
  }
  function assertTransaction(outcome: 'COMMIT' | 'ROLLBACK') {
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockClientQuery.mock.calls.filter(([sql]) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)).map(([sql]) => sql)).toEqual(['BEGIN', outcome]);
    expect(active).toBe(false);
  }

  test.each(cases)('$name cannot return success or commit state when its audit insert fails', async spec => {
    responses = [...spec.responses]; failAuditAt = 1;
    const response = await send(spec);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, message: 'Internal server error' });
    expect(businessAttempts).toBeGreaterThan(0);
    expect(auditAttempts).toBe(1);
    expect(committedWrites).toBe(0); expect(committedAudits).toEqual([]);
    assertTransaction('ROLLBACK');
  });

  test.each(cases)('$name commits its actor-bound audit with the state before responding', async spec => {
    responses = [...spec.responses];
    const response = await send(spec);
    expect(response.status).toBeLessThan(300); expect(response.body.success).toBe(true);
    expect(committedWrites).toBeGreaterThan(0);
    expect(committedAudits).toHaveLength(1);
    expect(committedAudits[0]!.slice(0, 2)).toEqual([1, spec.action]);
    expect(responses).toEqual([]);
    assertTransaction('COMMIT');
  });

  test('a second question failure rolls back the first question and creates no success audit', async () => {
    const spec = cases[2]; responses = [rows(course), rows(question)]; failBusinessAt = 2;
    const response = await send(spec, { questions: [...spec.body.questions, ...spec.body.questions] });
    expect(response.status).toBe(500); expect(committedWrites).toBe(0); expect(auditAttempts).toBe(0);
    assertTransaction('ROLLBACK');
  });

  test('missing course update returns the existing 404 contract and creates no mutation audit', async () => {
    responses = [rows()]; const response = await send(cases[1]);
    expect(response.status).toBe(404); expect(auditAttempts).toBe(0); assertTransaction('COMMIT');
  });

  test('expiry audits each affected user as a system event in the same transaction', async () => {
    responses = [rows({ id: 12, user_id: 2, course_id: 3, expiration_date: '2020-01-01' },
      { id: 13, user_id: 4, course_id: 3, expiration_date: '2020-01-02' })];
    expect(await expireOverdueRecords()).toBe(2);
    expect(committedAudits.map(a => [a[0], a[1], a[2], JSON.parse(a[4] as string).actor, JSON.parse(a[4] as string).affectedUserId]))
      .toEqual([[null, 'training_expired', 12, 'scheduled-expiration', 2], [null, 'training_expired', 13, 'scheduled-expiration', 4]]);
    assertTransaction('COMMIT');
  });

  test('any expiry audit refusal rolls back the whole update and previously written expiry audits', async () => {
    responses = [rows({ id: 12, user_id: 2, course_id: 3 }, { id: 13, user_id: 4, course_id: 3 })]; failAuditAt = 2;
    await expect(expireOverdueRecords()).rejects.toBe(failure);
    expect(committedWrites).toBe(0); expect(committedAudits).toEqual([]);
    assertTransaction('ROLLBACK');
  });

  test.each([false, true])('rollback failure retains the primary error and discards the unusable client (frozen error: %s)', async frozen => {
    responses = [rows({ id: 12, user_id: 2, course_id: 3 })]; failAuditAt = 1;
    if (frozen) Object.freeze(failure);
    rollbackFailure = new Error('Injected rollback connection failure');
    const error = await expireOverdueRecords().then(() => null, e => e);
    expect(frozen ? error.cause : error).toBe(failure);
    expect(error.rollbackError).toBe(rollbackFailure);
    expect(error.message).toBe(failure.message);
    expect(mockRelease).toHaveBeenCalledWith(true);
    expect(committedWrites).toBe(0); expect(committedAudits).toEqual([]);
    assertTransaction('ROLLBACK');
  });
});
