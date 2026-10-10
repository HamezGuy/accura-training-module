import {createHash,randomUUID} from 'node:crypto';
import {Request,Response} from 'express';
import {config} from '../config/environment';
import {observeObligationDueSource,DueSourceAuthority} from './training-due-source.service';
import {publishedMaterial} from './training-materials.service';
import {trainingDutyHash} from './training-obligations.service';
import {ImpactSourceObservation,ObligationScopeObservation} from './training-authority.service';
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
function fail(statusCode=503,code='TRAINING_DUE_UNAVAILABLE'):never{throw Object.assign(new Error('The exact native training due census is unavailable; no partial census or completion was inferred.'),{statusCode,code});}
function keys(v:unknown,allowed:string[]):asserts v is Record<string,any>{if(!record(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail(400,'TRAINING_DUE_INVALID_REQUEST');}

/** A separate, read-only machine transport. Credentials are request-local and
 * every callback reauthenticates at the existing native API-key authority. */
export function createServiceDueObserver(options:{baseUrl?:string;fetcher?:typeof fetch;now?:()=>number;timeoutMs?:number}={}){
  const fetcher=options.fetcher??((...args:Parameters<typeof fetch>)=>fetch(...args)),now=options.now??Date.now;
  let active=0;
  return async function observe(input:unknown,apiKey:string,signal?:AbortSignal){
    keys(input,['schemaVersion','requestId','installationId','scope','originals','expectedAuthorityHash']);
    keys(input.scope,['studyId','siteId']);
    if(input.schemaVersion!=='training-due-observation-request/1'||!uuid(input.requestId)||typeof input.installationId!=='string'
      ||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.installationId)||!positive(input.scope.studyId)
      ||input.scope.siteId!==undefined&&(!positive(input.scope.siteId)||input.scope.siteId===input.scope.studyId)
      ||input.expectedAuthorityHash!==undefined&&!sha(input.expectedAuthorityHash)||!Array.isArray(input.originals)||input.originals.length>16)fail(400,'TRAINING_DUE_INVALID_REQUEST');
    const scope:{studyId:number;siteId?:number}={studyId:input.scope.studyId,...(input.scope.siteId===undefined?{}:{siteId:input.scope.siteId})};
    const seen=new Set<string>();for(const pin of input.originals){keys(pin,['kind','fileId','sha256']);if(!['protocol','product','duty','amendment','staff'].includes(pin.kind)||!uuid(pin.fileId)||!sha(pin.sha256)||seen.has(pin.fileId))fail(400,'TRAINING_DUE_INVALID_REQUEST');seen.add(pin.fileId);}
    if(typeof apiKey!=='string'||!/^atk_[A-Za-z0-9_-]+$/.test(apiKey)||apiKey.length>1024)fail(401,'TRAINING_DUE_SERVICE_CREDENTIAL_REQUIRED');
    const root=new URL(options.baseUrl??config.authority.baseUrl),timeout=options.timeoutMs??config.authority.timeoutMs;
    if(!['https:','http:'].includes(root.protocol)||root.username||root.password||root.pathname!=='/'||root.search||root.hash
      ||root.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(root.hostname)&&process.env.NODE_ENV==='production'
      ||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)fail();
    if(active>=4)fail(503,'TRAINING_DUE_BUSY');active++;
    let admitted:string|undefined=input.expectedAuthorityHash,last:any;
    // A complete census either fits this bounded observation or is unavailable.
    // A slow 1,000-row source cannot occupy a reader indefinitely one callback at a time.
    const deadline=now()+30000;
    const check=()=>{if(signal?.aborted)fail(503,'TRAINING_DUE_CANCELLED');if(now()>=deadline)fail(503,'TRAINING_DUE_TIMEOUT');};
    const resolve=async(op:string,fields:Record<string,unknown>)=>{
      check();const request={schemaVersion:'training-due-authority-request/1',requestId:randomUUID(),installationId:input.installationId,scope:input.scope,op,...fields,...(admitted?{expectedAuthorityHash:admitted}:{})};
      const started=now(),controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(timeout,Math.max(1,deadline-started)));
      signal?.addEventListener('abort',abort,{once:true});let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
      try{
        const response=await fetcher(new URL('/api/training-authority/resolve-due',root),{method:'POST',redirect:'error',signal:controller.signal,
          headers:{'x-api-key':apiKey,'content-type':'application/json',accept:'application/json','cache-control':'no-store'},body:JSON.stringify(request)});
        if(!response.ok){if([401,403,409].includes(response.status))fail(response.status,'TRAINING_DUE_AUTHORITY_REFUSED');fail();}
        if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')||!response.body||Number(response.headers.get('content-length')??0)>262144)fail();
        reader=response.body.getReader();const chunks:Buffer[]=[];let count=0;
        while(true){const chunk=await reader.read();if(chunk.done)break;count+=chunk.value.byteLength;if(count>262144)fail();chunks.push(Buffer.from(chunk.value));}
        check();if(controller.signal.aborted)fail();
        const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),data=body?.data,end=now();
        if(body?.success!==true||!record(data)||data.schemaVersion!=='training-due-authority/1'||data.requestId!==request.requestId
          ||data.requestHash!==hash(request)||data.installationId!==input.installationId||!same(data.scope,input.scope)||data.op!==op||data.complete!==true
          ||!positive(data.serviceUserId)||!positive(data.apiKeyId)||!sha(data.authorityHash)||admitted!==undefined&&admitted!==data.authorityHash
          ||!exactDate(data.observedAt)||!exactDate(data.expiresAt)||Date.parse(data.observedAt)<started-5000||Date.parse(data.observedAt)>end+5000
          ||Date.parse(data.expiresAt)<=end||Date.parse(data.expiresAt)>Date.parse(data.observedAt)+15000
          ||data.consistency!=='current-observations-not-atomic'||!record(data.data))fail();
        if(last&&(last.serviceUserId!==data.serviceUserId||last.apiKeyId!==data.apiKeyId))fail(409,'TRAINING_DUE_AUTHORITY_CHANGED');
        admitted=data.authorityHash;last=data;return data.data;
      }catch(error){if(record(error)&&typeof error.statusCode==='number'&&typeof error.code==='string'&&error.code.startsWith('TRAINING_DUE_'))throw error;fail();}
      finally{clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);try{await reader?.cancel();}catch{/* bounded transport cleanup */}}
    };
    const inspect=async():Promise<ImpactSourceObservation>=>{
      const observed=await resolve('source',{originals:input.originals});
      if(!same(observed.scope,input.scope)||!record(observed.source)||!sha(observed.source.nativeSourceHash)||!Number.isSafeInteger(observed.source.lifecycleRevision)
        ||observed.source.lifecycleRevision<0||!same(observed.source.originals,input.originals)||!prefixed(observed.sourceObservationHash))fail();
      return {...observed,scopeFingerprint:`sha256:${admitted}`,actorAuthorityHash:`sha256:${admitted}`} as ImpactSourceObservation;
    };
    const callbacks:DueSourceAuthority={inspect,
      obligation:async(userId,scope,retained,expected):Promise<ObligationScopeObservation>=>{
        const data=await resolve('obligation',{userId,learnerScope:scope,retained});
        if(data.userId!==userId||!same(data.scope,scope)||typeof data.eligible!=='boolean'||!Array.isArray(data.roles)||data.roles.some(v=>typeof v!=='string')
          ||!prefixed(data.observationHash)||expected&&expected.observationHash!==data.observationHash)fail(409,'TRAINING_DUE_SCOPE_CHANGED');
        return {...data,scopeFingerprint:`sha256:${admitted}`} as ObligationScopeObservation;
      },
      material:async(client,course,row)=>{
        const publication=await publishedMaterial(client,course);if(!publication)fail(409,'TRAINING_DUE_MATERIAL_UNAVAILABLE');
        const data=await resolve('material',{material:publication.receipt.source,userId:row.userId,learnerScope:row.scope});
        if(data.current!==true||data.sourceHash!==publication.receipt.source.sourceHash)fail(409,'TRAINING_DUE_MATERIAL_CHANGED');
      },
      finish:async(source)=>{const current=await inspect();if(!same(source,current))fail(409,'TRAINING_DUE_SOURCE_CHANGED');},
    };
    try{
      check();const data=await observeObligationDueSource(scope,input.originals,callbacks);check();
      if(!last||Date.parse(last.expiresAt)<=now())fail();
      const receipt={schemaVersion:'TrainingDueServiceObservationV1@1.0.0',requestId:input.requestId,requestHash:hash(input),installationId:input.installationId,
        scope:input.scope,authority:{apiKeyId:last.apiKeyId,serviceUserId:last.serviceUserId,authorityHash:admitted,observedAt:last.observedAt,expiresAt:last.expiresAt},
        data,consistency:'current-observations-not-atomic',externalDeliveryConfirmed:false};
      const {observedAt:_time,consistency:_consistency,sourceHash,...body}=data;
      if(sourceHash!==trainingDutyHash(body))fail();
      if(Buffer.byteLength(JSON.stringify(receipt))>8*1024*1024)fail(413,'TRAINING_DUE_CENSUS_TOO_LARGE');
      return receipt;
    }finally{active--;}
  };
}

const observe=createServiceDueObserver();
/** Register before human-session middleware, only at the dedicated read route. */
export async function observeServiceDue(req:Request,res:Response):Promise<void>{
  const cancellation=new AbortController(),abort=()=>cancellation.abort(),close=()=>{if(!res.writableEnded)abort();};
  req.once('aborted',abort);res.once('close',close);res.setHeader('Cache-Control','no-store');
  try{
    if(req.aborted||res.destroyed)abort();if(Object.keys(req.query).length)fail(400,'TRAINING_DUE_INVALID_REQUEST');
    const key=req.headers['x-api-key'];if(typeof key!=='string')fail(401,'TRAINING_DUE_SERVICE_CREDENTIAL_REQUIRED');
    const data=await observe(req.body,key,cancellation.signal);if(!cancellation.signal.aborted)res.json({success:true,data});
  }catch(error){if(!cancellation.signal.aborted){const e=error as {statusCode?:number;code?:string};res.status(e.statusCode??503).json({success:false,error:{code:e.code??'TRAINING_DUE_UNAVAILABLE',message:'Training due-source observation could not be verified.'}});}}
  finally{req.off('aborted',abort);res.off('close',close);}
}
