import {randomUUID} from 'node:crypto';
import {query,queryOne,transaction,TransactionClient} from '../config/database';
import {logAudit,trainingEvidenceHash as hash,AuditAction} from './audit.service';
import {observeMaterialSource,inspectImpactSource,resolveObligationScope,TrainingAuthorityContext} from './training-authority.service';
import {TrainingCourse,TrainingMaterial,TrainingMaterialDraftRequest,TrainingMaterialSource,TrainingObligationScope,TrainingObligation} from '../types/training.types';

const database={query,queryOne};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
function fail(message:string,statusCode=409):never{throw Object.assign(new Error(message),{statusCode});}
function exact(v:unknown,keys:string[]):asserts v is Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Unexpected material fields',400);}
function text(v:unknown,max:number,empty=false):asserts v is string{if(typeof v!=='string'||(!empty&&!v.trim())||v.length>max)fail(`Supply ${empty?'0':'1'}–${max} characters`,400);}
const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Text is retained verbatim. Escaping, never HTML interpretation, preserves the
 * authored words and units in the existing HTML learner without executable markup. */
export const materialLessonHtml=(lesson:TrainingMaterial['lessons'][number])=>`<p>${escape(lesson.text).replace(/\r\n|\r|\n/g,'<br>')}</p>`+
 (lesson.citations.length?`<ul>${lesson.citations.map(c=>`<li>Source ${escape(c.fileId)} · ${escape(c.locator)} (author-declared locator)</li>`).join('')}</ul>`:'');
