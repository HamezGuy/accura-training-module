import {randomUUID} from 'node:crypto';
import {queryOne,transaction,TransactionClient} from '../config/database';
import {TrainingImpactPlanRequest,TrainingImpactAction,TrainingObligation,TrainingCourse,TrainingObligationRequest} from '../types/training.types';
import {resolveImpactSource,inspectImpactSource,resolveObligationScope,TrainingAuthorityContext,ImpactSourceObservation,ObligationScopeObservation} from './training-authority.service';
import {assignObligationInTransaction,withdrawObligationInTransaction,validateObligationRequest,trainingDutyHash} from './training-obligations.service';
import {logAudit,AuditAction} from './audit.service';

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function fail(message:string,statusCode=409):never{throw Object.assign(new Error(message),{statusCode});}
function object(v:unknown,keys:string[]):asserts v is Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Unexpected training impact fields',400);}
function reason(v:unknown):asserts v is string{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('An explicit impact reason of 1–2000 characters is required',400);}
const scopeMatches=(scope:{studyId:number;siteId?:number},target:{studyId:number;siteId?:number})=>scope.studyId===target.studyId&&scope.siteId===target.siteId;
interface PlanRow {
  id:string;createdBy:number;plan:TrainingImpactPlanRequest;planHash:string;sourceObservation:ImpactSourceObservation;
  status:'proposed'|'reviewed'|'applied'|'cancelled'|'rejected';revision:number;reviewedBy:number|null;
  reviewedAt:string|null;reviewReason:string|null;reviewAuthority:{userId:number;authorityHash:string}|null;cancellationReason:string|null;application:unknown;
}
interface Prepared {action:TrainingImpactAction;row:TrainingObligation|null;observation:ObligationScopeObservation}
export function validateImpactPlan(value:unknown):asserts value is TrainingImpactPlanRequest{
  object(value,['schemaVersion','idempotencyKey','scope','source','reason','actions']);
  if(value.schemaVersion!=='training-impact-plan/1'||!uuid(value.idempotencyKey))fail('Exact impact schema and idempotency key are required',400);
  object(value.scope,['studyId','siteId']);if(!id(value.scope.studyId)||value.scope.siteId!==undefined&&!id(value.scope.siteId))fail('Exact study/site scope is required',400);
  object(value.source,['nativeSourceHash','lifecycleRevision','originals']);
  if(!sha(value.source.nativeSourceHash)||!Number.isSafeInteger(value.source.lifecycleRevision)||value.source.lifecycleRevision<0||!Array.isArray(value.source.originals)||value.source.originals.length>16)fail('Exact native source and at most 16 original pins are required',400);
  const originals=new Set<string>();for(const pin of value.source.originals){object(pin,['kind','fileId','sha256']);if(!['protocol','product','duty','amendment','staff'].includes(pin.kind)||!uuid(pin.fileId)||!sha(pin.sha256)||originals.has(pin.fileId))fail('Distinct exact original custody pins are required',400);originals.add(pin.fileId);}
  reason(value.reason);
  if(!Array.isArray(value.actions)||!value.actions.length||value.actions.length>50)fail('An impact plan must contain 1–50 explicit affected actions; split larger reviews without dropping learners',400);
  const keys=new Set<string>();
  for(const action of value.actions){
    object(action,action?.kind==='assign'?['kind','request']:action?.kind==='revise'?['kind','obligationId','expectedRevision','request']:['kind','obligationId','expectedRevision','reason']);
    if(!['assign','revise','withdraw'].includes(action.kind))fail('Unknown obligation action',400);
    if(action.kind!=='assign'&&(!id(action.obligationId)||!id(action.expectedRevision)))fail('The current obligation identity and revision are required',400);
    if(action.kind==='withdraw')reason(action.reason);
    else {object(action.request,['userId','courseId','contentRevision','role','scope','dueAt','reason']);validateObligationRequest(action.request as TrainingObligationRequest);if(value.scope.studyId!==action.request.scope.studyId||value.scope.siteId!==action.request.scope.siteId)fail('Every action must belong to the exact plan study/site',400);}
    const key=action.kind==='assign'?`new:${trainingDutyHash({userId:action.request.userId,courseId:action.request.courseId,role:action.request.role,scope:action.request.scope})}`:`existing:${action.obligationId}`;
    if(keys.has(key))fail('Duplicate affected obligation',400);keys.add(key);
  }
}

