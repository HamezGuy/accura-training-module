import {randomUUID} from 'node:crypto';
import type {TransactionClient} from '../config/database';
import type {TrainingEffortInput,TrainingEffortKind,TrainingEffortServed,TrainingEffortStartBasis,TrainingObligation,TrainingObligationScope,
 TrainingSignatureReceipt} from '../types/training.types';

/**
 * Training effort (plan item T-4): one append-only interval per graded quiz attempt, completion attestation and
 * verification (acc_training_effort_intervals), written in the decision's own transaction, so a rolled-back decision
 * records none.
 *
 * Off unless TRAINING_EFFORT_LEDGER_ENABLED=true, read from process.env at every call and never through config: the
 * owned suites mock config partially and the EDC's native fixture (tests/helpers/synthetic-training-readiness.ts
 * there) compiles this file from the sibling checkout with only ../config/database, ./audit.service and
 * ./training-obligations.service replaced. Any other runtime import must enter that compile map first.
 */
export const effortLedgerEnabled=()=>process.env.TRAINING_EFFORT_LEDGER_ENABLED==='true';

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