export function validateMaterialDraft(value:unknown):asserts value is TrainingMaterialDraftRequest{
 exact(value,['schemaVersion','idempotencyKey','courseId','expectedContentRevision','expectedDraftId','source','reason','material']);
 if(value.schemaVersion!=='training-material-draft/1'||!uuid(value.idempotencyKey)||value.courseId!==null&&!id(value.courseId)
  ||!Number.isSafeInteger(value.expectedContentRevision)||value.expectedContentRevision<0||value.expectedDraftId!==null&&!uuid(value.expectedDraftId))fail('Exact draft identity and expected heads are required',400);
 text(value.reason,2000);exact(value.source,['scope','armIds','originals','sourceHash']);
 exact(value.source.scope,['studyId','siteId']);if(!id(value.source.scope.studyId)||value.source.scope.siteId!==undefined&&!id(value.source.scope.siteId))fail('Exact material scope required',400);
 if(!Array.isArray(value.source.armIds)||value.source.armIds.length>100||value.source.armIds.some((v:unknown)=>!id(v))||new Set(value.source.armIds).size!==value.source.armIds.length
  ||typeof value.source.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(value.source.sourceHash)||!Array.isArray(value.source.originals)||!value.source.originals.length||value.source.originals.length>16)fail('Current material source and 1–16 originals required',400);
 const files=new Set<string>();for(const pin of value.source.originals){exact(pin,['kind','fileId','sha256']);if(!uuid(pin.fileId)||files.has(pin.fileId)||!['protocol','product','duty','amendment','staff'].includes(pin.kind)||typeof pin.sha256!=='string'||!/^[a-f0-9]{64}$/.test(pin.sha256))fail('Invalid original custody pin',400);files.add(pin.fileId);}
 const m=value.material;exact(m,['courseCode','courseName','description','version','passingScore','durationMinutes','validityPeriodDays','active','intendedUse','lessons','questions']);
 text(m.courseCode,50);text(m.courseName,255);text(m.description,10000,true);text(m.version,20);
 if(!Number.isInteger(m.passingScore)||m.passingScore<1||m.passingScore>100||m.durationMinutes!==null&&(!id(m.durationMinutes)||m.durationMinutes>100000)
  ||!id(m.validityPeriodDays)||m.validityPeriodDays>36500||typeof m.active!=='boolean'||!['synthetic_qualification','operator_authored'].includes(m.intendedUse))fail('Invalid material settings',400);
 if(!Array.isArray(m.lessons)||!m.lessons.length||m.lessons.length>100||!Array.isArray(m.questions)||!m.questions.length||m.questions.length>100)fail('Supply 1–100 lessons and assessed questions',400);
 for(const lesson of m.lessons){exact(lesson,['title','text','citations']);text(lesson.title,255);text(lesson.text,20000);if(!Array.isArray(lesson.citations)||!lesson.citations.length||lesson.citations.length>16)fail('Each lesson requires declared source locators',400);
  for(const citation of lesson.citations){exact(citation,['fileId','locator']);if(!files.has(citation.fileId))fail('Citation is outside retained originals',400);text(citation.locator,1000);}}
 for(const q of m.questions){exact(q,['questionText','questionType','options','explanation']);text(q.questionText,5000);text(q.explanation,5000,true);
  if(!['multiple_choice','true_false','multi_select'].includes(q.questionType)||!Array.isArray(q.options)||q.options.length<2||q.options.length>12||q.questionType==='true_false'&&q.options.length!==2)fail('Unsupported question or answer count',400);
  for(const o of q.options){exact(o,['text','isCorrect']);text(o.text,2000);if(typeof o.isCorrect!=='boolean')fail('Exact answer key required',400);}
  const count=q.options.filter((o:any)=>o.isCorrect).length;if(count<1||q.questionType!=='multi_select'&&count!==1||new Set(q.options.map((o:any)=>o.text.trim())).size!==q.options.length)fail('Invalid or ambiguous answer key',400);
 }
 if(Buffer.byteLength(JSON.stringify(value),'utf8')>600000)fail('Material exceeds the supported complete draft size',413);
}
interface Draft {id:string;courseId:number;createdBy:number;request:TrainingMaterialDraftRequest;requestHash:string;authorAuthorityHash:string;status:string;revision:number;reviewedBy:number|null;reviewAuthorityHash:string|null;reviewReason:string|null;reviewedAt:string|null}
interface Publication {id:string;courseId:number;draftId:string;contentRevision:number;runtimeHash:string;runtimeSnapshot:unknown;receipt:any}
async function manager(authority:TrainingAuthorityContext,scope:{studyId:number;siteId?:number}){await inspectImpactSource(authority,scope,[]);}
function checkDraft(row:Draft){validateMaterialDraft(row.request);if(row.requestHash!==hash(row.request))fail('Retained material draft integrity failed');return row;}
async function draftById(client:Pick<TransactionClient,'queryOne'>,draftId:string):Promise<Draft>{if(!uuid(draftId))fail('Invalid material draft identity',400);const row=await client.queryOne<Draft>('SELECT * FROM acc_training_material_drafts WHERE id=$1',[draftId]);if(!row)fail('Material draft not found',404);return checkDraft(row);}
async function checkPublication(client:Pick<TransactionClient,'queryOne'>,pub:Publication){const draft=await draftById(client,pub.draftId),r=pub.receipt;
 if(!r||r.schemaVersion!=='training-material-publication/1'||draft.status!=='published'||draft.createdBy===draft.reviewedBy||r.courseVersion!==draft.request.material.version||r.clinicalAdequacyClaimed!==false
  ||hash(pub.runtimeSnapshot)!==pub.runtimeHash||r.runtimeHash!==pub.runtimeHash||r.publicationId!==pub.id||r.courseId!==pub.courseId||draft.courseId!==pub.courseId||r.draftId!==draft.id||r.requestHash!==draft.requestHash
  ||r.contentRevision!==pub.contentRevision||hash(r.source)!==hash(draft.request.source)||r.authorUserId!==draft.createdBy||r.reviewerUserId!==draft.reviewedBy||r.reviewReason!==draft.reviewReason)fail('Retained material publication integrity failed');return pub;}
/** Validate historic as well as current publications through the same custody
 * rules; inspection is not allowed to trust a stored hash column alone. */
