jest.mock('../../src/services/training-obligations.service',()=>({getObligations:jest.fn(async()=>[])}));
import * as trainingService from '../../src/services/training.service';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockTransaction = jest.fn();
const mockTargets = jest.fn(), mockDirectory = jest.fn(), mockRevalidate = jest.fn();
const authority = { actorUserId: 2, accessToken: 'fixture-native-token' };
jest.mock('../../src/services/training-authority.service', () => ({
  authorizeTrainingTargets: (...args: unknown[]) => mockTargets(...args),
  readTrainingDirectory: (...args: unknown[]) => mockDirectory(...args),
  revalidateTrainingDirectory: (...args: unknown[]) => mockRevalidate(...args),
}));

jest.mock('../../src/config/database', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (fn: unknown) => mockTransaction(fn),
}));

jest.mock('../../src/config/logger', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../../src/services/certificate.service', () => ({
  generateCertificateNumber: jest.fn().mockReturnValue('AT-CERT-GCP-101-1-TEST123-ABC456'),
  calculateExpirationDate: jest.fn().mockReturnValue(new Date('2027-05-04T00:00:00.000Z')),
}));

describe('TrainingService', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({rows:[]});
    mockQueryOne.mockReset();
    mockTransaction.mockReset();
    mockTargets.mockReset(); mockDirectory.mockReset(); mockRevalidate.mockReset();
    mockTargets.mockImplementation(async (_context, _action, ids: number[]) => ({ scopeFingerprint: 'fixture-scope', decisions: ids.map(userId => ({ userId, allowed: true })) }));
    mockDirectory.mockResolvedValue({ users: [], filter: {}, scopeFingerprint: 'fixture-scope' });
    mockRevalidate.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(async (fn) => fn({ query: (sql: string, ...args: unknown[]) => sql.startsWith('SET TRANSACTION') ? Promise.resolve({ rows: [] }) : mockQuery(sql, ...args), queryOne: mockQueryOne }));
  });

  describe('getCourses', () => {
    it('should return all active courses by default', async () => {
      const mockCourses = [
        { id: 1, courseCode: 'GCP-101', courseName: 'GCP Fundamentals', active: true },
        { id: 2, courseCode: 'CFR11-101', courseName: 'CFR Part 11', active: true },
      ];
      mockQuery.mockResolvedValue({ rows: mockCourses, rowCount: 2 });

      const result = await trainingService.getCourses();

      expect(result).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('active = $1'),
        [true]
      );
    });

    it('should filter by role when specified', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 1, requiredForRoles: ['site_monitor'] }, { id: 2, requiredForRoles: ['manager'] }], rowCount: 2 });
      expect((await trainingService.getCourses({ role: 'monitor' })).map(course => course.id)).toEqual([1]);
    });
  });

  describe('getCourseById', () => {
    it('should return null for non-existent course', async () => {
      mockQueryOne.mockResolvedValue(null);

      const result = await trainingService.getCourseById(999);

      expect(result).toBeNull();
    });

    it('should return course without questions by default', async () => {
      mockQueryOne.mockResolvedValue({
        id: 1,
        courseCode: 'GCP-101',
        courseName: 'GCP Fundamentals',
        passingScore: 80,
      });

      const result = await trainingService.getCourseById(1);

      expect(result).toBeDefined();
      expect(result!.courseCode).toBe('GCP-101');
      expect(result!.questions).toBeUndefined();
    });

    it('should strip isCorrect from options when including questions', async () => {
      mockQueryOne.mockResolvedValue({
        id: 1,
        courseCode: 'GCP-101',
        courseName: 'GCP Fundamentals',
        passingScore: 80,
      });
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 1,
            courseId: 1,
            questionText: 'Test question?',
            questionType: 'multiple_choice',
            options: [
              { text: 'A', isCorrect: true },
              { text: 'B', isCorrect: false },
            ],
            explanation: 'A is correct',
            orderIndex: 1,
          },
        ],
        rowCount: 1,
      });

      const result = await trainingService.getCourseById(1, true);

      expect(result!.questions).toHaveLength(1);
      expect(result!.questions![0].options[0]).not.toHaveProperty('isCorrect');
      expect(result!.questions![0].options[0].text).toBe('A');
    });
  });

  describe('startTraining', () => {
    it('should throw 404 for non-existent or inactive course', async () => {
      mockQueryOne.mockResolvedValue(null);

      await expect(trainingService.startTraining(1, 999)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('should throw 409 if training already completed', async () => {
      mockQueryOne
        .mockResolvedValueOnce({ id: 1, courseCode: 'GCP-101', active: true, version:'1', contentRevision:1 })
        .mockResolvedValueOnce({ id: 10, userId: 1, courseId: 1, status: 'completed', courseVersion:'1', contentRevision:1 });

      await expect(trainingService.startTraining(1, 1)).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it('should create new record if none exists', async () => {
      mockQueryOne
        .mockResolvedValueOnce({ id: 1, courseCode: 'GCP-101', active: true, version:'1', contentRevision:1 })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 10, userId: 1, courseId: 1, status: 'in_progress', startedAt: new Date() });

      const result = await trainingService.startTraining(1, 1);

      expect(result.status).toBe('in_progress');
      expect(mockQueryOne).toHaveBeenCalledTimes(3);
    });
  });

  describe('submitQuiz', () => {
    const cycleId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222';
    const submission={recordId:10,cycleId,requestId},learner={...authority,actorUserId:1};
    it('requires explicit cycle and authenticated learner before any grading',async()=>{
      await expect(trainingService.submitQuiz(1,1,[])).rejects.toMatchObject({statusCode:400});
      await expect(trainingService.submitQuiz(1,1,[],undefined,1,authority,submission)).rejects.toMatchObject({statusCode:403});
      expect(mockQuery).not.toHaveBeenCalled();
    });
    it('does not recover another learner record when course or record is absent',async()=>{
      mockQueryOne.mockResolvedValue(null);
      await expect(trainingService.submitQuiz(1,999,[],undefined,1,learner,submission)).rejects.toMatchObject({statusCode:404});
    });
    /** A started retained cycle of a two-question course; the mocks keep every history row the service writes. */
    function retainedQuiz(){
      const course:any={id:1,courseCode:'GCP-101',passingScore:80,validityPeriodDays:365,version:'1',contentRevision:1,active:true};
      const questions:any[]=[{id:1,courseId:1,options:[{text:'A',isCorrect:true},{text:'B',isCorrect:false}],questionType:'multiple_choice',questionText:'Q1',orderIndex:1},
        {id:2,courseId:1,options:[{text:'True',isCorrect:true},{text:'False',isCorrect:false}],questionType:'true_false',questionText:'Q2',orderIndex:2}];
      const record:any={id:10,userId:1,courseId:1,status:'in_progress',courseVersion:'1',contentRevision:1,assessmentCycleId:cycleId,assessmentReceipt:null,
        attempts:0,score:null,completedAt:null,certificateNumber:null,expirationDate:null,startedAt:'2026-01-01T00:00:00.000Z',contentSnapshot:{course,slides:[],questions}};
      const history:any[]=[{recordId:10,userId:1,courseId:1,eventKind:'cycle_started',assessmentCycleId:cycleId,recordSnapshot:structuredClone(record)}];
      mockQueryOne.mockImplementation(async(sql:string,values:any[])=>{
        if(sql.startsWith('SELECT * FROM acc_training_courses'))return course;
        if(sql.startsWith('SELECT * FROM acc_training_records'))return record;
        if(sql.startsWith('UPDATE acc_training_records'))return Object.assign(record,{status:values[1],score:values[2],attempts:1,completedAt:values[3],certificateNumber:values[4],expirationDate:values[5],assessmentReceipt:JSON.parse(values[6])});
        throw new Error('Unexpected single-row query');
      });
      mockQuery.mockImplementation(async(sql:string,values:any[])=>{
        if(sql.startsWith('SELECT * FROM acc_training_record_history'))return {rows:history};
        if(sql.startsWith('SELECT * FROM acc_training_questions'))return {rows:questions};
        if(sql.startsWith('INSERT INTO acc_training_record_history'))history.push({recordId:10,userId:1,courseId:1,recordSnapshot:JSON.parse(values[3]),eventKind:'quiz_attempt',assessmentCycleId:values[4],requestKey:values[5],requestHash:values[6],assessment:JSON.parse(values[7])});
        return {rows:[]};
      });
      return {history};
    }
    const effortRows=()=>mockQuery.mock.calls.filter(([sql])=>String(sql).startsWith('INSERT INTO acc_training_effort_intervals'));
    it('grades the retained snapshot and writes receipt and audit in the same transaction',async()=>{
      const {history}=retainedQuiz();
      const result=await trainingService.submitQuiz(1,1,[{questionId:1,selectedOptions:[0]},{questionId:2,selectedOptions:[0]}],undefined,1,learner,submission);
      expect(result).toMatchObject({passed:true,score:100,replayed:false,receipt:{cycleId,attemptNumber:1}});
      expect(history[1].assessment.answers).toEqual([{questionId:1,selectedOptions:[0]},{questionId:2,selectedOptions:[0]}]);
      expect(mockQuery.mock.calls.filter(([sql])=>sql.includes('INSERT INTO acc_training_audit_log'))).toHaveLength(1);
      const again=await trainingService.submitQuiz(1,1,[{questionId:2,selectedOptions:[0]},{questionId:1,selectedOptions:[0]}],undefined,1,learner,submission);
      expect(again).toMatchObject({replayed:true,receipt:result.receipt});expect(history).toHaveLength(2);
      expect(mockQuery.mock.calls.filter(([sql])=>sql.includes('INSERT INTO acc_training_audit_log'))).toHaveLength(1);
      // The effort ledger is off unless switched on: no interval is written.
      expect(effortRows()).toHaveLength(0);
    });
    it('with the effort ledger on, an attempt writes one learning interval in its transaction and a replay none (T-4)',async()=>{
      process.env.TRAINING_EFFORT_LEDGER_ENABLED='true';
      try{
        const {history}=retainedQuiz(),stated=new Date(Date.now()-30*60000).toISOString(),answers=[{questionId:1,selectedOptions:[0]},{questionId:2,selectedOptions:[1]}];
        expect(await trainingService.submitQuiz(1,1,answers,undefined,1,learner,submission,undefined,{workStartedAt:stated,actorRole:'coordinator'})).toMatchObject({passed:false,replayed:false});
        expect(effortRows()).toHaveLength(1);
        const values=effortRows()[0][1] as unknown[];
        expect(values.slice(0,8)).toEqual([requestId,'learning',1,null,1,10,1,cycleId]);
        expect(values.slice(9)).toEqual([stated,history[1].assessment.assessedAt,'client-work-start',null]);
        // The audit row precedes the interval in the same transaction; a replay writes neither again.
        const order=mockQuery.mock.calls.map(([sql])=>String(sql)).filter(sql=>/INSERT INTO acc_training_(audit_log|effort_intervals)/.test(sql)).map(sql=>sql.includes('audit_log')?'audit':'effort');
        expect(order).toEqual(['audit','effort']);
        expect(await trainingService.submitQuiz(1,1,answers,undefined,1,learner,submission,undefined,{workStartedAt:stated})).toMatchObject({replayed:true});
        expect(effortRows()).toHaveLength(1);
      }finally{delete process.env.TRAINING_EFFORT_LEDGER_ENABLED;}
    });
  });

  describe('verifyTraining', () => {
    it('should throw 404 if record not found', async () => {
      mockQueryOne.mockResolvedValue(null);

      await expect(trainingService.verifyTraining(999, authority)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('should throw 400 if training not completed', async () => {
      mockQueryOne.mockResolvedValue({ id: 1, userId: 3, status: 'in_progress' });

      await expect(trainingService.verifyTraining(1, authority)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('should throw 403 if user tries to verify own training', async () => {
      mockQueryOne.mockResolvedValue({ id: 1, userId: 2, status: 'completed' });

      await expect(trainingService.verifyTraining(1, authority)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('should verify completed training by another user', async () => {
      mockQueryOne.mockResolvedValueOnce({userId:3,courseId:4}).mockResolvedValueOnce({version:'1',contentRevision:1}).mockResolvedValueOnce({ id: 1, userId: 3, status: 'completed',courseVersion:'1',contentRevision:1,expirationDate:null });
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const result = await trainingService.verifyTraining(1, authority, 'Verified during audit');

      expect(result.verified).toBe(true);
    });

    it('with the effort ledger on, records the verifier interval with the platform role and stated start (T-4)', async () => {
      process.env.TRAINING_EFFORT_LEDGER_ENABLED = 'true';
      try {
        mockQueryOne.mockResolvedValueOnce({userId:3,courseId:4}).mockResolvedValueOnce({version:'1',contentRevision:1}).mockResolvedValueOnce({ id: 1, userId: 3, courseId: 4, status: 'completed',courseVersion:'1',contentRevision:1,expirationDate:null });
        mockQuery.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT id,revision,role,scope') ? [{ id: 8, revision: 1, role: 'coordinator', scope: { studyId: 100, siteId: 101 } }] : [], rowCount: 1 }));
        const stated = new Date(Date.now() - 20 * 60000).toISOString();
        expect(await trainingService.verifyTraining(1, authority, 'Verified during audit', undefined, { effort: { workStartedAt: stated, actorRole: 'monitor' } })).toEqual({ verified: true });
        const effort = mockQuery.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO acc_training_effort_intervals'));
        expect(effort).toHaveLength(1);
        const values = effort[0][1] as unknown[];
        expect(values.slice(1, 9)).toEqual(['verification', 2, 'monitor', 3, 1, 4, null, JSON.stringify([{ obligationId: 8, revision: 1, role: 'coordinator', scope: { studyId: 100, siteId: 101 } }])]);
        expect([values[9], values[11], values[12]]).toEqual([stated, 'client-work-start', null]);
      } finally { delete process.env.TRAINING_EFFORT_LEDGER_ENABLED; }
    });
  });

  describe('getExpiringTraining', () => {
    beforeEach(() => mockQueryOne.mockResolvedValue({ referenceTime: '2026-10-07 00:00:00+00', upperRecordId: 0 }));
    it('should query for records expiring within specified days', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await trainingService.getExpiringTraining(authority, 14);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INTERVAL '1 day' * $1"),
        [14, '2026-10-07 00:00:00+00', 0, null, 0]
      );
    });

    it('should default to 30 days', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await trainingService.getExpiringTraining(authority);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [30, '2026-10-07 00:00:00+00', 0, null, 0]
      );
    });
  });

  describe('expireOverdueRecords', () => {
    it('should update overdue records to expired status', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 1, userId: 4, courseId: 2 }, { id: 2, userId: 5, courseId: 2 }], rowCount: 2 });

      const count = await trainingService.expireOverdueRecords();

      expect(count).toBe(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'expired'"),
      );
    });
  });

  describe('exact compliance identity', () => {
    it('cannot report an absent user as compliant', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(trainingService.checkUserCompliance(77, authority)).rejects.toMatchObject({ statusCode: 404 });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockDirectory).toHaveBeenCalledWith(authority, { userId: 77 });
    });

    it.each([0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid user identity %s before reading records', async userId => {
      await expect(trainingService.checkUserCompliance(userId, authority)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('propagates a failed user read rather than manufacturing compliant empty state', async () => {
      const failure = new Error('Identity storage unavailable');
      mockDirectory.mockRejectedValue(failure);
      await expect(trainingService.checkUserCompliance(77, authority)).rejects.toBe(failure);
    });

    it('refuses a successful-looking compliance result for a different user', async () => {
      mockDirectory.mockResolvedValue({ users: [{ userId: 78, username: 'other', firstName: 'Other', lastName: 'Person', role: 'monitor' }], filter: {}, scopeFingerprint: 'fixture-scope' });
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(trainingService.checkUserCompliance(77, authority)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('keeps the existing required-course calculation for an exact known user', async () => {
      mockDirectory.mockResolvedValue({ users: [{ userId: 77, username: 'known', firstName: 'Known', lastName: 'Person', role: 'monitor' }], filter: {}, scopeFingerprint: 'fixture-scope' });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 5, requiredForRoles: ['monitor'], courseCode: 'REQUIRED-1', courseName: 'Required course', regulatoryReference: null }],
        rowCount: 1,
      }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(trainingService.checkUserCompliance(77, authority)).resolves.toEqual({
        userId: 77, isCompliant: false, missingCount: 1, expiredCount: 0,
      });
    });
  });
});
