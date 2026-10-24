import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {Pool} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import trainingRoutes from '../../src/routes/training.routes';
import {errorHandler} from '../../src/middleware/errorHandler.middleware';
import {pool} from '../../src/config/database';
import {runMigrations} from '../../src/config/migrations';
import {nativeTrainingAuthority} from '../fixtures/native-training-authority';
import {trainingDutyHash} from '../../src/services/training-obligations.service';
import * as certificateService from '../../src/services/certificate.service';
import {trainingEvidenceHash} from '../../src/services/audit.service';
import {bindSignatureReceipt,materialApprovalSubject} from '../../src/services/training-signatures.service';
import {transaction} from '../../src/config/database';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';

jest.mock('../../src/config/environment',()=>({config:{database:{url:process.env['TRAINING_OBLIGATION_TEST_DATABASE_URL']??'postgresql://127.0.0.1:1/disabled',ssl:false},authority:{baseUrl:'https://authority.invalid',timeoutMs:1000},training:{certificateValidityDays:365}}}));
jest.mock('../../src/config/logger',()=>({logger:{info:jest.fn(),error:jest.fn(),warn:jest.fn(),debug:jest.fn()}}));
const owned=process.env['TRAINING_OBLIGATION_TEST_DATABASE_URL']&&process.env['TRAINING_NATIVE_AUTHORITY_ROOT']?describe:describe.skip;
owned('native obligation scope, durable assignment and completion evidence',()=>{
  const nativePool=new Pool({connectionString:process.env['TRAINING_OBLIGATION_TEST_DATABASE_URL']??'postgresql://127.0.0.1:1/disabled'});
  const app=express();app.use(express.json());app.use('/api/training',trainingRoutes);app.use(errorHandler);
  let authority:ReturnType<typeof nativeTrainingAuthority>,courseId:number,revision:number,questionId:number;
  let intercept:((input:any)=>Promise<void>)|undefined;
  // Stand-in for the EDC's signature rows and its authority op `signature` while the EDC head has neither (both land
  // with T-3/edcapi). It answers exactly the shape the training service checks, and only to the signer.
  const edcSignatures=new Map<number,any>();let nextSignatureId=9001;
  // Stand-in for the EDC's machine resolve-due authority, op arms only (T-4/edcapi lands the real op; its native suite
  // tests it on a real EDC schema). It answers the exact training-due-authority/1 envelope the shared transport checks.
  const EFFORT_KEY='atk_synthetic_effort_reader';let effortArms:any[]=[];
  const dueServiceAuthority=(input:any,key:string|null)=>{
    if(key!==EFFORT_KEY||input.op!=='arms')return new Response(JSON.stringify({success:false,error:{code:'TRAINING_DUE_SERVICE_DENIED'}}),{status:403,headers:{'content-type':'application/json'}});
    const now=Date.now(),data={scope:input.scope,arms:effortArms,armsObservationHash:`sha256:${trainingDutyHash({scope:input.scope,arms:effortArms})}`};
    return new Response(JSON.stringify({success:true,data:{schemaVersion:'training-due-authority/1',requestId:input.requestId,requestHash:trainingDutyHash(input),installationId:input.installationId,
      scope:input.scope,serviceUserId:99,apiKeyId:7,authorityHash:'d'.repeat(64),op:input.op,complete:true,data,observedAt:new Date(now).toISOString(),
      expiresAt:new Date(now+15000).toISOString(),consistency:'current-observations-not-atomic'}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const token=(userId:number)=>jwt.sign({userId},'synthetic-only-authority');
  const api=(userId=11)=>({get:(path:string)=>request(app).get(`/api/training${path}`).set('Authorization',`Bearer ${token(userId)}`),post:(path:string,body:object)=>request(app).post(`/api/training${path}`).set('Authorization',`Bearer ${token(userId)}`).send(body)});
  const payload=(extra:object={})=>({userId:22,courseId,contentRevision:revision,role:'coordinator',scope:{studyId:100,siteId:101,armId:5},dueAt:'2020-01-01T00:00:00Z',reason:'Protocol procedure for assigned arm responsibility',...extra});
  async function initializeNative(){
    await nativePool.query(`CREATE TABLE user_account(user_id integer PRIMARY KEY,user_name text UNIQUE,first_name text,last_name text,user_type_id integer,status_id integer);
      CREATE TABLE user_account_extended(user_id integer PRIMARY KEY,platform_role text);
      CREATE TABLE acc_organization_member(organization_id integer,user_id integer,status text);
      CREATE TABLE study(study_id integer PRIMARY KEY,parent_study_id integer,status_id integer);
      CREATE TABLE study_user_role(user_name text,study_id integer,role_name text,status_id integer);
      CREATE TABLE group_class_types(group_class_type_id integer PRIMARY KEY,name text);
      CREATE TABLE study_group_class(study_group_class_id integer PRIMARY KEY,study_id integer,group_class_type_id integer,status_id integer);
      CREATE TABLE study_group(study_group_id integer PRIMARY KEY,study_group_class_id integer,name text);
      CREATE FUNCTION reject_obligation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned audit failure'; END; $$`);
    for(const sql of authority.signatureMigration??[])await nativePool.query(sql);
  }
  beforeAll(async()=>{
    const url=new URL(process.env['TRAINING_OBLIGATION_TEST_DATABASE_URL']!);
    if(process.env['TRAINING_OBLIGATION_TEST_OWNED']!=='yes'||url.hostname!=='127.0.0.1'||!/^\/training_obligation_test_[a-z0-9_]+$/.test(url.pathname))throw new Error('An explicitly owned loopback training_obligation_test_* database is required');
    if((await nativePool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' LIMIT 1")).rowCount)throw new Error('Owned test database must be empty');
    await runMigrations();await runMigrations();
    authority=nativeTrainingAuthority(process.env['TRAINING_NATIVE_AUTHORITY_ROOT']!,nativePool);
    console.info('TRAINING_NATIVE_OBLIGATION_SOURCE_HASHES',JSON.stringify(authority.sourceHashes));
  });
  afterAll(async()=>{await pool.end();await nativePool.end();});
  beforeEach(async()=>{
    intercept=undefined;edcSignatures.clear();effortArms=[];
    // This entire database was created empty and validated as owned above.
    // Recreate its disposable schema; never disable the production history guard.
    await nativePool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await runMigrations();await initializeNative();
    await nativePool.query(`
      INSERT INTO user_account VALUES(11,'manager','Site','Manager',1,1),(22,'learner','Site','Learner',2,1),(33,'reviewer','Other','Reviewer',2,1),(44,'outside','Outside','Org',2,1);
      INSERT INTO user_account_extended VALUES(11,'admin'),(22,'coordinator'),(33,'monitor'),(44,'data_manager');
      INSERT INTO acc_organization_member VALUES(10,11,'active'),(10,22,'active'),(10,33,'active'),(20,44,'active');
      INSERT INTO study VALUES(100,NULL,1),(101,100,1),(102,100,1),(200,NULL,1);
      INSERT INTO study_user_role VALUES('manager',101,'study_director',1),('learner',101,'ra',1),('reviewer',101,'site_monitor',1),('outside',101,'study_director',1);
      INSERT INTO group_class_types VALUES(1,'Arm'),(2,'Other');
      INSERT INTO study_group_class VALUES(1,100,1,1),(2,200,1,1),(3,100,2,1);
      INSERT INTO study_group VALUES(5,1,'Arm A'),(6,2,'Foreign arm'),(7,3,'Other group');`);
    courseId=(await nativePool.query(`INSERT INTO acc_training_courses(course_code,course_name,version,passing_score,required_for_roles)
      VALUES('PROCEDURE','Arm procedure','1',80,'["coordinator"]') RETURNING id`)).rows[0].id;
    questionId=(await nativePool.query(`INSERT INTO acc_training_questions(course_id,question_text,question_type,options)
      VALUES($1,'Use current procedure?','true_false','[{"text":"Yes","isCorrect":true},{"text":"No","isCorrect":false}]') RETURNING id`,[courseId])).rows[0].id;
    revision=(await nativePool.query('SELECT content_revision FROM acc_training_courses WHERE id=$1',[courseId])).rows[0].content_revision;
    jest.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
      if(String(url).endsWith('/api/training-authority/resolve-due'))return dueServiceAuthority(JSON.parse(String(options?.body)),new Headers(options?.headers).get('x-api-key'));
      try{
        const claims=jwt.verify(new Headers(options?.headers).get('Authorization')!.slice(7),'synthetic-only-authority') as {userId:number};
        if(String(url).endsWith('/api/training-authority/resolve')){
          const input=JSON.parse(String(options?.body));await intercept?.(input);
          if(input.op==='signature'&&!authority.signatureMigration){const row=edcSignatures.get(input.signatureId);
            if(!row||row.requestKey!==input.requestKey||row.decision!==input.decision||row.subjectHash!==input.subjectHash)return new Response(JSON.stringify({success:false,error:{code:'TRAINING_AUTHORITY_SIGNATURE_NOT_FOUND'}}),{status:404,headers:{'content-type':'application/json'}});
            if(row.signerUserId!==claims.userId)return new Response(JSON.stringify({success:false,error:{code:'TRAINING_AUTHORITY_FORBIDDEN'}}),{status:403,headers:{'content-type':'application/json'}});
            return new Response(JSON.stringify({success:true,data:{schemaVersion:'training-authority/1',op:input.op,action:input.action,actorUserId:claims.userId,observedAt:new Date().toISOString(),
              scopeFingerprint:`sha256:${'5'.repeat(64)}`,consistency:'current-page-observations-not-atomic',complete:true,observationHash:`sha256:${trainingEvidenceHash(row)}`,signature:row}}),{status:200,headers:{'content-type':'application/json'}});}
          const data=await authority.resolve(claims.userId,input);return new Response(JSON.stringify({success:true,data}),{status:200,headers:{'content-type':'application/json'}});
        }
        const native=(await nativePool.query('SELECT * FROM user_account WHERE user_id=$1 AND status_id=1',[claims.userId])).rows[0];
        const role=(await nativePool.query('SELECT platform_role FROM user_account_extended WHERE user_id=$1',[claims.userId])).rows[0]?.platform_role;
        return new Response(JSON.stringify({success:!!native,data:{userId:claims.userId,username:native?.user_name,email:'',role,userType:'user',studyIds:[101],organizationIds:[10]}}),{status:native?200:401});
      }catch(error){const fail=error as {statusCode?:number;code?:string};return new Response(JSON.stringify({success:false,error:{code:fail.code}}),{status:fail.statusCode??401,headers:{'content-type':'application/json'}});}
    });
  });
  afterEach(()=>jest.restoreAllMocks());
  async function assign(){const response=await api().post('/obligations',payload());expect(response.status).toBe(201);return response.body.data;}
  async function complete(){
    const started=await api(22).post(`/start/${courseId}`,{contentRevision:revision});expect(started.status).toBe(200);
    const submitted=await api(22).post(`/submit-quiz/${courseId}`,{recordId:started.body.data.id,cycleId:started.body.data.assessmentCycleId,requestId:randomUUID(),contentRevision:revision,answers:[{questionId,selectedOptions:[0]}]});expect(submitted.body.data.passed).toBe(true);
    return (await nativePool.query('SELECT id FROM acc_training_records WHERE user_id=22')).rows[0].id;
  }
  test('actual routes assign, require independent verification, retain native scope and export documentation without answers',async()=>{
    const obligation=await assign();let current=await api(22).get('/obligations?userId=22');expect(current.body.data[0]).toMatchObject({readiness:'pending',overdue:true});
    const recordId=await complete();current=await api(22).get('/obligations?userId=22');expect(current.body.data[0].readiness).toBe('awaiting_verification');
    expect((await api(22).post(`/verify/${recordId}`,{notes:'Self'})).status).toBe(403);
    expect((await api(33).post(`/verify/${recordId}`,{notes:'Observed completion reviewed'})).status).toBe(200);
    current=await api(22).get('/obligations?userId=22');expect(current.body.data[0]).toMatchObject({id:obligation.id,readiness:'complete',overdue:false,verifiedBy:33,completedLate:true,verifiedLate:true});
    const exported=await api().get('/obligation-history?userId=22');expect(exported.body.data.events).toHaveLength(1);expect(exported.body.data.records[0].certificateNumber).toBeTruthy();expect(JSON.stringify(exported.body)).not.toContain('isCorrect');
  });
  test.each([{scope:{studyId:100,siteId:102,armId:5}},{scope:{studyId:100,siteId:101,armId:6}},{scope:{studyId:100,siteId:101,armId:7}},{scope:{studyId:101}},{role:'investigator'},{contentRevision:999}])('cannot assign wrong role/site/arm/current revision %j',async extra=>{expect((await api().post('/obligations',payload(extra))).status).toBe(409);expect((await nativePool.query('SELECT * FROM acc_training_obligations')).rows).toHaveLength(0);});
  test('organization and management role cannot be widened by UI claims',async()=>{
    expect((await api(44).post('/obligations',payload())).status).toBe(403);
    expect((await api(33).post('/obligations',payload())).status).toBe(403);
    expect((await api(22).get('/obligations?userId=33')).status).toBe(403);
    expect((await api(22).get('/obligations')).status).toBe(200);
    expect((await api(22).get('/obligation-history')).status).toBe(200);
  });
  test('non-admin assignment requires exact site membership even with shared organization',async()=>{
    await nativePool.query("UPDATE user_account SET user_type_id=2 WHERE user_id=11;UPDATE user_account_extended SET platform_role='data_manager' WHERE user_id=11;DELETE FROM study_user_role WHERE user_name='manager'");
    expect((await api().post('/obligations',payload())).status).toBe(403);
  });
  test('two concurrent assignments produce one obligation and event, preserving duplicate intent as conflict',async()=>{
    const responses=await Promise.all([api().post('/obligations',payload()),api().post('/obligations',payload())]);expect(responses.map(row=>row.status).sort()).toEqual([201,409]);
    expect((await nativePool.query('SELECT * FROM acc_training_obligation_events')).rows).toHaveLength(1);
  });
  test('audit failure rolls back assignment and event',async()=>{
    await nativePool.query('CREATE TRIGGER reject_obligation_audit BEFORE INSERT ON acc_training_audit_log FOR EACH ROW EXECUTE FUNCTION reject_obligation_audit()');
    expect((await api().post('/obligations',payload())).status).toBe(500);
    expect((await nativePool.query('SELECT * FROM acc_training_obligations')).rows).toHaveLength(0);expect((await nativePool.query('SELECT * FROM acc_training_obligation_events')).rows).toHaveLength(0);
  });
  test('membership revoked between admission and write prevents assignment',async()=>{
    let calls=0;intercept=async input=>{if(input.op==='obligation'&&++calls===2)await nativePool.query("UPDATE study_user_role SET status_id=5 WHERE user_name='learner'");};
    expect((await api().post('/obligations',payload())).status).toBe(409);expect((await nativePool.query('SELECT * FROM acc_training_obligations')).rows).toHaveLength(0);
  });
  test('changed course requires revised obligation and preserves earlier completion when retraining starts',async()=>{
    const row=await assign();const recordId=await complete();expect((await api(33).post(`/verify/${recordId}`,{notes:'Reviewed'})).status).toBe(200);
    await nativePool.query("UPDATE acc_training_courses SET version='2' WHERE id=$1",[courseId]);revision++;
    expect((await api(22).get('/obligations?userId=22')).body.data[0].readiness).toBe('retraining_required');
    expect((await api().post(`/obligations/${row.id}/revise`,{...payload(),expectedRevision:row.revision,reason:'Amendment retraining'})).status).toBe(200);
    expect((await api(22).post(`/start/${courseId}`,{contentRevision:revision})).status).toBe(200);
    const exported=(await api().get('/obligation-history?userId=22')).body.data;expect(exported.events).toHaveLength(2);expect(exported.events[0].snapshot.courseVersion).toBe('1');expect(exported.history.find((r:any)=>r.eventKind==='restart').record.verifiedBy).toBe(33);expect(JSON.stringify(exported)).not.toContain('isCorrect');
  });
  test('lost scope cannot remain green; closed scope can be administratively withdrawn with retained history',async()=>{
    const row=await assign();await nativePool.query('UPDATE study SET status_id=5 WHERE study_id=101');
    expect((await api(22).get('/obligations?userId=22')).body.data[0].readiness).toBe('scope_changed');
    expect((await api().post(`/obligations/${row.id}/withdraw`,{expectedRevision:1,reason:'Site closed'})).status).toBe(200);
    expect((await api(22).get('/obligations?userId=22')).body.data[0].readiness).toBe('withdrawn');
    await expect(nativePool.query("UPDATE acc_training_obligation_events SET action='rewrite'")).rejects.toThrow('append-only');
    await expect(nativePool.query('DELETE FROM acc_training_obligation_events')).rejects.toThrow('append-only');
  });
  test('shared organization alone cannot authorize withdrawal from another site',async()=>{
    const row=await assign();await nativePool.query("UPDATE user_account_extended SET platform_role='data_manager' WHERE user_id=33;DELETE FROM study_user_role WHERE user_name='reviewer';INSERT INTO study_user_role VALUES('reviewer',102,'study_director',1)");
    expect((await api(33).post(`/obligations/${row.id}/withdraw`,{expectedRevision:1,reason:'Not my site'})).status).toBe(403);
    expect((await nativePool.query('SELECT status,revision FROM acc_training_obligations WHERE id=$1',[row.id])).rows[0]).toEqual({status:'assigned',revision:1});
    await nativePool.query("INSERT INTO study_user_role VALUES('reviewer',101,'study_director',1);UPDATE study SET status_id=5 WHERE study_id=101");
    expect((await api(33).post(`/obligations/${row.id}/withdraw`,{expectedRevision:1,reason:'My site has closed'})).status).toBe(200);
  });
  test('learner documentation excludes their unrelated manager and reviewer actions for other people',async()=>{
    await assign();await complete();
    await nativePool.query(`INSERT INTO acc_training_audit_log(user_id,action,record_id,details) VALUES
      (22,'obligation_assigned',NULL,'{"learnerId":33,"reason":"PRIVATE OTHER LEARNER"}'),
      (22,'course_updated',NULL,'{"changes":"PRIVATE CONTENT EDIT"}'),
      (22,'training_verified',999,'{"notes":"PRIVATE REVIEW NOTE"}')`);
    const exported=await api().get('/obligation-history?userId=22');expect(exported.status).toBe(200);
    expect(exported.body.data.audit.map((entry:any)=>entry.action)).toEqual(['obligation_assigned','training_started','quiz_passed']);
    expect(JSON.stringify(exported.body)).not.toContain('PRIVATE');
  });
  test('revision concurrency and immutable scope reject stale operator edits',async()=>{
    const row=await assign();expect((await api().post(`/obligations/${row.id}/revise`,{...payload(),expectedRevision:1,reason:'New due date'})).status).toBe(200);
    expect((await api().post(`/obligations/${row.id}/withdraw`,{expectedRevision:1,reason:'Stale action'})).status).toBe(409);
    expect((await api().post(`/obligations/${row.id}/revise`,{...payload({scope:{studyId:100,siteId:101}}),expectedRevision:2})).status).toBe(409);
  });
  test('verification refuses altered expiry or stale completion and never overwrites a previous review',async()=>{
    const recordId=await complete();await nativePool.query("UPDATE acc_training_records SET expiration_date='2020-01-01' WHERE id=$1",[recordId]);
    expect((await api(33).post(`/verify/${recordId}`,{notes:'Invalid'})).status).toBe(409);
    await nativePool.query(`UPDATE acc_training_records r SET expiration_date=(h.assessment->'result'->>'expirationDate')::timestamptz
      FROM acc_training_record_history h WHERE r.id=$1 AND h.record_id=r.id AND h.event_kind='quiz_attempt'`,[recordId]);
    expect((await api(33).post(`/verify/${recordId}`,{notes:'Reviewed'})).status).toBe(200);
    expect((await api().post(`/verify/${recordId}`,{notes:'Overwrite'})).status).toBe(409);
    expect((await nativePool.query('SELECT notes FROM acc_training_records WHERE id=$1',[recordId])).rows[0].notes).toBe('Reviewed');
  });
  const dutyPolicy=(row:any)=>({schemaVersion:'training-duty-policy/1',scope:{studyId:100,siteId:101},assignments:[
    {userId:22,role:'coordinator',duties:['participant_enrollment','arm_assignment'],disposition:'not_required',rationale:'Synthetic common activity needs no additional course',obligations:[]},
    {userId:22,role:'coordinator',armId:5,duties:['participant_enrollment','arm_assignment'],disposition:'required',rationale:'Synthetic arm procedure requires assigned curriculum',
      obligations:[{id:row.id,revision:row.revision,courseId:row.courseId,courseVersion:row.courseVersion,contentRevision:row.contentRevision}]}]});
  const dutyRequest=(policy:any,extra:object={})=>({schemaVersion:'training-duty-readiness-request/1',nonce:'d'.repeat(32),policy,actorUserId:22,duty:'arm_assignment',armIds:[5],...extra});
  test.each(['supply_dispensing','data_entry'])('%s duty is explicit, actor-bound and requires exact verified common/arm assignments',async duty=>{
    const row=await assign(),policy=dutyPolicy(row),old=JSON.stringify(policy),req=dutyRequest(policy,{duty});
    expect((await api(22).post('/duty-readiness',req)).body.data.ready).toBe(false);expect(JSON.stringify(policy)).toBe(old);
    policy.assignments[0].duties.push(duty);
    expect((await api(22).post('/duty-readiness',req)).body.data.ready).toBe(false);
    policy.assignments[1].duties.push(duty);
    expect((await api(22).post('/duty-readiness',req)).body.data.ready).toBe(false);
    const recordId=await complete();expect((await api(33).post(`/verify/${recordId}`,{notes:'Synthetic independent clinical duty verification'})).status).toBe(200);
    expect((await api(22).post('/duty-readiness',req)).body.data).toMatchObject({ready:true,duty,actorUserId:22,armIds:[5]});
    expect((await api(11).post('/duty-readiness',{...req,actorUserId:11})).body.data.ready).toBe(false);
    expect((await api(33).post('/duty-readiness',req)).status).toBe(403);
    await nativePool.query('UPDATE acc_training_courses SET content_revision=content_revision+1 WHERE id=$1',[courseId]);
    expect((await api(22).post('/duty-readiness',req)).body.data.ready).toBe(false);
  });
  test('actual duty route requires exact current independently verified course then immediately denies a content revision change',async()=>{
    const row=await assign(),policy=dutyPolicy(row),req=dutyRequest(policy);
    expect((await api(22).post('/duty-readiness',req)).body.data).toMatchObject({ready:false});
    const recordId=await complete();expect((await api(22).post('/duty-readiness',req)).body.data.ready).toBe(false);
    expect((await api(33).post(`/verify/${recordId}`,{notes:'Independent synthetic procedure review'})).status).toBe(200);
    const observed=await api(22).post('/duty-readiness',req);expect(observed.status).toBe(200);expect(observed.headers['cache-control']).toBe('no-store');
    expect(observed.body.data).toMatchObject({ready:true,nonce:req.nonce,policyHash:trainingDutyHash(policy),actorUserId:22,armIds:[5]});
    const {schemaVersion:_schemaVersion,nonce:_nonce,observedAt:_observedAt,consistency:_consistency,evidenceHash,...exportedEvidence}=observed.body.data;expect(trainingDutyHash(exportedEvidence)).toBe(evidenceHash);
    expect(observed.body.data.assignments[1].obligations[0]).toMatchObject({retainedScope:{studyId:100,siteId:101,armId:5},verifiedBy:33,recordId});
    const retained=(await nativePool.query('SELECT * FROM acc_training_record_history ORDER BY history_id')).rows;
    expect(retained.map(r=>r.event_kind)).toEqual(['cycle_started','quiz_attempt']);
    await nativePool.query("UPDATE acc_training_questions SET question_text='Revised procedure' WHERE id=$1",[questionId]);
    const changed=await api(22).post('/duty-readiness',req);expect(changed.body.data.ready).toBe(false);expect(changed.body.data.assignments[1].obligations[0].readiness).toBe('retraining_required');
    expect((await nativePool.query('SELECT * FROM acc_training_record_history ORDER BY history_id')).rows).toEqual(retained);
  });
  test('three-arm declarations preserve modular applicability and an unrelated missing course does not block the selected arm',async()=>{
    await nativePool.query("INSERT INTO study_group VALUES(8,1,'Arm B'),(9,1,'Arm C')");
    const row=await assign(),recordId=await complete();await api(33).post(`/verify/${recordId}`,{notes:'Verified'});const policy=dutyPolicy(row);
    policy.assignments.push({...policy.assignments[1],armId:8,obligations:[{...policy.assignments[1].obligations[0],id:999}]},
      {...policy.assignments[0],armId:9} as any);
    expect((await api(22).post('/duty-readiness',dutyRequest(policy))).body.data.ready).toBe(true);
    const wrong=await api(22).post('/duty-readiness',dutyRequest(policy,{armIds:[8]}));expect(wrong.body.data.ready).toBe(false);
    expect((await api(22).post('/duty-readiness',dutyRequest(policy,{armIds:[9]}))).body.data.ready).toBe(true);
    expect((await api(22).post('/duty-readiness',dutyRequest(policy,{duty:'participant_enrollment',armIds:[]}))).body.data.assignments).toHaveLength(1);
    expect((await api(22).post('/duty-readiness',dutyRequest(policy,{armIds:[999]}))).body.data.ready).toBe(false);
  });
  test('a verified completion expiring during final native callbacks cannot be ready at the response cutoff',async()=>{
    // The test drives the clock: Date.now() is the real clock plus a step taken inside the third final callback, so
    // no wall-clock wait meets the 1 s authority timeout and machine load cannot expire the completion early. The
    // lifetime exceeds any test timeout here, so only that step crosses it. Timers stay real.
    const realNow=Date.now.bind(Date);let step=0;jest.spyOn(Date,'now').mockImplementation(()=>realNow()+step);
    const row=await assign(),expires=Date.now()+600000;
    // A synthetic certificate lifetime is supplied at grading, so both the
    // immutable receipt and record retain it. Do not rewrite either afterward.
    jest.spyOn(certificateService,'calculateExpirationDate').mockReturnValueOnce(new Date(expires));
    const recordId=await complete();expect((await api(33).post(`/verify/${recordId}`,{notes:'Independent synthetic review'})).status).toBe(200);
    let scopes=0,crossed=false;intercept=async input=>{if(input.action==='duties:read'&&++scopes===3){expect(Date.now()).toBeLessThan(expires);step=expires-realNow()+40;crossed=true;}};
    const observed=await api(22).post('/duty-readiness',dutyRequest(dutyPolicy(row)));intercept=undefined;
    expect(observed.status).toBe(200);expect(crossed).toBe(true);expect(Date.parse(observed.body.data.observedAt)).toBeGreaterThanOrEqual(expires);
    expect(observed.body.data.ready).toBe(false);expect(observed.body.data.assignments[1].obligations[0].readiness).toBe('retraining_required');
    expect(observed.body.data.blockers).toContain(`Learner 22, obligation ${row.id}: retraining_required.`);
  });
  test('retained parent obligation loses readiness after parent role revocation even while child role remains current',async()=>{
    await nativePool.query("INSERT INTO study_user_role VALUES('learner',100,'ra',1)");
    const assigned=await api().post('/obligations',payload({scope:{studyId:100}}));expect(assigned.status).toBe(201);
    const recordId=await complete();await api(33).post(`/verify/${recordId}`,{notes:'Verified'});const policy=dutyPolicy(assigned.body.data);
    expect((await api(22).post('/duty-readiness',dutyRequest(policy))).body.data.ready).toBe(true);
    await nativePool.query("UPDATE study_user_role SET status_id=5 WHERE user_name='learner' AND study_id=100");
    const result=await api(22).post('/duty-readiness',dutyRequest(policy));expect(result.status).toBe(200);expect(result.body.data.ready).toBe(false);expect(result.body.data.assignments[1].obligations[0].readiness).toBe('scope_changed');
  });
  test('own census cannot escalate to other staff, cross-site manager scope or a claimed actor',async()=>{
    const policy=dutyPolicy(await assign());
    expect((await api(33).post('/duty-readiness',dutyRequest(policy))).status).toBe(403);
    const census={schemaVersion:'training-duty-readiness-request/1',nonce:'a'.repeat(32),policy};
    expect((await api(33).post('/duty-readiness',census)).status).toBe(403);
    await nativePool.query("UPDATE user_account_extended SET platform_role='data_manager' WHERE user_id=33;DELETE FROM study_user_role WHERE user_name='reviewer';INSERT INTO study_user_role VALUES('reviewer',102,'study_director',1)");
    expect((await api(33).post('/duty-readiness',census)).status).toBe(403);
    policy.assignments[0].userId=33;expect((await api(22).post('/duty-readiness',{...census,policy})).status).toBe(403);
  });
  test('pending or suspended scope permits preparation, but removed scope and revoked role never qualify',async()=>{
    await nativePool.query('UPDATE study SET status_id=4 WHERE study_id=101');const row=await assign();
    await nativePool.query('UPDATE study SET status_id=2 WHERE study_id=100');const p=dutyPolicy(row);
    const request=dutyRequest(p,{duty:'participant_enrollment',armIds:[]});expect((await api(22).post('/duty-readiness',request)).body.data.ready).toBe(true);
    await nativePool.query("UPDATE study_user_role SET status_id=5 WHERE user_name='learner'");expect((await api(22).post('/duty-readiness',request)).body.data.ready).toBe(false);
    await nativePool.query('UPDATE study SET status_id=5 WHERE study_id=101');expect((await api(22).post('/duty-readiness',request)).status).toBe(409);
  });
  test('mid-observation authority change, withdrawn obligation, wrong exact pin and malformed empty policy cannot produce readiness',async()=>{
    const row=await assign(),recordId=await complete();await api(33).post(`/verify/${recordId}`,{notes:'Verified'});const p=dutyPolicy(row),req=dutyRequest(p);
    let scopes=0;intercept=async input=>{if(input.action==='duties:read'&&++scopes===3)await nativePool.query("UPDATE study_user_role SET status_id=5 WHERE user_name='learner'");};
    expect((await api(22).post('/duty-readiness',req)).status).toBe(409);intercept=undefined;await nativePool.query("UPDATE study_user_role SET status_id=1 WHERE user_name='learner'");
    p.assignments[1].obligations[0].revision++;expect((await api(22).post('/duty-readiness',req)).body.data.ready).toBe(false);p.assignments[1].obligations[0].revision--;
    expect((await api().post(`/obligations/${row.id}/withdraw`,{expectedRevision:1,reason:'Duty removed'})).status).toBe(200);expect((await api(22).post('/duty-readiness',req)).body.data.ready).toBe(false);
    expect((await api(22).post('/duty-readiness',{...req,policy:{...p,assignments:[]}})).status).toBe(400);
  });

  // Part 11 signatures on training decisions (T-3). The EDC side (its signature rows and authority op `signature`)
  // is the stand-in above until the EDC head carries training-signature-migration.ts; then the compiled EDC
  // authority answers from its own table and every case below runs against it.
  const contracts=new Ajv2020({allErrors:true,strict:true});
  for(const name of ['training-signature-subject-v1.schema.json','training-duty-readiness-v2.schema.json','training-effort-source-v1.schema.json','training-effort-observation-request-v1.schema.json'])contracts.addSchema(JSON.parse(fs.readFileSync(path.join(__dirname,'../../contracts',name),'utf8')));
  const conforms=(id:string,value:unknown)=>{const validate=contracts.getSchema(`https://schemas.accuratrials.com/training/${id}`)!;return validate(value)?'valid':JSON.stringify(validate.errors);};
  const site={studyId:100,siteId:101},names:Record<number,string>={11:'manager',22:'learner',33:'reviewer',44:'outside'};
  const subjectQuery=(kind:string,recordId:number)=>`kind=${kind}&recordId=${recordId}&studyId=100&siteId=101`;
  /** The EDC proxy's part: read the subject with the signer's own bearer, check its hash, keep the password re-entry
   * signature row, and forward the receipt. Synthetic users and meanings only. */
  async function edcSign(signer:number,query:string,decision:string,requestKey:string=randomUUID()){
    const read=await api(signer).get(`/signature-subject?${query}`);expect(read.status).toBe(200);
    expect(trainingEvidenceHash(read.body.data.subject)).toBe(read.body.data.subjectHash);expect(conforms('training-signature-subject/1',read.body.data.subject)).toBe('valid');
    const row:any={signatureId:nextSignatureId++,requestKey,decision,studyId:site.siteId,subject:read.body.data.subject,subjectHash:read.body.data.subjectHash,
      meaning:`SYNTHETIC ENGINEERING STUDY. NOT A REAL TRIAL. ${decision}`,signerUserId:signer,signerUsername:names[signer],signerFullName:`Synthetic ${names[signer]}`,
      signedAt:new Date().toISOString(),effortRequestId:randomUUID()};
    if(authority.signatureMigration){
      const inserted=await nativePool.query(`INSERT INTO acc_esignature_training_decision(request_key,decision,study_id,subject,subject_hash,meaning,signer_user_id,
        signer_username,signer_full_name,signed_at,effort_request_id) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11) RETURNING signature_id`,
        [row.requestKey,decision,row.studyId,JSON.stringify(row.subject),row.subjectHash,row.meaning,signer,row.signerUsername,row.signerFullName,row.signedAt,row.effortRequestId]);
      row.signatureId=Number(inserted.rows[0].signature_id);
    }else edcSignatures.set(row.signatureId,row);
    return {schemaVersion:'training-signature-receipt/1',signatureId:row.signatureId,requestKey:row.requestKey,decision,meaning:row.meaning,signerUserId:signer,signerUsername:row.signerUsername,
      signerFullName:row.signerFullName,signedAt:row.signedAt,context:site,subjectHash:row.subjectHash,edcEffort:{requestId:row.effortRequestId,workStartedAt:null,startBasis:'not-supplied'}};
  }
  const bindings=async()=>(await nativePool.query('SELECT * FROM acc_training_decision_signatures ORDER BY id')).rows;
  test('the learner attests once through the real route; the binding is append-only and the same receipt replays',async()=>{
    await assign();const recordId=await complete(),query=subjectQuery('completion-attestation',recordId);
    expect((await api(22).get(`/signature-subject?${query}`)).body.data.binding).toEqual({status:'unbound'});
    const receipt=await edcSign(22,query,'completion-attestation');
    const attested=await api(22).post(`/attest/${recordId}`,{signatureReceipt:receipt});expect(attested.status).toBe(200);
    expect(attested.body.data).toMatchObject({attested:true,replayed:false,signature:{signatureId:receipt.signatureId,subjectHash:receipt.subjectHash}});
    expect((await api(22).post(`/attest/${recordId}`,{signatureReceipt:receipt})).body.data).toMatchObject({attested:true,replayed:true});
    const rows=await bindings();expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({decision:'completion-attestation',signer_user_id:22,record_id:recordId,edc_signature_id:String(receipt.signatureId),subject_hash:receipt.subjectHash,draft_id:null});
    expect((await nativePool.query("SELECT details FROM acc_training_audit_log WHERE action='training_completion_attested' AND record_id=$1",[recordId])).rows.map(r=>r.details.signatureId)).toEqual([receipt.signatureId]);
    expect((await api(22).get(`/signature-subject?${query}`)).body.data.binding).toMatchObject({status:'bound',signatureId:receipt.signatureId,requestKey:receipt.requestKey,signerUserId:22});
    // A second signature for the attested completion, or another person's attestation, binds nothing.
    expect((await api(22).post(`/attest/${recordId}`,{signatureReceipt:await edcSign(22,query,'completion-attestation')})).status).toBe(409);
    expect((await api(33).post(`/attest/${recordId}`,{signatureReceipt:{...receipt,signerUserId:33}})).status).toBe(404);
    expect(await bindings()).toEqual(rows);
    for(const sql of ["UPDATE acc_training_decision_signatures SET subject_hash=repeat('0',64)",'DELETE FROM acc_training_decision_signatures','TRUNCATE acc_training_decision_signatures'])
      await expect(nativePool.query(sql)).rejects.toThrow('Training history is append-only');
  });
  test('a signed verification binds the verifier\'s signature in its transaction; a learner never verifies their own completion',async()=>{
    await assign();const recordId=await complete(),query=subjectQuery('verification',recordId);
    const receipt=await edcSign(33,query,'verification');
    const verified=await api(33).post(`/verify/${recordId}`,{notes:'Synthetic signed verification',signatureReceipt:receipt});expect(verified.status).toBe(200);
    expect(verified.body.data).toMatchObject({verified:true,replayed:false,signature:{signatureId:receipt.signatureId,subjectHash:receipt.subjectHash}});
    expect((await api(33).post(`/verify/${recordId}`,{notes:'Synthetic signed verification',signatureReceipt:receipt})).body.data).toMatchObject({verified:true,replayed:true});
    const audit=(await nativePool.query("SELECT action,details FROM acc_training_audit_log WHERE record_id=$1 AND action IN ('training_verified','training_signature_bound') ORDER BY id",[recordId])).rows;
    expect(audit.map(r=>r.action)).toEqual(['training_verified','training_signature_bound']);
    expect(audit[0].details).toMatchObject({notes:'Synthetic signed verification',courseId,courseVersion:'1',contentRevision:revision,assessmentCycleId:expect.stringMatching(/^[a-f0-9-]{36}$/)});
    expect((await bindings()).map(row=>[row.decision,row.signer_user_id])).toEqual([['verification',33]]);
    // Even holding a verifier role, the learner is refused before any signature is read or bound.
    await nativePool.query("UPDATE user_account_extended SET platform_role='monitor' WHERE user_id=22");
    expect((await api(22).get(`/signature-subject?${query}`)).status).toBe(403);
    expect((await api(22).post(`/verify/${recordId}`,{notes:'Self',signatureReceipt:{...receipt,signerUserId:22}})).status).toBe(403);
    expect(await bindings()).toHaveLength(1);
  });
  test('the recorded verifier signs an unsigned verification afterwards; nobody else can, and the verification is never rewritten',async()=>{
    await assign();const recordId=await complete();
    expect((await api(33).post(`/verify/${recordId}`,{notes:'Unsigned synthetic verification'})).status).toBe(200);
    const before=(await nativePool.query('SELECT verified_by,verified_at,notes,updated_at FROM acc_training_records WHERE id=$1',[recordId])).rows[0];
    expect((await api(11).get(`/signature-subject?${subjectQuery('verification',recordId)}`)).status).toBe(409);
    const receipt=await edcSign(33,subjectQuery('verification',recordId),'verification');
    expect((await api(11).post(`/verify/${recordId}/signature`,{signatureReceipt:{...receipt,signerUserId:11}})).status).toBe(409);
    const signed=await api(33).post(`/verify/${recordId}/signature`,{signatureReceipt:receipt});expect(signed.status).toBe(200);
    expect(signed.body.data).toMatchObject({signed:true,replayed:false,signature:{signatureId:receipt.signatureId}});
    expect((await nativePool.query('SELECT verified_by,verified_at,notes,updated_at FROM acc_training_records WHERE id=$1',[recordId])).rows[0]).toEqual(before);
    expect((await bindings()).map(row=>row.decision)).toEqual(['verification']);
  });
  test('readiness /2 over real rows is signature_required until both signatures are bound, conforms to its schema, and /1 is unchanged',async()=>{
    const row=await assign(),recordId=await complete();expect((await api(33).post(`/verify/${recordId}`,{notes:'Unsigned synthetic verification'})).status).toBe(200);
    const policy2={...dutyPolicy(row),schemaVersion:'training-duty-policy/2',signatures:'part11-required'},request2=dutyRequest(policy2,{schemaVersion:'training-duty-readiness-request/2'});
    const v1=(await api(22).post('/duty-readiness',dutyRequest(dutyPolicy(row)))).body.data;
    expect(v1).toMatchObject({schemaVersion:'training-duty-readiness/1',ready:true});expect('signatures' in v1.assignments[1].obligations[0]).toBe(false);
    let observed=(await api(22).post('/duty-readiness',request2)).body.data;
    expect(observed).toMatchObject({schemaVersion:'training-duty-readiness/2',ready:false,blockers:[`Learner 22, obligation ${row.id}: signature_required.`]});
    expect(conforms('training-duty-readiness/2',observed)).toBe('valid');
    expect((await api(22).post(`/attest/${recordId}`,{signatureReceipt:await edcSign(22,subjectQuery('completion-attestation',recordId),'completion-attestation')})).status).toBe(200);
    expect((await api(22).post('/duty-readiness',request2)).body.data.ready).toBe(false);
    expect((await api(33).post(`/verify/${recordId}/signature`,{signatureReceipt:await edcSign(33,subjectQuery('verification',recordId),'verification')})).status).toBe(200);
    observed=(await api(22).post('/duty-readiness',request2)).body.data;
    expect(observed).toMatchObject({ready:true,blockers:[]});expect(conforms('training-duty-readiness/2',observed)).toBe('valid');
    const cited=observed.assignments[1].obligations[0].signatures;
    expect(cited.attestation.subject).toMatchObject({kind:'completion-attestation',recordId,learnerUserId:22,context:site});
    expect(cited.verification.subject.kind).toBe('verification');expect(cited.materialApproval).toBeNull();
    const {schemaVersion:_v,nonce:_n,observedAt:_o,consistency:_c,evidenceHash,...evidence}=observed;expect(trainingDutyHash(evidence)).toBe(evidenceHash);
    // A /1 request never carries a /2 policy.
    expect((await api(22).post('/duty-readiness',dutyRequest(policy2))).status).toBe(400);
  });
  test('material approval binds by draft on the real table; the row shape refuses reserved and incomplete decisions',async()=>{
    const draftId=randomUUID(),requestHash='b'.repeat(64);
    await nativePool.query(`INSERT INTO acc_training_material_drafts(id,course_id,created_by,idempotency_key,request,request_hash,author_authority_hash,status)
      VALUES($1,$2,11,$3,'{}'::jsonb,$4,$5,'reviewed')`,[draftId,courseId,randomUUID(),requestHash,`sha256:${'8'.repeat(64)}`]);
    const subject=materialApprovalSubject({draftId,draftRevision:1,requestHash,courseId,authorUserId:11,sourceHash:'c'.repeat(64),context:site}),subjectHash=trainingEvidenceHash(subject);
    const signed=(signatureId:number):any=>({schemaVersion:'training-signature-receipt/1',signatureId,requestKey:randomUUID(),decision:'material-approval',meaning:'SYNTHETIC approval',
      signerUserId:33,signerUsername:'reviewer',signerFullName:'Synthetic reviewer',signedAt:new Date().toISOString(),context:site,subjectHash,edcEffort:null});
    const confirm=(r:any)=>({signatureId:r.signatureId,requestKey:r.requestKey,decision:r.decision,studyId:101,subjectHash,meaning:r.meaning,signerUserId:33,signerUsername:r.signerUsername,
      signerFullName:r.signerFullName,signedAt:r.signedAt,effortRequestId:null,observationHash:`sha256:${'e'.repeat(64)}`});
    const expected={decision:'material-approval' as const,subject,subjectHash,signerUserId:33,draftId},first=signed(7001);
    expect(await transaction(client=>bindSignatureReceipt(client,first,confirm(first),expected))).toMatchObject({replayed:false,binding:{signatureId:7001,draftId,recordId:null}});
    expect(await transaction(client=>bindSignatureReceipt(client,first,confirm(first),expected))).toMatchObject({replayed:true});
    const second=signed(7002);
    await expect(transaction(client=>bindSignatureReceipt(client,second,confirm(second),expected))).rejects.toMatchObject({statusCode:409});
    const insert=(signatureId:number,decision:string,draft:string|null)=>nativePool.query(`INSERT INTO acc_training_decision_signatures(edc_signature_id,decision,request_key,signer_user_id,
      signed_at,context,subject,subject_hash,receipt,edc_observation_hash,record_id,assessment_cycle_id,draft_id) VALUES($1,$2,$3,33,NOW(),'{}'::jsonb,'{}'::jsonb,$4,'{}'::jsonb,'synthetic',NULL,NULL,$5)`,
      [signatureId,decision,randomUUID(),'f'.repeat(64),draft]);
    await expect(insert(7003,'matrix-approval',null)).rejects.toThrow('acc_training_signature_shape');
    await expect(insert(7004,'completion-attestation',draftId)).rejects.toThrow('acc_training_signature_shape');
    expect((await bindings()).map(row=>[row.decision,row.edc_signature_id])).toEqual([['material-approval','7001']]);
  });
  test('the compiled EDC authority confirms signatures from its own table',async()=>{
    if(!authority.signatureMigration){
      console.info('SKIPPED compiled EDC op signature: the EDC checkout at TRAINING_NATIVE_AUTHORITY_ROOT has no src/services/database/training-signature-migration.ts yet (T-3/edcapi lands it and runs this case)');
      return;
    }
    await assign();const recordId=await complete(),receipt=await edcSign(22,subjectQuery('completion-attestation',recordId),'completion-attestation');
    expect((await api(22).post(`/attest/${recordId}`,{signatureReceipt:receipt})).status).toBe(200);
    expect((await bindings()).map(row=>[row.decision,Number(row.edc_signature_id)])).toEqual([['completion-attestation',receipt.signatureId]]);
  });

  // Training effort (T-4): intervals in each decision's own transaction and the TrainingEffortSourceV1@1.0.0
  // observation over the real rows. The switch is set per case and removed after it.
  const efforts=async()=>(await nativePool.query('SELECT * FROM acc_training_effort_intervals ORDER BY id')).rows;
  const withEffort=async(fn:()=>Promise<void>)=>{process.env.TRAINING_EFFORT_LEDGER_ENABLED='true';try{await fn();}finally{delete process.env.TRAINING_EFFORT_LEDGER_ENABLED;}};
  const start=async()=>{const started=await api(22).post(`/start/${courseId}`,{contentRevision:revision});expect(started.status).toBe(200);return started.body.data as {id:number;assessmentCycleId:string};};
  const quiz=(started:{id:number;assessmentCycleId:string},selected:number,requestId:string,stated?:string)=>{
    const call=request(app).post(`/api/training/submit-quiz/${courseId}`).set('Authorization',`Bearer ${token(22)}`);
    return (stated?call.set('X-Work-Started-At',stated):call).send({recordId:started.id,cycleId:started.assessmentCycleId,requestId,contentRevision:revision,answers:[{questionId,selectedOptions:[selected]}]});
  };
  test('each graded attempt, attestation and verification writes one interval in its transaction; replays add none; the rows are append-only',()=>withEffort(async()=>{
    const obligation=await assign(),started=await start();
    expect((await quiz(started,1,randomUUID())).body.data.passed).toBe(false);
    const stated=new Date(Date.now()-20*60000).toISOString(),passKey=randomUUID();
    expect((await quiz(started,0,passKey,stated)).body.data).toMatchObject({passed:true,replayed:false});
    expect((await quiz(started,0,passKey,stated)).body.data).toMatchObject({passed:true,replayed:true});
    const signed=await edcSign(22,subjectQuery('completion-attestation',started.id),'completion-attestation');
    const attestation={...signed,edcEffort:{...signed.edcEffort,workStartedAt:new Date(Date.parse(signed.signedAt)-15*60000).toISOString(),startBasis:'client-work-start'}};
    expect((await api(22).post(`/attest/${started.id}`,{signatureReceipt:attestation})).body.data).toMatchObject({attested:true,replayed:false});
    expect((await api(22).post(`/attest/${started.id}`,{signatureReceipt:attestation})).body.data).toMatchObject({attested:true,replayed:true});
    const verification=await edcSign(33,subjectQuery('verification',started.id),'verification');
    expect((await api(33).post(`/verify/${started.id}`,{notes:'Synthetic signed verification',signatureReceipt:verification})).body.data).toMatchObject({verified:true,replayed:false});
    expect((await api(33).post(`/verify/${started.id}`,{notes:'Synthetic signed verification',signatureReceipt:verification})).body.data).toMatchObject({replayed:true});
    const rows=await efforts();
    expect(rows.map(r=>[r.kind,r.actor_user_id,r.actor_role,r.learner_user_id,r.record_id,r.assessment_cycle_id,r.start_basis])).toEqual([
      ['learning',22,null,22,started.id,started.assessmentCycleId,'server-cycle-start'],['learning',22,null,22,started.id,started.assessmentCycleId,'client-work-start'],
      ['attestation',22,null,22,started.id,started.assessmentCycleId,'edc-signed-effort'],['verification',33,'monitor',22,started.id,started.assessmentCycleId,'not-supplied']]);
    const retained=(await nativePool.query("SELECT assessment FROM acc_training_record_history WHERE event_kind='quiz_attempt' ORDER BY history_id")).rows.map(r=>r.assessment);
    // Learning: the first attempt starts at the cycle start, the second at its stated start; each ends at its grading.
    expect(rows[0].work_started_at.getTime()).toBeLessThanOrEqual(rows[0].ended_at.getTime());
    expect([rows[0].ended_at.toISOString(),rows[1].work_started_at.toISOString(),rows[1].ended_at.toISOString(),rows[1].request_key]).toEqual([retained[0].assessedAt,stated,retained[1].assessedAt,passKey]);
    // Signed decisions end at the EDC signature, keep its request key and copy, never mint, its EDC effort request.
    expect([rows[2].work_started_at.toISOString(),rows[2].ended_at.toISOString(),rows[2].request_key,rows[2].edc_effort_request_id]).toEqual(
      [attestation.edcEffort.workStartedAt,attestation.signedAt,attestation.requestKey,attestation.edcEffort.requestId]);
    expect([rows[3].work_started_at,rows[3].ended_at.toISOString(),rows[3].request_key,rows[3].edc_effort_request_id]).toEqual([null,verification.signedAt,verification.requestKey,verification.edcEffort.requestId]);
    for(const row of rows)expect(row.served).toEqual([{obligationId:obligation.id,revision:1,role:'coordinator',scope:{studyId:100,siteId:101,armId:5}}]);
    // A second interval naming the same EDC effort request adds nothing.
    await nativePool.query(`INSERT INTO acc_training_effort_intervals(request_key,kind,actor_user_id,learner_user_id,record_id,course_id,served,ended_at,start_basis,edc_effort_request_id)
      VALUES($1,'attestation',22,22,$2,$3,'[]'::jsonb,NOW(),'not-supplied',$4) ON CONFLICT DO NOTHING`,[randomUUID(),started.id,courseId,attestation.edcEffort.requestId]);
    expect(await efforts()).toHaveLength(4);
    for(const sql of ["UPDATE acc_training_effort_intervals SET ended_at=NOW()",'DELETE FROM acc_training_effort_intervals','TRUNCATE acc_training_effort_intervals','TRUNCATE acc_training_records CASCADE'])
      await expect(nativePool.query(sql)).rejects.toThrow('Training history is append-only');
    // Replica mode is covered for this table with every other history table by the owned audit suite.
    expect(await efforts()).toHaveLength(4);
  }));
  test('a decision rolled back after its interval was written leaves none, and with the switch off no decision writes one',async()=>{
    await assign();const started=await start();
    await withEffort(async()=>{
      // The attempt's final access check fails after the interval insert: the whole attempt, interval included, rolls back.
      let targets=0;intercept=async input=>{if(input.op==='targets'&&input.action==='records:read'&&++targets===2)throw Object.assign(new Error('Synthetic final authority outage'),{statusCode:503});};
      expect((await quiz(started,1,randomUUID())).status).toBe(503);intercept=undefined;
      expect(await efforts()).toEqual([]);
      expect((await nativePool.query("SELECT count(*)::int AS n FROM acc_training_record_history WHERE event_kind='quiz_attempt'")).rows[0].n).toBe(0);
      expect((await quiz(started,1,randomUUID())).status).toBe(200);expect(await efforts()).toHaveLength(1);
    });
    expect((await quiz(started,0,randomUUID())).body.data.passed).toBe(true);
    expect((await api(33).post(`/verify/${started.id}`,{notes:'Unsigned synthetic verification'})).status).toBe(200);
    expect(await efforts()).toHaveLength(1);
  });
  test('a client key reused in a new cycle, or by another person or kind, records its own interval (R11)',()=>withEffort(async()=>{
    const row=await assign(),key=randomUUID();
    const pass=async()=>{const started=await start();expect((await quiz(started,0,key)).body.data.passed).toBe(true);return started;};
    const first=await pass();
    expect((await api(33).post(`/verify/${first.id}`,{notes:'Unsigned synthetic verification'})).status).toBe(200);
    // A course change requires retraining: a new assessment cycle of the same record, submitted with the same client key.
    await nativePool.query("UPDATE acc_training_courses SET version='2' WHERE id=$1",[courseId]);revision++;
    expect((await api().post(`/obligations/${row.id}/revise`,{...payload(),expectedRevision:row.revision,reason:'Amendment retraining'})).status).toBe(200);
    const second=await pass();expect([second.id,second.assessmentCycleId===first.assessmentCycleId]).toEqual([first.id,false]);
    // The learner's attestation and the verifier's signature use the same key as their EDC request keys.
    expect((await api(22).post(`/attest/${second.id}`,{signatureReceipt:await edcSign(22,subjectQuery('completion-attestation',second.id),'completion-attestation',key)})).status).toBe(200);
    expect((await api(33).post(`/verify/${second.id}`,{notes:'Signed synthetic verification',signatureReceipt:await edcSign(33,subjectQuery('verification',second.id),'verification',key)})).status).toBe(200);
    expect((await efforts()).map(r=>[r.kind,r.actor_user_id,r.assessment_cycle_id,r.request_key===key])).toEqual([
      ['learning',22,first.assessmentCycleId,true],['verification',33,first.assessmentCycleId,false],['learning',22,second.assessmentCycleId,true],
      ['attestation',22,second.assessmentCycleId,true],['verification',33,second.assessmentCycleId,true]]);
  }));
  test('the effort observation over real rows: regimen arm hours and measured lead time, a treatment-assignment arm withheld, valid against its schema',()=>withEffort(async()=>{
    process.env.TRAINING_DATA_CLASS='synthetic';
    try{
      await nativePool.query("INSERT INTO study_group VALUES(8,1,'Arm T')");
      await assign();expect((await api().post('/obligations',payload({scope:{studyId:100,siteId:101,armId:8}}))).status).toBe(201);
      const onboardedAt=new Date(Date.now()-3600000).toISOString();
      effortArms=[{armId:5,classId:1,disclosureLevel:'regimen',groupStatus:null,lifecycleState:'pending',onboardedAt,onboardEventId:41},
        {armId:8,classId:1,disclosureLevel:'treatment-assignment',groupStatus:null,lifecycleState:null,onboardedAt:null,onboardEventId:null}];
      const started=await start();
      expect((await quiz(started,0,randomUUID(),new Date(Date.now()-30*60000).toISOString())).body.data.passed).toBe(true);
      expect((await request(app).post(`/api/training/verify/${started.id}`).set('Authorization',`Bearer ${token(33)}`).set('X-Work-Started-At',new Date(Date.now()-5*60000).toISOString())
        .send({notes:'Synthetic independent verification'})).status).toBe(200);
      const requestBody={schemaVersion:'training-effort-observation-request/1',requestId:randomUUID(),installationId:'synthetic-installation',scope:{studyId:100}};
      expect(conforms('training-effort-observation-request/1',requestBody)).toBe('valid');
      const observed=await request(app).post('/api/training/effort-source/observe').set('x-api-key',EFFORT_KEY).send(requestBody);
      expect([observed.status,observed.headers['cache-control']]).toEqual([200,'no-store']);
      const receipt=observed.body.data,doc=receipt.data;
      expect(receipt).toMatchObject({schemaVersion:'TrainingEffortServiceObservationV1@1.0.0',requestId:requestBody.requestId,requestHash:trainingDutyHash(requestBody),scope:{studyId:100},
        authority:{apiKeyId:7,serviceUserId:99,authorityHash:'d'.repeat(64)},consistency:'current-observations-not-atomic',externalDeliveryConfirmed:false});
      expect(conforms('TrainingEffortSourceV1@1.0.0',doc)).toBe('valid');
      const rows=await efforts(),verifiedAt:Date=(await nativePool.query('SELECT verified_at FROM acc_training_records WHERE id=$1',[started.id])).rows[0].verified_at;
      const hours=(row:any)=>Math.round((row.ended_at.getTime()-row.work_started_at.getTime())/3600000*1000)/1000;
      const hoursRow=(level:string,armId:number|null,kind:string,role:string,row:any)=>({level,armId,role,roleBasis:kind==='verification'?'actor-platform-role':'obligation-role',kind,
        hours:hours(row),intervals:1,unknownIntervals:0,actors:1,disclosure:level==='platform'?'platform':'regimen-or-cohort'});
      expect(rows.map(r=>[r.kind,r.start_basis,r.served.map((s:any)=>s.scope.armId)])).toEqual([['learning','client-work-start',[5,8]],['verification','client-work-start',[5,8]]]);
      // The interval served both arms: arm 5 (regimen) gets its rows, arm 8 (treatment-assignment) none.
      expect(doc.hours).toEqual([hoursRow('platform',null,'learning','coordinator',rows[0]),hoursRow('platform',null,'verification','monitor',rows[1]),
        hoursRow('arm',5,'learning','coordinator',rows[0]),hoursRow('arm',5,'verification','monitor',rows[1])]);
      expect(doc.arms).toEqual([
        {armId:5,disclosureLevel:'regimen',onboardedAt,onboardEventId:41,leadTime:{status:'measured',days:Math.round((verifiedAt.getTime()-Date.parse(onboardedAt))/86400000*1000)/1000,
          startedAt:onboardedAt,trainedAt:verifiedAt.toISOString(),obligations:{assigned:1,complete:1},learners:1,sites:1,trainedBeforeOnboarding:false,reason:null}},
        {armId:8,disclosureLevel:'treatment-assignment',onboardedAt:null,onboardEventId:null,leadTime:{status:'withheld',days:null,startedAt:null,trainedAt:null,obligations:null,
          learners:null,sites:null,trainedBeforeOnboarding:null,reason:'per-arm values are given only for arms whose class is declared regimen or cohort'}}]);
      expect([doc.dataClass,doc.counts,doc.limitations[0].startsWith('SYNTHETIC ENGINEERING STUDY. NOT A REAL TRIAL.')]).toEqual(['synthetic',{intervals:2,throughIntervalId:Number(rows[1].id)},true]);
      const {asOf:_asOf,sourceHash,...body}=doc;expect(sourceHash).toBe(trainingDutyHash(body));
      expect(JSON.stringify(doc)).not.toMatch(/"(userId|learnerUserId|actorUserId|obligationId|recordId)"/);
      // Opt-in: keep these exact response bytes, synthetic, for the Command Center register lane (T-4/cc).
      const out=process.env['TRAINING_EFFORT_SOURCE_FIXTURE_OUT'];
      if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'training-effort-source-v1.synthetic.json'),observed.text);
        fs.writeFileSync(path.join(out,'training-effort-source-v1.synthetic.provenance.json'),`${JSON.stringify({note:'SYNTHETIC ENGINEERING STUDY. NOT A REAL TRIAL.',
          producer:'accura-training-module',producerHead:process.env['TRAINING_EFFORT_SOURCE_FIXTURE_HEAD']??null,route:'POST /api/training/effort-source/observe',
          test:'tests/integration/training-obligations.postgres.test.ts',case:expect.getState().currentTestName,generatedAt:new Date().toISOString(),
          bytes:Buffer.byteLength(observed.text),sha256:createHash('sha256').update(observed.text).digest('hex'),
          contract:'TrainingEffortServiceObservationV1@1.0.0 with data TrainingEffortSourceV1@1.0.0',edcCensus:'synthetic stand-in for resolve-due op arms'},null,2)}\n`);}
    }finally{delete process.env.TRAINING_DATA_CLASS;}
  }));
});
