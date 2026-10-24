import type {TransactionClient} from '../config/database';
import type {TrainingMaterialSignatureSubject,TrainingRecord,TrainingRecordSignatureDecision,TrainingRecordSignatureSubject,TrainingSignatureBinding,
 TrainingSignatureConfirmation,TrainingSignatureContext,TrainingSignatureDecision,TrainingSignatureReceipt,TrainingSignatureReference,TrainingSignatureSubject} from '../types/training.types';

/**
 * Part 11 signatures on training decisions: training-signature-subject/1 (this service computes the subject) and
 * training-signature-receipt/1 (the EDC produces the receipt). A person signs in the EDC with password re-entry; the
 * EDC keeps the signature row and its hash-chained audit. Once the EDC confirms the receipt (authority op
 * `signature`), the decision's own transaction keeps an append-only binding here. The subject hash is
 * trainingEvidenceHash (audit.service), the canonical JSON the duty policy hash already uses.
 *
 * A leaf with no runtime import. Callers hold and lock the rows, compute the hashes, obtain the EDC confirmation and
 * write the audit, then pass them in. The EDC's native suites compile this source from the sibling checkout
 * (tests/helpers/synthetic-training-readiness.ts there); a runtime import here must enter that compile map first.
 */
export const SIGNATURE_SUBJECT_VERSION='training-signature-subject/1';
const RECEIPT_VERSION='training-signature-receipt/1';
const DECISIONS:TrainingSignatureDecision[]=['completion-attestation','verification','material-approval','matrix-approval'];
const RECORD_DECISIONS:TrainingSignatureDecision[]=['completion-attestation','verification'];
const RECEIPT_KEYS=['schemaVersion','signatureId','requestKey','decision','meaning','signerUserId','signerUsername','signerFullName','signedAt','context','subjectHash','edcEffort'];
const UUID_V4=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const INSTANT=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/;
const nativeId=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const edcId=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exactKeys=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
function fail(message:string,statusCode=409):never{throw Object.assign(new Error(message),{statusCode});}
/** PostgreSQL returns Date objects; canonical subjects and receipts carry ISO instants only. */
const instant=(v:unknown):string|null=>{const t=v instanceof Date?v.getTime():typeof v==='string'?new Date(v).getTime():NaN;return Number.isFinite(t)?new Date(t).toISOString():null;};

/** The exact study, or site, a person signs in. Arms never appear in a subject, receipt or refusal (D-25). */
export function signatureContext(value:unknown):TrainingSignatureContext{
 if(!object(value)||Object.keys(value).some(k=>!['studyId','siteId'].includes(k))||!nativeId(value.studyId)||value.siteId!==undefined&&!nativeId(value.siteId))
  fail('An exact native study and optional site signature context is required',400);
 return {studyId:value.studyId,...(value.siteId===undefined?{}:{siteId:value.siteId})};
}

/** Attestation and verification sign the same subject: one exact completion with its retained assessment cycle,
 * passing receipt and certificate. Verifier and verification time are the signature's own facts, not the subject's. */
export function recordDecisionSubject(kind:TrainingRecordSignatureDecision,record:TrainingRecord,context:TrainingSignatureContext):TrainingRecordSignatureSubject{
 const assessment=record.assessmentReceipt,completedAt=instant(record.completedAt);
 if(!RECORD_DECISIONS.includes(kind))fail('Unsupported training record signature',400);
 if(record.status!=='completed'||!record.assessmentCycleId||!assessment||assessment.cycleId!==record.assessmentCycleId||typeof assessment.id!=='string'||typeof assessment.hash!=='string'
  ||!completedAt||!record.certificateNumber||typeof record.courseVersion!=='string'||!nativeId(record.contentRevision))fail('Only a completion with its retained assessment cycle can be signed');
 return {schemaVersion:SIGNATURE_SUBJECT_VERSION,kind,context:signatureContext(context),learnerUserId:record.userId,recordId:record.id,courseId:record.courseId,
  courseVersion:record.courseVersion,contentRevision:record.contentRevision,assessmentCycleId:record.assessmentCycleId.toLowerCase(),
  assessment:{id:assessment.id,hash:assessment.hash},completedAt,certificateNumber:record.certificateNumber};
}

