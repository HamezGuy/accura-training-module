import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createJwtService } from '@accura-trial/auth-core';
import trainingRoutes from '../../src/routes/training.routes';
import { errorHandler } from '../../src/middleware/errorHandler.middleware';

const mockGetCourses = jest.fn();
const mockGetCourseById = jest.fn();
const mockCreateCourse = jest.fn();
const mockStartTraining = jest.fn();
const mockSubmitQuiz = jest.fn();
const mockGetMyRecords = jest.fn();
const mockGetUserRecords = jest.fn();
const mockVerifyTraining = jest.fn();
const mockGetComplianceStatus = jest.fn();
const mockGetExpiringTraining = jest.fn();
const mockCheckUserCompliance = jest.fn();
const mockAttestTraining = jest.fn();
const mockSignTrainingVerification = jest.fn();
const mockReadRecordSignatureSubject = jest.fn();

jest.mock('../../src/services/training.service', () => ({
  getCourses: (...args: unknown[]) => mockGetCourses(...args),
  getCourseById: (...args: unknown[]) => mockGetCourseById(...args),
  createCourse: (...args: unknown[]) => mockCreateCourse(...args),
  startTraining: (...args: unknown[]) => mockStartTraining(...args),
  submitQuiz: (...args: unknown[]) => mockSubmitQuiz(...args),
  getMyRecords: (...args: unknown[]) => mockGetMyRecords(...args),
  getUserRecords: (...args: unknown[]) => mockGetUserRecords(...args),
  verifyTraining: (...args: unknown[]) => mockVerifyTraining(...args),
  getComplianceStatus: (...args: unknown[]) => mockGetComplianceStatus(...args),
  getExpiringTraining: (...args: unknown[]) => mockGetExpiringTraining(...args),
  checkUserCompliance: (...args: unknown[]) => mockCheckUserCompliance(...args),
  attestTraining: (...args: unknown[]) => mockAttestTraining(...args),
  signTrainingVerification: (...args: unknown[]) => mockSignTrainingVerification(...args),
  readRecordSignatureSubject: (...args: unknown[]) => mockReadRecordSignatureSubject(...args),
}));

jest.mock('../../src/services/audit.service', () => ({
  logAudit: jest.fn(),
}));

jest.mock('../../src/config/database', () => ({
  transaction: (fn: (client: unknown) => Promise<unknown>) => fn({}),
}));

