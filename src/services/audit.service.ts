import { query, TransactionClient } from '../config/database';
import {createHash} from 'node:crypto';

export function canonicalTrainingEvidence(value:any):string {
 if(Array.isArray(value))return `[${value.map(canonicalTrainingEvidence).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalTrainingEvidence(value[key])}`).join(',')}}`;
 return JSON.stringify(value);
}
export const trainingEvidenceHash=(value:unknown)=>createHash('sha256').update(canonicalTrainingEvidence(value)).digest('hex');

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
  | 'obligation_assigned'
  | 'obligation_revised'
  | 'obligation_withdrawn'
  | 'training_impact_proposed'
  | 'training_impact_reviewed'
  | 'training_impact_rejected'
  | 'training_impact_applied'
  | 'training_impact_cancelled'
  | 'training_material_drafted'
  | 'training_material_reviewed'
  | 'training_material_rejected'
  | 'training_material_published'
  | 'compliance_checked';

interface AuditFields {
  recordId?: number;
  courseId?: number;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

type AuditEntry = AuditFields & (
  | { userId: number; action: AuditAction }
  | { userId: null; action: 'training_expired'; details: {
      actor: 'scheduled-expiration'; affectedUserId: number; [key: string]: unknown;
    } }
);

// A mutation's caller supplies its transaction client. An audit failure must
// reject that same transaction; success must never mean "state without audit".
export async function logAudit(entry: AuditEntry, client: Pick<TransactionClient, 'query'> = { query }): Promise<void> {
  await client.query(
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
}
