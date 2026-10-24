import {createHash,randomUUID} from 'node:crypto';
import {Request,Response} from 'express';
import {config} from '../config/environment';
import {observeObligationDueSource,DueSourceAuthority} from './training-due-source.service';
import {publishedMaterial} from './training-materials.service';
import {trainingDutyHash} from './training-obligations.service';
import {ImpactSourceObservation,ObligationScopeObservation} from './training-authority.service';
import {effortLedgerEnabled,observeTrainingEffortSource} from './training-effort.service';
import type {TrainingEffortArm} from '../types/training.types';
import type {ReadableStreamDefaultReader} from 'node:stream/web';

const canonical=(v:any):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exactDate=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const prefixed=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
const record=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const exactKeys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).length===allowed.length&&allowed.every(k=>Object.prototype.hasOwnProperty.call(v,k));
/** Each observer's refusal codes start with its prefix; every other failure is that observer's _UNAVAILABLE. */
type Prefix='TRAINING_DUE'|'TRAINING_EFFORT';
const UNAVAILABLE:Record<Prefix,string>={TRAINING_DUE:'The exact native training due census is unavailable; no partial census or completion was inferred.',
  TRAINING_EFFORT:'The exact training effort observation is unavailable; no partial count or lead time was inferred.'};
function fail(statusCode=503,code='TRAINING_DUE_UNAVAILABLE'):never{throw Object.assign(new Error(UNAVAILABLE[code.startsWith('TRAINING_EFFORT_')?'TRAINING_EFFORT':'TRAINING_DUE']),{statusCode,code});}
function keys(v:unknown,allowed:string[],code='TRAINING_DUE_INVALID_REQUEST'):asserts v is Record<string,any>{if(!record(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail(400,code);}

type TransportOptions={baseUrl?:string;fetcher?:typeof fetch;now?:()=>number;timeoutMs?:number};
interface ServiceSession {
  /** One bounded native resolve-due call; the first admitted authority hash pins every later one. */
  resolve(op:string,fields:Record<string,unknown>):Promise<any>;
  check():void;now():number;admitted():string|undefined;
  /** The last admitted native answer, whose identity, authority and expiry the receipt names. */
  last():any;
}
/** A separate, read-only machine transport, shared by the due and the effort observers (one per observer, each with
 * its own four readers). Credentials are request-local and every callback reauthenticates at the existing native
 * API-key authority. The whole observation, local reads included, is bounded by one 30 s deadline. */
function serviceTransport(options:TransportOptions,prefix:Prefix){
  const fetcher=options.fetcher??((...args:Parameters<typeof fetch>)=>fetch(...args)),now=options.now??Date.now;
  // Native refusals passed through by status. Only the effort census (op arms) has a native size bound.
  const passed:Record<number,string>={401:'AUTHORITY_REFUSED',403:'AUTHORITY_REFUSED',409:'AUTHORITY_REFUSED'};
  if(prefix==='TRAINING_EFFORT')passed[413]='TOO_LARGE';
  let active=0;
  return async function session<T>(input:Record<string,any>,apiKey:string,signal:AbortSignal|undefined,observe:(session:ServiceSession)=>Promise<T>):Promise<T>{
    if(typeof apiKey!=='string'||!/^atk_[A-Za-z0-9_-]+$/.test(apiKey)||apiKey.length>1024)fail(401,`${prefix}_SERVICE_CREDENTIAL_REQUIRED`);
    const root=new URL(options.baseUrl??config.authority.baseUrl),timeout=options.timeoutMs??config.authority.timeoutMs;
    if(!['https:','http:'].includes(root.protocol)||root.username||root.password||root.pathname!=='/'||root.search||root.hash
      ||root.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(root.hostname)&&process.env.NODE_ENV==='production'
      ||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)fail(503,`${prefix}_UNAVAILABLE`);
    if(active>=4)fail(503,`${prefix}_BUSY`);active++;
    try{
      let admitted:string|undefined=input.expectedAuthorityHash,last:any;
      // A complete census either fits this bounded observation or is unavailable.
      // A slow 1,000-row source cannot occupy a reader indefinitely one callback at a time.
      const deadline=now()+30000;
      const check=()=>{if(signal?.aborted)fail(503,`${prefix}_CANCELLED`);if(now()>=deadline)fail(503,`${prefix}_TIMEOUT`);};
      const resolve=async(op:string,fields:Record<string,unknown>)=>{
        check();const request={schemaVersion:'training-due-authority-request/1',requestId:randomUUID(),installationId:input.installationId,scope:input.scope,op,...fields,...(admitted?{expectedAuthorityHash:admitted}:{})};
        const started=now(),controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(timeout,Math.max(1,deadline-started)));
        signal?.addEventListener('abort',abort,{once:true});let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
        try{
          const response=await fetcher(new URL('/api/training-authority/resolve-due',root),{method:'POST',redirect:'error',signal:controller.signal,
            headers:{'x-api-key':apiKey,'content-type':'application/json',accept:'application/json','cache-control':'no-store'},body:JSON.stringify(request)});
          if(!response.ok){const code=passed[response.status];if(code)fail(response.status,`${prefix}_${code}`);fail(503,`${prefix}_UNAVAILABLE`);}
          if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')||!response.body||Number(response.headers.get('content-length')??0)>262144)fail(503,`${prefix}_UNAVAILABLE`);
          reader=response.body.getReader();const chunks:Buffer[]=[];let count=0;
          while(true){const chunk=await reader.read();if(chunk.done)break;count+=chunk.value.byteLength;if(count>262144)fail(503,`${prefix}_UNAVAILABLE`);chunks.push(Buffer.from(chunk.value));}
          check();if(controller.signal.aborted)fail(503,`${prefix}_UNAVAILABLE`);
          const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),data=body?.data,end=now();
          if(body?.success!==true||!record(data)||data.schemaVersion!=='training-due-authority/1'||data.requestId!==request.requestId
            ||data.requestHash!==hash(request)||data.installationId!==input.installationId||!same(data.scope,input.scope)||data.op!==op||data.complete!==true
            ||!positive(data.serviceUserId)||!positive(data.apiKeyId)||!sha(data.authorityHash)||admitted!==undefined&&admitted!==data.authorityHash
            ||!exactDate(data.observedAt)||!exactDate(data.expiresAt)||Date.parse(data.observedAt)<started-5000||Date.parse(data.observedAt)>end+5000
            ||Date.parse(data.expiresAt)<=end||Date.parse(data.expiresAt)>Date.parse(data.observedAt)+15000
            ||data.consistency!=='current-observations-not-atomic'||!record(data.data))fail(503,`${prefix}_UNAVAILABLE`);
          if(last&&(last.serviceUserId!==data.serviceUserId||last.apiKeyId!==data.apiKeyId))fail(409,`${prefix}_AUTHORITY_CHANGED`);
          admitted=data.authorityHash;last=data;return data.data;
        }catch(error){if(record(error)&&typeof error.statusCode==='number'&&typeof error.code==='string'&&error.code.startsWith(`${prefix}_`))throw error;fail(503,`${prefix}_UNAVAILABLE`);}
        finally{clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);try{await reader?.cancel();}catch{/* bounded transport cleanup */}}
      };
      return await observe({resolve,check,now,admitted:()=>admitted,last:()=>last});
    }finally{active--;}
  };
}
/** The service observation envelope (TrainingDueServiceObservationV1@1.0.0, TrainingEffortServiceObservationV1@1.0.0):
 * the request, the admitted native service authority and the observed data, never the credential. */
