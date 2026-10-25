/**
 * Re-export shared-types for internal use.
 * This module also re-defines the types locally so the training module
 * can be built standalone without depending on the shared-types package directly.
 * When shared-types is linked, these serve as the canonical types.
 */

export interface TrainingCourse {
  id: number;
  courseCode: string;
  courseName: string;
  description: string | null;
  version: string;
  contentRevision?: number;
  durationMinutes: number | null;
  passingScore: number;
  requiredForRoles: string[];
  regulatoryReference: string | null;
  active: boolean;
  validityPeriodDays: number | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  questions?: TrainingQuizQuestion[];
  materialScope?: {studyId:number;siteId?:number} | null;
  materialDraftId?: string | null;
  materialPublicationId?: string | null;
  /** Request-local result; never a stored authorization flag. */
  materialReady?: boolean;
}

export interface CreateCourseRequest {
  courseCode: string;
  courseName: string;
  description?: string;
  version: string;
  durationMinutes?: number;
  passingScore: number;
  requiredForRoles: string[];
  regulatoryReference?: string;
  validityPeriodDays?: number;
}

export interface UpdateCourseRequest {
  courseName?: string;
  description?: string;
  version?: string;
  durationMinutes?: number;
  passingScore?: number;
  requiredForRoles?: string[];
  regulatoryReference?: string;
  active?: boolean;
  validityPeriodDays?: number;
}

export interface TrainingQuizQuestion {
  id: number;
  courseId: number;
  questionText: string;
  questionType: 'multiple_choice' | 'true_false' | 'multi_select';
  options: TrainingQuizOption[];
  explanation: string | null;
  orderIndex: number;
}

export interface TrainingQuizOption {
  text: string;
  isCorrect?: boolean;
}

export interface TrainingQuizAnswer {
  questionId: number;
  selectedOptions: number[];
}

export interface TrainingAssessmentReference { id:string; hash:string; cycleId:string; attemptNumber:number }
export interface TrainingQuizSubmission { recordId:number; cycleId:string; requestId:string }
export interface TrainingQuizResult {
  passed: boolean;
  score: number;
  totalQuestions: number;
  correctAnswers: number;
  certificateNumber?: string;
  expirationDate?: string;
  receipt?:TrainingAssessmentReference;
  replayed?:boolean;
  evidenceStatus?:'recorded_assessment'|'historical_assessment';
}


export interface CreateQuestionRequest {
  questionText: string;
  questionType: 'multiple_choice' | 'true_false' | 'multi_select';
  options: TrainingQuizOption[];
  explanation?: string;
  orderIndex: number;
}

export type TrainingRecordStatus = 'not_started' | 'in_progress' | 'completed' | 'expired';

export interface TrainingRecord {
  id: number;
  userId: number;
  courseId: number;
  courseName?: string;
  courseCode?: string;
  courseVersion?: string | null;
  contentRevision?: number | null;
  /** Internal evidence only; controllers must never expose stored quiz answers. */
  contentSnapshot?: unknown;
  assessmentCycleId?: string | null;
  assessmentReceipt?: TrainingAssessmentReference | null;
  /** Evidence category only; retained-cycle presence is not current qualification. */
  assessmentEvidence?: 'retained_assessment_cycle' | 'legacy_summary_only';
  /** Request-local integrity classification; never a persisted authorization grant. */
  assessmentEvidenceVerified?: boolean;
  status: TrainingRecordStatus;
  startedAt: string | null;
  completedAt: string | null;
  score: number | null;
  attempts: number;
  certificateNumber: string | null;
  expirationDate: string | null;
  verifiedBy: number | null;
  verifiedByName?: string;
  verifiedAt: string | null;
  notes: string | null;
}

