import {randomUUID} from 'node:crypto';
import {transaction} from '../config/database';
import type {TransactionClient} from '../config/database';
import {trainingEvidenceHash} from './audit.service';
import {retainedObligationReadiness} from './training-obligations.service';
import type {TrainingEffortArm,TrainingEffortHours,TrainingEffortInput,TrainingEffortKind,TrainingEffortLeadTime,TrainingEffortServed,TrainingEffortSource,
 TrainingEffortStartBasis,TrainingObligation,TrainingObligationScope,TrainingRecord,TrainingSignatureReceipt} from '../types/training.types';

/**
 * Training effort (plan item T-4): one append-only interval per graded quiz attempt, completion attestation and
 * verification (acc_training_effort_intervals), written in the decision's own transaction, so a rolled-back decision
 * records none; and the TrainingEffortSourceV1@1.0.0 observation of one root study (hours by role and by regimen or
 * cohort arm, and each arm's lead time from its EDC onboard event to fully trained staff), which
 * service-due-authority.ts serves on the due observer's machine transport.
 *
 * Off unless TRAINING_EFFORT_LEDGER_ENABLED=true, read from process.env at every call and never through config: the
 * owned suites mock config partially and the EDC's native fixture (tests/helpers/synthetic-training-readiness.ts
 * there) compiles this file from the sibling checkout with only ../config/database, ./audit.service and
 * ./training-obligations.service replaced. Any other runtime import must enter that compile map first.
 * TRAINING_DATA_CLASS=synthetic (a synthetic test stack) labels the observation synthetic.
 */
export const effortLedgerEnabled=()=>process.env.TRAINING_EFFORT_LEDGER_ENABLED==='true';
export const effortDataClass=():TrainingEffortSource['dataClass']=>process.env.TRAINING_DATA_CLASS==='synthetic'?'synthetic':'not-stated';
function fail(message:string,statusCode:number,code:string):never{throw Object.assign(new Error(message),{statusCode,code});}

// The stated-work-start rule of the EDC effort ledger, ported unchanged. Source of truth: libreclinicaapi
// src/services/database/effort-capture.ts:42-53 (checkedWorkStart) with its MAX_ACTIVE_INTERVAL_MS, CLOCK_SKEW_MS and
// INSTANT; tests/unit/training-effort.test.ts runs this port, and the compiled EDC function when
// TRAINING_NATIVE_AUTHORITY_ROOT is set, on the same vectors.
export const MAX_ACTIVE_INTERVAL_MS=12*3600000;
const CLOCK_SKEW_MS=2*60000;
const INSTANT=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Validate a stated work start against the end of its interval; null when none was stated. */
export function checkedWorkStart(value:string|undefined,signedAt:string):{workStartedAt:string|null}|{error:string}{
 if(value===undefined)return {workStartedAt:null};
 const at=Date.parse(value),signed=Date.parse(signedAt);
 const [y,m,d]=value.slice(0,10).split('-').map(Number),day=new Date(Date.UTC(y,m-1,d));
 if(!INSTANT.test(value)||!Number.isFinite(at)||day.getUTCFullYear()!==y||day.getUTCMonth()!==m-1||day.getUTCDate()!==d){
  return {error:'workStartedAt must be an exact instant with an explicit time zone'};
 }
 if(at>signed+CLOCK_SKEW_MS)return {error:'workStartedAt cannot be after the signature'};
 if(signed-at>MAX_ACTIVE_INTERVAL_MS)return {error:`workStartedAt can precede the signature by at most ${MAX_ACTIVE_INTERVAL_MS/3600000} hours`};
 return {workStartedAt:new Date(Math.min(at,signed)).toISOString()};
}

const time=(v:unknown):number=>v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;
const accepted=(stated:ReturnType<typeof checkedWorkStart>|undefined)=>stated&&'workStartedAt' in stated?stated.workStartedAt:null;
const ROLE=/^[a-z][a-z_]{0,63}$/;

export interface EffortStart {workStartedAt:string|null;startBasis:TrainingEffortStartBasis;edcEffortRequestId:string|null}
/** The interval's start (P25 5.2 A). Learning: the stated X-Work-Started-At; else the later of the assessment cycle's
 * start and the cycle's previous attempt, when within 12 hours of this one (server-cycle-start); else not-supplied.
 * Attestation and verification signed in the EDC: the receipt's edcEffort (its stated start as edc-signed-effort, or
 * not-supplied) with its EDC request id, never the header. Unsigned verification: the header or not-supplied. A
 * start the rule refuses at the end falls through to the next basis; effort never refuses a decision. */