function envelope(schemaVersion:string,input:Record<string,any>,session:ServiceSession,data:unknown,prefix:Prefix){
  const last=session.last();if(!last||Date.parse(last.expiresAt)<=session.now())fail(503,`${prefix}_UNAVAILABLE`);
  return {schemaVersion,requestId:input.requestId,requestHash:hash(input),installationId:input.installationId,
    scope:input.scope,authority:{apiKeyId:last.apiKeyId,serviceUserId:last.serviceUserId,authorityHash:session.admitted(),observedAt:last.observedAt,expiresAt:last.expiresAt},
    data,consistency:'current-observations-not-atomic',externalDeliveryConfirmed:false};
}

export function createServiceDueObserver(options:TransportOptions={}){
  const session=serviceTransport(options,'TRAINING_DUE');
  return async function observe(input:unknown,apiKey:string,signal?:AbortSignal){
    keys(input,['schemaVersion','requestId','installationId','scope','originals','expectedAuthorityHash']);
    keys(input.scope,['studyId','siteId']);
    if(input.schemaVersion!=='training-due-observation-request/1'||!uuid(input.requestId)||typeof input.installationId!=='string'
      ||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.installationId)||!positive(input.scope.studyId)
      ||input.scope.siteId!==undefined&&(!positive(input.scope.siteId)||input.scope.siteId===input.scope.studyId)
      ||input.expectedAuthorityHash!==undefined&&!sha(input.expectedAuthorityHash)||!Array.isArray(input.originals)||input.originals.length>16)fail(400,'TRAINING_DUE_INVALID_REQUEST');
    const scope:{studyId:number;siteId?:number}={studyId:input.scope.studyId,...(input.scope.siteId===undefined?{}:{siteId:input.scope.siteId})};
    const seen=new Set<string>();for(const pin of input.originals){keys(pin,['kind','fileId','sha256']);if(!['protocol','product','duty','amendment','staff'].includes(pin.kind)||!uuid(pin.fileId)||!sha(pin.sha256)||seen.has(pin.fileId))fail(400,'TRAINING_DUE_INVALID_REQUEST');seen.add(pin.fileId);}
    return session(input,apiKey,signal,async(native)=>{
      const {resolve,check,admitted}=native;
      const inspect=async():Promise<ImpactSourceObservation>=>{
        const observed=await resolve('source',{originals:input.originals});
        if(!same(observed.scope,input.scope)||!record(observed.source)||!sha(observed.source.nativeSourceHash)||!Number.isSafeInteger(observed.source.lifecycleRevision)
          ||observed.source.lifecycleRevision<0||!same(observed.source.originals,input.originals)||!prefixed(observed.sourceObservationHash))fail();
        return {...observed,scopeFingerprint:`sha256:${admitted()}`,actorAuthorityHash:`sha256:${admitted()}`} as ImpactSourceObservation;
      };
      const callbacks:DueSourceAuthority={inspect,
        obligation:async(userId,scope,retained,expected):Promise<ObligationScopeObservation>=>{
          const data=await resolve('obligation',{userId,learnerScope:scope,retained});
          if(data.userId!==userId||!same(data.scope,scope)||typeof data.eligible!=='boolean'||!Array.isArray(data.roles)||data.roles.some((v:unknown)=>typeof v!=='string')
            ||!prefixed(data.observationHash)||expected&&expected.observationHash!==data.observationHash)fail(409,'TRAINING_DUE_SCOPE_CHANGED');
          return {...data,scopeFingerprint:`sha256:${admitted()}`} as ObligationScopeObservation;
        },
        material:async(client,course,row)=>{
          const publication=await publishedMaterial(client,course);if(!publication)fail(409,'TRAINING_DUE_MATERIAL_UNAVAILABLE');
          const data=await resolve('material',{material:publication.receipt.source,userId:row.userId,learnerScope:row.scope});
          if(data.current!==true||data.sourceHash!==publication.receipt.source.sourceHash)fail(409,'TRAINING_DUE_MATERIAL_CHANGED');
        },
        finish:async(source)=>{const current=await inspect();if(!same(source,current))fail(409,'TRAINING_DUE_SOURCE_CHANGED');},
      };
      check();const data=await observeObligationDueSource(scope,input.originals,callbacks);check();
      const receipt=envelope('TrainingDueServiceObservationV1@1.0.0',input,native,data,'TRAINING_DUE');
      const {observedAt:_time,consistency:_consistency,sourceHash,...body}=data;
      if(sourceHash!==trainingDutyHash(body))fail();
      if(Buffer.byteLength(JSON.stringify(receipt))>8*1024*1024)fail(413,'TRAINING_DUE_CENSUS_TOO_LARGE');
      return receipt;
    });
  };
}

