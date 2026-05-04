import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import * as trainingService from '../services/training.service';
import { logAudit } from '../services/audit.service';
import {
  TrainingCourse,
  TrainingRecord,
  TrainingQuizResult,
  TrainingComplianceStatus,
  TrainingComplianceCheck,
  TrainingQuizQuestion,
} from '../types/training.types';

// ============================================================================
// Course Endpoints
// ============================================================================

export async function getCourses(req: AuthRequest, res: Response): Promise<void> {
  const activeOnly = req.query['activeOnly'] !== 'false';
  const role = req.query['role'] as string | undefined;

  const courses = await trainingService.getCourses({ activeOnly, role });

  const dto: TrainingCourse[] = courses.map(mapCourseToDto);

  res.json({ success: true, data: dto });
}

export async function getCourseById(req: AuthRequest, res: Response): Promise<void> {
  const courseId = parseInt(req.params['id'], 10);
  const includeQuestions = req.query['includeQuestions'] === 'true';

  const course = await trainingService.getCourseById(courseId, includeQuestions);

  if (!course) {
    res.status(404).json({ success: false, message: 'Course not found' });
    return;
  }

  const dto: TrainingCourse = mapCourseToDto(course);
  res.json({ success: true, data: dto });
}

export async function createCourse(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.userId;
  const course = await trainingService.createCourse(req.body, userId);

  await logAudit({
    userId,
    action: 'course_created',
    courseId: course.id,
    details: { courseCode: course.courseCode, courseName: course.courseName },
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  const dto: TrainingCourse = mapCourseToDto(course);
  res.status(201).json({ success: true, data: dto });
}

export async function updateCourse(req: AuthRequest, res: Response): Promise<void> {
  const courseId = parseInt(req.params['id'], 10);
  const userId = req.user!.userId;

  const course = await trainingService.updateCourse(courseId, req.body);

  if (!course) {
    res.status(404).json({ success: false, message: 'Course not found' });
    return;
  }

  await logAudit({
    userId,
    action: 'course_updated',
    courseId: course.id,
    details: { changes: req.body },
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  const dto: TrainingCourse = mapCourseToDto(course);
  res.json({ success: true, data: dto });
}

export async function addQuestions(req: AuthRequest, res: Response): Promise<void> {
  const courseId = parseInt(req.params['id'], 10);
  const userId = req.user!.userId;

  const existing = await trainingService.getCourseById(courseId);
  if (!existing) {
    res.status(404).json({ success: false, message: 'Course not found' });
    return;
  }

  const questions = await trainingService.addQuestions(courseId, req.body.questions);

  await logAudit({
    userId,
    action: 'questions_added',
    courseId,
    details: { count: questions.length },
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  const dto: TrainingQuizQuestion[] = questions.map(mapQuestionToDto);
  res.status(201).json({ success: true, data: dto });
}

// ============================================================================
// Training Record Endpoints
// ============================================================================

export async function getMyRecords(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.userId;
  const records = await trainingService.getMyRecords(userId);

  const dto: TrainingRecord[] = records.map(mapRecordToDto);
  res.json({ success: true, data: dto });
}

export async function getUserRecords(req: AuthRequest, res: Response): Promise<void> {
  const userId = parseInt(req.params['userId'], 10);
  const records = await trainingService.getUserRecords(userId);

  const dto: TrainingRecord[] = records.map(mapRecordToDto);
  res.json({ success: true, data: dto });
}

export async function startTraining(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.userId;
  const courseId = parseInt(req.params['courseId'], 10);

  const record = await trainingService.startTraining(userId, courseId);

  await logAudit({
    userId,
    action: 'training_started',
    recordId: record.id,
    courseId,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  const dto: TrainingRecord = mapRecordToDto(record);
  res.json({ success: true, data: dto });
}

export async function submitQuiz(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.userId;
  const courseId = parseInt(req.params['courseId'], 10);
  const { answers } = req.body;

  const result = await trainingService.submitQuiz(userId, courseId, answers);

  await logAudit({
    userId,
    action: result.passed ? 'quiz_passed' : 'quiz_failed',
    courseId,
    details: { score: result.score, passed: result.passed, totalQuestions: result.totalQuestions },
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  const dto: TrainingQuizResult = {
    passed: result.passed,
    score: result.score,
    totalQuestions: result.totalQuestions,
    correctAnswers: result.correctAnswers,
    certificateNumber: result.certificateNumber,
    expirationDate: result.expirationDate,
  };

  res.json({ success: true, data: dto });
}

export async function verifyTraining(req: AuthRequest, res: Response): Promise<void> {
  const verifierId = req.user!.userId;
  const recordId = parseInt(req.params['recordId'], 10);
  const { notes } = req.body;

  const result = await trainingService.verifyTraining(recordId, verifierId, notes);

  await logAudit({
    userId: verifierId,
    action: 'training_verified',
    recordId,
    details: { notes },
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  res.json({ success: true, data: result });
}

// ============================================================================
// Compliance Endpoints
// ============================================================================

export async function getComplianceStatus(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.query['userId'] ? parseInt(req.query['userId'] as string, 10) : undefined;
  const studyId = req.query['studyId'] ? parseInt(req.query['studyId'] as string, 10) : undefined;

  const statuses = await trainingService.getComplianceStatus({ userId, studyId });

  const dto: TrainingComplianceStatus[] = statuses.map((s) => ({
    userId: s.userId,
    username: s.username,
    userFullName: s.userFullName,
    role: s.role,
    totalRequired: s.totalRequired,
    completed: s.completed,
    expired: s.expired,
    pending: s.pending,
    compliancePercentage: s.compliancePercentage,
    isCompliant: s.isCompliant,
    missingCourses: s.missingCourses,
  }));

  res.json({ success: true, data: dto });
}

export async function getExpiringTraining(req: AuthRequest, res: Response): Promise<void> {
  const days = parseInt(req.query['days'] as string || '30', 10);
  const records = await trainingService.getExpiringTraining(days);

  const dto: TrainingRecord[] = records.map(mapRecordToDto);
  res.json({ success: true, data: dto });
}

export async function checkCompliance(req: AuthRequest, res: Response): Promise<void> {
  const userId = parseInt(req.params['userId'], 10);
  const result = await trainingService.checkUserCompliance(userId);

  const dto: TrainingComplianceCheck = {
    userId: result.userId,
    isCompliant: result.isCompliant,
    missingCount: result.missingCount,
    expiredCount: result.expiredCount,
  };

  res.json({ success: true, data: dto });
}

// ============================================================================
// DTO Mappers
// ============================================================================

function mapCourseToDto(course: TrainingCourse): TrainingCourse {
  return {
    id: course.id,
    courseCode: course.courseCode,
    courseName: course.courseName,
    description: course.description,
    version: course.version,
    durationMinutes: course.durationMinutes,
    passingScore: course.passingScore,
    requiredForRoles: course.requiredForRoles,
    regulatoryReference: course.regulatoryReference,
    active: course.active,
    validityPeriodDays: course.validityPeriodDays,
    createdBy: course.createdBy,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt,
    ...(course.questions ? { questions: course.questions.map(mapQuestionToDto) } : {}),
  };
}

function mapQuestionToDto(q: TrainingQuizQuestion): TrainingQuizQuestion {
  return {
    id: q.id,
    courseId: q.courseId,
    questionText: q.questionText,
    questionType: q.questionType,
    options: q.options,
    explanation: q.explanation,
    orderIndex: q.orderIndex,
  };
}

function mapRecordToDto(r: TrainingRecord): TrainingRecord {
  return {
    id: r.id,
    userId: r.userId,
    courseId: r.courseId,
    courseName: r.courseName,
    courseCode: r.courseCode,
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
  };
}
