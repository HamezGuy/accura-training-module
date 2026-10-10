import type {TransactionClient} from '../config/database';
import {trainingEvidenceHash} from './audit.service';
import type {TrainingCourse,TrainingQuizAnswer,TrainingQuizQuestion,TrainingQuizResult,TrainingQuizSubmission,TrainingRecord} from '../types/training.types';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const normalized=(value:unknown):any=>JSON.parse(JSON.stringify(value));
const same=(a:unknown,b:unknown)=>trainingEvidenceHash(normalized(a))===trainingEvidenceHash(normalized(b));
function refuse(message:string,statusCode=409):never {throw Object.assign(new Error(message),{statusCode});}
export interface AssessmentSnapshot {course:TrainingCourse;slides:unknown[];questions:TrainingQuizQuestion[]}
export interface AssessmentReceipt {
 schemaVersion:'training-assessment/1';id:string;hash:string;grader:'exact-option-set/1';actorUserId:number;
 recordId:number;courseId:number;cycleId:string;attemptNumber:number;requestId:string;requestHash:string;
 contentRevision:number;courseVersion:string;contentHash:string;startedAt:string;assessedAt:string;
 answers:TrainingQuizAnswer[];grades:Array<{questionId:number;selectedOptions:number[];correctOptions:number[];correct:boolean}>;
 result:TrainingQuizResult;materialProof:string|null;assignments:unknown[];authorityFingerprint:string;
}
export interface AssessmentHistoryRow {historyId?:string;recordId:number;userId:number;courseId:number;eventKind:string;assessmentCycleId:string|null;requestKey:string|null;requestHash:string|null;assessment:AssessmentReceipt|null;recordSnapshot:TrainingRecord}

export function validateSubmission(value:TrainingQuizSubmission|undefined):asserts value is TrainingQuizSubmission {
 if(!value||!Number.isSafeInteger(value.recordId)||value.recordId<1||!uuid.test(value.cycleId)||!uuid.test(value.requestId))refuse('An exact record, assessment cycle and request UUID are required',400);
}
/** Canonical request meaning is independent of answer/option presentation order. */
export function canonicalAnswers(answers:TrainingQuizAnswer[]):TrainingQuizAnswer[] {
 if(!Array.isArray(answers)||answers.length>1000)refuse('Invalid quiz answers',400);
 const seen=new Set<number>();
 return answers.map(answer=>{
  if(!answer||!Number.isSafeInteger(answer.questionId)||answer.questionId<1||seen.has(answer.questionId)||!Array.isArray(answer.selectedOptions)
   ||answer.selectedOptions.some(option=>!Number.isSafeInteger(option)||option<0)||new Set(answer.selectedOptions).size!==answer.selectedOptions.length)refuse('Duplicate or invalid quiz answers',400);
  seen.add(answer.questionId);return {questionId:answer.questionId,selectedOptions:[...answer.selectedOptions].sort((a,b)=>a-b)};
 }).sort((a,b)=>a.questionId-b.questionId);
}
export function assessmentRequestHash(userId:number,courseId:number,contentRevision:number,submission:TrainingQuizSubmission,answers:TrainingQuizAnswer[]):string {
 return trainingEvidenceHash({schemaVersion:'training-quiz-request/1',userId,courseId,contentRevision,...submission,answers:canonicalAnswers(answers)});
}
/** Sole grader, reused to verify retained evidence. Missing answers remain wrong. */
export function gradeAssessment(snapshot:AssessmentSnapshot,answers:TrainingQuizAnswer[]) {
 const questions=snapshot.questions;const canonical=canonicalAnswers(answers);
 if(!Array.isArray(questions)||!questions.length||new Set(questions.map(q=>q.id)).size!==questions.length)refuse('Quiz definition is unavailable');
 for(const answer of canonical){const question=questions.find(q=>q.id===answer.questionId);
  if(!question||answer.selectedOptions.some(option=>option>=question.options.length)||question.questionType!=='multi_select'&&answer.selectedOptions.length>1)refuse('Answers do not match the exact quiz definition',400);}
 const grades=questions.map(question=>{
  const selectedOptions=canonical.find(a=>a.questionId===question.id)?.selectedOptions??[];
  const correctOptions=question.options.flatMap((option,index)=>option.isCorrect?[index]:[]);
  if(!correctOptions.length||question.questionType!=='multi_select'&&correctOptions.length!==1)refuse('Quiz answer configuration is unavailable');
  return {questionId:question.id,selectedOptions,correctOptions,correct:selectedOptions.length>0&&same(selectedOptions,correctOptions)};
 });
 const correctAnswers=grades.filter(grade=>grade.correct).length;const score=Math.round(correctAnswers/questions.length*100);
 return {grades,result:{passed:score>=snapshot.course.passingScore,score,totalQuestions:questions.length,correctAnswers}};
}
export function contentMeaning(snapshot:AssessmentSnapshot):unknown {
 const c=snapshot.course;
 return {course:{id:c.id,courseCode:c.courseCode,courseName:c.courseName,description:c.description,version:c.version,contentRevision:c.contentRevision,
  passingScore:c.passingScore,validityPeriodDays:c.validityPeriodDays,regulatoryReference:c.regulatoryReference,requiredForRoles:c.requiredForRoles,
  materialScope:c.materialScope??null,materialDraftId:c.materialDraftId??null,materialPublicationId:c.materialPublicationId??null},
  slides:snapshot.slides,questions:snapshot.questions};
}
export function assertStartedContent(record:TrainingRecord,live:AssessmentSnapshot):AssessmentSnapshot {
 const snapshot=record.contentSnapshot as AssessmentSnapshot;
 if(!snapshot?.course||!Array.isArray(snapshot.slides)||!Array.isArray(snapshot.questions)||!same(contentMeaning(snapshot),contentMeaning(live)))refuse('Started training content differs from the current definition; restart the course');
 return snapshot;
}
export const assessmentContentHash=(snapshot:AssessmentSnapshot)=>trainingEvidenceHash(normalized(contentMeaning(snapshot)));
export function sealAssessment(receipt:Omit<AssessmentReceipt,'hash'>):AssessmentReceipt {return {...receipt,hash:trainingEvidenceHash(normalized(receipt))};}
export function assessmentReference(receipt:AssessmentReceipt){return {id:receipt.id,hash:receipt.hash,cycleId:receipt.cycleId,attemptNumber:receipt.attemptNumber};}
function time(value:unknown):number{return typeof value==='string'||value instanceof Date?new Date(value).getTime():NaN;}

