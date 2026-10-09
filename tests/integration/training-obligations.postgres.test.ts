import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {Pool} from 'pg';
import trainingRoutes from '../../src/routes/training.routes';
import {errorHandler} from '../../src/middleware/errorHandler.middleware';
import {pool} from '../../src/config/database';
import {runMigrations} from '../../src/config/migrations';
import {nativeTrainingAuthority} from '../fixtures/native-training-authority';

jest.mock('../../src/config/environment',()=>({config:{database:{url:process.env['TRAINING_OBLIGATION_TEST_DATABASE_URL']??'postgresql://127.0.0.1:1/disabled',ssl:false},authority:{baseUrl:'https://authority.invalid',timeoutMs:1000},training:{certificateValidityDays:365}}}));
jest.mock('../../src/config/logger',()=>({logger:{info:jest.fn(),error:jest.fn(),warn:jest.fn(),debug:jest.fn()}}));
const owned=process.env['TRAINING_OBLIGATION_TEST_DATABASE_URL']&&process.env['TRAINING_NATIVE_AUTHORITY_ROOT']?describe:describe.skip;
owned('native obligation scope, durable assignment and completion evidence',()=>{
  const nativePool=new Pool({connectionString:process.env['TRAINING_OBLIGATION_TEST_DATABASE_URL']??'postgresql://127.0.0.1:1/disabled'});
  const app=express();app.use(express.json());app.use('/api/training',trainingRoutes);app.use(errorHandler);
  let authority:ReturnType<typeof nativeTrainingAuthority>,courseId:number,revision:number,questionId:number;
  let intercept:((input:any)=>Promise<void>)|undefined;
  const token=(userId:number)=>jwt.sign({userId},'synthetic-only-authority');
  const api=(userId=11)=>({get:(path:string)=>request(app).get(`/api/training${path}`).set('Authorization',`Bearer ${token(userId)}`),post:(path:string,body:object)=>request(app).post(`/api/training${path}`).set('Authorization',`Bearer ${token(userId)}`).send(body)});
  const payload=(extra:object={})=>({userId:22,courseId,contentRevision:revision,role:'coordinator',scope:{studyId:100,siteId:101,armId:5},dueAt:'2020-01-01T00:00:00Z',reason:'Protocol procedure for assigned arm responsibility',...extra});
  beforeAll(async()=>{
    const url=new URL(process.env['TRAINING_OBLIGATION_TEST_DATABASE_URL']!);
    if(process.env['TRAINING_OBLIGATION_TEST_OWNED']!=='yes'||url.hostname!=='127.0.0.1'||!/^\/training_obligation_test_[a-z0-9_]+$/.test(url.pathname))throw new Error('An explicitly owned loopback training_obligation_test_* database is required');
    if((await nativePool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' LIMIT 1")).rowCount)throw new Error('Owned test database must be empty');
    await runMigrations();await runMigrations();
    await nativePool.query(`CREATE TABLE user_account(user_id integer PRIMARY KEY,user_name text UNIQUE,first_name text,last_name text,user_type_id integer,status_id integer);
      CREATE TABLE user_account_extended(user_id integer PRIMARY KEY,platform_role text);
      CREATE TABLE acc_organization_member(organization_id integer,user_id integer,status text);
      CREATE TABLE study(study_id integer PRIMARY KEY,parent_study_id integer,status_id integer);
      CREATE TABLE study_user_role(user_name text,study_id integer,role_name text,status_id integer);
      CREATE TABLE group_class_types(group_class_type_id integer PRIMARY KEY,name text);
      CREATE TABLE study_group_class(study_group_class_id integer PRIMARY KEY,study_id integer,group_class_type_id integer,status_id integer);
      CREATE TABLE study_group(study_group_id integer PRIMARY KEY,study_group_class_id integer,name text);
      CREATE FUNCTION reject_obligation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned audit failure'; END; $$`);
    authority=nativeTrainingAuthority(process.env['TRAINING_NATIVE_AUTHORITY_ROOT']!,nativePool);
    console.info('TRAINING_NATIVE_OBLIGATION_SOURCE_HASHES',JSON.stringify(authority.sourceHashes));
  });
  afterAll(async()=>{await pool.end();await nativePool.end();});
  beforeEach(async()=>{
    intercept=undefined;
    await nativePool.query(`DROP TRIGGER IF EXISTS reject_obligation_audit ON acc_training_audit_log;
      TRUNCATE acc_training_obligation_events,acc_training_obligations,acc_training_record_history,acc_training_records,acc_training_questions,acc_training_slides,acc_training_courses,acc_training_audit_log RESTART IDENTITY CASCADE;
      TRUNCATE user_account,user_account_extended,acc_organization_member,study,study_user_role,group_class_types,study_group_class,study_group;
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
      try{
        const claims=jwt.verify(new Headers(options?.headers).get('Authorization')!.slice(7),'synthetic-only-authority') as {userId:number};
        if(String(url).endsWith('/api/training-authority/resolve')){
          const input=JSON.parse(String(options?.body));await intercept?.(input);
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
    expect((await api(22).post(`/start/${courseId}`,{contentRevision:revision})).status).toBe(200);
    const submitted=await api(22).post(`/submit-quiz/${courseId}`,{contentRevision:revision,answers:[{questionId,selectedOptions:[0]}]});expect(submitted.body.data.passed).toBe(true);
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
    const exported=(await api().get('/obligation-history?userId=22')).body.data;expect(exported.events).toHaveLength(2);expect(exported.events[0].snapshot.courseVersion).toBe('1');expect(exported.history[0].record.verifiedBy).toBe(33);expect(JSON.stringify(exported)).not.toContain('isCorrect');
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
  test('verification refuses expired or stale completion and never overwrites a previous review',async()=>{
    const recordId=await complete();await nativePool.query("UPDATE acc_training_records SET expiration_date='2020-01-01' WHERE id=$1",[recordId]);
    expect((await api(33).post(`/verify/${recordId}`,{notes:'Invalid'})).status).toBe(409);
    await nativePool.query("UPDATE acc_training_records SET expiration_date=NOW()+INTERVAL '1 day' WHERE id=$1",[recordId]);
    expect((await api(33).post(`/verify/${recordId}`,{notes:'Reviewed'})).status).toBe(200);
    expect((await api().post(`/verify/${recordId}`,{notes:'Overwrite'})).status).toBe(409);
    expect((await nativePool.query('SELECT notes FROM acc_training_records WHERE id=$1',[recordId])).rows[0].notes).toBe('Reviewed');
  });
});
