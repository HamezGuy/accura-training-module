import type {TrainingRecord} from '../types/training.types';

/** Learner/manager record projection. Retained snapshots and grading keys stay
 * in the evidence store; neither current nor historical API records expose them. */
export function mapRecordToDto(r: TrainingRecord): TrainingRecord {
  return {
    id: r.id,
    userId: r.userId,
    courseId: r.courseId,
    courseName: r.courseName,
    courseCode: r.courseCode,
    courseVersion: r.courseVersion ?? null,
    contentRevision: r.contentRevision ?? null,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    score: r.score,
    attempts: r.attempts,
    certificateNumber: r.certificateNumber,
    expirationDate: r.expirationDate,
    verifiedBy: r.verifiedBy,
    verifiedByName: r.verifiedByName,
    verifiedAt: r.verifiedAt,
    notes: r.notes,
    assessmentCycleId:r.assessmentCycleId??null,
    assessmentEvidence:r.assessmentCycleId?'retained_assessment_cycle':'legacy_summary_only',
    assessmentReceipt:r.assessmentReceipt?{id:r.assessmentReceipt.id,hash:r.assessmentReceipt.hash,cycleId:r.assessmentReceipt.cycleId,attemptNumber:r.assessmentReceipt.attemptNumber}:null,
  };
}
