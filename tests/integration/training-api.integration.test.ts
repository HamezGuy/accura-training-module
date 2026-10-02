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
const mockVerifyTraining = jest.fn();
const mockGetComplianceStatus = jest.fn();
const mockGetExpiringTraining = jest.fn();
const mockCheckUserCompliance = jest.fn();

jest.mock('../../src/services/training.service', () => ({
  getCourses: (...args: unknown[]) => mockGetCourses(...args),
  getCourseById: (...args: unknown[]) => mockGetCourseById(...args),
  createCourse: (...args: unknown[]) => mockCreateCourse(...args),
  startTraining: (...args: unknown[]) => mockStartTraining(...args),
  submitQuiz: (...args: unknown[]) => mockSubmitQuiz(...args),
  getMyRecords: (...args: unknown[]) => mockGetMyRecords(...args),
  verifyTraining: (...args: unknown[]) => mockVerifyTraining(...args),
  getComplianceStatus: (...args: unknown[]) => mockGetComplianceStatus(...args),
  getExpiringTraining: (...args: unknown[]) => mockGetExpiringTraining(...args),
  checkUserCompliance: (...args: unknown[]) => mockCheckUserCompliance(...args),
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
        .send({ answers: [] });

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
          answers: [
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
    expect(mockGetComplianceStatus).toHaveBeenCalledWith({ studyId: 5, userId: 7 });
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

});