/** Closure includes the immutable cycle start, every prior attempt and exact
 * completion fields. A hash alone is not evidence that the record was graded. */
export function verifyAssessmentRows(rows:AssessmentHistoryRow[],record?:TrainingRecord):void {
 if(record){const starts=rows.filter(row=>row.recordId===record.id&&row.eventKind==='cycle_started');
  if(starts.length&&starts[starts.length-1].assessmentCycleId!==record.assessmentCycleId)refuse('Current record does not match its latest retained assessment cycle');}
 const cycles=new Map<string,AssessmentHistoryRow[]>();
 for(const row of rows){if(row.eventKind==='restart')continue;if(!row.assessmentCycleId)refuse('Assessment cycle evidence is incomplete');const group=cycles.get(row.assessmentCycleId)??[];group.push(row);cycles.set(row.assessmentCycleId,group);}
 for(const [cycle,events] of cycles){const starts=events.filter(e=>e.eventKind==='cycle_started');if(starts.length!==1)refuse('Assessment start evidence is incomplete');
  const start=starts[0].recordSnapshot;const snapshot=start.contentSnapshot as AssessmentSnapshot;
  if(starts[0].recordId!==start.id||starts[0].userId!==start.userId||starts[0].courseId!==start.courseId||start.assessmentCycleId!==cycle||start.status!=='in_progress'||start.attempts!==0||start.assessmentReceipt||!Number.isFinite(time(start.startedAt))||!snapshot?.questions)refuse('Assessment start evidence is invalid');
  let passed=false;const attempts=events.filter(e=>e.eventKind==='quiz_attempt');
  for(let index=0;index<attempts.length;index++){const row=attempts[index],receipt=row.assessment;if(!receipt)refuse('Assessment receipt is missing');
   const {hash,...body}=receipt;const result=gradeAssessment(snapshot,receipt.answers);const after=row.recordSnapshot;
   if(passed||receipt.schemaVersion!=='training-assessment/1'||receipt.grader!=='exact-option-set/1'||!uuid.test(receipt.id)||hash!==trainingEvidenceHash(normalized(body))
    ||receipt.actorUserId!==start.userId||receipt.recordId!==start.id||receipt.courseId!==start.courseId||receipt.cycleId!==cycle||receipt.attemptNumber!==index+1
    ||row.userId!==start.userId||row.recordId!==start.id||row.courseId!==start.courseId||row.requestKey!==receipt.requestId||row.requestHash!==receipt.requestHash
    ||receipt.requestHash!==assessmentRequestHash(start.userId,start.courseId,receipt.contentRevision,{recordId:start.id,cycleId:cycle,requestId:receipt.requestId},receipt.answers)
    ||receipt.courseVersion!==start.courseVersion||receipt.contentRevision!==start.contentRevision||receipt.contentHash!==assessmentContentHash(snapshot)
    ||time(receipt.startedAt)!==time(start.startedAt)||!Number.isFinite(time(receipt.assessedAt))||time(receipt.assessedAt)<time(start.startedAt)
    ||!same(receipt.grades,result.grades)||Object.keys(receipt.result).some(key=>!['passed','score','totalQuestions','correctAnswers','certificateNumber','expirationDate'].includes(key))
    ||Object.entries(result.result).some(([key,value])=>(receipt.result as any)[key]!==value)
    ||after.id!==start.id||after.userId!==start.userId||after.courseId!==start.courseId||after.courseVersion!==start.courseVersion||after.contentRevision!==start.contentRevision
    ||after.assessmentCycleId!==cycle||!same(after.contentSnapshot,start.contentSnapshot)||time(after.startedAt)!==time(start.startedAt)
    ||after.attempts!==index+1||after.score!==receipt.result.score||!same(after.assessmentReceipt,assessmentReference(receipt)))refuse('Assessment receipt does not close its retained record');
   passed=receipt.result.passed;
   if(passed?(after.status!=='completed'||time(after.completedAt)!==time(receipt.assessedAt)||after.certificateNumber!==receipt.result.certificateNumber||time(after.expirationDate)!==time(receipt.result.expirationDate))
    :(after.status!=='in_progress'||after.completedAt!==null||after.certificateNumber!==null||after.expirationDate!==null))refuse('Assessment outcome evidence is inconsistent');
  }
  if(record?.assessmentCycleId===cycle){const latest=attempts[attempts.length-1]?.recordSnapshot??start;
   for(const key of ['id','userId','courseId','courseVersion','contentRevision','assessmentCycleId','attempts','score','certificateNumber'] as const)if(record[key]!==latest[key])refuse('Current assessment record differs from retained evidence');
   for(const key of ['startedAt','completedAt','expirationDate'] as const)if((record[key]===null)!==(latest[key]===null)||record[key]!==null&&time(record[key])!==time(latest[key]))refuse('Current assessment dates differ from retained evidence');
   if(!same(record.contentSnapshot,latest.contentSnapshot)||!same(record.assessmentReceipt??null,latest.assessmentReceipt??null)
    ||record.status!==latest.status&&!(record.status==='expired'&&latest.status==='completed'))refuse('Current assessment completion differs from retained evidence');
  }
 }
 if(record?.assessmentCycleId&&!cycles.has(record.assessmentCycleId)||record?.assessmentReceipt&&!record.assessmentCycleId)refuse('Current assessment evidence is missing');
}
export async function verifyRecordAssessment(client:TransactionClient,record:TrainingRecord):Promise<void> {
 // Read the retained census even when a mutable record loses its receipt pin;
 // it must not masquerade as a legacy completion after an assessed cycle.
 const rows=(await client.query<AssessmentHistoryRow>(`SELECT * FROM acc_training_record_history WHERE record_id=$1 AND user_id=$2 ORDER BY history_id`,[record.id,record.userId])).rows;
 verifyAssessmentRows(rows,record);record.assessmentEvidenceVerified=Boolean(record.assessmentCycleId);
}