const ARM_KEYS=['armId','classId','disclosureLevel','groupStatus','lifecycleState','onboardedAt','onboardEventId'];
const LEVELS=['regimen','cohort','treatment-assignment',null];
/** The EDC's op arms census (T-4/edcapi), exactly: the requested root, at most 500 arms in armId order with their seven
 * keys, and the census hash over both. Anything else is refused whole. */
function armCensus(data:unknown,scope:{studyId:number}):{arms:TrainingEffortArm[];armsObservationHash:string}{
  if(!record(data)||!exactKeys(data,['scope','arms','armsObservationHash'])||!same(data.scope,scope)||!Array.isArray(data.arms)||data.arms.length>500
    ||data.armsObservationHash!==`sha256:${hash({scope:data.scope,arms:data.arms})}`)fail(503,'TRAINING_EFFORT_UNAVAILABLE');
  let previous=0;
  for(const arm of data.arms){
    if(!record(arm)||!exactKeys(arm,ARM_KEYS)||!positive(arm.armId)||arm.armId<=previous||!positive(arm.classId)||!LEVELS.includes(arm.disclosureLevel)
      ||arm.groupStatus!==null&&!Number.isSafeInteger(arm.groupStatus)||arm.lifecycleState!==null&&(typeof arm.lifecycleState!=='string'||!arm.lifecycleState||arm.lifecycleState.length>64)
      ||(arm.onboardedAt===null)!==(arm.onboardEventId===null)||arm.onboardedAt!==null&&(!exactDate(arm.onboardedAt)||!Number.isSafeInteger(arm.onboardEventId)||arm.onboardEventId<1))
      fail(503,'TRAINING_EFFORT_UNAVAILABLE');
    previous=arm.armId;
  }
  return {arms:data.arms as TrainingEffortArm[],armsObservationHash:data.armsObservationHash};
}
/** TrainingEffortServiceObservationV1@1.0.0 (T-4, P25 5.2 C) for one root study: the EDC's arm census, the local
 * snapshot computed against it (training-effort.service.ts), and the same census again, which must not have changed.
 * Answers 503 TRAINING_EFFORT_DISABLED, before anything else, unless TRAINING_EFFORT_LEDGER_ENABLED=true. */
