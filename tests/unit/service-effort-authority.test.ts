import {randomUUID} from 'node:crypto';
import {createServiceEffortObserver} from '../../src/services/service-due-authority';
import {observeTrainingEffortSource} from '../../src/services/training-effort.service';
import {trainingDutyHash} from '../../src/services/training-obligations.service';
jest.mock('../../src/config/environment',()=>({config:{authority:{baseUrl:'https://native.example.invalid',timeoutMs:15000}}}));
jest.mock('../../src/config/database',()=>({}));
jest.mock('../../src/services/training-authority.service',()=>({}));
jest.mock('../../src/services/training-materials.service',()=>({}));
jest.mock('../../src/services/training-due-source.service',()=>({observeObligationDueSource:jest.fn()}));
// The real switch (process.env at each call); only the local snapshot reader is replaced.
jest.mock('../../src/services/training-effort.service',()=>({...jest.requireActual('../../src/services/training-effort.service'),observeTrainingEffortSource:jest.fn()}));

/** The effort observer shares the due observer's machine transport (P25 5.2 C): one fixed native read route, the
 * request-local API key, the 30 s observation deadline and four readers. It reads the EDC's op arms census before and
 * after the local snapshot and refuses a census that changed in between. */
const credential='atk_synthetic_OnlyForTransportUnitFixture';
const input=(extra:object={})=>({schemaVersion:'training-effort-observation-request/1',requestId:randomUUID(),installationId:'synthetic-installation',scope:{studyId:11},...extra});
const census=(scope:{studyId:number},arms:any[]=[{armId:5,classId:2,disclosureLevel:'regimen',groupStatus:null,lifecycleState:'pending',onboardedAt:'2026-10-01T00:00:00.000Z',onboardEventId:41},
  {armId:6,classId:3,disclosureLevel:'treatment-assignment',groupStatus:1,lifecycleState:null,onboardedAt:null,onboardEventId:null}])=>({scope,arms,armsObservationHash:`sha256:${trainingDutyHash({scope,arms})}`});
function response(request:any,now:number,data:unknown=census(request.scope),status=200){
  return new Response(JSON.stringify(status===200?{success:true,data:{schemaVersion:'training-due-authority/1',requestId:request.requestId,requestHash:trainingDutyHash(request),installationId:request.installationId,
    scope:request.scope,op:request.op,complete:true,apiKeyId:7,serviceUserId:8,authorityHash:'a'.repeat(64),observedAt:new Date(now).toISOString(),expiresAt:new Date(now+15000).toISOString(),
    consistency:'current-observations-not-atomic',data}}:{success:false,error:{code:'TRAINING_DUE_CENSUS_TOO_LARGE'}}),{status,headers:{'content-type':'application/json'}});
}
const body={schemaVersion:'TrainingEffortSourceV1@1.0.0',scope:{studyId:11},dataClass:'synthetic',hours:[],arms:[],counts:{intervals:0,throughIntervalId:null}};
const document={...body,asOf:'2026-10-24T00:00:00.000Z',sourceHash:trainingDutyHash(body)};
const local=jest.mocked(observeTrainingEffortSource);
beforeEach(()=>{jest.clearAllMocks();process.env.TRAINING_EFFORT_LEDGER_ENABLED='true';local.mockResolvedValue(document as any);});
afterEach(()=>{delete process.env.TRAINING_EFFORT_LEDGER_ENABLED;});