export async function validateInspectionMaterial(client:Pick<TransactionClient,'queryOne'>,drafts:Draft[],publications:Publication[],events:Array<{draftId:string;revision:number;snapshot:Draft}>){
 for(const draft of drafts){checkDraft(draft);const history=events.filter(e=>e.draftId===draft.id).sort((a,b)=>a.revision-b.revision);
  if(history.length!==draft.revision||history.some((e,i)=>e.revision!==i+1||e.snapshot.revision!==e.revision||e.snapshot.id!==draft.id||e.snapshot.requestHash!==draft.requestHash))fail('Material history is incomplete or inconsistent');
  const last=history.at(-1)!.snapshot;if(last.status!==draft.status||last.reviewedBy!==draft.reviewedBy||last.reviewReason!==draft.reviewReason||last.reviewAuthorityHash!==draft.reviewAuthorityHash)fail('Material head differs from its retained history');
  if((draft.status==='published')!==publications.some(p=>p.draftId===draft.id))fail('Material publication closure is incomplete');
 }
 for(const event of events){const snapshot=checkDraft(event.snapshot),draft=drafts.find(row=>row.id===snapshot.id);if(!draft||draft.requestHash!==snapshot.requestHash)fail('Material history integrity failed');}
 for(const publication of publications)await checkPublication(client,publication);
}
async function event(client:TransactionClient,row:Draft,actor:number,action:AuditAction){await client.query('INSERT INTO acc_training_material_events(draft_id,revision,actor_user_id,action,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)',[row.id,row.revision,actor,action,JSON.stringify(row)]);await logAudit({userId:actor,courseId:row.courseId,action,details:{draftId:row.id,revision:row.revision,requestHash:row.requestHash}},client);}
async function locked(client:TransactionClient,draftId:string){const prior=await draftById(client,draftId);const course=await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 FOR UPDATE',[prior.courseId]);if(!course)fail('Course custody missing');const row=await client.queryOne<Draft>('SELECT * FROM acc_training_material_drafts WHERE id=$1 FOR UPDATE',[draftId]);if(!row)fail('Draft custody missing');return {course,row:checkDraft(row)};}
export async function getMaterialDraft(authority:TrainingAuthorityContext,draftId:string){const row=await draftById(database,draftId);await manager(authority,row.request.source.scope);
 const history=(await query('SELECT revision,actor_user_id,action,snapshot,created_at FROM acc_training_material_events WHERE draft_id=$1 ORDER BY revision',[draftId])).rows;
 let sourceCurrent=true;try{await observeMaterialSource(authority,row.request.source);}catch(e){if([401,403].includes((e as any).statusCode))throw e;sourceCurrent=false;}
 const course=await queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1',[row.courseId]);
 for(const entry of history as Array<{snapshot:Draft}>){const snapshot=checkDraft(entry.snapshot);if(snapshot.id!==row.id||snapshot.requestHash!==row.requestHash)fail('Material history integrity failed');}
 const publication=await queryOne<Publication>('SELECT * FROM acc_training_material_publications WHERE draft_id=$1',[draftId]);if(publication)await checkPublication(database,publication);
 return {...row,history,sourceCurrent,currentDraftId:course?.materialDraftId??null,currentContentRevision:course?.contentRevision??null,publication:publication?.receipt??null};
}
export async function listMaterialDrafts(authority:TrainingAuthorityContext,scope:{studyId:number;siteId?:number}){await manager(authority,scope);const rows=(await query<Draft>('SELECT d.* FROM acc_training_material_drafts d JOIN acc_training_courses c ON c.id=d.course_id WHERE c.material_scope=$1::jsonb ORDER BY d.created_at DESC,d.id LIMIT 501',[JSON.stringify(scope)])).rows;if(rows.length>500)fail('Material history exceeds the complete supported list size',413);return rows.map(checkDraft);}
export async function proposeMaterialDraft(authority:TrainingAuthorityContext,value:unknown){validateMaterialDraft(value);const requestHash=hash(value);
 return transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`training-material:${authority.actorUserId}:${value.idempotencyKey}`]);
  const prior=await client.queryOne<Draft>('SELECT * FROM acc_training_material_drafts WHERE created_by=$1 AND idempotency_key=$2',[authority.actorUserId,value.idempotencyKey]);
  if(prior){checkDraft(prior);if(prior.requestHash!==requestHash)fail('This key names different material');await manager(authority,prior.request.source.scope);return prior;}
  const observed=await observeMaterialSource(authority,value.source);let course:TrainingCourse|null;
  if(value.courseId===null){if(value.expectedContentRevision!==0||value.expectedDraftId!==null)fail('A new course has no previous head',400);
   course=await client.queryOne<TrainingCourse>(`INSERT INTO acc_training_courses(course_code,course_name,version,passing_score,required_for_roles,active,created_by,material_scope)
    VALUES($1,$2,$3,$4,'[]'::jsonb,false,$5,$6::jsonb) RETURNING *`,[value.material.courseCode,value.material.courseName,value.material.version,value.material.passingScore,authority.actorUserId,JSON.stringify(value.source.scope)]);
  }else{course=await client.queryOne<TrainingCourse>('SELECT * FROM acc_training_courses WHERE id=$1 FOR UPDATE',[value.courseId]);
   if(!course?.materialScope||hash(course.materialScope)!==hash(value.source.scope))fail('Select a governed course in this exact scope');
   if(course.contentRevision!==value.expectedContentRevision||course.materialDraftId!==value.expectedDraftId)fail('Course or draft head changed; reload before authoring');
   if(course.courseCode!==value.material.courseCode)fail('Course code is immutable; author a separate course',400);}
  if(!course)fail('Course could not be retained');await observeMaterialSource(authority,value.source,{authorityHash:observed.authorityHash});
  const row=await client.queryOne<Draft>(`INSERT INTO acc_training_material_drafts(id,course_id,created_by,idempotency_key,request,request_hash,author_authority_hash,status)
   VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,'draft') RETURNING *`,[randomUUID(),course.id,authority.actorUserId,value.idempotencyKey,JSON.stringify(value),requestHash,observed.authorityHash]);
  await client.query('UPDATE acc_training_courses SET material_draft_id=$2 WHERE id=$1',[course.id,row!.id]);await event(client,row!,authority.actorUserId,'training_material_drafted');return row!;
 });
}
export async function reviewMaterialDraft(authority:TrainingAuthorityContext,draftId:string,input:unknown){exact(input,['expectedRevision','requestHash','accepted','reason']);if(!id(input.expectedRevision)||typeof input.accepted!=='boolean')fail('Exact review disposition required',400);text(input.reason,2000);
 return transaction(async client=>{const {course,row}=await locked(client,draftId);await manager(authority,row.request.source.scope);
  if(row.createdBy===authority.actorUserId)fail('A different authorized reviewer must review the material',403);
  if(course.materialDraftId!==row.id||row.revision!==input.expectedRevision||row.requestHash!==input.requestHash||row.status!=='draft')fail('The exact current unreviewed draft is required');
  const observed=input.accepted?await observeMaterialSource(authority,row.request.source):null;
  const updated=await client.queryOne<Draft>(`UPDATE acc_training_material_drafts SET status=$2,revision=revision+1,reviewed_by=$3,review_authority_hash=$4,review_reason=$5,reviewed_at=NOW() WHERE id=$1 RETURNING *`,[draftId,input.accepted?'reviewed':'rejected',authority.actorUserId,observed?.authorityHash??null,input.reason]);
  if(observed)await observeMaterialSource(authority,row.request.source,{authorityHash:observed.authorityHash});await event(client,updated!,authority.actorUserId,input.accepted?'training_material_reviewed':'training_material_rejected');return updated!;
 });
}
/** Whole live projection, including disabled questions, is retained and hashed.
 * Database edits and seeding cannot silently turn unreviewed bytes into a publication. */
