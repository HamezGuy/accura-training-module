import { Router } from 'express';
import Joi from 'joi';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { authorize } from '../middleware/authorization.middleware';
import { validate } from '../middleware/validation.middleware';
import { asyncHandler } from '../middleware/errorHandler.middleware';
import * as controller from '../controllers/training.controller';
import * as obligations from '../services/training-obligations.service';
import * as impact from '../services/training-impact.service';
import {inspectImpactSource,observeMaterialSource} from '../services/training-authority.service';
import * as materials from '../services/training-materials.service';
import {getObligationDueSource} from '../services/training-due-source.service';
import { exactPositiveId } from '../middleware/validation.middleware';
import {observeServiceDue,observeServiceEffort} from '../services/service-due-authority';

const router = Router();

// The service reader owns explicit machine authentication at every native
// callback. It cannot enter any human course, record or management route.
router.post('/obligation-due-source/observe',asyncHandler(observeServiceDue));
// T-4 training effort (TrainingEffortSourceV1@1.0.0) on the same machine transport;
// 503 TRAINING_EFFORT_DISABLED unless TRAINING_EFFORT_LEDGER_ENABLED=true.
router.post('/effort-source/observe',asyncHandler(observeServiceEffort));
// All remaining routes require current human authentication.
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
  recordId: Joi.number().integer().positive().strict().required(),
  cycleId: Joi.string().guid().required(),
  requestId: Joi.string().guid().required(),
  contentRevision: Joi.number().integer().positive().strict().required(),
  answers: Joi.array()
    .items(
      Joi.object({
        questionId: Joi.number().integer().positive().strict().required(),
        selectedOptions: Joi.array().items(Joi.number().integer().min(0).strict()).min(1).unique().required(),
      })
    )
    .min(1).max(1000)
    .required(),
});

// signatureReceipt is training-signature-receipt/1, added only by the EDC proxy; the service checks its exact keys.
const verifyTrainingSchema = Joi.object({
  notes: Joi.string().allow('', null).optional(),
  signatureReceipt: Joi.object().optional(),
});

const signatureReceiptSchema = Joi.object({
  signatureReceipt: Joi.object().required(),
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
router.post('/inspection-evidence',asyncHandler<AuthRequest>(async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');res.json({success:true,data:await obligations.getTrainingInspectionEvidence(req.trainingAuthority!,req.body)});
}));

router.post('/duty-readiness', asyncHandler<AuthRequest>(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: await obligations.getDutyReadiness(req.trainingAuthority!, req.body) });
}));

router.post('/material-source',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.json({success:true,data:await observeMaterialSource(req.trainingAuthority!,req.body)});
}));
router.get('/material-drafts',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  if(Object.keys(req.query).some(k=>!['studyId','siteId'].includes(k)))throw Object.assign(new Error('Exact material scope required'),{statusCode:400});
  const studyId=exactPositiveId(req.query['studyId'],'study ID'),siteId=exactPositiveId(req.query['siteId'],'site ID');
  if(!studyId)throw Object.assign(new Error('Study ID required'),{statusCode:400});
  res.setHeader('Cache-Control','no-store');res.json({success:true,data:await materials.listMaterialDrafts(req.trainingAuthority!,{studyId,...(siteId?{siteId}:{})})});
}));
router.post('/material-drafts',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.status(201).json({success:true,data:await materials.proposeMaterialDraft(req.trainingAuthority!,req.body)});
}));
router.get('/material-drafts/:id',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.json({success:true,data:await materials.getMaterialDraft(req.trainingAuthority!,req.params['id'])});
}));
router.post('/material-drafts/:id/review',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.json({success:true,data:await materials.reviewMaterialDraft(req.trainingAuthority!,req.params['id'],req.body)});
}));
router.post('/material-drafts/:id/publish',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.json({success:true,data:await materials.publishMaterialDraft(req.trainingAuthority!,req.params['id'],req.body)});
}));
router.post('/material-drafts/:id/approval-signature',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.json({success:true,data:await materials.signMaterialApproval(req.trainingAuthority!,req.params['id'],req.body)});
}));
router.post('/impact-source',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  if(!req.body||Object.keys(req.body).some(key=>!['scope','originals'].includes(key)))throw Object.assign(new Error('Exact source selectors required'),{statusCode:400});
  res.setHeader('Cache-Control','no-store');res.json({success:true,data:await inspectImpactSource(req.trainingAuthority!,req.body.scope,req.body.originals)});
}));
router.post('/obligation-due-source',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  if(!req.body||Object.keys(req.body).some(key=>!['scope','originals'].includes(key)))throw Object.assign(new Error('Exact due-source selectors required'),{statusCode:400});
  res.setHeader('Cache-Control','no-store');res.json({success:true,data:await getObligationDueSource(req.trainingAuthority!,req.body.scope,req.body.originals)});
}));
router.post('/impact-plans',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.status(201).json({success:true,data:await impact.proposeImpactPlan(req.trainingAuthority!,req.body)});
}));
router.get('/impact-plans/:id',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.json({success:true,data:await impact.getImpactPlan(req.trainingAuthority!,req.params['id'])});
}));
router.post('/impact-plans/:id/review',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.json({success:true,data:await impact.reviewImpactPlan(req.trainingAuthority!,req.params['id'],req.body)});
}));
router.post('/impact-plans/:id/apply',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.json({success:true,data:await impact.applyImpactPlan(req.trainingAuthority!,req.params['id'],req.body)});
}));
router.post('/impact-plans/:id/cancel',authorize(['admin','data_manager']),asyncHandler<AuthRequest>(async(req,res)=>{
  res.json({success:true,data:await impact.cancelImpactPlan(req.trainingAuthority!,req.params['id'],req.body)});
}));

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
// Part 11 Signature Routes (signed in the EDC; receipts come only from its proxy)
// ============================================================================

const subjectRoles: Record<string, string[]> = {
  verification: ['admin', 'data_manager', 'monitor', 'investigator'],
  'material-approval': ['admin', 'data_manager'],
};
router.get('/signature-subject', (req: AuthRequest, res, next) => {
  const roles = subjectRoles[String(req.query['kind'])];
  if (roles) authorize(roles)(req, res, next); else next();
}, asyncHandler<AuthRequest>(async (req, res) => {
  if (req.query['kind'] !== 'material-approval') { await controller.getRecordSignatureSubject(req, res); return; }
  if (Object.keys(req.query).some(key => !['kind', 'draftId'].includes(key)) || typeof req.query['draftId'] !== 'string') {
    throw Object.assign(new Error('Exact signature kind and material draft required'), { statusCode: 400 });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: await materials.readMaterialSignatureSubject(req.trainingAuthority!, req.query['draftId']) });
}));

router.post('/attest/:recordId', validate(signatureReceiptSchema), asyncHandler<AuthRequest>(controller.attestTraining));

router.post(
  '/verify/:recordId/signature',
  authorize(['admin', 'data_manager', 'monitor', 'investigator']),
  validate(signatureReceiptSchema),
  asyncHandler<AuthRequest>(controller.signTrainingVerification)
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
