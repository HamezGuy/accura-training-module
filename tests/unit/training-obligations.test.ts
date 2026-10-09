import {obligationReadiness,validateObligationRequest} from '../../src/services/training-obligations.service';
jest.mock('../../src/config/database',()=>({}));
jest.mock('../../src/config/logger',()=>({logger:{}}));
jest.mock('../../src/services/training-authority.service',()=>({}));
const now=Date.parse('2026-10-09T12:00:00Z');
const obligation:any={userId:22,courseId:1,courseVersion:'2',contentRevision:8,status:'assigned'};
const course:any={active:true,version:'2',contentRevision:8};
const record:any={userId:22,status:'completed',courseVersion:'2',contentRevision:8,expirationDate:'2027-01-01',completedAt:'2026-10-09T09:00:00Z',certificateNumber:'CERT',verifiedBy:33,verifiedAt:'2026-10-09T10:00:00Z'};
test('only current independent evidence can satisfy an obligation',()=>{expect(obligationReadiness(obligation,course,record,'current',now)).toBe('complete');});
test.each([
  ['expiry',{expirationDate:'2026-10-09T12:00:00Z'},'retraining_required'],['invalid expiry',{expirationDate:'bad'},'retraining_required'],
  ['old revision',{contentRevision:7},'retraining_required'],['missing pin',{courseVersion:null},'retraining_required'],
  ['self review',{verifiedBy:22},'awaiting_verification'],['invalid review time',{verifiedAt:'bad'},'awaiting_verification'],
  ['early review',{verifiedAt:'2026-10-09T08:00:00Z'},'awaiting_verification'],['missing reviewer',{verifiedBy:null},'awaiting_verification'],
  ['missing certificate',{certificateNumber:null},'pending'],['invalid completion time',{completedAt:'bad'},'pending'],
] as const)('%s does not produce complete readiness',(_name,patch,expected)=>{expect(obligationReadiness(obligation,course,{...record,...patch},'current',now)).toBe(expected);});
test.each(['changed','unavailable'] as const)('lost native scope %s overrides valid certificate',scope=>{expect(obligationReadiness(obligation,course,record,scope,now)).not.toBe('complete');});
test('inactive or revised course cannot keep readiness complete',()=>{
  expect(obligationReadiness(obligation,{...course,active:false},record,'current',now)).toBe('course_inactive');
  expect(obligationReadiness(obligation,{...course,contentRevision:9},record,'current',now)).toBe('retraining_required');
});
const valid:any={userId:22,courseId:1,contentRevision:8,role:'coordinator',scope:{studyId:1,siteId:2,armId:3},dueAt:'2026-10-10T10:00:00Z',reason:'Required procedure'};
test.each([{dueAt:'2026-02-30T12:00:00Z'},{dueAt:'2026-10-10T12:00:00'},{userId:1.5},{scope:{studyId:1,siteId:0}},{scope:{studyId:1,extra:'claim'}},{role:'study_director'},{reason:'  '}])('refuses invalid obligation input %j',patch=>{expect(()=>validateObligationRequest({...valid,...patch})).toThrow();});
test('explicit valid UTC-offset due date is retained',()=>{expect(()=>validateObligationRequest({...valid,dueAt:'2026-10-10T10:00:00-05:00'})).not.toThrow();});
