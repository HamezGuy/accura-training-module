import { Router } from 'express';
import Joi from 'joi';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { authorize } from '../middleware/authorization.middleware';
import { validate } from '../middleware/validation.middleware';
import { asyncHandler } from '../middleware/errorHandler.middleware';
import * as controller from '../controllers/training.controller';
import * as obligations from '../services/training-obligations.service';
import { exactPositiveId } from '../middleware/validation.middleware';

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
  contentRevision: Joi.number().integer().positive().strict().required(),
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

router.get('/courses', asyncHandler<AuthRequest>(controller.getCourses));

router.get('/courses/:id', asyncHandler<AuthRequest>(controller.getCourseById));

router.get('/courses/:id/content', asyncHandler<AuthRequest>(controller.getCourseContent));

router.post(
  '/courses',
  authorize(['admin', 'data_manager']),
  validate(createCourseSchema),
  asyncHandler<AuthRequest>(controller.createCourse)
);

router.put(
  '/courses/:id',
  authorize(['admin', 'data_manager']),
  validate(updateCourseSchema),
  asyncHandler<AuthRequest>(controller.updateCourse)
);

router.post(
  '/courses/:id/questions',
  authorize(['admin', 'data_manager']),
  validate(addQuestionsSchema),
  asyncHandler<AuthRequest>(controller.addQuestions)
);

// ============================================================================
// Training Record Routes
// ============================================================================

router.get('/my-records', asyncHandler<AuthRequest>(controller.getMyRecords));
router.get('/my-record-history', asyncHandler<AuthRequest>(controller.getMyRecordHistory));

const obligationSchema = Joi.object({
  userId:Joi.number().integer().positive().strict().required(), courseId:Joi.number().integer().positive().strict().required(),
  contentRevision:Joi.number().integer().positive().strict().required(), role:Joi.string().required(),
  scope:Joi.object({studyId:Joi.number().integer().positive().strict().required(),siteId:Joi.number().integer().positive().strict(),armId:Joi.number().integer().positive().strict()}).required(),
  dueAt:Joi.string().required(),reason:Joi.string().trim().min(1).max(2000).required(),
});
router.get('/obligations', authorize(['admin','data_manager','monitor'], req => req.query['userId'] ?? String(req.user!.userId)), asyncHandler<AuthRequest>(async (req,res) => {
  const userId=exactPositiveId(req.query['userId'],'learner ID') ?? req.user!.userId;
  res.json({success:true,data:await obligations.getObligations(req.trainingAuthority!,userId)});
}));
router.get('/obligation-history', authorize(['admin','data_manager','monitor'], req => req.query['userId'] ?? String(req.user!.userId)), asyncHandler<AuthRequest>(async (req,res) => {
  const userId=exactPositiveId(req.query['userId'],'learner ID') ?? req.user!.userId;
  res.json({success:true,data:await obligations.getObligationHistory(req.trainingAuthority!,userId)});
}));
router.post('/obligations',authorize(['admin','data_manager']),validate(obligationSchema),asyncHandler<AuthRequest>(async(req,res)=>{
  res.status(201).json({success:true,data:await obligations.assignObligation(req.trainingAuthority!,req.body)});
}));
router.post('/obligations/:id/revise',authorize(['admin','data_manager']),validate(obligationSchema.append({expectedRevision:Joi.number().integer().positive().strict().required()})),asyncHandler<AuthRequest>(async(req,res)=>{
  const {expectedRevision,...body}=req.body;
  res.json({success:true,data:await obligations.assignObligation(req.trainingAuthority!,body,{id:exactPositiveId(req.params['id'],'obligation ID')!,expectedRevision})});
}));
router.post('/obligations/:id/withdraw',authorize(['admin','data_manager']),validate(Joi.object({expectedRevision:Joi.number().integer().positive().strict().required(),reason:Joi.string().trim().min(1).max(2000).required()})),asyncHandler<AuthRequest>(async(req,res)=>{
  res.json({success:true,data:await obligations.withdrawObligation(req.trainingAuthority!,exactPositiveId(req.params['id'],'obligation ID')!,req.body.expectedRevision,req.body.reason)});
}));

router.get(
  '/user/:userId/records',
  authorize(['admin', 'data_manager', 'monitor']),
  asyncHandler<AuthRequest>(controller.getUserRecords)
);

router.post('/start/:courseId', validate(Joi.object({contentRevision: Joi.number().integer().positive().optional()})), asyncHandler<AuthRequest>(controller.startTraining));

router.post(
  '/submit-quiz/:courseId',
  validate(submitQuizSchema),
  asyncHandler<AuthRequest>(controller.submitQuiz)
);

router.post(
  '/verify/:recordId',
  authorize(['admin', 'data_manager', 'monitor', 'investigator']),
  validate(verifyTrainingSchema),
  asyncHandler<AuthRequest>(controller.verifyTraining)
);

// ============================================================================
// Compliance Routes
// ============================================================================

router.get('/compliance', authorize(['admin', 'data_manager', 'monitor'], req => req.query['userId']),
  asyncHandler<AuthRequest>(controller.getComplianceStatus));

router.get('/expiring', authorize(['admin', 'data_manager', 'monitor']),
  asyncHandler<AuthRequest>(controller.getExpiringTraining));

router.get('/user/:userId/is-compliant', authorize(['admin', 'data_manager', 'monitor'], req => req.params['userId']),
  asyncHandler<AuthRequest>(controller.checkCompliance));

// Learning paths
router.get('/learning-paths', asyncHandler<AuthRequest>(controller.getLearningPaths));

export default router;