export interface TrainingInspectionEvidence {
  schemaVersion:'training-inspection-evidence/1';nonce:string;nativeStudyId:number;actorUserId:number;
  studyIds:number[];scopes:Array<{studyId:number;siteId?:number}>;capturedAt:string;observedAt:string;
  consistency:'training-snapshot-with-separate-native-observations';authorityHash:string;complete:true;
  tables:Array<{table:string;count:number;contentHash:string;rows:Array<{nativeJson:string;sha256:string}>}>;
  materialSources:TrainingMaterialSource[];sourceChecks:Array<{sourceHash:string;current:boolean}>;
  impactSources:Array<{scope:{studyId:number;siteId?:number};source:TrainingImpactSource}>;
  impactChecks:Array<{nativeSourceHash:string;lifecycleRevision:number;current:boolean}>;
  originalPins:Array<{fileId:string;sha256:string;nativeStudyId:number}>;gaps:string[];limitations:string[];evidenceHash:string;
}
/** One hashed segment of a training-inspection-evidence/2 capture (contracts/training-inspection-evidence-v2.schema.json). */
export interface TrainingInspectionSegmentDescriptor {ordinal:number;table:string;count:number;contentHash:string;bytes:number}
/** training-inspection-evidence/2: the /1 snapshot plus two tables as a manifest of segments, without rows. */
export interface TrainingInspectionManifest extends Omit<TrainingInspectionEvidence,'schemaVersion'|'tables'> {
  schemaVersion:'training-inspection-evidence/2';captureId:string;
  limits:{maxSegments:number;maxSegmentRows:number;maxSegmentBytes:number};
  segments:TrainingInspectionSegmentDescriptor[];manifestHash:string;
}
/** training-inspection-segment/1 (contracts/training-inspection-segment-v1.schema.json). */
export interface TrainingInspectionSegment extends TrainingInspectionSegmentDescriptor {
  schemaVersion:'training-inspection-segment/1';captureId:string;manifestHash:string;rows:Array<{nativeJson:string;sha256:string}>;
}

export interface TrainingComplianceStatus {
  userId: number;
  username: string;
  userFullName: string;
  role: string;
  totalRequired: number;
  completed: number;
  expired: number;
  pending: number;
  compliancePercentage: number;
  isCompliant: boolean;
  missingCourses: TrainingMissingCourse[];
  totalObligations?: number;
  completedObligations?: number;
  overdueObligations?: number;
}

export interface TrainingMissingCourse {
  courseCode: string;
  courseName: string;
  requiredBy: string;
}

export interface SubmitQuizRequest {
  answers: TrainingQuizAnswer[];
}

export interface VerifyTrainingRequest {
  notes?: string;
}

export interface TrainingComplianceCheck {
  userId: number;
  isCompliant: boolean;
  missingCount: number;
  expiredCount: number;
}

/** Native study/site/group IDs, never labels supplied as authorization evidence. */
export interface TrainingObligationScope { studyId: number; siteId?: number; armId?: number }
export interface TrainingObligationRequest {
  userId: number; courseId: number; contentRevision: number; role: string;
  scope: TrainingObligationScope; dueAt: string; reason: string;
}
export interface TrainingObligation {
  id: number; userId: number; courseId: number; courseVersion: string; contentRevision: number;
  role: string; scope: TrainingObligationScope; dueAt: string; reason: string;
  revision: number; status: 'assigned' | 'withdrawn'; assignedBy: number; createdAt: string; updatedAt: string;
  scopeObservation: unknown;
}
export interface TrainingObligationView extends TrainingObligation {
  courseName: string; currentContentRevision: number;
  readiness: 'withdrawn' | 'scope_changed' | 'scope_unavailable' | 'course_inactive' | 'retraining_required' | 'pending' | 'in_progress' | 'awaiting_verification' | 'complete';
  overdue: boolean; recordId: number | null; certificateNumber: string | null;
  completedLate: boolean; verifiedLate: boolean;
  completedAt: string | null; verifiedAt: string | null; verifiedBy: number | null;
}

/** Proposed duty assignments are approved by the native clinical lifecycle,
 * never by the training assessment endpoint itself. */
export interface TrainingDutyPolicy {
  schemaVersion: 'training-duty-policy/1' | 'training-duty-policy/2';
  scope: { studyId: number; siteId?: number };
  /** training-duty-policy/2 only: a complete pin also needs its Part 11 signatures. */
  signatures?: 'part11-required';
  assignments: Array<{
    userId: number;
    role: string;
    armId?: number;
    disposition: 'required' | 'not_required';
    rationale: string;
    duties: Array<'site_activation' | 'participant_enrollment' | 'arm_assignment' | 'supply_dispensing' | 'data_entry'>;
    obligations: Array<{ id: number; revision: number; courseId: number; courseVersion: string; contentRevision: number }>;
  }>;
}

export interface TrainingDutyReadinessRequest {
  /** /2 carries exactly a training-duty-policy/2 and is answered with training-duty-readiness/2. */
  schemaVersion: 'training-duty-readiness-request/1' | 'training-duty-readiness-request/2';
  nonce: string;
  policy: TrainingDutyPolicy;
  /** Omitted only when evaluating the complete activation census. */
  actorUserId?: number;
  duty?: 'participant_enrollment' | 'arm_assignment' | 'supply_dispensing' | 'data_entry';
  armIds?: number[];
}