test('answers 503 TRAINING_EFFORT_DISABLED while the switch is off, before validation or any native call',async()=>{
  delete process.env.TRAINING_EFFORT_LEDGER_ENABLED;const fetcher=jest.fn() as unknown as typeof fetch;
  await expect(createServiceEffortObserver({fetcher})(input(),credential)).rejects.toMatchObject({statusCode:503,code:'TRAINING_EFFORT_DISABLED'});
  await expect(createServiceEffortObserver({fetcher})({nonsense:true},'')).rejects.toMatchObject({statusCode:503,code:'TRAINING_EFFORT_DISABLED'});
  expect(fetcher).not.toHaveBeenCalled();expect(local).not.toHaveBeenCalled();
});
test('reads the arm census twice on the fixed native read route with the request-local key, then wraps the local snapshot',async()=>{
  const requests:any[]=[];const fetcher:typeof fetch=async(url,init)=>{expect(String(url)).toBe('https://native.example.invalid/api/training-authority/resolve-due');expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();expect(new Headers(init?.headers).get('x-api-key')).toBe(credential);const r=JSON.parse(String(init?.body));requests.push(r);return response(r,100000);};
  const request=input(),receipt=await createServiceEffortObserver({fetcher,now:()=>100000})(request,credential);
  expect(requests.map(r=>[r.op,r.scope,r.expectedAuthorityHash])).toEqual([['arms',{studyId:11},undefined],['arms',{studyId:11},'a'.repeat(64)]]);
  for(const r of requests)expect(Object.keys(r).sort()).toEqual(['installationId','op','requestId','schemaVersion','scope',...(r.expectedAuthorityHash?['expectedAuthorityHash']:[])].sort());
  // The arms read before the snapshot reach the local computation exactly.
  expect(local).toHaveBeenCalledWith({studyId:11},census({studyId:11}).arms);
  expect(receipt).toEqual({schemaVersion:'TrainingEffortServiceObservationV1@1.0.0',requestId:request.requestId,requestHash:trainingDutyHash(request),installationId:'synthetic-installation',scope:{studyId:11},
    authority:{apiKeyId:7,serviceUserId:8,authorityHash:'a'.repeat(64),observedAt:new Date(100000).toISOString(),expiresAt:new Date(115000).toISOString()},
    data:document,consistency:'current-observations-not-atomic',externalDeliveryConfirmed:false});
  expect(JSON.stringify(receipt)).not.toContain(credential);
});
test('refuses a census that changed between the two observations, and a local document that does not hash to itself',async()=>{
  let calls=0;const changing:typeof fetch=async(_url,init)=>{const r=JSON.parse(String(init?.body));return response(r,100000,++calls===1?census(r.scope):census(r.scope,[]));};
  await expect(createServiceEffortObserver({fetcher:changing,now:()=>100000})(input(),credential)).rejects.toMatchObject({statusCode:409,code:'TRAINING_EFFORT_SOURCE_CHANGED'});
  const fetcher:typeof fetch=async(_url,init)=>response(JSON.parse(String(init?.body)),100000);
  local.mockResolvedValueOnce({...document,hours:[{}]} as any);
  await expect(createServiceEffortObserver({fetcher,now:()=>100000})(input(),credential)).rejects.toMatchObject({statusCode:503,code:'TRAINING_EFFORT_UNAVAILABLE'});
});
test.each([
  ['an extra census key',(s:any)=>({...census(s),complete:true})],
  ['an arm with an extra key',(s:any)=>census(s,[{armId:5,classId:2,disclosureLevel:'regimen',groupStatus:null,lifecycleState:null,onboardedAt:null,onboardEventId:null,name:'Arm A'}])],
  ['an unknown disclosure level',(s:any)=>census(s,[{armId:5,classId:2,disclosureLevel:'site-known',groupStatus:null,lifecycleState:null,onboardedAt:null,onboardEventId:null}])],
  ['arms out of order',(s:any)=>census(s,[{armId:6,classId:2,disclosureLevel:null,groupStatus:null,lifecycleState:null,onboardedAt:null,onboardEventId:null},{armId:5,classId:2,disclosureLevel:null,groupStatus:null,lifecycleState:null,onboardedAt:null,onboardEventId:null}])],
  ['an inexact onboarding instant',(s:any)=>census(s,[{armId:5,classId:2,disclosureLevel:'regimen',groupStatus:null,lifecycleState:'pending',onboardedAt:'2026-10-01T00:00:00Z',onboardEventId:41}])],
  ['a census hash that is not of its arms',(s:any)=>({...census(s),armsObservationHash:`sha256:${'b'.repeat(64)}`})],
  ['another scope',()=>census({studyId:12})],
  ['501 arms',(s:any)=>census(s,Array.from({length:501},(_v,i)=>({armId:i+1,classId:2,disclosureLevel:null,groupStatus:null,lifecycleState:null,onboardedAt:null,onboardEventId:null})))],
])('refuses %s whole, before any local read',async(_name,data)=>{
  const fetcher:typeof fetch=async(_url,init)=>{const r=JSON.parse(String(init?.body));return response(r,100000,data(r.scope));};
  await expect(createServiceEffortObserver({fetcher,now:()=>100000})(input(),credential)).rejects.toMatchObject({statusCode:503,code:'TRAINING_EFFORT_UNAVAILABLE'});
  expect(local).not.toHaveBeenCalled();
});
test('passes the native census bound and authority refusals through by status; any other failure is unavailable',async()=>{
  const status=(code:number):typeof fetch=>async(_url,init)=>response(JSON.parse(String(init?.body)),100000,undefined,code);
  await expect(createServiceEffortObserver({fetcher:status(413)})(input(),credential)).rejects.toMatchObject({statusCode:413,code:'TRAINING_EFFORT_TOO_LARGE'});
  for(const code of [401,403,409])await expect(createServiceEffortObserver({fetcher:status(code)})(input(),credential)).rejects.toMatchObject({statusCode:code,code:'TRAINING_EFFORT_AUTHORITY_REFUSED'});
  await expect(createServiceEffortObserver({fetcher:status(500)})(input(),credential)).rejects.toMatchObject({statusCode:503,code:'TRAINING_EFFORT_UNAVAILABLE'});
  // The local census bound keeps its own refusal.
  local.mockRejectedValueOnce(Object.assign(new Error('bound'),{statusCode:413,code:'TRAINING_EFFORT_TOO_LARGE'}));
  const fetcher:typeof fetch=async(_url,init)=>response(JSON.parse(String(init?.body)),100000);
  await expect(createServiceEffortObserver({fetcher,now:()=>100000})(input(),credential)).rejects.toMatchObject({statusCode:413,code:'TRAINING_EFFORT_TOO_LARGE'});
});
test.each([
  ['a site scope',input({scope:{studyId:11,siteId:22}})],['originals',input({originals:[]})],['another version',input({schemaVersion:'training-due-observation-request/1'})],
  ['a malformed request id',input({requestId:'r-1'})],['a malformed installation',input({installationId:'-bad'})],['a malformed authority pin',input({expectedAuthorityHash:'abc'})],['an array',[]],
])('refuses %s with 400 before any native call',async(_name,value)=>{
  const fetcher=jest.fn() as unknown as typeof fetch;
  await expect(createServiceEffortObserver({fetcher})(value,credential)).rejects.toMatchObject({statusCode:400,code:'TRAINING_EFFORT_INVALID_REQUEST'});
  expect(fetcher).not.toHaveBeenCalled();
});
test('requires the request-local API key and cancels before any native disclosure',async()=>{
  const fetcher=jest.fn() as unknown as typeof fetch;
  await expect(createServiceEffortObserver({fetcher})(input(),'Bearer human')).rejects.toMatchObject({statusCode:401,code:'TRAINING_EFFORT_SERVICE_CREDENTIAL_REQUIRED'});
  const controller=new AbortController();controller.abort();
  await expect(createServiceEffortObserver({fetcher})(input(),credential,controller.signal)).rejects.toMatchObject({code:'TRAINING_EFFORT_CANCELLED'});
  expect(fetcher).not.toHaveBeenCalled();
});
test('bounds the whole observation, including the local snapshot, by the shared 30 s deadline',async()=>{
  let now=100000;const fetcher:typeof fetch=async(_url,init)=>response(JSON.parse(String(init?.body)),now);
  local.mockImplementationOnce(async()=>{now+=31000;return document as any;});
  await expect(createServiceEffortObserver({fetcher,now:()=>now})(input(),credential)).rejects.toMatchObject({statusCode:503,code:'TRAINING_EFFORT_TIMEOUT'});
});