jest.mock('../../src/config/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const JWT_SECRET = 'test-secret';

jest.mock('../../src/config/environment', () => ({
  config: {
    authority: { baseUrl: 'http://authority.invalid', timeoutMs: 100 },
    training: { certificateValidityDays: 365 },
  },
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/training', trainingRoutes);
  app.use(errorHandler);
  return app;
}

function generateToken(payload: Record<string, unknown> = {}) {
  return jwt.sign(
    {
      userId: 1,
      username: 'testuser',
      role: 'admin',
      email: 'owned@example.invalid',
      type: 'access',
      organizationIds: [1],
      ...payload,
    },
    JWT_SECRET,
    { expiresIn: '1h', algorithm: 'HS256', issuer: 'libreclinica-api', audience: 'libreclinica-client' }
  );
}

describe('Training API Integration', () => {
  let app: express.Express;

  beforeAll(() => {
    app = createApp();
  });

  test('target-record reads pass the authenticated caller separately from the requested user', async () => {
    mockGetUserRecords.mockResolvedValue([]);
    const response = await request(app).get('/api/training/user/2/records').set('Authorization', `Bearer ${generateToken()}`);
    expect(response.status).toBe(200);
    expect(mockGetUserRecords).toHaveBeenCalledWith(2, expect.objectContaining({ actorUserId: 1, accessToken: expect.any(String), signal: expect.any(AbortSignal) }));
  });

  test.each(['0', '01', '1junk', '1.5', '9007199254740992'])('malformed user/record ID %s cannot reach a training service', async id => {
    const headers = `Bearer ${generateToken()}`;
    expect((await request(app).get(`/api/training/user/${id}/records`).set('Authorization', headers)).status).toBe(400);
    expect((await request(app).post(`/api/training/verify/${id}`).set('Authorization', headers).send({})).status).toBe(400);
    expect(mockGetUserRecords).not.toHaveBeenCalled();
    expect(mockVerifyTraining).not.toHaveBeenCalled();
  });

  test.each(['0', '30junk', '1.5', '9007199254740992', '1&days=2'])('malformed expiry horizon %s cannot reach the service', async days => {
    const response = await request(app).get(`/api/training/expiring?days=${days}`).set('Authorization', `Bearer ${generateToken()}`);
    expect(response.status).toBe(400); expect(mockGetExpiringTraining).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const verifier = createJwtService({ secret: JWT_SECRET });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const bearer = new Headers(options?.headers).get('Authorization')!.slice('Bearer '.length);
      const decoded = verifier.verifyAccessToken(bearer);
      // Test authority fixture only. Production grants always come from native
      // account lookup, exercised independently by the authority contract suite.
      return new Response(JSON.stringify(decoded ? { success: true, data: {
        userId: decoded.userId, username: decoded.username, email: decoded.email, role: decoded.role,
        userType: 'user', studyIds: [], organizationIds: [1],
      } } : { success: false }), { status: decoded ? 200 : 401 });
    });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('Authentication', () => {
    it('should reject requests without token', async () => {
      const res = await request(app).get('/api/training/courses');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should reject invalid tokens', async () => {
      const res = await request(app)
        .get('/api/training/courses')
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
    });

    it('should accept valid tokens', async () => {
      mockGetCourses.mockResolvedValue([]);
      const token = generateToken();

      const res = await request(app)
        .get('/api/training/courses')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/training/courses', () => {
    it('should return courses list', async () => {
      mockGetCourses.mockResolvedValue([
        {
          id: 1, courseCode: 'GCP-101', courseName: 'GCP Fundamentals',
          description: null, version: '2.0', durationMinutes: 120,
          passingScore: 80, requiredForRoles: ['admin'], regulatoryReference: 'ICH E6',
          active: true, validityPeriodDays: 365, createdBy: 1,
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
      ]);
      const token = generateToken();

      const res = await request(app)
        .get('/api/training/courses')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].courseCode).toBe('GCP-101');
    });
  });

  describe('POST /api/training/courses', () => {
    it('should reject non-admin users', async () => {
      const token = generateToken({ role: 'viewer' });

      const res = await request(app)
        .post('/api/training/courses')
        .set('Authorization', `Bearer ${token}`)
        .send({
          courseCode: 'NEW-101',
          courseName: 'New Course',
          version: '1.0',
          passingScore: 80,
          requiredForRoles: ['admin'],
        });

      expect(res.status).toBe(403);
    });

    it('should validate required fields', async () => {
      const token = generateToken();

      const res = await request(app)
        .post('/api/training/courses')
        .set('Authorization', `Bearer ${token}`)
        .send({ courseCode: 'NEW-101' });

      expect(res.status).toBe(400);
      expect(res.body.errors).toBeDefined();
    });

    it('should create course for admin', async () => {
      mockCreateCourse.mockResolvedValue({
        id: 5, courseCode: 'NEW-101', courseName: 'New Course',
        description: null, version: '1.0', durationMinutes: null,
        passingScore: 80, requiredForRoles: ['admin'], regulatoryReference: null,
        active: true, validityPeriodDays: 365, createdBy: 1,
        createdAt: '2026-05-04', updatedAt: '2026-05-04',
      });
      const token = generateToken();

      const res = await request(app)
        .post('/api/training/courses')
        .set('Authorization', `Bearer ${token}`)
        .send({
          courseCode: 'NEW-101',
          courseName: 'New Course',
          version: '1.0',
          passingScore: 80,
          requiredForRoles: ['admin'],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.courseCode).toBe('NEW-101');
    });
  });

  describe('POST /api/training/start/:courseId', () => {
    it('should start training for authenticated user', async () => {
      mockStartTraining.mockResolvedValue({
        id: 1, userId: 1, courseId: 2, status: 'in_progress',
        startedAt: '2026-05-04', completedAt: null, score: null,
        attempts: 0, certificateNumber: null, expirationDate: null,
        verifiedBy: null, verifiedAt: null, notes: null,
      });
      const token = generateToken();

      const res = await request(app)
        .post('/api/training/start/2')
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('in_progress');
    });
  });

  describe('POST /api/training/submit-quiz/:courseId', () => {
    it('should validate quiz submission body', async () => {
      const token = generateToken();

      const res = await request(app)
        .post('/api/training/submit-quiz/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ contentRevision:1, answers: [] });

      expect(res.status).toBe(400);
    });

    it('should submit quiz with valid answers', async () => {
      mockSubmitQuiz.mockResolvedValue({
        passed: true,
        score: 100,
        totalQuestions: 2,
        correctAnswers: 2,
        certificateNumber: 'AT-CERT-GCP-101-1-TEST',
        expirationDate: '2027-05-04',
      });
      const token = generateToken();

      const res = await request(app)
        .post('/api/training/submit-quiz/1')
        .set('Authorization', `Bearer ${token}`)
        .send({
          recordId:1,cycleId:'11111111-1111-4111-8111-111111111111',requestId:'22222222-2222-4222-8222-222222222222',
          contentRevision:1, answers: [
            { questionId: 1, selectedOptions: [0] },
            { questionId: 2, selectedOptions: [1] },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.passed).toBe(true);
      expect(res.body.data.certificateNumber).toBeDefined();
    });
  });

  describe('GET /api/training/my-records', () => {
    it('should return current user records', async () => {
      mockGetMyRecords.mockResolvedValue([
        {
          id: 1, userId: 1, courseId: 1, courseName: 'GCP', courseCode: 'GCP-101',
          status: 'completed', startedAt: '2026-01-01', completedAt: '2026-01-02',
          score: 90, attempts: 1, certificateNumber: 'AT-CERT-123',
          expirationDate: '2027-01-02', verifiedBy: null, verifiedAt: null, notes: null,
        },
      ]);
      const token = generateToken();

      const res = await request(app)
        .get('/api/training/my-records')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('completed');
    });
  });

  describe('GET /api/training/compliance', () => {
    it('should return compliance statuses', async () => {
      mockGetComplianceStatus.mockResolvedValue([
        {
          userId: 1, username: 'testuser', userFullName: 'Test User',
          role: 'admin', totalRequired: 3, completed: 2, expired: 0,
          pending: 1, compliancePercentage: 67, isCompliant: false,
          missingCourses: [{ courseCode: 'HIPAA-101', courseName: 'HIPAA', requiredBy: 'HIPAA §164.308(a)(5)' }],
        },
      ]);
      const token = generateToken();

      const res = await request(app)
        .get('/api/training/compliance')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].isCompliant).toBe(false);
      expect(res.body.data[0].missingCourses).toHaveLength(1);
    });
  });

  describe('GET /api/training/user/:userId/is-compliant', () => {
    it('should return compliance check result', async () => {
      mockCheckUserCompliance.mockResolvedValue({
        userId: 5, isCompliant: true, missingCount: 0, expiredCount: 0,
      });
      const token = generateToken();

      const res = await request(app)
        .get('/api/training/user/5/is-compliant')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isCompliant).toBe(true);
    });
  });
  test.each(['0', '-1', '1.5', '1abc', '', '1&studyId=2'])('rejects malformed supplied study scope %s before calling services', async value => {
    const response = await request(app).get(`/api/training/compliance?studyId=${value}`).set('Authorization', `Bearer ${generateToken()}`);
    expect(response.status).toBe(400); expect(mockGetComplianceStatus).not.toHaveBeenCalled();
  });
  test('preserves exact explicit user and study scope at the DTO boundary', async () => {
    mockGetComplianceStatus.mockResolvedValue([]);
    expect((await request(app).get('/api/training/compliance?studyId=5&userId=7').set('Authorization', `Bearer ${generateToken()}`)).status).toBe(200);
    expect(mockGetComplianceStatus).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 1 }), { studyId: 5, userId: 7 });
  });

  test.each(['data_manager', 'study_director'])('actual course route accepts governed management role %s', async role => {
    mockCreateCourse.mockResolvedValue({ id: 10, courseCode: 'OWNED-ROLE', requiredForRoles: [role] });
    const response = await request(app).post('/api/training/courses').set('Authorization', `Bearer ${generateToken({ role })}`)
      .send({ courseCode: 'OWNED-ROLE', courseName: 'Owned role course', version: '1', passingScore: 80, requiredForRoles: [role] });
    expect(response.status).toBe(201); expect(mockCreateCourse).toHaveBeenCalledTimes(1);
  });

  test('course route accepts legacy empty email while preserving actor identity', async () => {
    mockCreateCourse.mockResolvedValue({ id:10, courseCode:'OWNED-LEGACY', requiredForRoles:['admin'] });
    const response = await request(app).post('/api/training/courses').set('Authorization', `Bearer ${generateToken({email:''})}`)
      .send({courseCode:'OWNED-LEGACY',courseName:'Owned legacy',version:'1',passingScore:80,requiredForRoles:['admin']});
    expect(response.status).toBe(201); expect(mockCreateCourse.mock.calls[0][1]).toBe(1);
  });
  test('learning-path role uses the same canonical data-manager identity', async () => {
    const response = await request(app).get('/api/training/learning-paths').set('Authorization', `Bearer ${generateToken({role:'data_manager'})}`);
    expect(response.status).toBe(200);
    expect(response.body.data.find((path:any) => path.id==='data-manager-path').targetRole).toBe('data_manager');
  });


  describe('training read privacy', () => {
    const readMocks = [mockGetComplianceStatus, mockGetExpiringTraining, mockCheckUserCompliance];
    beforeEach(() => {
      mockGetComplianceStatus.mockResolvedValue([]);
      mockGetExpiringTraining.mockResolvedValue([]);
      mockCheckUserCompliance.mockImplementation(async (userId: number) => ({ userId, isCompliant: false, missingCount: 1, expiredCount: 0 }));
    });
    const routes = ['/compliance', '/compliance?studyId=5', '/compliance?userId=2', '/user/2/is-compliant', '/expiring'];
    test.each(routes)('rejects unrelated viewer access to %s before any data service', async route => {
      const response = await request(app).get(`/api/training${route}`)
        .set('Authorization', `Bearer ${generateToken({ role: 'viewer' })}`);
      expect(response.status).toBe(403);
      for (const read of readMocks) expect(read).not.toHaveBeenCalled();
    });
    test.each(['coordinator', 'investigator'])(
      'does not widen global reads to the non-oversight role %s', async role => {
        for (const route of routes) {
          const response = await request(app).get(`/api/training${route}`)
            .set('Authorization', `Bearer ${generateToken({ role })}`);
          expect(response.status).toBe(403);
        }
        for (const read of readMocks) expect(read).not.toHaveBeenCalled();
      });
    test.each(['viewer', 'coordinator', 'investigator'])(
      'allows exact self compliance reads for %s without widening the query', async role => {
        const bearer = generateToken({ role });
        expect((await request(app).get('/api/training/compliance?userId=1&studyId=5')
          .set('Authorization', `Bearer ${bearer}`)).status).toBe(200);
        expect(mockGetComplianceStatus).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 1 }), { userId: 1, studyId: 5 });
        const response = await request(app).get('/api/training/user/1/is-compliant').set('Authorization', `Bearer ${bearer}`);
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({ userId: 1, isCompliant: false, missingCount: 1, expiredCount: 0 });
        expect(mockCheckUserCompliance).toHaveBeenCalledWith(1, expect.objectContaining({ actorUserId: 1 }));
        expect(mockGetExpiringTraining).not.toHaveBeenCalled();
      });
    test.each(['admin', 'data_manager', 'monitor', 'study_director'])(
      'preserves existing oversight access for %s and governed aliases', async role => {
        for (const route of routes) {
          const response = await request(app).get(`/api/training${route}`)
            .set('Authorization', `Bearer ${generateToken({ role })}`);
          expect(response.status).toBe(200);
        }
        expect(mockGetComplianceStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({ actorUserId: 1 }), { userId: undefined, studyId: undefined });
        expect(mockGetComplianceStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({ actorUserId: 1 }), { userId: undefined, studyId: 5 });
        expect(mockGetComplianceStatus).toHaveBeenNthCalledWith(3, expect.objectContaining({ actorUserId: 1 }), { userId: 2, studyId: undefined });
        expect(mockCheckUserCompliance).toHaveBeenCalledWith(2, expect.objectContaining({ actorUserId: 1 }));
        expect(mockGetExpiringTraining).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 1 }), 30);
      });
    test.each(['0', '-1', '1.5', '1abc', '01', '0x1', '1e0', '9007199254740992'])(
      'refuses malformed target %s even for an oversight actor without reading data', async target => {
        for (const route of [`/compliance?userId=${target}`, `/user/${target}/is-compliant`]) {
          const response = await request(app).get(`/api/training${route}`)
            .set('Authorization', `Bearer ${generateToken()}`);
          expect(response.status).toBe(400);
        }
        for (const read of readMocks) expect(read).not.toHaveBeenCalled();
      });
    test.each(['userId=', 'userId[]=1', 'userId=1&userId=2', 'userId[member]=1'])(
      'does not coerce ambiguous self query %s into permission', async query => {
        const response = await request(app).get(`/api/training/compliance?${query}`)
          .set('Authorization', `Bearer ${generateToken({ role: 'viewer' })}`);
        expect(response.status).toBe(400);
        for (const read of readMocks) expect(read).not.toHaveBeenCalled();
      });
    test.each(['constructor', 'unknown-role'])(
      'refuses fresh unknown authority role %s before data reads', async role => {
        const response = await request(app).get('/api/training/compliance?userId=1')
          .set('Authorization', `Bearer ${generateToken({ role })}`);
        expect(response.status).toBe(503);
        for (const read of readMocks) expect(read).not.toHaveBeenCalled();
      });
    test('fresh viewer authority cannot retain a stale administrator read grant', async () => {
      const bearer = generateToken({ role: 'admin' });
      (globalThis.fetch as jest.Mock).mockImplementation(async (_url, options) => {
        const token = new Headers(options?.headers).get('Authorization')!.slice('Bearer '.length);
        const decoded = createJwtService({ secret: JWT_SECRET }).verifyAccessToken(token);
        return new Response(JSON.stringify(decoded ? { success: true, data: {
          userId: decoded.userId, username: decoded.username, email: decoded.email, role: 'viewer',
          userType: 'user', studyIds: [], organizationIds: [1],
        } } : { success: false }), { status: decoded ? 200 : 401 });
      });
      expect((await request(app).get('/api/training/compliance?userId=2')
        .set('Authorization', `Bearer ${bearer}`)).status).toBe(403);
      for (const read of readMocks) expect(read).not.toHaveBeenCalled();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    test('preserves the existing separate self-record and oversight-record routes', async () => {
      mockGetMyRecords.mockResolvedValue([]);
      const bearer = generateToken({ role: 'viewer' });
      expect((await request(app).get('/api/training/user/1/records').set('Authorization', `Bearer ${bearer}`)).status).toBe(403);
      expect((await request(app).get('/api/training/my-records').set('Authorization', `Bearer ${bearer}`)).status).toBe(200);
      expect(mockGetMyRecords).toHaveBeenCalledWith(1);
    });
  });
  describe('Part 11 signature routes (receipts come only from the EDC proxy)', () => {
    const receipt = { schemaVersion: 'training-signature-receipt/1', signatureId: 501, decision: 'verification' };
    const bearer = (role = 'admin') => `Bearer ${generateToken({ role })}`;
    const draftPath = '/api/training/material-drafts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/approval-signature';
    test('verification passes a receipt object through, and without one stays the unsigned call', async () => {
      mockVerifyTraining.mockResolvedValue({ verified: true });
      const unsigned = await request(app).post('/api/training/verify/5').set('Authorization', bearer('monitor')).send({ notes: 'Synthetic' });
      expect(unsigned.body.data).toEqual({ verified: true });
      expect(mockVerifyTraining).toHaveBeenLastCalledWith(5, expect.objectContaining({ actorUserId: 1 }), 'Synthetic', expect.anything(),
        { signatureReceipt: undefined, auditContext: { ipAddress: expect.any(String), userAgent: undefined }, effort: { workStartedAt: undefined, actorRole: 'monitor' } });
      await request(app).post('/api/training/verify/5').set('Authorization', bearer('monitor')).send({ notes: 'Synthetic', signatureReceipt: receipt });
      expect(mockVerifyTraining.mock.calls.at(-1)![4].signatureReceipt).toEqual(receipt);
    });
    test.each([['a string', 'signed'], ['an array', [receipt]], ['null', null]])('a receipt that is %s is refused 400 before any service', async (_name, value) => {
      for (const route of ['/verify/5', '/verify/5/signature', '/attest/5']) {
        expect((await request(app).post(`/api/training${route}`).set('Authorization', bearer()).send({ signatureReceipt: value })).status).toBe(400);
      }
      for (const service of [mockVerifyTraining, mockSignTrainingVerification, mockAttestTraining]) expect(service).not.toHaveBeenCalled();
    });
    test('attestation and the signature of a recorded verification require a receipt', async () => {
      expect((await request(app).post('/api/training/attest/5').set('Authorization', bearer('coordinator')).send({})).status).toBe(400);
      expect((await request(app).post('/api/training/verify/5/signature').set('Authorization', bearer()).send({ notes: 'no receipt' })).status).toBe(400);
      mockAttestTraining.mockResolvedValue({ attested: true, replayed: false, signature: { signatureId: 501 } });
      const attested = await request(app).post('/api/training/attest/5').set('Authorization', bearer('coordinator')).send({ signatureReceipt: receipt });
      expect(attested.status).toBe(200);
      expect(attested.body.data).toEqual({ attested: true, replayed: false, signature: { signatureId: 501 } });
      expect(mockAttestTraining).toHaveBeenCalledWith(5, expect.objectContaining({ actorUserId: 1 }), receipt, expect.objectContaining({ ipAddress: expect.any(String) }),
        { workStartedAt: undefined, actorRole: 'coordinator' });
    });
    test('only verifier roles sign a recorded verification, and only training managers sign material approval', async () => {
      expect((await request(app).post('/api/training/verify/5/signature').set('Authorization', bearer('coordinator')).send({ signatureReceipt: receipt })).status).toBe(403);
      expect((await request(app).post(draftPath).set('Authorization', bearer('monitor')).send({ signatureReceipt: receipt })).status).toBe(403);
      mockSignTrainingVerification.mockResolvedValue({ signed: true });
      expect((await request(app).post('/api/training/verify/5/signature').set('Authorization', bearer('investigator')).send({ signatureReceipt: receipt })).status).toBe(200);
      expect(mockSignTrainingVerification).toHaveBeenCalledWith(5, expect.objectContaining({ actorUserId: 1 }), receipt, expect.anything());
    });
    test('the signature subject route dispatches exact completion selectors and never caches', async () => {
      mockReadRecordSignatureSubject.mockResolvedValue({ subject: { kind: 'completion-attestation' }, subjectHash: 'a'.repeat(64), binding: { status: 'unbound' } });
      const read = await request(app).get('/api/training/signature-subject?kind=completion-attestation&recordId=5&studyId=100&siteId=101').set('Authorization', bearer('coordinator'));
      expect(read.status).toBe(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(mockReadRecordSignatureSubject).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 1 }),
        { kind: 'completion-attestation', recordId: 5, context: { studyId: 100, siteId: 101 } });
      await request(app).get('/api/training/signature-subject?kind=verification&recordId=5&studyId=100').set('Authorization', bearer('investigator'));
      expect(mockReadRecordSignatureSubject).toHaveBeenLastCalledWith(expect.anything(), { kind: 'verification', recordId: 5, context: { studyId: 100 } });
    });
    test.each([
      ['a verification subject for a non-verifier role', 'kind=verification&recordId=5&studyId=100', 'coordinator', 403],
      ['a material subject for a non-manager role', 'kind=material-approval&draftId=x', 'monitor', 403],
      ['no kind', 'recordId=5&studyId=100', 'admin', 400],
      ['the reserved matrix kind', 'kind=matrix-approval&recordId=5&studyId=100', 'admin', 400],
      ['no study context', 'kind=completion-attestation&recordId=5', 'admin', 400],
      ['an arm selector', 'kind=completion-attestation&recordId=5&studyId=100&armId=7', 'admin', 400],
      ['a malformed record', 'kind=verification&recordId=05&studyId=100', 'admin', 400],
      ['a repeated study', 'kind=verification&recordId=5&studyId=100&studyId=101', 'admin', 400],
      ['a record selector on a material subject', 'kind=material-approval&draftId=x&recordId=5', 'admin', 400],
    ])('refuses %s before any service', async (_name, query, role, status) => {
      expect((await request(app).get(`/api/training/signature-subject?${query}`).set('Authorization', bearer(role))).status).toBe(status);
      expect(mockReadRecordSignatureSubject).not.toHaveBeenCalled();
    });
  });
  describe('T-4 effort input of the three effort decisions', () => {
    const bearer = (role = 'admin') => `Bearer ${generateToken({ role })}`;
    const stated = '2026-10-24T09:10:00.000Z';
    test('the forwarded X-Work-Started-At and the authenticated platform role reach the service unchanged; the body field never does', async () => {
      mockSubmitQuiz.mockResolvedValue({ passed: true, score: 100, totalQuestions: 1, correctAnswers: 1 });
      const quiz = { recordId: 1, cycleId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', contentRevision: 1,
        answers: [{ questionId: 1, selectedOptions: [0] }] };
      expect((await request(app).post('/api/training/submit-quiz/1').set('Authorization', bearer('coordinator')).set('X-Work-Started-At', stated)
        .send({ ...quiz, workStartedAt: '2026-10-24T01:00:00.000Z' })).status).toBe(200);
      expect(mockSubmitQuiz.mock.calls.at(-1)![8]).toEqual({ workStartedAt: stated, actorRole: 'coordinator' });
      mockVerifyTraining.mockResolvedValue({ verified: true });
      await request(app).post('/api/training/verify/5').set('Authorization', bearer('investigator')).set('X-Work-Started-At', stated).send({ notes: 'Synthetic' });
      expect(mockVerifyTraining.mock.calls.at(-1)![4].effort).toEqual({ workStartedAt: stated, actorRole: 'investigator' });
      mockAttestTraining.mockResolvedValue({ attested: true, replayed: false });
      await request(app).post('/api/training/attest/5').set('Authorization', bearer('coordinator')).set('X-Work-Started-At', 'not an instant')
        .send({ signatureReceipt: { schemaVersion: 'training-signature-receipt/1' } });
      // The service applies the EDC rule; an unusable value is passed as stated and falls through there, never refused here.
      expect(mockAttestTraining.mock.calls.at(-1)![4]).toEqual({ workStartedAt: 'not an instant', actorRole: 'coordinator' });
    });
    test('the effort observation is a machine route ahead of human authentication, 503 whatever the request while the ledger is off', async () => {
      const route = '/api/training/effort-source/observe';
      for (const call of [request(app).post(route).send({}), request(app).post(`${route}?studyId=1`).set('Authorization', bearer()).send({ any: 'thing' })]) {
        const off = await call;
        expect([off.status, off.body.error.code, off.headers['cache-control']]).toEqual([503, 'TRAINING_EFFORT_DISABLED', 'no-store']);
      }
      process.env.TRAINING_EFFORT_LEDGER_ENABLED = 'true';
      try {
        // A human bearer is not a machine credential, and nothing reaches the native authority before the request is exact.
        expect((await request(app).post(route).set('Authorization', bearer()).send({})).body.error.code).toBe('TRAINING_EFFORT_SERVICE_CREDENTIAL_REQUIRED');
        expect((await request(app).post(`${route}?studyId=1`).set('x-api-key', 'atk_synthetic').send({})).body.error.code).toBe('TRAINING_EFFORT_INVALID_REQUEST');
        expect((await request(app).post(route).set('x-api-key', 'atk_synthetic').send({ schemaVersion: 'training-effort-observation-request/1' })).status).toBe(400);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally { delete process.env.TRAINING_EFFORT_LEDGER_ENABLED; }
    });
  });
});