/** Native source custody, not a claim of clinical approval. */
export interface TrainingImpactSource {
  nativeSourceHash: string;
  lifecycleRevision: number;
  originals: Array<{kind:'protocol'|'product'|'duty'|'amendment'|'staff';fileId:string;sha256:string}>;
}
export type TrainingImpactAction =
  | {kind:'assign';request:TrainingObligationRequest}
  | {kind:'revise';obligationId:number;expectedRevision:number;request:TrainingObligationRequest}
  | {kind:'withdraw';obligationId:number;expectedRevision:number;reason:string};
export interface TrainingImpactPlanRequest {
  schemaVersion:'training-impact-plan/1';
  idempotencyKey:string;
  scope:{studyId:number;siteId?:number};
  source:TrainingImpactSource;
  reason:string;
  actions:TrainingImpactAction[];
}

/** Text lessons and assessed questions use the existing learner runtime. Citation
 * locators are author declarations; custody checks do not validate medical meaning. */
export interface TrainingMaterial {
  courseCode:string;courseName:string;description:string;version:string;passingScore:number;
  durationMinutes:number|null;validityPeriodDays:number;active:boolean;
  intendedUse:'synthetic_qualification'|'operator_authored';
  lessons:Array<{title:string;text:string;citations:Array<{fileId:string;locator:string}>}>;
  questions:Array<{questionText:string;questionType:'multiple_choice'|'true_false'|'multi_select';options:Array<{text:string;isCorrect:boolean}>;explanation:string}>;
}
export interface TrainingMaterialSource {
  scope:{studyId:number;siteId?:number};armIds:number[];originals:TrainingImpactSource['originals'];sourceHash:string;
}
export interface TrainingMaterialDraftRequest {
  schemaVersion:'training-material-draft/1';idempotencyKey:string;courseId:number|null;
  expectedContentRevision:number;expectedDraftId:string|null;source:TrainingMaterialSource;reason:string;material:TrainingMaterial;
}

/** Part 11 signature decisions on training (contracts/training-signature-subject-v1.schema.json; impact review:
 * contracts/training-impact-review-subject-v1.schema.json). Matrix approval is reserved for the curriculum matrix
 * (T-1); nothing produces or binds it yet. */
export type TrainingSignatureDecision = 'completion-attestation' | 'verification' | 'material-approval' | 'matrix-approval' | 'impact-review';
export type TrainingRecordSignatureDecision = 'completion-attestation' | 'verification';
/** Where the person signs: the study, or the site, of an assigned obligation or of the material. Never an arm. */
export interface TrainingSignatureContext { studyId: number; siteId?: number }
/** One exact completion: its retained assessment cycle, passing receipt and certificate. No participant data. */
export interface TrainingRecordSignatureSubject {
  schemaVersion: 'training-signature-subject/1'; kind: TrainingRecordSignatureDecision; context: TrainingSignatureContext;
  learnerUserId: number; recordId: number; courseId: number; courseVersion: string; contentRevision: number;
  assessmentCycleId: string; assessment: { id: string; hash: string }; completedAt: string; certificateNumber: string;
}
/** One exact reviewed material draft: its immutable request hash, author and source, as accepted. */
export interface TrainingMaterialSignatureSubject {
  schemaVersion: 'training-signature-subject/1'; kind: 'material-approval'; context: TrainingSignatureContext;
  draftId: string; draftRevision: number; requestHash: string; courseId: number; authorUserId: number; sourceHash: string; disposition: 'accepted';
}
/** training-impact-review-subject/1: an accepted independent review of one exact proposed impact plan, at the plan
 * revision it was reviewed in. The plan hash covers the affected actions; no learner or arm id appears. */
export interface TrainingImpactReviewSignatureSubject {
  schemaVersion: 'training-impact-review-subject/1'; kind: 'impact-review'; context: TrainingSignatureContext;
  planId: string; reviewedRevision: number; planHash: string; sourceObservationHash: string; proposerUserId: number; disposition: 'accepted';
}
export type TrainingSignatureSubject = TrainingRecordSignatureSubject | TrainingMaterialSignatureSubject | TrainingImpactReviewSignatureSubject;
/** training-signature-receipt/1, produced by the EDC proxy after a password re-entry signature. Only the proxy adds
 * it to a forwarded body; this service binds it only after the EDC confirms the same signature (op `signature`). */