/** The subject of an accepted material review: the immutable draft as reviewed, at the revision it was reviewed in. */
export function materialApprovalSubject(input:{draftId:string;draftRevision:number;requestHash:string;courseId:number;authorUserId:number;sourceHash:string;context:TrainingSignatureContext}):TrainingMaterialSignatureSubject{
 if(typeof input.draftId!=='string'||!UUID.test(input.draftId)||!nativeId(input.draftRevision)||typeof input.requestHash!=='string'||!SHA.test(input.requestHash)
  ||!nativeId(input.courseId)||!nativeId(input.authorUserId)||typeof input.sourceHash!=='string'||!SHA.test(input.sourceHash))fail('Retained material draft identity is incomplete');
 return {schemaVersion:SIGNATURE_SUBJECT_VERSION,kind:'material-approval',context:signatureContext(input.context),draftId:input.draftId.toLowerCase(),draftRevision:input.draftRevision,
  requestHash:input.requestHash,courseId:input.courseId,authorUserId:input.authorUserId,sourceHash:input.sourceHash,disposition:'accepted'};
}

/** Exact training-signature-receipt/1. A malformed receipt refuses the decision: it is never dropped, because a
 * dropped signature would leave an unsigned decision its signer believes is signed. */
export function readSignatureReceipt(value:unknown):TrainingSignatureReceipt{
 const invalid=():never=>fail('An exact training-signature-receipt/1 from the EDC is required',400);
 if(!object(value)||!exactKeys(value,RECEIPT_KEYS))invalid();
 const v=value as Record<string,any>,e=v.edcEffort;
 if(v.schemaVersion!==RECEIPT_VERSION||!edcId(v.signatureId)||typeof v.requestKey!=='string'||!UUID_V4.test(v.requestKey)||!DECISIONS.includes(v.decision)
  ||typeof v.meaning!=='string'||!v.meaning.trim()||v.meaning.length>1000||!nativeId(v.signerUserId)||typeof v.signerUsername!=='string'||!v.signerUsername.trim()||v.signerUsername.length>255
  ||typeof v.signerFullName!=='string'||v.signerFullName.length>255||typeof v.signedAt!=='string'||!INSTANT.test(v.signedAt)||!instant(v.signedAt)||typeof v.subjectHash!=='string'||!SHA.test(v.subjectHash)
  ||e!==null&&(!object(e)||!exactKeys(e,['requestId','workStartedAt','startBasis'])||typeof e.requestId!=='string'||!UUID.test(e.requestId)||!['client-work-start','not-supplied'].includes(e.startBasis)
   ||(e.startBasis==='not-supplied')!==(e.workStartedAt===null)||e.workStartedAt!==null&&(typeof e.workStartedAt!=='string'||!INSTANT.test(e.workStartedAt)||!instant(e.workStartedAt))))invalid();
 return {schemaVersion:RECEIPT_VERSION,signatureId:v.signatureId,requestKey:v.requestKey.toLowerCase(),decision:v.decision,meaning:v.meaning,signerUserId:v.signerUserId,signerUsername:v.signerUsername,
  signerFullName:v.signerFullName,signedAt:v.signedAt,context:signatureContext(v.context),subjectHash:v.subjectHash,
  edcEffort:e===null?null:{requestId:e.requestId.toLowerCase(),workStartedAt:e.workStartedAt,startBasis:e.startBasis}};
}

interface BindingRow {id:string|number;edcSignatureId:string|number;decision:TrainingSignatureDecision;requestKey:string;signerUserId:number;signedAt:string|Date;
 context:TrainingSignatureContext;subject:TrainingSignatureSubject;subjectHash:string;receipt:TrainingSignatureReceipt;edcObservationHash:string;
 recordId:number|null;assessmentCycleId:string|null;draftId:string|null;createdAt:string|Date}
