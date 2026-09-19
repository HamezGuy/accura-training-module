import * as trainingService from '../../src/services/training.service';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../src/config/database', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (fn: unknown) => mockTransaction(fn),
}));

jest.mock('../../src/config/logger', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../../src/services/certificate.service', () => ({
  generateCertificateNumber: jest.fn().mockReturnValue('AT-CERT-GCP-101-1-TEST123-ABC456'),
  calculateExpirationDate: jest.fn().mockReturnValue(new Date('2027-05-04T00:00:00.000Z')),
}));

describe('TrainingService', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQueryOne.mockReset();
    mockTransaction.mockReset();
  });

  describe('getCourses', () => {
    it('should return all active courses by default', async () => {
      const mockCourses = [
        { id: 1, courseCode: 'GCP-101', courseName: 'GCP Fundamentals', active: true },
        { id: 2, courseCode: 'CFR11-101', courseName: 'CFR Part 11', active: true },
      ];
      mockQuery.mockResolvedValue({ rows: mockCourses, rowCount: 2 });

      const result = await trainingService.getCourses();

      expect(result).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('active = $1'),
        [true]
      );
    });

    it('should filter by role when specified', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await trainingService.getCourses({ role: 'monitor' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('required_for_roles'),
        expect.arrayContaining([JSON.stringify(['monitor'])])
      );
    });
  });

  describe('getCourseById', () => {
    it('should return null for non-existent course', async () => {
      mockQueryOne.mockResolvedValue(null);

      const result = await trainingService.getCourseById(999);

      expect(result).toBeNull();
    });

    it('should return course without questions by default', async () => {
      mockQueryOne.mockResolvedValue({
        id: 1,
        courseCode: 'GCP-101',
        courseName: 'GCP Fundamentals',
        passingScore: 80,
      });

      const result = await trainingService.getCourseById(1);

      expect(result).toBeDefined();
      expect(result!.courseCode).toBe('GCP-101');
      expect(result!.questions).toBeUndefined();
    });

    it('should strip isCorrect from options when including questions', async () => {
      mockQueryOne.mockResolvedValue({
        id: 1,
        courseCode: 'GCP-101',
        courseName: 'GCP Fundamentals',
        passingScore: 80,
      });
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 1,
            courseId: 1,
            questionText: 'Test question?',
            questionType: 'multiple_choice',
            options: [
              { text: 'A', isCorrect: true },
              { text: 'B', isCorrect: false },
            ],
            explanation: 'A is correct',
            orderIndex: 1,
          },
        ],
        rowCount: 1,
      });

      const result = await trainingService.getCourseById(1, true);

      expect(result!.questions).toHaveLength(1);
      expect(result!.questions![0].options[0]).not.toHaveProperty('isCorrect');
      expect(result!.questions![0].options[0].text).toBe('A');
    });
  });

  describe('startTraining', () => {
    it('should throw 404 for non-existent or inactive course', async () => {
      mockQueryOne.mockResolvedValue(null);

      await expect(trainingService.startTraining(1, 999)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('should throw 409 if training already completed', async () => {
      mockQueryOne
        .mockResolvedValueOnce({ id: 1, courseCode: 'GCP-101', active: true })
        .mockResolvedValueOnce({ id: 10, userId: 1, courseId: 1, status: 'completed' });

      await expect(trainingService.startTraining(1, 1)).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it('should create new record if none exists', async () => {
      mockQueryOne
        .mockResolvedValueOnce({ id: 1, courseCode: 'GCP-101', active: true })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 10, userId: 1, courseId: 1, status: 'in_progress', startedAt: new Date() });

      const result = await trainingService.startTraining(1, 1);

      expect(result.status).toBe('in_progress');
      expect(mockQueryOne).toHaveBeenCalledTimes(3);
    });
  });

  describe('submitQuiz', () => {
    it('should throw 404 for non-existent course', async () => {
      mockQueryOne.mockResolvedValue(null);

      await expect(trainingService.submitQuiz(1, 999, [])).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('should throw 400 if no questions exist', async () => {
      mockQueryOne.mockResolvedValue({ id: 1, courseCode: 'GCP-101', passingScore: 80 });
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await expect(trainingService.submitQuiz(1, 1, [])).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('should grade quiz correctly and return result via transaction', async () => {
      mockQueryOne.mockResolvedValue({ id: 1, courseCode: 'GCP-101', passingScore: 80, validityPeriodDays: 365 });
      mockQuery.mockResolvedValue({
        rows: [
          { id: 1, courseId: 1, options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }], questionType: 'multiple_choice', questionText: 'Q1', orderIndex: 1 },
          { id: 2, courseId: 1, options: [{ text: 'True', isCorrect: true }, { text: 'False', isCorrect: false }], questionType: 'true_false', questionText: 'Q2', orderIndex: 2 },
        ],
        rowCount: 2,
      });

      const mockTxResult = {
        passed: true,
        score: 100,
        totalQuestions: 2,
        correctAnswers: 2,
        certificateNumber: 'AT-CERT-GCP-101-1-TEST123-ABC456',
        expirationDate: '2027-05-04T00:00:00.000Z',
      };
      mockTransaction.mockImplementation(async (_fn: Function) => {
        return mockTxResult;
      });

      const result = await trainingService.submitQuiz(1, 1, [
        { questionId: 1, selectedOptions: [0] },
        { questionId: 2, selectedOptions: [0] },
      ]);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(100);
      expect(result.certificateNumber).toBeDefined();
    });
  });

  describe('verifyTraining', () => {
    it('should throw 404 if record not found', async () => {
      mockQueryOne.mockResolvedValue(null);

      await expect(trainingService.verifyTraining(999, 2)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('should throw 400 if training not completed', async () => {
      mockQueryOne.mockResolvedValue({ id: 1, userId: 3, status: 'in_progress' });

      await expect(trainingService.verifyTraining(1, 2)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('should throw 403 if user tries to verify own training', async () => {
      mockQueryOne.mockResolvedValue({ id: 1, userId: 2, status: 'completed' });

      await expect(trainingService.verifyTraining(1, 2)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('should verify completed training by another user', async () => {
      mockQueryOne.mockResolvedValue({ id: 1, userId: 3, status: 'completed' });
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const result = await trainingService.verifyTraining(1, 2, 'Verified during audit');

      expect(result.verified).toBe(true);
    });
  });

  describe('getExpiringTraining', () => {
    it('should query for records expiring within specified days', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await trainingService.getExpiringTraining(14);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INTERVAL '1 day' * $1"),
        [14]
      );
    });

    it('should default to 30 days', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await trainingService.getExpiringTraining();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [30]
      );
    });
  });

  describe('expireOverdueRecords', () => {
    it('should update overdue records to expired status', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });

      const count = await trainingService.expireOverdueRecords();

      expect(count).toBe(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'expired'"),
      );
    });
  });

  describe('exact compliance identity', () => {
    it('cannot report an absent user as compliant', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(trainingService.checkUserCompliance(77)).rejects.toMatchObject({ statusCode: 404 });
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][1]).toEqual([77]);
    });

    it.each([0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid user identity %s before reading records', async userId => {
      await expect(trainingService.checkUserCompliance(userId)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('propagates a failed user read rather than manufacturing compliant empty state', async () => {
      const failure = new Error('Identity storage unavailable');
      mockQuery.mockRejectedValue(failure);
      await expect(trainingService.checkUserCompliance(77)).rejects.toBe(failure);
    });

    it('refuses a successful-looking compliance result for a different user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ userId: 78, username: 'other', firstName: 'Other', lastName: 'Person', role: 'monitor' }],
        rowCount: 1,
      }).mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(trainingService.checkUserCompliance(77)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('keeps the existing required-course calculation for an exact known user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ userId: 77, username: 'known', firstName: 'Known', lastName: 'Person', role: 'monitor' }],
        rowCount: 1,
      }).mockResolvedValueOnce({
        rows: [{ courseCode: 'REQUIRED-1', courseName: 'Required course', regulatoryReference: null }],
        rowCount: 1,
      }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(trainingService.checkUserCompliance(77)).resolves.toEqual({
        userId: 77, isCompliant: false, missingCount: 1, expiredCount: 0,
      });
    });
  });
});