async function prepare(authority:TrainingAuthorityContext,plan:TrainingImpactPlanRequest,client:Pick<TransactionClient,'queryOne'>={queryOne}):Promise<Prepared[]>{
  const result:Prepared[]=[];
  for(const action of plan.actions){
    const row=action.kind==='assign'?null:await client.queryOne<TrainingObligation>('SELECT * FROM acc_training_obligations WHERE id=$1',[action.obligationId]);
    if(action.kind!=='assign'&&(!row||row.revision!==action.expectedRevision||row.status!=='assigned'))fail('An affected obligation changed; propose and review a new impact plan');
    const target=action.kind==='withdraw'?row!:action.request;
    if(!scopeMatches(plan.scope,target.scope))fail('The affected obligation belongs to a different study/site');
    const observation=await resolveObligationScope(authority,action.kind==='withdraw'?'obligations:withdraw':'obligations:manage',target.userId,target.scope);
    if(action.kind!=='withdraw'){
      if(!observation.eligible||!observation.roles.includes(target.role))fail('An affected learner no longer holds the declared duty role');
      const course=await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1',[action.request.courseId]);
      if(!course?.active||course.contentRevision!==action.request.contentRevision)fail('A selected course/content revision is no longer current');
      if(row&&(row.userId!==target.userId||row.courseId!==target.courseId||row.role!==target.role||trainingDutyHash(row.scope)!==trainingDutyHash(target.scope)))fail('A revision cannot move an obligation to another learner, course or scope');
    }
    result.push({action,row,observation});
  }
  return result;
}
async function event(client:TransactionClient,row:PlanRow,actor:number,action:AuditAction){
  await client.query('INSERT INTO acc_training_impact_events(plan_id,revision,actor_user_id,action,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)',[row.id,row.revision,actor,action,JSON.stringify(row)]);
  await logAudit({userId:actor,action,details:{planId:row.id,revision:row.revision,planHash:row.planHash,scope:row.plan.scope}},client);
}
async function load(client:Pick<TransactionClient,'queryOne'>,planId:string,lock=false):Promise<PlanRow>{
  if(!uuid(planId))fail('Invalid impact plan identity',400);
  const row=await client.queryOne<PlanRow>(`SELECT * FROM acc_training_impact_plans WHERE id=$1${lock?' FOR UPDATE':''}`,[planId]);
  if(!row)fail('Impact plan not found',404);return row;
}
export async function proposeImpactPlan(authority:TrainingAuthorityContext,value:unknown){
  validateImpactPlan(value);const hash=trainingDutyHash(value);
  return transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`training-impact:${authority.actorUserId}:${value.idempotencyKey}`]);
    const prior=await client.queryOne<PlanRow>('SELECT * FROM acc_training_impact_plans WHERE created_by=$1 AND idempotency_key=$2',[authority.actorUserId,value.idempotencyKey]);
    if(prior){if(prior.planHash!==hash)fail('The idempotency key already names a different impact plan');return getAppliedReplay(authority,prior,client);}
    const observed=await resolveImpactSource(authority,value.scope,value.source);
    await prepare(authority,value,client);
    await resolveImpactSource(authority,value.scope,value.source,observed);
    const row=await client.queryOne<PlanRow>(`INSERT INTO acc_training_impact_plans(id,idempotency_key,created_by,plan,plan_hash,source_observation,status)
      VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,'proposed') RETURNING *`,[randomUUID(),value.idempotencyKey,authority.actorUserId,JSON.stringify(value),hash,JSON.stringify(observed)]);
    if(!row)fail('Impact plan could not be retained');await event(client,row,authority.actorUserId,'training_impact_proposed');return row;
  });
}
export async function getImpactPlan(authority:TrainingAuthorityContext,planId:string){
  const row=await load({queryOne},planId);
  // Historical source changes must not erase authorized history. Exact current
  // native management authority is still required for every affected learner.
  await getAppliedReplay(authority,row,{queryOne});
  const events=await transaction(client=>client.query('SELECT revision,actor_user_id,action,snapshot,created_at FROM acc_training_impact_events WHERE plan_id=$1 ORDER BY revision',[planId]));
  let sourceCurrent=false;try{const observed=await resolveImpactSource(authority,row.plan.scope,row.plan.source);sourceCurrent=observed.sourceObservationHash===row.sourceObservation.sourceObservationHash;}catch(error){if([401,403].includes((error as {statusCode?:number}).statusCode??0))throw error;}
  return {...row,history:events.rows,sourceCurrent,sourceIssue:sourceCurrent?null:'The retained native source is changed or unavailable; history is retained, but a new current observation is required for execution.'};
}
export async function reviewImpactPlan(authority:TrainingAuthorityContext,planId:string,input:unknown){
  object(input,['expectedRevision','accepted','reason']);if(!id(input.expectedRevision)||typeof input.accepted!=='boolean')fail('Exact review revision and disposition are required',400);reason(input.reason);
  return transaction(async client=>{
    const row=await load(client,planId,true);
    if(row.createdBy===authority.actorUserId)fail('A different currently authorized training manager must review the impact mapping',403);
    if(row.revision!==input.expectedRevision||row.status!=='proposed')fail('The impact plan already changed or has a review');
    const observed=input.accepted?await resolveImpactSource(authority,row.plan.scope,row.plan.source):await inspectImpactSource(authority,row.plan.scope,[]);
    if(input.accepted){if(observed.sourceObservationHash!==row.sourceObservation.sourceObservationHash)fail('The native impact source changed; a new plan is required');
      await prepare(authority,row.plan,client);await resolveImpactSource(authority,row.plan.scope,row.plan.source,observed);}
    else await getAppliedReplay(authority,row,client);
    const updated=await client.queryOne<PlanRow>(`UPDATE acc_training_impact_plans SET status=$2,revision=revision+1,reviewed_by=$3,reviewed_at=NOW(),review_reason=$4,review_authority=$5::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`,[planId,input.accepted?'reviewed':'rejected',authority.actorUserId,input.reason.trim(),JSON.stringify({userId:authority.actorUserId,authorityHash:observed.actorAuthorityHash})]);
    await event(client,updated!,authority.actorUserId,input.accepted?'training_impact_reviewed':'training_impact_rejected');return updated;
  });
}
export async function applyImpactPlan(authority:TrainingAuthorityContext,planId:string,input:unknown){
  object(input,['expectedRevision']);if(!id(input.expectedRevision))fail('Exact reviewed revision is required',400);
  return transaction(async client=>{
    const row=await load(client,planId,true);
    if(row.createdBy!==authority.actorUserId)fail('Only the currently authorized proposer can apply this impact plan',403);
    if(row.status==='applied'&&row.revision===input.expectedRevision+1)return getAppliedReplay(authority,row,client);
    if(row.revision!==input.expectedRevision||row.status!=='reviewed')fail('A current independently reviewed impact plan is required');
    if(!row.reviewAuthority||row.reviewAuthority.userId!==row.reviewedBy)fail('Independent review authority custody is missing');
    const observed=await resolveImpactSource(authority,row.plan.scope,row.plan.source,row.sourceObservation,row.reviewAuthority);
    const prepared=await prepare(authority,row.plan,client);
    // Match the existing writer order: all courses, then obligations; distinct
    // plans touching the same courses/obligations always acquire ascending IDs.
    const courses=[...new Set(prepared.filter(p=>p.action.kind!=='withdraw').map(p=>(p.action as Exclude<TrainingImpactAction,{kind:'withdraw'}>).request.courseId))].sort((a,b)=>a-b);
    if(courses.length)await client.query('SELECT id FROM acc_training_courses WHERE id=ANY($1::integer[]) ORDER BY id FOR SHARE',[courses]);
    const ids=prepared.flatMap(p=>p.row?[p.row.id]:[]).sort((a,b)=>a-b);
    if(ids.length)await client.query('SELECT id FROM acc_training_obligations WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE',[ids]);
    const applied=[];
    for(const {action,observation} of prepared){const obligation=action.kind==='withdraw'
      ?await withdrawObligationInTransaction(client,authority,action.obligationId,action.expectedRevision,action.reason)
      :await assignObligationInTransaction(client,authority,action.request,action.kind==='revise'?{id:action.obligationId,expectedRevision:action.expectedRevision}:undefined,observation);
      applied.push({kind:action.kind,obligationId:obligation.id,revision:obligation.revision,snapshot:obligation});}
    await resolveImpactSource(authority,row.plan.scope,row.plan.source,observed,row.reviewAuthority);
    const updated=await client.queryOne<PlanRow>(`UPDATE acc_training_impact_plans SET status='applied',revision=revision+1,application=$2::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`,[planId,JSON.stringify({appliedBy:authority.actorUserId,planHash:row.planHash,sourceObservation:observed,actions:applied,clinicalApprovalClaimed:false})]);
    await event(client,updated!,authority.actorUserId,'training_impact_applied');return updated;
  });
}
async function getAppliedReplay(authority:TrainingAuthorityContext,row:PlanRow,client:Pick<TransactionClient,'queryOne'>){
  // A role elsewhere cannot authorize historical recovery or cancellation here.
  // Current custody inspection also works for retained closed scopes; it does
  // not admit a new assignment or replace the exact source used for application.
  await inspectImpactSource(authority,row.plan.scope,[]);
  for(const action of row.plan.actions){const target=action.kind==='withdraw'?await client.queryOne<TrainingObligation>('SELECT * FROM acc_training_obligations WHERE id=$1',[action.obligationId]):action.request;if(!target)fail('Applied obligation custody is missing');await resolveObligationScope(authority,'obligations:withdraw',target.userId,target.scope);}
  return row;
}
export async function cancelImpactPlan(authority:TrainingAuthorityContext,planId:string,input:unknown){
  object(input,['expectedRevision','reason']);if(!id(input.expectedRevision))fail('Exact plan revision is required',400);reason(input.reason);
  return transaction(async client=>{const row=await load(client,planId,true);
    if(row.createdBy!==authority.actorUserId)fail('Only the current proposer may cancel this plan',403);
    if(row.revision!==input.expectedRevision||!['proposed','reviewed'].includes(row.status))fail('Only the current unapplied plan can be cancelled');
    await getAppliedReplay(authority,row,client);
    const updated=await client.queryOne<PlanRow>("UPDATE acc_training_impact_plans SET status='cancelled',revision=revision+1,cancellation_reason=$2,updated_at=NOW() WHERE id=$1 RETURNING *",[planId,input.reason.trim()]);
    await event(client,updated!,authority.actorUserId,'training_impact_cancelled');return updated;
  });
}