export function createServiceEffortObserver(options:TransportOptions={}){
  const session=serviceTransport(options,'TRAINING_EFFORT');
  return async function observe(input:unknown,apiKey:string,signal?:AbortSignal){
    if(!effortLedgerEnabled())fail(503,'TRAINING_EFFORT_DISABLED');
    keys(input,['schemaVersion','requestId','installationId','scope','expectedAuthorityHash'],'TRAINING_EFFORT_INVALID_REQUEST');
    keys(input.scope,['studyId'],'TRAINING_EFFORT_INVALID_REQUEST');
    if(input.schemaVersion!=='training-effort-observation-request/1'||!uuid(input.requestId)||typeof input.installationId!=='string'
      ||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.installationId)||!positive(input.scope.studyId)
      ||input.expectedAuthorityHash!==undefined&&!sha(input.expectedAuthorityHash))fail(400,'TRAINING_EFFORT_INVALID_REQUEST');
    const scope={studyId:input.scope.studyId as number};
    return session(input,apiKey,signal,async(native)=>{
      native.check();const census=armCensus(await native.resolve('arms',{}),scope);
      const data=await observeTrainingEffortSource(scope,census.arms);native.check();
      if(armCensus(await native.resolve('arms',{}),scope).armsObservationHash!==census.armsObservationHash)fail(409,'TRAINING_EFFORT_SOURCE_CHANGED');
      const receipt=envelope('TrainingEffortServiceObservationV1@1.0.0',input,native,data,'TRAINING_EFFORT');
      const {asOf:_asOf,sourceHash,...body}=data;
      if(sourceHash!==trainingDutyHash(body))fail(503,'TRAINING_EFFORT_UNAVAILABLE');
      if(Buffer.byteLength(JSON.stringify(receipt))>8*1024*1024)fail(413,'TRAINING_EFFORT_TOO_LARGE');
      return receipt;
    });
  };
}

/** The HTTP handler of one observer: x-api-key only, no query, never cached; a cancelled request answers nothing. */
function serve(observe:(input:unknown,apiKey:string,signal?:AbortSignal)=>Promise<unknown>,prefix:Prefix,message:string,precondition?:()=>void){
  return async function serveObservation(req:Request,res:Response):Promise<void>{
    const cancellation=new AbortController(),abort=()=>cancellation.abort(),close=()=>{if(!res.writableEnded)abort();};
    req.once('aborted',abort);res.once('close',close);res.setHeader('Cache-Control','no-store');
    try{
      precondition?.();
      if(req.aborted||res.destroyed)abort();if(Object.keys(req.query).length)fail(400,`${prefix}_INVALID_REQUEST`);
      const key=req.headers['x-api-key'];if(typeof key!=='string')fail(401,`${prefix}_SERVICE_CREDENTIAL_REQUIRED`);
      const data=await observe(req.body,key,cancellation.signal);if(!cancellation.signal.aborted)res.json({success:true,data});
    }catch(error){if(!cancellation.signal.aborted){const e=error as {statusCode?:number;code?:string};res.status(e.statusCode??503).json({success:false,error:{code:e.code??`${prefix}_UNAVAILABLE`,message}});}}
    finally{req.off('aborted',abort);res.off('close',close);}
  };
}
/** Register before human-session middleware, only at the dedicated read route. */
export const observeServiceDue=serve(createServiceDueObserver(),'TRAINING_DUE','Training due-source observation could not be verified.');
/** POST /api/training/effort-source/observe, registered beside the due route before human-session middleware. With
 * the effort ledger off it answers 503 TRAINING_EFFORT_DISABLED whatever the request. */
export const observeServiceEffort=serve(createServiceEffortObserver(),'TRAINING_EFFORT','Training effort observation could not be verified.',
  ()=>{if(!effortLedgerEnabled())fail(503,'TRAINING_EFFORT_DISABLED');});
