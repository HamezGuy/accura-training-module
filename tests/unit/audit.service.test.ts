import { logAudit } from '../../src/services/audit.service';

const mockQuery = jest.fn();

jest.mock('../../src/config/database', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

jest.mock('../../src/config/logger', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('AuditService', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('logAudit', () => {
    it('should insert audit record with all fields', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      await logAudit({
        userId: 1,
        action: 'training_started',
        recordId: 5,
        courseId: 2,
        details: { reason: 'new hire' },
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO acc_training_audit_log'),
        [1, 'training_started', 5, 2, '{"reason":"new hire"}', '192.168.1.1', 'Mozilla/5.0']
      );
    });

    it('should handle missing optional fields with null', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      await logAudit({
        userId: 3,
        action: 'quiz_passed',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO acc_training_audit_log'),
        [3, 'quiz_passed', null, null, '{}', null, null]
      );
    });

    it('should not throw on database error (logs instead)', async () => {
      mockQuery.mockRejectedValue(new Error('Connection lost'));

      await expect(
        logAudit({ userId: 1, action: 'training_started' })
      ).resolves.toBeUndefined();
    });
  });
});
