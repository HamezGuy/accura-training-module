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