export function effortStart(capture:{kind:TrainingEffortKind;endedAt:string;workStartedAt?:string;receipt?:Pick<TrainingSignatureReceipt,'edcEffort'>;
 cycle?:{startedAt:unknown;previousAssessedAt:unknown}}):EffortStart{
 if(capture.receipt&&capture.kind!=='learning'){
  const effort=capture.receipt.edcEffort;if(!effort)return {workStartedAt:null,startBasis:'not-supplied',edcEffortRequestId:null};
  const signed=effort.workStartedAt===null?null:accepted(checkedWorkStart(effort.workStartedAt,capture.endedAt));
  return {workStartedAt:signed,startBasis:signed?'edc-signed-effort':'not-supplied',edcEffortRequestId:effort.requestId};
 }
 const stated=capture.workStartedAt===undefined?null:accepted(checkedWorkStart(capture.workStartedAt,capture.endedAt));
 if(stated)return {workStartedAt:stated,startBasis:'client-work-start',edcEffortRequestId:null};
 if(capture.kind==='learning'&&capture.cycle){
  const known=[time(capture.cycle.startedAt),time(capture.cycle.previousAssessedAt)].filter(Number.isFinite);
  const server=known.length?accepted(checkedWorkStart(new Date(Math.max(...known)).toISOString(),capture.endedAt)):null;
  if(server)return {workStartedAt:server,startBasis:'server-cycle-start',edcEffortRequestId:null};
 }
 return {workStartedAt:null,startBasis:'not-supplied',edcEffortRequestId:null};
}

/** Exact native study, site and arm keys only, in a fixed order. */
const canonicalScope=(scope:TrainingObligationScope):TrainingObligationScope=>({studyId:scope.studyId,...(scope.siteId===undefined?{}:{siteId:scope.siteId}),
 ...(scope.armId===undefined?{}:{armId:scope.armId})});
type ServedRow=Pick<TrainingObligation,'id'|'revision'|'role'|'scope'>;
export const servedOf=(rows:ServedRow[]):TrainingEffortServed[]=>rows.map(row=>({obligationId:row.id,revision:row.revision,role:row.role,scope:canonicalScope(row.scope)}))
 .sort((a,b)=>a.obligationId-b.obligationId);

export interface EffortCapture {
 kind:TrainingEffortKind;actorUserId:number;learnerUserId:number;recordId:number;courseId:number;assessmentCycleId:string|null|undefined;
 /** The quiz requestId, or the signature receipt's request key; an unsigned verification gets a new key. */
 requestKey?:string;
 input?:TrainingEffortInput;
 /** A signed attestation or verification: the interval ends at the signature and takes the receipt's edcEffort. */
 receipt?:Pick<TrainingSignatureReceipt,'edcEffort'|'signedAt'|'requestKey'>;
 /** Learning: the grading time. Unsigned verification: now. */
 endedAt?:string;
 /** Learning: the cycle's start and its previous attempt's grading time, for server-cycle-start. */
 cycle?:{startedAt:unknown;previousAssessedAt:unknown};
 /** The learner's assigned obligations for the course, when the decision already holds them; otherwise read here. */
 served?:ServedRow[];
}
/** One interval in the caller's decision transaction, or nothing when the ledger is off. The same decision again,
 * and a second interval for one EDC effort request, add nothing (ON CONFLICT DO NOTHING on the two unique indexes). */
