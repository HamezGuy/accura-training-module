import {randomUUID} from 'node:crypto';
import {createServiceDueObserver} from '../../src/services/service-due-authority';
import {observeObligationDueSource} from '../../src/services/training-due-source.service';
import {trainingDutyHash} from '../../src/services/training-obligations.service';
jest.mock('../../src/config/environment',()=>({config:{authority:{baseUrl:'https://native.example.invalid',timeoutMs:15000}}}));
jest.mock('../../src/config/database',()=>({}));
jest.mock('../../src/services/training-authority.service',()=>({}));
jest.mock('../../src/services/training-materials.service',()=>({}));
jest.mock('../../src/services/training-due-source.service',()=>({observeObligationDueSource:jest.fn()}));
const input=()=>({schemaVersion:'training-due-observation-request/1',requestId:randomUUID(),installationId:'synthetic-installation',scope:{studyId:11,siteId:22},originals:[]});
const credential='atk_synthetic_OnlyForTransportUnitFixture';
const body={schemaVersion:'TrainingObligationDueSourceV1@1.0.0',scope:{studyId:11,siteId:22},complete:true,count:0,obligations:[]};
const observed=jest.mocked(observeObligationDueSource);
beforeEach(()=>{jest.clearAllMocks();observed.mockImplementation(async(_scope,_originals,authority)=>{
 const source=await authority.inspect();await authority.finish(source);return {...body,observedAt:new Date(100000).toISOString(),consistency:'current-observations-not-atomic',sourceHash:trainingDutyHash(body)} as any;
});});
function response(request:any,now:number){return new Response(JSON.stringify({success:true,data:{schemaVersion:'training-due-authority/1',requestId:request.requestId,requestHash:trainingDutyHash(request),installationId:request.installationId,scope:request.scope,op:request.op,complete:true,apiKeyId:7,serviceUserId:8,authorityHash:'a'.repeat(64),observedAt:new Date(now).toISOString(),expiresAt:new Date(now+15000).toISOString(),consistency:'current-observations-not-atomic',data:{scope:request.scope,source:{nativeSourceHash:'b'.repeat(64),lifecycleRevision:0,originals:[]},sourceObservationHash:`sha256:${'c'.repeat(64)}`}}}),{headers:{'content-type':'application/json'}});}
test('uses only the fixed native read route and request-local key, pinning authority across callbacks',async()=>{
 const requests:any[]=[];const fetcher:typeof fetch=async(url,init)=>{expect(String(url)).toBe('https://native.example.invalid/api/training-authority/resolve-due');expect(init?.redirect).toBe('error');expect(new Headers(init?.headers).get('authorization')).toBeNull();expect(new Headers(init?.headers).get('x-api-key')).toBe(credential);const r=JSON.parse(String(init?.body));requests.push(r);return response(r,100000);};
 const receipt=await createServiceDueObserver({fetcher,now:()=>100000})(input(),credential);expect(requests).toHaveLength(2);expect(requests[0].expectedAuthorityHash).toBeUndefined();expect(requests[1].expectedAuthorityHash).toBe('a'.repeat(64));expect(JSON.stringify(receipt)).not.toContain(credential);
});
test('bounds total observation duration even when each individual callback is timely',async()=>{
 observed.mockImplementationOnce(async(_scope,_originals,authority)=>{const source=await authority.inspect();await authority.finish(source);await authority.finish(source);return {...body,observedAt:new Date(133000).toISOString(),consistency:'current-observations-not-atomic',sourceHash:trainingDutyHash(body)} as any;});
 let now=100000;const fetcher:typeof fetch=async(_url,init)=>{now+=11000;return response(JSON.parse(String(init?.body)),now);};
 await expect(createServiceDueObserver({fetcher,now:()=>now})(input(),credential)).rejects.toMatchObject({statusCode:503,code:'TRAINING_DUE_TIMEOUT'});
});
test('cancels before any native source disclosure',async()=>{
 const controller=new AbortController();controller.abort();const fetcher=jest.fn() as unknown as typeof fetch;
 await expect(createServiceDueObserver({fetcher})(input(),credential,controller.signal)).rejects.toMatchObject({code:'TRAINING_DUE_CANCELLED'});expect(fetcher).not.toHaveBeenCalled();
});
test('aborts a stalled callback and releases capacity for an explicit retry',async()=>{
 const stalled:typeof fetch=async(_url,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('fixture abort')),{once:true}));
 const observe=createServiceDueObserver({fetcher:stalled,timeoutMs:5});
 for(let i=0;i<5;i++)await expect(observe(input(),credential)).rejects.toMatchObject({statusCode:503,code:'TRAINING_DUE_UNAVAILABLE'});
});