export interface TrainingSignatureReceipt {
  schemaVersion: 'training-signature-receipt/1'; signatureId: number; requestKey: string; decision: TrainingSignatureDecision;
  meaning: string; signerUserId: number; signerUsername: string; signerFullName: string; signedAt: string;
  context: TrainingSignatureContext; subjectHash: string;
  edcEffort: { requestId: string; workStartedAt: string | null; startBasis: 'client-work-start' | 'not-supplied' } | null;
}
/** The EDC's answer to authority op `signature`: its own signature row, which only the signer may read. */
export interface TrainingSignatureConfirmation {
  signatureId: number; requestKey: string; decision: TrainingSignatureDecision; studyId: number; subjectHash: string; meaning: string;
  signerUserId: number; signerUsername: string; signerFullName: string; signedAt: string; effortRequestId: string | null; observationHash: string;
}
/** An append-only acc_training_decision_signatures row; signatureId is the EDC's own signature id. */
export interface TrainingSignatureBinding {
  id: number; signatureId: number; decision: TrainingSignatureDecision; requestKey: string; signerUserId: number; signedAt: string;
  context: TrainingSignatureContext; subject: TrainingSignatureSubject; subjectHash: string; receipt: TrainingSignatureReceipt;
  edcObservationHash: string; recordId: number | null; assessmentCycleId: string | null; draftId: string | null; impactPlanId: string | null; createdAt: string;
}
/** A cited signature in training-duty-readiness/2; the EDC re-hashes the subject against its own signature row. */
export interface TrainingSignatureReference { signatureId: number; subjectHash: string; subject: TrainingSignatureSubject }

/** Training effort intervals (T-4, src/services/training-effort.service.ts): one per graded quiz attempt, completion
 * attestation and verification, recorded only while TRAINING_EFFORT_LEDGER_ENABLED=true. */
export type TrainingEffortKind = 'learning' | 'attestation' | 'verification';
export type TrainingEffortStartBasis = 'client-work-start' | 'server-cycle-start' | 'edc-signed-effort' | 'not-supplied';
/** What a decision route passes to the service: the X-Work-Started-At the EDC proxy forwarded (unchecked here; the
 * effort service applies the EDC rule) and the actor's current platform role from the authenticated identity. */
export interface TrainingEffortInput { workStartedAt?: string; actorRole?: string }
/** One of the learner's assigned obligations for the course at capture; it attributes the interval to its study,
 * site, arm and role. */
export interface TrainingEffortServed { obligationId: number; revision: number; role: string; scope: TrainingObligationScope }
/** One Arm-type group of the root in the EDC's resolve-due op `arms` census, exactly as the EDC answers it. */
export interface TrainingEffortArm {
  armId: number; classId: number; disclosureLevel: 'regimen' | 'cohort' | 'treatment-assignment' | null;
  groupStatus: number | null; lifecycleState: string | null; onboardedAt: string | null; onboardEventId: number | null;
}
export interface TrainingEffortHours {
  level: 'platform' | 'arm'; armId: number | null; role: string | null; roleBasis: 'obligation-role' | 'actor-platform-role';
  kind: TrainingEffortKind; hours: number; intervals: number; unknownIntervals: number; actors: number; disclosure: 'platform' | 'regimen-or-cohort';
}
export interface TrainingEffortLeadTime {
  status: 'measured' | 'open' | 'incomplete' | 'withheld'; days: number | null; startedAt: string | null; trainedAt: string | null;
  obligations: { assigned: number; complete: number } | null; learners: number | null; sites: number | null;
  trainedBeforeOnboarding: boolean | null; reason: string | null;
}
/** TrainingEffortSourceV1@1.0.0 (contracts/training-effort-source-v1.schema.json): hours by role and regimen or cohort
 * arm, and each arm's lead time from its EDC onboard event to fully trained staff, for one root study. */
export interface TrainingEffortSource {
  schemaVersion: 'TrainingEffortSourceV1@1.0.0'; scope: { studyId: number }; asOf: string; dataClass: 'synthetic' | 'not-stated';
  definitions: Record<'learning' | 'attestation' | 'verification' | 'startBasis' | 'roleBasis' | 'hours' | 'leadTime' | 'disclosure', string>;
  hours: TrainingEffortHours[];
  arms: Array<{ armId: number; disclosureLevel: TrainingEffortArm['disclosureLevel']; onboardedAt: string | null; onboardEventId: number | null; leadTime: TrainingEffortLeadTime }>;
  counts: { intervals: number; throughIntervalId: number | null }; limitations: string[]; sourceHash: string;
}