export async function materialRuntimeSnapshot(client:Pick<TransactionClient,'query'>,course:TrainingCourse){return {
 course:{id:course.id,courseCode:course.courseCode,courseName:course.courseName,description:course.description,version:course.version,contentRevision:course.contentRevision,durationMinutes:course.durationMinutes,passingScore:course.passingScore,requiredForRoles:course.requiredForRoles,regulatoryReference:course.regulatoryReference,active:course.active,validityPeriodDays:course.validityPeriodDays,materialScope:course.materialScope},
 slides:(await client.query('SELECT id,title,content,slide_type,order_index,media_url,interactive_config FROM acc_training_slides WHERE course_id=$1 ORDER BY order_index,id',[course.id])).rows,
 questions:(await client.query('SELECT id,question_text,question_type,options,explanation,order_index,active FROM acc_training_questions WHERE course_id=$1 ORDER BY order_index,id',[course.id])).rows};}
export async function publishedMaterial(client:Pick<TransactionClient,'query'|'queryOne'>,course:TrainingCourse):Promise<Publication|null>{if(!course.materialScope)return null;
 const pub=course.materialPublicationId?await client.queryOne<Publication>('SELECT * FROM acc_training_material_publications WHERE id=$1 AND course_id=$2',[course.materialPublicationId,course.id]):null;
 if(!pub||pub.contentRevision!==course.contentRevision||pub.runtimeHash!==hash(await materialRuntimeSnapshot(client,course)))fail('The exact reviewed course publication is unavailable; ask the training manager to reassess it');return checkPublication(client,pub);
}
export async function publishMaterialDraft(authority:TrainingAuthorityContext,draftId:string,input:unknown){exact(input,['expectedRevision','requestHash']);if(!id(input.expectedRevision))fail('Exact reviewed revision required',400);
 return transaction(async client=>{const {course,row}=await locked(client,draftId);await manager(authority,row.request.source.scope);
  if(row.createdBy!==authority.actorUserId)fail('Only the current author can publish this reviewed draft',403);
  if(row.status==='published'&&row.revision===input.expectedRevision+1&&row.requestHash===input.requestHash){const prior=await client.queryOne<Publication>('SELECT * FROM acc_training_material_publications WHERE draft_id=$1',[row.id]);if(!prior)fail('Publication custody missing');await checkPublication(client,prior);return {draft:row,publication:prior.receipt,replay:true};}
  if(course.materialDraftId!==row.id||row.status!=='reviewed'||row.revision!==input.expectedRevision||row.requestHash!==input.requestHash||!row.reviewedBy||!row.reviewAuthorityHash)fail('Publish the exact current independently reviewed draft');
  if(row.request.courseId!==null&&course.contentRevision!==row.request.expectedContentRevision)fail('Live course changed after drafting');
  const opts={authorityHash:row.authorAuthorityHash,reviewer:{userId:row.reviewedBy,authorityHash:row.reviewAuthorityHash}};
  await observeMaterialSource(authority,row.request.source,opts);const m=row.request.material;
  await client.query('DELETE FROM acc_training_slides WHERE course_id=$1',[course.id]);await client.query('DELETE FROM acc_training_questions WHERE course_id=$1',[course.id]);
  for(const [i,l] of m.lessons.entries())await client.query("INSERT INTO acc_training_slides(course_id,title,content,slide_type,order_index) VALUES($1,$2,$3,'text',$4)",[course.id,l.title,materialLessonHtml(l),i]);
  for(const [i,q] of m.questions.entries())await client.query('INSERT INTO acc_training_questions(course_id,question_text,question_type,options,explanation,order_index) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[course.id,q.questionText,q.questionType,JSON.stringify(q.options),q.explanation,i]);
  const current=await client.queryOne<TrainingCourse>(`UPDATE acc_training_courses SET course_name=$2,description=$3,version=$4,passing_score=$5,duration_minutes=$6,
   validity_period_days=$7,active=$8,required_for_roles='[]'::jsonb,regulatory_reference=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,[course.id,m.courseName,m.description,m.version,m.passingScore,m.durationMinutes,m.validityPeriodDays,m.active]);
  const runtime=await materialRuntimeSnapshot(client,current!),publicationId=randomUUID();
  const receipt={schemaVersion:'training-material-publication/1',publicationId,courseId:course.id,draftId:row.id,requestHash:row.requestHash,contentRevision:current!.contentRevision,courseVersion:m.version,runtimeHash:hash(runtime),source:row.request.source,authorUserId:row.createdBy,reviewerUserId:row.reviewedBy,reviewReason:row.reviewReason,reviewedAt:row.reviewedAt,publishedAt:new Date().toISOString(),clinicalAdequacyClaimed:false};
  await client.query('INSERT INTO acc_training_material_publications(id,course_id,draft_id,content_revision,runtime_hash,runtime_snapshot,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',[publicationId,course.id,row.id,current!.contentRevision,receipt.runtimeHash,JSON.stringify(runtime),JSON.stringify(receipt)]);
  await client.query('UPDATE acc_training_courses SET material_publication_id=$2 WHERE id=$1',[course.id,publicationId]);
  await observeMaterialSource(authority,row.request.source,opts);
  const updated=await client.queryOne<Draft>("UPDATE acc_training_material_drafts SET status='published',revision=revision+1 WHERE id=$1 RETURNING *",[row.id]);await event(client,updated!,authority.actorUserId,'training_material_published');return {draft:updated!,publication:receipt,replay:false};
 });
}
function applies(source:TrainingMaterialSource,scope:TrainingObligationScope){return source.scope.studyId===scope.studyId&&(source.scope.siteId===undefined||source.scope.siteId===scope.siteId)&&(!source.armIds.length||scope.armId!==undefined&&source.armIds.includes(scope.armId));}
export async function observePublication(authority:TrainingAuthorityContext,pub:Publication,learner:{userId:number;scope:TrainingObligationScope}){
 const source=pub.receipt.source as TrainingMaterialSource;if(!applies(source,learner.scope))fail('Material does not apply to the assigned training scope');return observeMaterialSource(authority,source,{learner});
}
/** Callers must supply real authenticated context for governed material; legacy
 * generic courses keep their existing behavior and gain no invented approval. */
export async function assertMaterialUse(authority:TrainingAuthorityContext|undefined,client:Pick<TransactionClient,'query'|'queryOne'>,course:TrainingCourse,learner?:{userId:number;scope:TrainingObligationScope}){
 if(!course.materialScope)return;if(!authority)fail('Authenticated material scope is required',403);const pub=(await publishedMaterial(client,course))!;
 const source=pub.receipt.source as TrainingMaterialSource;
 if(learner){const observed=await observePublication(authority,pub,learner);course.materialReady=true;return hash({publicationId:pub.id,observed,learner});}
 const assigned=(await client.query<TrainingObligation>("SELECT * FROM acc_training_obligations WHERE user_id=$1 AND course_id=$2 AND status='assigned' ORDER BY id",[authority.actorUserId,course.id])).rows;
 for(const row of assigned){if(!applies(source,row.scope))continue;const current=await resolveObligationScope(authority,'obligations:read',row.userId,row.scope);if(current.eligible&&current.roles.includes(row.role)){const observed=await observeMaterialSource(authority,source,{learner:{userId:row.userId,scope:row.scope}});course.materialReady=true;return hash({publicationId:pub.id,observed,obligationId:row.id,revision:row.revision,role:row.role});}}
 // Exact managers can inspect the published learner view; author answer keys
 // are available only from the separately authorized draft endpoint.
 const observed=await observeMaterialSource(authority,source);course.materialReady=true;return hash({publicationId:pub.id,observed});
}
export async function materialCourseVisible(authority:TrainingAuthorityContext|undefined,course:TrainingCourse){if(!course.materialScope)return true;if(!authority)return false;
 const own=(await query<TrainingObligation>('SELECT * FROM acc_training_obligations WHERE user_id=$1 AND course_id=$2 AND status=$3',[authority.actorUserId,course.id,'assigned'])).rows;
 for(const row of own){try{const scope=await resolveObligationScope(authority,'obligations:read',row.userId,row.scope);if(scope.eligible&&scope.roles.includes(row.role))return true;}catch(e){if(![403,409].includes((e as any).statusCode))throw e;}}
 try{await manager(authority,course.materialScope);return true;}catch(e){if((e as any).statusCode===403)return false;throw e;}}