function bindingOf(row:BindingRow):TrainingSignatureBinding{
 // BIGINT columns arrive as text from pg; refuse any value that is not an exact safe integer.
 const id=Number(row.id),signatureId=Number(row.edcSignatureId),signedAt=instant(row.signedAt),createdAt=instant(row.createdAt);
 if(!edcId(id)||!edcId(signatureId)||!signedAt||!createdAt||!DECISIONS.includes(row.decision)||!object(row.context)||!object(row.subject)||!object(row.receipt)||typeof row.subjectHash!=='string'||!SHA.test(row.subjectHash))
  fail('Retained training signature integrity failed');
 return {id,signatureId,decision:row.decision,requestKey:row.requestKey,signerUserId:row.signerUserId,signedAt,context:row.context,subject:row.subject,subjectHash:row.subjectHash,
  receipt:row.receipt,edcObservationHash:row.edcObservationHash,recordId:row.recordId,assessmentCycleId:row.assessmentCycleId,draftId:row.draftId,createdAt};
}

/** Checks a receipt passes before its decision writes anything or calls the EDC; binding repeats them. */
export function checkSignedDecision(receipt:TrainingSignatureReceipt,decision:TrainingSignatureDecision,signerUserId:number,subjectHash:string):void{
 if(receipt.decision!==decision)fail('The signature was made for a different training decision');
 if(receipt.signerUserId!==signerUserId)fail('Only the person recording this training decision can sign it',403);
 if(!SHA.test(subjectHash)||receipt.subjectHash!==subjectHash)fail('The signed subject is not the current training subject; read the current subject and sign it again');
}

/** What the caller recomputed inside its decision transaction, with the decision rows it holds locked. */
export interface SignatureExpectation {
 decision:TrainingSignatureDecision;subject:TrainingSignatureSubject;subjectHash:string;signerUserId:number;
 recordId?:number;assessmentCycleId?:string;draftId?:string;
}
/** Bind an EDC-confirmed signature to its decision. The receipt, the EDC's own row and the recomputed subject must
 * agree exactly. The same receipt again replays its binding; another signature for a signed decision is refused,
 * never overwritten, and stays in the EDC as a signature that no decision consumed. */
