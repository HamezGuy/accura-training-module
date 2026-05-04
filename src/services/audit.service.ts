import { query } from '../config/database';
import { logger } from '../config/logger';

export type AuditAction =
  | 'course_created'
  | 'course_updated'
  | 'questions_added'
  | 'training_started'
  | 'quiz_submitted'
  | 'quiz_passed'
  | 'quiz_failed'
  | 'training_verified'
  | 'training_expired'
  | 'compliance_checked';

interface AuditEntry {
  userId: number;
  action: AuditAction;
  recordId?: number;
  courseId?: number;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO acc_training_audit_log 
       (user_id, action, record_id, course_id, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.userId,
        entry.action,
        entry.recordId ?? null,
        entry.courseId ?? null,
        JSON.stringify(entry.details ?? {}),
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
      ]
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to write audit log', { entry, error: message });
  }
}
