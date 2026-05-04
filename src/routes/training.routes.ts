import { Router } from 'express';
import Joi from 'joi';
import { authMiddleware } from '../middleware/auth.middleware';
import { authorize } from '../middleware/authorization.middleware';
import { validate } from '../middleware/validation.middleware';
import { asyncHandler } from '../middleware/errorHandler.middleware';
import * as controller from '../controllers/training.controller';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// ============================================================================
// Validation Schemas
// ============================================================================

const createCourseSchema = Joi.object({
  courseCode: Joi.string().max(50).required(),
  courseName: Joi.string().max(255).required(),
  description: Joi.string().allow('', null).optional(),
  version: Joi.string().max(20).required(),
  durationMinutes: Joi.number().integer().min(1).optional(),
  passingScore: Joi.number().integer().min(1).max(100).required(),
  requiredForRoles: Joi.array().items(Joi.string()).min(1).required(),
  regulatoryReference: Joi.string().allow('', null).optional(),
  validityPeriodDays: Joi.number().integer().min(1).optional(),
});

const updateCourseSchema = Joi.object({
  courseName: Joi.string().max(255).optional(),
  description: Joi.string().allow('', null).optional(),
  version: Joi.string().max(20).optional(),
  durationMinutes: Joi.number().integer().min(1).allow(null).optional(),
  passingScore: Joi.number().integer().min(1).max(100).optional(),
  requiredForRoles: Joi.array().items(Joi.string()).optional(),
  regulatoryReference: Joi.string().allow('', null).optional(),
  active: Joi.boolean().optional(),
  validityPeriodDays: Joi.number().integer().min(1).allow(null).optional(),
}).min(1);

const addQuestionsSchema = Joi.object({
  questions: Joi.array()
    .items(
      Joi.object({
        questionText: Joi.string().required(),
        questionType: Joi.string().valid('multiple_choice', 'true_false', 'multi_select').required(),
        options: Joi.array()
          .items(
            Joi.object({
              text: Joi.string().required(),
              isCorrect: Joi.boolean().optional(),
            })
          )
          .min(2)
          .required(),
        explanation: Joi.string().allow('', null).optional(),
        orderIndex: Joi.number().integer().min(0).required(),
      })
    )
    .min(1)
    .required(),
});

const submitQuizSchema = Joi.object({
  answers: Joi.array()
    .items(
      Joi.object({
        questionId: Joi.number().integer().required(),
        selectedOptions: Joi.array().items(Joi.number().integer().min(0)).min(1).required(),
      })
    )
    .min(1)
    .required(),
});

const verifyTrainingSchema = Joi.object({
  notes: Joi.string().allow('', null).optional(),
});

// ============================================================================
// Course Routes
// ============================================================================

router.get('/courses', asyncHandler(controller.getCourses));

router.get('/courses/:id', asyncHandler(controller.getCourseById));

router.post(
  '/courses',
  authorize(['admin', 'manager']),
  validate(createCourseSchema),
  asyncHandler(controller.createCourse)
);

router.put(
  '/courses/:id',
  authorize(['admin', 'manager']),
  validate(updateCourseSchema),
  asyncHandler(controller.updateCourse)
);

router.post(
  '/courses/:id/questions',
  authorize(['admin', 'manager']),
  validate(addQuestionsSchema),
  asyncHandler(controller.addQuestions)
);

// ============================================================================
// Training Record Routes
// ============================================================================

router.get('/my-records', asyncHandler(controller.getMyRecords));

router.get(
  '/user/:userId/records',
  authorize(['admin', 'manager', 'monitor']),
  asyncHandler(controller.getUserRecords)
);

router.post('/start/:courseId', asyncHandler(controller.startTraining));

router.post(
  '/submit-quiz/:courseId',
  validate(submitQuizSchema),
  asyncHandler(controller.submitQuiz)
);

router.post(
  '/verify/:recordId',
  authorize(['admin', 'manager', 'monitor', 'investigator']),
  validate(verifyTrainingSchema),
  asyncHandler(controller.verifyTraining)
);

// ============================================================================
// Compliance Routes
// ============================================================================

router.get('/compliance', asyncHandler(controller.getComplianceStatus));

router.get('/expiring', asyncHandler(controller.getExpiringTraining));

router.get('/user/:userId/is-compliant', asyncHandler(controller.checkCompliance));

export default router;