export async function recordEffortInterval(client:Pick<TransactionClient,'query'>,capture:EffortCapture):Promise<void>{
 if(!effortLedgerEnabled())return;
 const rows=capture.served??(await client.query<ServedRow>("SELECT id,revision,role,scope FROM acc_training_obligations WHERE user_id=$1 AND course_id=$2 AND status='assigned' ORDER BY id",
  [capture.learnerUserId,capture.courseId])).rows;
 const endedAt=new Date(capture.receipt?time(capture.receipt.signedAt):capture.endedAt===undefined?Date.now():time(capture.endedAt)).toISOString();
 const start=effortStart({kind:capture.kind,endedAt,workStartedAt:capture.input?.workStartedAt,receipt:capture.receipt,cycle:capture.cycle});
 const role=capture.kind==='verification'&&typeof capture.input?.actorRole==='string'&&ROLE.test(capture.input.actorRole)?capture.input.actorRole:null;
 const requestKey=(capture.receipt?.requestKey??capture.requestKey??randomUUID()).toLowerCase();
 await client.query(`INSERT INTO acc_training_effort_intervals(request_key,kind,actor_user_id,actor_role,learner_user_id,record_id,course_id,assessment_cycle_id,
   served,work_started_at,ended_at,start_basis,edc_effort_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
  [requestKey,capture.kind,capture.actorUserId,role,capture.learnerUserId,capture.recordId,capture.courseId,capture.assessmentCycleId?.toLowerCase()??null,
   JSON.stringify(servedOf(rows)),start.workStartedAt,endedAt,start.startBasis,start.edcEffortRequestId]);
}

// ============================================================================
// TrainingEffortSourceV1@1.0.0 (contracts/training-effort-source-v1.schema.json)
// ============================================================================

/** A census larger than these is refused whole, never truncated (P25 5.2 C). */
export const MAX_EFFORT_INTERVALS=100000,MAX_EFFORT_OBLIGATIONS=10000;
const KINDS:TrainingEffortKind[]=['learning','attestation','verification'];
const BASES:TrainingEffortStartBasis[]=['client-work-start','server-cycle-start','edc-signed-effort','not-supplied'];
const DAY_MS=86400000;
const nativeId=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const round3=(v:number)=>Math.round(v*1000)/1000;
const only=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const NO_OBLIGATIONS='no assigned arm-scoped training obligations; coverage is T-2',FROM_START='arm present from study start';
const WITHHELD='per-arm values are given only for arms whose class is declared regimen or cohort';
const SYNTHETIC='SYNTHETIC ENGINEERING STUDY. NOT A REAL TRIAL. TRAINING_DATA_CLASS=synthetic: these are test-stack values, not real training effort.';
const DEFINITIONS:TrainingEffortSource['definitions']={
 learning:'One interval per graded quiz attempt (a replayed submission adds none), ending at its grading time.',
 attestation:'One interval per learner completion attestation bound to an EDC Part 11 signature, ending at the signature time.',
 verification:'One interval per independent verification of a completion, ending at the EDC signature time when signed and at the verification otherwise. Signing a verification already recorded adds none.',
 startBasis:'client-work-start: the X-Work-Started-At the EDC proxy forwarded, under the EDC effort rule (an explicit zone, at most 12 hours before and 2 minutes after the end). server-cycle-start (learning only): the later of the assessment cycle start and the previous attempt of the cycle, when within 12 hours. edc-signed-effort: the stated start of the EDC signature\'s effort record. not-supplied: no start, so the interval adds no hours.',
 roleBasis:'obligation-role: the role of each served obligation (learning, attestation). actor-platform-role: the verifier\'s platform role at verification, null when the decision did not state it.',
 hours:'Per row, the sum of end minus start over the row\'s intervals with a start, in hours to 3 decimals; intervals counts every interval of the row, unknownIntervals those without a start, actors the distinct people.',
 leadTime:'Days from the arm\'s EDC onboard event (onboardedAt, also startedAt) to trainedAt: the latest, over the assigned obligations scoped to the arm, of the later of the record\'s verification and the obligation\'s current revision, once every one of them is complete (completed, verified by another person, current course revision, unexpired). 0 with trainedBeforeOnboarding when trainedAt is earlier. open: not every such obligation is complete, days elapsed to asOf. incomplete: no such obligation, or no onboard event.',
 disclosure:'platform rows count every interval of the study. Arm rows and lead time are given only for arms whose class the EDC declares regimen or cohort (regimen-or-cohort); every other arm is withheld, with no values and no counts.',
};
const LIMITATIONS=[
 'Effort is recorded only for graded quiz attempts, completion attestations and verifications made while the training effort ledger is switched on; earlier activity, and reading before a stated start, are not counted.',
 'A stated start is the person\'s claim, checked against the EDC effort rule; it is not an observation.',
 'An interval belongs to this study when an obligation it served at capture is scoped to the study. A platform row counts an interval once per role and kind, so an interval that served obligations of several roles counts in each of their rows.',
 'An arm row takes the whole of every interval that served the arm, so the arm rows of one interval can sum to more than its platform row.',
 'Signed attestation and verification time (edc-signed-effort) is also EDC observed signed-action effort; these training components are kept apart from it and are not to be added to it.',
 'Lead time is current, not historical: a retraining or a new obligation revision moves trainedAt later, and obligations never assigned are not seen, so missing arm-scoped coverage flatters the lead time until coverage is reported (T-2).',
 'Readiness here uses retained rows only: the native scope and the governed material source are not re-observed, and a governed course counts as current while its retained publication matches its current content.',
 'An arm present from study start has no onboard event and no lead time.',
 'No learner or actor identity leaves the training service, but a role group of one person shows that person\'s hours.',
];

export interface EffortInterval {id:number;kind:TrainingEffortKind;actorUserId:number;actorRole:string|null;served:TrainingEffortServed[];durationMs:number|null}
interface IntervalRow {id:string|number;kind:string;actorUserId:number;actorRole:string|null;served:unknown;workStartedAt:unknown;endedAt:unknown;startBasis:string}
const servedValid=(v:unknown):v is TrainingEffortServed=>{const s=v as Record<string,any>;return !!s&&typeof s==='object'&&only(s,['obligationId','revision','role','scope'])
 &&nativeId(s.obligationId)&&nativeId(s.revision)&&typeof s.role==='string'&&ROLE.test(s.role)&&!!s.scope&&typeof s.scope==='object'&&only(s.scope,['studyId','siteId','armId'])
 &&nativeId(s.scope.studyId)&&(s.scope.siteId===undefined||nativeId(s.scope.siteId))&&(s.scope.armId===undefined||nativeId(s.scope.armId));};
/** A retained row, exactly as this service writes it (BIGINT ids arrive as text from pg); anything else refuses the
 * whole observation. */
function intervalOf(row:IntervalRow):EffortInterval{
 const id=Number(row.id),ended=time(row.endedAt),started=row.workStartedAt===null?null:time(row.workStartedAt);
 if(!Number.isSafeInteger(id)||id<1||!KINDS.includes(row.kind as TrainingEffortKind)||!nativeId(row.actorUserId)||!Number.isFinite(ended)
  ||!BASES.includes(row.startBasis as TrainingEffortStartBasis)||(row.startBasis==='not-supplied')!==(started===null)
  ||started!==null&&(!Number.isFinite(started)||started>ended||ended-started>MAX_ACTIVE_INTERVAL_MS)
  ||(row.kind==='verification'?row.actorRole!==null&&(typeof row.actorRole!=='string'||!ROLE.test(row.actorRole)):row.actorRole!==null)
  ||!Array.isArray(row.served)||!row.served.every(servedValid))fail('Retained training effort integrity failed',409,'TRAINING_EFFORT_UNAVAILABLE');
 return {id,kind:row.kind as TrainingEffortKind,actorUserId:row.actorUserId,actorRole:row.actorRole,served:row.served as TrainingEffortServed[],durationMs:started===null?null:ended-started};
}

export interface EffortSnapshot {
 asOf:string;intervals:EffortInterval[];
 /** The study's assigned obligations scoped to an arm, with each one's retained readiness and record. */
 obligations:TrainingObligation[];readiness:Map<number,{readiness:string;record:TrainingRecord|null}>;
 /** created_at of each obligation's current revision event, keyed `obligationId:revision`. */
 revisedAt:Map<string,number>;
}
/** One REPEATABLE READ READ ONLY snapshot of a root study: its effort intervals and its assigned arm-scoped obligations. */
export async function readEffortSnapshot(studyId:number):Promise<EffortSnapshot>{
 return transaction(async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const at=time((await client.queryOne<{asOf:unknown}>('SELECT now() AS as_of'))?.asOf);
  if(!Number.isFinite(at))fail('The training effort snapshot time is unavailable',503,'TRAINING_EFFORT_UNAVAILABLE');
  const intervals=(await client.query<IntervalRow>(`SELECT id,kind,actor_user_id,actor_role,served,work_started_at,ended_at,start_basis
    FROM acc_training_effort_intervals WHERE served @> $1::jsonb ORDER BY id LIMIT ${MAX_EFFORT_INTERVALS+1}`,[JSON.stringify([{scope:{studyId}}])])).rows;
  if(intervals.length>MAX_EFFORT_INTERVALS)fail(`The study exceeds ${MAX_EFFORT_INTERVALS} training effort intervals; no partial observation was returned`,413,'TRAINING_EFFORT_TOO_LARGE');
  const obligations=(await client.query<TrainingObligation>(`SELECT * FROM acc_training_obligations WHERE status='assigned' AND (scope->>'studyId')::integer=$1
    AND scope ? 'armId' ORDER BY id LIMIT ${MAX_EFFORT_OBLIGATIONS+1}`,[studyId])).rows;
  if(obligations.length>MAX_EFFORT_OBLIGATIONS)fail(`The study exceeds ${MAX_EFFORT_OBLIGATIONS} arm-scoped obligations; no partial observation was returned`,413,'TRAINING_EFFORT_TOO_LARGE');
  const revisions=(await client.query<{obligationId:number;revision:number;createdAt:unknown}>(`SELECT e.obligation_id,e.revision,e.created_at FROM acc_training_obligation_events e
    JOIN jsonb_to_recordset($1::jsonb) AS current(id integer,revision integer) ON e.obligation_id=current.id AND e.revision=current.revision`,
   [JSON.stringify(obligations.map(row=>({id:row.id,revision:row.revision})))])).rows;
  return {asOf:new Date(at).toISOString(),intervals:intervals.map(intervalOf),obligations,readiness:await retainedObligationReadiness(client,obligations,at),
   revisedAt:new Map(revisions.map(row=>[`${row.obligationId}:${row.revision}`,time(row.createdAt)]))};
 });
}

const disclosedLevel=(level:TrainingEffortArm['disclosureLevel'])=>level==='regimen'||level==='cohort';
const compare=(a:Array<number|string>,b:Array<number|string>)=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]<b[i]?-1:1;return 0;};
/** The pure document (P25 5.2 B) of one root study, from its snapshot and the EDC's census of its arms. */
export function computeTrainingEffortSource(input:{studyId:number;arms:TrainingEffortArm[];snapshot:EffortSnapshot;dataClass:TrainingEffortSource['dataClass']}):TrainingEffortSource{
 const {studyId,snapshot}=input,disclosed=new Set(input.arms.filter(arm=>disclosedLevel(arm.disclosureLevel)).map(arm=>arm.armId));
 type Row=Omit<TrainingEffortHours,'hours'|'actors'>&{ms:number;people:Set<number>};
 const rows=new Map<string,Row>();
 const add=(level:Row['level'],armId:number|null,role:string|null,interval:EffortInterval)=>{
  const key=JSON.stringify([level,armId,role,interval.kind]);let row=rows.get(key);
  if(!row)rows.set(key,row={level,armId,role,roleBasis:interval.kind==='verification'?'actor-platform-role':'obligation-role',kind:interval.kind,
   intervals:0,unknownIntervals:0,disclosure:level==='platform'?'platform':'regimen-or-cohort',ms:0,people:new Set()});
  row.intervals++;row.people.add(interval.actorUserId);if(interval.durationMs===null)row.unknownIntervals++;else row.ms+=interval.durationMs;
 };
 let counted=0,through:number|null=null;
 for(const interval of snapshot.intervals){
  const served=interval.served.filter(item=>item.scope.studyId===studyId);if(!served.length)continue;
  counted++;through=Math.max(through??0,interval.id);
  // Learning and attestation take each served obligation's role, once per role; verification the verifier's role.
  const roles=(items:TrainingEffortServed[])=>interval.kind==='verification'?[interval.actorRole]:[...new Set(items.map(item=>item.role))];
  for(const role of roles(served))add('platform',null,role,interval);
  const arms=new Map<number,TrainingEffortServed[]>();
  for(const item of served)if(item.scope.armId!==undefined&&disclosed.has(item.scope.armId))arms.set(item.scope.armId,[...(arms.get(item.scope.armId)??[]),item]);
  for(const [armId,items] of arms)for(const role of roles(items))add('arm',armId,role,interval);
 }
 const hours:TrainingEffortHours[]=[...rows.values()].sort((a,b)=>compare([a.level==='platform'?0:1,a.armId??0,KINDS.indexOf(a.kind),a.role??'',a.roleBasis],
  [b.level==='platform'?0:1,b.armId??0,KINDS.indexOf(b.kind),b.role??'',b.roleBasis])).map(row=>({level:row.level,armId:row.armId,role:row.role,roleBasis:row.roleBasis,kind:row.kind,
  hours:round3(row.ms/3600000),intervals:row.intervals,unknownIntervals:row.unknownIntervals,actors:row.people.size,disclosure:row.disclosure}));
 const asOf=Date.parse(snapshot.asOf);
 const arms=input.arms.map((arm):TrainingEffortSource['arms'][number]=>{
  if(!disclosed.has(arm.armId))return {armId:arm.armId,disclosureLevel:arm.disclosureLevel,onboardedAt:null,onboardEventId:null,
   leadTime:{status:'withheld',days:null,startedAt:null,trainedAt:null,obligations:null,learners:null,sites:null,trainedBeforeOnboarding:null,reason:WITHHELD}};
  const assigned=snapshot.obligations.filter(row=>row.scope.armId===arm.armId);
  const complete=assigned.filter(row=>snapshot.readiness.get(row.id)?.readiness==='complete').length;
  const counts={obligations:{assigned:assigned.length,complete},learners:new Set(assigned.map(row=>row.userId)).size,
   sites:new Set(assigned.flatMap(row=>row.scope.siteId===undefined?[]:[row.scope.siteId])).size};
  const head={armId:arm.armId,disclosureLevel:arm.disclosureLevel,onboardedAt:arm.onboardedAt,onboardEventId:arm.onboardEventId};
  const lead=(leadTime:Omit<TrainingEffortLeadTime,'obligations'|'learners'|'sites'>)=>({...head,leadTime:{status:leadTime.status,days:leadTime.days,startedAt:leadTime.startedAt,
   trainedAt:leadTime.trainedAt,...counts,trainedBeforeOnboarding:leadTime.trainedBeforeOnboarding,reason:leadTime.reason}});
  if(!assigned.length||arm.onboardedAt===null)return lead({status:'incomplete',days:null,startedAt:null,trainedAt:null,trainedBeforeOnboarding:false,reason:assigned.length?FROM_START:NO_OBLIGATIONS});
  const onboarded=Date.parse(arm.onboardedAt);
  if(complete<assigned.length)return lead({status:'open',days:Math.max(0,round3((asOf-onboarded)/DAY_MS)),startedAt:arm.onboardedAt,trainedAt:null,trainedBeforeOnboarding:false,reason:null});
  // Trained once the last obligation was both verified and current: a retraining or a new revision moves this later.
  const trained=Math.max(...assigned.map(row=>{const verified=time(snapshot.readiness.get(row.id)?.record?.verifiedAt),revised=snapshot.revisedAt.get(`${row.id}:${row.revision}`);
   if(!Number.isFinite(verified)||revised===undefined||!Number.isFinite(revised))fail('Retained obligation history is incomplete',409,'TRAINING_EFFORT_UNAVAILABLE');
   return Math.max(verified,revised);}));
  return lead({status:'measured',days:Math.max(0,round3((trained-onboarded)/DAY_MS)),startedAt:arm.onboardedAt,trainedAt:new Date(trained).toISOString(),
   trainedBeforeOnboarding:trained<onboarded,reason:null});
 });
 const document={schemaVersion:'TrainingEffortSourceV1@1.0.0' as const,scope:{studyId},asOf:snapshot.asOf,dataClass:input.dataClass,definitions:{...DEFINITIONS},hours,arms,
  counts:{intervals:counted,throughIntervalId:through},limitations:[...(input.dataClass==='synthetic'?[SYNTHETIC]:[]),...LIMITATIONS]};
 const {asOf:_asOf,...body}=document;
 return {...document,sourceHash:trainingEvidenceHash(body)};
}

/** The observation of one root study for the machine route (service-due-authority.ts), from the EDC's census of its
 * arms read on that route's transport. */
export async function observeTrainingEffortSource(scope:{studyId:number},arms:TrainingEffortArm[]):Promise<TrainingEffortSource>{
 if(!effortLedgerEnabled())fail('The training effort ledger is not switched on',503,'TRAINING_EFFORT_DISABLED');
 return computeTrainingEffortSource({studyId:scope.studyId,arms,snapshot:await readEffortSnapshot(scope.studyId),dataClass:effortDataClass()});
}