export async function bindSignatureReceipt(client:Pick<TransactionClient,'query'>,receipt:TrainingSignatureReceipt,confirmation:TrainingSignatureConfirmation,
 expected:SignatureExpectation):Promise<{binding:TrainingSignatureBinding;replayed:boolean}>{
 if(expected.decision==='matrix-approval')fail('Matrix approval signatures are reserved for the curriculum matrix');
 const forRecord=RECORD_DECISIONS.includes(expected.decision),context=expected.subject.context;
 if(forRecord?!nativeId(expected.recordId)||typeof expected.assessmentCycleId!=='string'||expected.draftId!==undefined
  :typeof expected.draftId!=='string'||expected.recordId!==undefined||expected.assessmentCycleId!==undefined)fail('The signed training decision target is incomplete',500);
 if(expected.subject.kind!==expected.decision)fail('The signed training decision target is incomplete',500);
 checkSignedDecision(receipt,expected.decision,expected.signerUserId,expected.subjectHash);
 if(receipt.context.studyId!==context.studyId||receipt.context.siteId!==context.siteId)fail('The signature context differs from the signed subject');
 if(confirmation.signatureId!==receipt.signatureId||confirmation.requestKey!==receipt.requestKey||confirmation.decision!==receipt.decision||confirmation.subjectHash!==receipt.subjectHash
  ||confirmation.meaning!==receipt.meaning||confirmation.signerUserId!==receipt.signerUserId||confirmation.signerUsername!==receipt.signerUsername||confirmation.signerFullName!==receipt.signerFullName
  ||instant(confirmation.signedAt)!==instant(receipt.signedAt)||confirmation.studyId!==(context.siteId??context.studyId)||confirmation.effortRequestId!==(receipt.edcEffort?.requestId??null))
  fail('The signature receipt does not match the native EDC signature');
 const target=[expected.recordId??null,expected.assessmentCycleId??null,expected.draftId??null];
 const prior=(await client.query<BindingRow>(`SELECT * FROM acc_training_decision_signatures WHERE edc_signature_id=$1
   OR decision=$2 AND (record_id=$3 AND assessment_cycle_id=$4 OR draft_id=$5) ORDER BY id`,[receipt.signatureId,expected.decision,...target])).rows.map(bindingOf);
 if(prior.length){
  const row=prior[0];
  if(prior.length!==1||row.signatureId!==receipt.signatureId||row.decision!==expected.decision||row.subjectHash!==expected.subjectHash||row.signerUserId!==expected.signerUserId
   ||row.recordId!==(expected.recordId??null)||row.assessmentCycleId!==(expected.assessmentCycleId??null)||row.draftId!==(expected.draftId??null))
   fail(prior.some(binding=>binding.signatureId===receipt.signatureId)?'This EDC signature is already bound to another training decision':'This training decision already carries a different signature');
  return {binding:row,replayed:true};
 }
 try{
  const row=(await client.query<BindingRow>(`INSERT INTO acc_training_decision_signatures(edc_signature_id,decision,request_key,signer_user_id,signed_at,context,subject,
    subject_hash,receipt,edc_observation_hash,record_id,assessment_cycle_id,draft_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13) RETURNING *`,
   [receipt.signatureId,expected.decision,receipt.requestKey,receipt.signerUserId,receipt.signedAt,JSON.stringify(context),JSON.stringify(expected.subject),expected.subjectHash,
    JSON.stringify(receipt),confirmation.observationHash,...target])).rows[0];
  return {binding:bindingOf(row),replayed:false};
 }catch(error){
  if((error as {code?:string}).code==='23505')fail('This training decision or EDC signature was bound concurrently; read the signature subject before retrying');
  throw error;
 }
}

/** Every binding of the given records (attestation, verification) and drafts (material approval), oldest first. */
export async function signatureBindings(client:Pick<TransactionClient,'query'>,selection:{recordIds:number[];draftIds:string[]}):Promise<TrainingSignatureBinding[]>{
 if(!selection.recordIds.length&&!selection.draftIds.length)return [];
 return (await client.query<BindingRow>(`SELECT * FROM acc_training_decision_signatures WHERE decision IN ('completion-attestation','verification') AND record_id=ANY($1::integer[])
   OR decision='material-approval' AND draft_id=ANY($2::uuid[]) ORDER BY id`,[selection.recordIds,selection.draftIds])).rows.map(bindingOf);
}
/** The binding of one decision slot: a record's assessment cycle, or a draft. */
export function bindingFor(bindings:TrainingSignatureBinding[],decision:TrainingSignatureDecision,target:{recordId:number;assessmentCycleId:string|null|undefined}|{draftId:string}){
 return bindings.find(binding=>binding.decision===decision&&('draftId' in target?binding.draftId===target.draftId.toLowerCase()
  :binding.recordId===target.recordId&&binding.assessmentCycleId===(target.assessmentCycleId?.toLowerCase()??null)));
}
/** The read side of an uncertain signed request: a client retries only with the same request key, never a new one. */
export function bindingStatus(binding:TrainingSignatureBinding|undefined){
 return binding?{status:'bound' as const,signatureId:binding.signatureId,requestKey:binding.requestKey,signerUserId:binding.signerUserId,signedAt:binding.signedAt}:{status:'unbound' as const};
}
export const signatureReference=(binding:TrainingSignatureBinding):TrainingSignatureReference=>({signatureId:binding.signatureId,subjectHash:binding.subjectHash,subject:binding.subject});
/** Audit details of a bound signature (training_completion_attested, training_signature_bound). */
export const signatureAuditDetails=(binding:TrainingSignatureBinding)=>({signatureId:binding.signatureId,decision:binding.decision,subjectHash:binding.subjectHash,signedAt:binding.signedAt});
