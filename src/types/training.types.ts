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

export interface TrainingQuizResult {
  passed: boolean;
  score: number;
  totalQuestions: number;
  correctAnswers: number;
  certificateNumber?: string;
  expirationDate?: string;
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
  schemaVersion: 'training-duty-policy/1';
  scope: { studyId: number; siteId?: number };
  assignments: Array<{
    userId: number;
    role: string;
    armId?: number;
    disposition: 'required' | 'not_required';
    rationale: string;
    duties: Array<'site_activation' | 'participant_enrollment' | 'arm_assignment'>;
    obligations: Array<{ id: number; revision: number; courseId: number; courseVersion: string; contentRevision: number }>;
  }>;
}

export interface TrainingDutyReadinessRequest {
  schemaVersion: 'training-duty-readiness-request/1';
  nonce: string;
  policy: TrainingDutyPolicy;
  /** Omitted only when evaluating the complete activation census. */
  actorUserId?: number;
  duty?: 'participant_enrollment' | 'arm_assignment';
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
