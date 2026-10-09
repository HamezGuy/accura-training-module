// Opt-in only: an owner-provisioned, empty disposable PostgreSQL database.
// No existing application database or credential variable is ever selected.
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createJwtService } from '@accura-trial/auth-core';
import { Pool } from 'pg';
import trainingRoutes from '../../src/routes/training.routes';
import { errorHandler } from '../../src/middleware/errorHandler.middleware';
import { pool } from '../../src/config/database';
import { runMigrations } from '../../src/config/migrations';
import { expireOverdueRecords } from '../../src/services/training.service';
import { nativeTrainingAuthority } from '../fixtures/native-training-authority';

jest.mock('../../src/config/environment', () => ({ config: {
  database: { url: process.env['TRAINING_AUDIT_TEST_DATABASE_URL'] ?? 'postgresql://127.0.0.1:1/disabled', ssl: false },
  authority: { baseUrl: 'https://authority.invalid', timeoutMs: 100 }, training: { certificateValidityDays: 365 },
} }));
jest.mock('../../src/config/logger', () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));

// This cross-repository qualification needs both explicit resources. A skipped
// suite does not qualify the HTTP/SQL owner boundary or native authorization.
const runOwned = process.env['TRAINING_AUDIT_TEST_DATABASE_URL'] && process.env['TRAINING_NATIVE_AUTHORITY_ROOT'] ? describe : describe.skip;
runOwned('owned PostgreSQL training audit atomicity', () => {
  const fixturePool = new Pool({ connectionString: process.env['TRAINING_AUDIT_TEST_DATABASE_URL'] ?? 'postgresql://127.0.0.1:1/disabled' });
  let nativeAuthority: ReturnType<typeof nativeTrainingAuthority>;
  const guardedClients = new WeakSet<object>();
  let beforeNativeResolve: ((input: any) => Promise<void>) | undefined;
  const app = express(); app.use(express.json()); app.use('/api/training', trainingRoutes); app.use(errorHandler);
  const token = jwt.sign({ userId: 111, username: 'owned-fixture-admin', role: 'admin', email: 'owned@example.invalid', type: 'access' }, 'owned-training-postgres-test', { algorithm: 'HS256', issuer: 'libreclinica-api', audience: 'libreclinica-client', expiresIn: '1h' });
  let ready = false, courseId: number, questionId: number, recordId: number;
  const cases = ['create', 'update', 'questions', 'start', 'quiz-pass', 'quiz-fail', 'verify'] as const;
  const options = [{ text: 'yes', isCorrect: true }, { text: 'no', isCorrect: false }];
  const expected = { create: 'course_created', update: 'course_updated', questions: 'questions_added', start: 'training_started',
    'quiz-pass': 'quiz_passed', 'quiz-fail': 'quiz_failed', verify: 'training_verified' };

  beforeAll(async () => {
    const url = new URL(process.env['TRAINING_AUDIT_TEST_DATABASE_URL']!);
    if (process.env['TRAINING_AUDIT_TEST_OWNED'] !== 'yes' || !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.search || url.hash || !/^\/training_audit_test_[a-z0-9_]+$/.test(url.pathname)) {
      throw new Error('Requires an explicitly owned loopback training_audit_test_* disposable database.');
    }
    // Refuse a populated database before DDL or cleanup, even if its name matches.
    const existing = await fixturePool.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' LIMIT 1");
    if (existing.rowCount) throw new Error('The owned PostgreSQL test database must initially be empty.');
    await runMigrations(); await runMigrations(); // Additive DDL is idempotent.
    // Minimal projection of the authoritative EDC schema, not a second account store.
    // Column names/joins match libreclinicaapi auth.service/user.service and native study membership.
    await fixturePool.query(`CREATE TABLE user_account (user_id integer PRIMARY KEY, user_name text UNIQUE NOT NULL,
      first_name text, last_name text, user_type_id integer, status_id integer NOT NULL);
      CREATE TABLE user_account_extended (user_id integer PRIMARY KEY REFERENCES user_account, platform_role text);
      CREATE TABLE acc_organization_member (organization_id integer NOT NULL,
        user_id integer NOT NULL REFERENCES user_account, status varchar(30) NOT NULL DEFAULT 'active',
        UNIQUE (organization_id, user_id));
      CREATE TABLE study (study_id integer PRIMARY KEY, parent_study_id integer REFERENCES study);
      CREATE TABLE study_user_role (user_name text REFERENCES user_account(user_name), study_id integer REFERENCES study,
        role_name text, status_id integer NOT NULL)`);
    await fixturePool.query(`CREATE FUNCTION reject_owned_training_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Owned injected audit storage failure'; END; $$`);
    nativeAuthority = nativeTrainingAuthority(process.env['TRAINING_NATIVE_AUTHORITY_ROOT']!, fixturePool);
    console.info('TRAINING_NATIVE_AUTHORITY_SOURCE_HASHES', JSON.stringify(nativeAuthority.sourceHashes));
    ready = true;
  }, 30_000);
  afterAll(async () => { await pool.end(); await fixturePool.end(); });

  beforeEach(async () => {
    beforeNativeResolve = undefined;
    const verifier = createJwtService({ secret: 'owned-training-postgres-test' });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const bearer = new Headers(options?.headers).get('Authorization')!.slice('Bearer '.length);
      const verified = verifier.verifyAccessToken(bearer);
      if (verified && String(url).endsWith('/api/training-authority/resolve')) {
        try {
          const input = JSON.parse(String(options?.body));
          await beforeNativeResolve?.(input);
          const data = await nativeAuthority.resolve(111, input);
          return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
        } catch (error) {
          const failure = error as { statusCode?: number; code?: string; message?: string };
          return new Response(JSON.stringify({ success: false, error: { code: failure.code, message: failure.message } }), {
            status: failure.statusCode ?? 500, headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify(verified ? { success: true, data: {
        userId: 111, username: 'owned-fixture-admin', email: '', role: 'admin', userType: 'user', studyIds: [], organizationIds: [],
      } } : { success: false }), { status: verified ? 200 : 401 });
    });
    if (!ready) throw new Error('Owned test database preparation did not complete.');
    await fixturePool.query('DROP TRIGGER IF EXISTS reject_owned_training_audit ON acc_training_audit_log');
    await fixturePool.query('TRUNCATE acc_training_questions, acc_training_records, acc_training_audit_log, acc_training_courses RESTART IDENTITY CASCADE');
    await fixturePool.query(`TRUNCATE acc_organization_member, study_user_role, user_account_extended, user_account, study;
      INSERT INTO user_account VALUES (111,'owned-admin','Owned','Admin',1,1),(222,'owned-manager','Owned','Manager',2,1),
        (333,'owned-inactive','Owned','Inactive',2,1),(444,'owned-outside','Owned','Outside',2,1);
      INSERT INTO user_account_extended VALUES (111,'monitor'),(222,'study_director'),(333,'monitor'),(444,'monitor');
      INSERT INTO acc_organization_member VALUES (10,111,'active'),(10,222,'active'),(10,333,'removed'),(20,444,'active');
      INSERT INTO study VALUES (100,NULL),(101,100),(200,NULL);
      INSERT INTO study_user_role VALUES ('owned-admin',100,'ra',1),('owned-manager',101,'site_monitor',1),
        ('owned-inactive',100,'monitor',5),('owned-outside',200,'monitor',1)`);
    const course = await fixturePool.query(`INSERT INTO acc_training_courses
      (course_code, course_name, version, passing_score, required_for_roles, validity_period_days)
      VALUES ('OWNED-FIXTURE', 'Owned training fixture', '1', 80, '["admin"]'::jsonb, 365) RETURNING id`);
    courseId = course.rows[0].id;
    const question = await fixturePool.query(`INSERT INTO acc_training_questions
      (course_id, question_text, question_type, options, order_index) VALUES ($1, 'Owned fixture?', 'true_false', $2, 0) RETURNING id`, [courseId, JSON.stringify(options)]);
    questionId = question.rows[0].id;
    const record = await fixturePool.query(`INSERT INTO acc_training_records
      (user_id, course_id, status, score, attempts, completed_at, expiration_date,course_version,content_revision)
      VALUES (222, $1, 'completed', 100, 1, NOW(), NOW() + INTERVAL '1 day','1',(SELECT content_revision FROM acc_training_courses WHERE id=$1)) RETURNING id`, [courseId]);
    recordId = record.rows[0].id;
    // Native fixtures and producer use a distinct pool. Every query issued by
    // training (including its transaction connections) must remain local-owned.
    const refuseForeignSql = (sql: unknown) => {
      const text = typeof sql === 'string' ? sql : (sql as { text?: string })?.text ?? '';
      if (/\b(user_account|user_account_extended|acc_organization_member|study_user_role|study)\b/i.test(text)) {
        throw new Error('Training attempted a forbidden native-authority SQL read');
      }
    };
    const direct = pool.query.bind(pool);
    jest.spyOn(pool, 'query').mockImplementation(((...args: any[]) => { refuseForeignSql(args[0]); return (direct as any)(...args); }) as any);
    const connect = pool.connect.bind(pool);
    const guard = (client: any) => {
      if (!guardedClients.has(client)) {
        const execute = client.query.bind(client);
        client.query = (...args: any[]) => { refuseForeignSql(args[0]); return execute(...args); };
        guardedClients.add(client);
      }
      return client;
    };
    jest.spyOn(pool, 'connect').mockImplementation(((callback?: (...args: any[]) => void) => callback
      ? (connect as any)((error: unknown, client: any, release: any) => callback(error, client ? guard(client) : client, release))
      : connect().then(guard)) as any);
  });

  async function snapshot() {
    const state: Record<string, unknown> = {};
    for (const table of ['acc_training_courses', 'acc_training_questions', 'acc_training_records', 'acc_training_audit_log']) {
      state[table] = (await fixturePool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    }
    return state;
  }
  afterEach(() => jest.restoreAllMocks());
  async function refuseAudit() {
    await fixturePool.query(`CREATE TRIGGER reject_owned_training_audit BEFORE INSERT ON acc_training_audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_owned_training_audit()`);
  }
  async function send(kind: typeof cases[number]) {
    const client = request(app);
    const pending = kind === 'create' ? client.post('/api/training/courses').send({ courseCode: 'OWNED-NEW', courseName: 'Owned new fixture', version: '1', passingScore: 80, requiredForRoles: ['admin'] })
      : kind === 'update' ? client.put(`/api/training/courses/${courseId}`).send({ courseName: 'Owned renamed fixture' })
      : kind === 'questions' ? client.post(`/api/training/courses/${courseId}/questions`).send({ questions: [{ questionText: 'Second owned question', questionType: 'true_false', options, orderIndex: 1 }] })
      : kind === 'start' ? client.post(`/api/training/start/${courseId}`).send({})
      : kind === 'verify' ? client.post(`/api/training/verify/${recordId}`).send({ notes: 'Owned verification note' })
      : client.post(`/api/training/submit-quiz/${courseId}`).send({ contentRevision:2, answers: [{ questionId, selectedOptions: [kind === 'quiz-pass' ? 0 : 1] }] });
    return pending.set('Authorization', `Bearer ${token}`);
  }

  async function prepareQuiz(kind: string) {
    if (!kind.startsWith('quiz-')) return;
    const response = await request(app).post(`/api/training/start/${courseId}`).set('Authorization',`Bearer ${token}`).send({});
    expect(response.status).toBe(200);
    await fixturePool.query('DELETE FROM acc_training_audit_log'); // isolate action under test
  }
  test.each(cases)('%s leaves all business and audit rows unchanged when PostgreSQL rejects the audit insert', async kind => {
    await prepareQuiz(kind);
    await refuseAudit(); const before = await snapshot();
    const response = await send(kind);
    expect(response.status).toBe(500); expect(response.body.success).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
  test.each(cases)('%s commits the native rows and actor-bound audit together', async kind => {
    await prepareQuiz(kind);
    const before = await snapshot(), response = await send(kind);
    expect(response.status).toBeLessThan(300); expect(response.body.success).toBe(true);
    expect(await snapshot()).not.toEqual(before);
    const audit = await fixturePool.query('SELECT user_id, action, record_id, course_id FROM acc_training_audit_log');
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ user_id: 111, action: expected[kind] });
    if (kind === 'verify') expect(audit.rows[0].record_id).toBe(recordId);
    else if (kind === 'create') expect(audit.rows[0].course_id).toBe(response.body.data.id);
    else expect(audit.rows[0].course_id).toBe(courseId);
  });
  test('expiry rollback and null system actor survive real PostgreSQL constraints and remain visible', async () => {
    await fixturePool.query("UPDATE acc_training_records SET expiration_date = '2000-01-01' WHERE id = $1", [recordId]);
    await refuseAudit(); const before = await snapshot();
    await expect(expireOverdueRecords()).rejects.toThrow('Owned injected audit storage failure');
    expect(await snapshot()).toEqual(before);
    await fixturePool.query('DROP TRIGGER reject_owned_training_audit ON acc_training_audit_log');
    expect(await expireOverdueRecords()).toBe(1);
    const audit = await fixturePool.query('SELECT * FROM acc_training_audit_log');
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ user_id: null, record_id: recordId, course_id: courseId, action: 'training_expired',
      details: { actor: 'scheduled-expiration', affectedUserId: 222, previousStatus: 'completed', status: 'expired' } });
    expect(await expireOverdueRecords()).toBe(0);
    expect((await fixturePool.query('SELECT COUNT(*)::int AS count FROM acc_training_audit_log')).rows[0].count).toBe(1);
  });
  test('migration rejects anonymous interactive and incomplete system events, including SQL-null JSON fields', async () => {
    for (const [action, details] of [['course_created', {}], ['training_expired', null], ['training_expired', {}],
      ['training_expired', { actor: 'scheduled-expiration' }], ['training_expired', { actor: 'scheduled-expiration', affectedUserId: '222' }]]) {
      await expect(fixturePool.query('INSERT INTO acc_training_audit_log (user_id, action, details) VALUES (NULL, $1, $2)',
        [action, details === null ? null : JSON.stringify(details)])).rejects.toMatchObject({ code: '23514' });
    }
  });
  test('native account/admin precedence and active parent/site scope survive real SQL', async () => {
    const response = await request(app).get('/api/training/compliance?studyId=100').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: any) => [row.userId, row.role])).toEqual([[111, 'admin'], [222, 'data_manager']]);
    expect((await request(app).get('/api/training/compliance?studyId=999').set('Authorization', `Bearer ${token}`)).status).toBe(404);
    expect((await request(app).get('/api/training/compliance?studyId=100.5').set('Authorization', `Bearer ${token}`)).status).toBe(400);
  });
  test('required course IDs exclude optional expired and inactive completed records in real SQL', async () => {
    await fixturePool.query(`UPDATE acc_training_courses SET required_for_roles='["manager"]' WHERE id=$1`, [courseId]);
    const optional = await fixturePool.query(`INSERT INTO acc_training_courses (course_code,course_name,version,passing_score,required_for_roles)
      VALUES ('OWNED-OPTIONAL','Optional','1',80,'["monitor"]') RETURNING id`);
    const obsolete = await fixturePool.query(`INSERT INTO acc_training_courses (course_code,course_name,version,passing_score,required_for_roles,active)
      VALUES ('OWNED-OBSOLETE','Obsolete','1',80,'["data_manager"]',false) RETURNING id`);
    await fixturePool.query(`INSERT INTO acc_training_records (user_id,course_id,status,expiration_date) VALUES
      (222,$1,'expired','2000-01-01'),(222,$2,'completed','2099-01-01')`, [optional.rows[0].id, obsolete.rows[0].id]);
    const response = await request(app).get('/api/training/compliance?studyId=100&userId=222').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ userId:222, role:'data_manager', totalRequired:1, completed:1,
      expired:0, pending:0, compliancePercentage:100, isCompliant:true });
    await fixturePool.query(`UPDATE acc_training_records SET expiration_date='2000-01-01' WHERE id=$1`, [recordId]);
    const expired = await request(app).get('/api/training/compliance?userId=222').set('Authorization', `Bearer ${token}`);
    expect(expired.body.data[0]).toMatchObject({ totalRequired:1, completed:0, expired:1, pending:0, compliancePercentage:0, isCompliant:false });
  });

  test('legacy manager requirements are visible in course lists and unknown role configuration cannot disappear', async () => {
    await fixturePool.query(`UPDATE acc_training_courses SET required_for_roles='["manager"]' WHERE id=$1`,[courseId]);
    const listed = await request(app).get('/api/training/courses?role=data_manager').set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200); expect(listed.body.data.map((row:any)=>row.id)).toEqual([courseId]);
    const bad = {courseCode:'OWNED-BAD',courseName:'Invalid roles',version:'1',passingScore:80,requiredForRoles:['constructor']};
    expect((await request(app).post('/api/training/courses').send(bad).set('Authorization', `Bearer ${token}`)).status).toBe(400);
    expect((await request(app).put(`/api/training/courses/${courseId}`).send({requiredForRoles:['invented']}).set('Authorization', `Bearer ${token}`)).status).toBe(400);
    expect((await fixturePool.query('SELECT COUNT(*)::int AS n FROM acc_training_audit_log')).rows[0].n).toBe(0);
    await fixturePool.query(`UPDATE acc_training_courses SET required_for_roles='["invented"]' WHERE id=$1`,[courseId]);
    expect((await request(app).get('/api/training/compliance?userId=222').set('Authorization', `Bearer ${token}`)).status).toBe(409);
  });

  test('active organization peers are the only aggregate and expiring rows, including under a study filter', async () => {
    await fixturePool.query(`INSERT INTO acc_training_records (user_id,course_id,status,expiration_date)
      VALUES (333,$1,'completed',NOW() + INTERVAL '1 day'),(444,$1,'completed',NOW() + INTERVAL '1 day')`, [courseId]);
    // Foreign and removed members share the study: its filter must not replace organization isolation.
    await fixturePool.query(`INSERT INTO study_user_role VALUES ('owned-outside',100,'monitor',1);
      UPDATE study_user_role SET status_id=1 WHERE user_name='owned-inactive'`);
    const before = await snapshot();
    for (const path of ['/compliance', '/compliance?studyId=100']) {
      const response = await request(app).get(`/api/training${path}`).set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(200); expect(response.body.success).toBe(true);
      expect(response.body.data.map((row: any) => row.userId).sort()).toEqual([111,222]);
    }
    const records = await request(app).get('/api/training/user/222/records').set('Authorization', `Bearer ${token}`);
    expect(records.status).toBe(200); expect(records.body.data).toHaveLength(1);
    expect(records.body.data[0]).toMatchObject({ id: recordId, userId: 222 });
    const compliance = await request(app).get('/api/training/user/222/is-compliant').set('Authorization', `Bearer ${token}`);
    expect(compliance.status).toBe(200); expect(compliance.body.data.userId).toBe(222);
    const expiring = await request(app).get('/api/training/expiring?days=30').set('Authorization', `Bearer ${token}`);
    expect(expiring.status).toBe(200);
    expect(expiring.body.data.map((row: any) => [row.id, row.userId])).toEqual([[recordId,222]]);
    expect(await snapshot()).toEqual(before);
  });

  test('foreign and removed organization members cannot be read through any targeted oversight route', async () => {
    const before = await snapshot();
    for (const targetId of [333,444]) {
      for (const path of [`/user/${targetId}/records`, `/user/${targetId}/is-compliant`, `/compliance?userId=${targetId}`]) {
        const response = await request(app).get(`/api/training${path}`).set('Authorization', `Bearer ${token}`);
        expect(response.status).toBe(403); expect(response.body.success).toBe(false);
        expect(response.body.data).toBeUndefined();
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  test('expiry pages retain one local snapshot across concurrent expiration and status changes', async () => {
    const reference = (await fixturePool.query('SELECT CURRENT_TIMESTAMP::text AS value')).rows[0].value;
    await fixturePool.query('UPDATE acc_training_records SET expiration_date=$1::timestamptz + interval \'1 day\' WHERE id=$2', [reference, recordId]);
    await fixturePool.query(`WITH courses AS (
      INSERT INTO acc_training_courses(course_code,course_name,version,passing_score,required_for_roles)
      SELECT 'PAGE-'||n,'Paged expiry','1',80,'["admin"]'::jsonb FROM generate_series(1,201) n RETURNING id
    ) INSERT INTO acc_training_records(user_id,course_id,status,expiration_date)
      SELECT 222,id,'completed',$1::timestamptz+interval '1 day'+id*interval '1 microsecond' FROM courses`, [reference]);
    const expected = (await fixturePool.query('SELECT id FROM acc_training_records ORDER BY expiration_date,id')).rows.map(row => row.id);
    let mutated = false;
    beforeNativeResolve = async input => {
      if (!mutated && input.action === 'records:expiring' && input.userIds.length) {
        mutated = true;
        await fixturePool.query('UPDATE acc_training_records SET expiration_date=expiration_date+interval \'1 day\' WHERE id=$1', [recordId]);
        await fixturePool.query("UPDATE acc_training_records SET status='expired' WHERE id=$1", [expected[expected.length - 1]]);
      }
    };
    const response = await request(app).get('/api/training/expiring?days=14').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200); expect(mutated).toBe(true);
    expect(response.body.data.map((row: any) => row.id)).toEqual(expected);
    expect(new Set(response.body.data.map((row: any) => row.id)).size).toBe(expected.length);
  });

  test('foreign verification is invisible and leaves all rows unchanged before a same-organization audited success', async () => {
    const foreign = await fixturePool.query(`INSERT INTO acc_training_records (user_id,course_id,status,score,completed_at)
      VALUES (444,$1,'completed',100,NOW()) RETURNING *`, [courseId]);
    const before = await snapshot();
    const refused = await request(app).post(`/api/training/verify/${foreign.rows[0].id}`)
      .send({ notes: 'Must not reach the foreign record' }).set('Authorization', `Bearer ${token}`);
    expect(refused.status).toBe(404); expect(refused.body.success).toBe(false);
    expect(await snapshot()).toEqual(before);
    const accepted = await send('verify');
    expect(accepted.status).toBe(200); expect(accepted.body.data).toEqual({ verified: true });
    expect((await fixturePool.query('SELECT * FROM acc_training_records WHERE id=$1', [foreign.rows[0].id])).rows).toEqual(foreign.rows);
    expect((await fixturePool.query('SELECT verified_by,notes FROM acc_training_records WHERE id=$1', [recordId])).rows)
      .toEqual([{ verified_by:111, notes:'Owned verification note' }]);
    expect((await fixturePool.query('SELECT user_id,action,record_id FROM acc_training_audit_log')).rows)
      .toEqual([{ user_id:111, action:'training_verified', record_id:recordId }]);
  });

  test('organization-less study-derived admin stays self-only while explicit platform and native admins retain global scope', async () => {
    // The same authenticated admin role cannot itself grant global database scope.
    await fixturePool.query(`DELETE FROM acc_organization_member WHERE user_id=111;
      UPDATE user_account SET user_type_id=2 WHERE user_id=111;
      UPDATE user_account_extended SET platform_role=NULL WHERE user_id=111;
      UPDATE study_user_role SET role_name='admin' WHERE user_name='owned-admin'`);
    const before = await snapshot();
    const restricted = await request(app).get('/api/training/compliance').set('Authorization', `Bearer ${token}`);
    expect(restricted.status).toBe(200);
    expect(restricted.body.data.map((row: any) => [row.userId,row.role])).toEqual([[111,'admin']]);
    expect((await request(app).get('/api/training/user/222/records').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await send('verify')).status).toBe(404);
    expect(await snapshot()).toEqual(before);
    await fixturePool.query("UPDATE user_account_extended SET platform_role='admin' WHERE user_id=111");
    const platform = await request(app).get('/api/training/compliance').set('Authorization', `Bearer ${token}`);
    expect(platform.status).toBe(200);
    expect(platform.body.data.map((row: any) => row.userId).sort()).toEqual([111,222,333,444]);
    await fixturePool.query(`UPDATE user_account SET user_type_id=1 WHERE user_id=111;
      UPDATE user_account_extended SET platform_role='monitor' WHERE user_id=111`);
    const native = await request(app).get('/api/training/compliance').set('Authorization', `Bearer ${token}`);
    expect(native.status).toBe(200);
    expect(native.body.data.map((row: any) => row.userId).sort()).toEqual([111,222,333,444]);
    expect((await request(app).get('/api/training/user/444/records').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  test('a real organization lookup failure refuses reads and verification without granting empty-membership global scope', async () => {
    const before = await snapshot();
    // Only this already-qualified empty disposable database is modified; restore even if an assertion fails.
    await fixturePool.query('ALTER TABLE acc_organization_member RENAME TO owned_unavailable_organization_member');
    try {
      for (const path of ['/compliance', '/expiring', '/user/222/records', '/user/222/is-compliant', '/compliance?userId=222']) {
        const response = await request(app).get(`/api/training${path}`).set('Authorization', `Bearer ${token}`);
        expect(response.status).toBe(503); expect(response.body.success).toBe(false);
        expect(response.body.data).toBeUndefined();
      }
      const response = await send('verify');
      expect(response.status).toBe(503); expect(response.body.success).toBe(false);
      expect(await snapshot()).toEqual(before);
    } finally {
      await fixturePool.query('ALTER TABLE owned_unavailable_organization_member RENAME TO acc_organization_member');
    }
    const restored = await request(app).get('/api/training/user/222/records').set('Authorization', `Bearer ${token}`);
    expect(restored.status).toBe(200); expect(restored.body.data[0].id).toBe(recordId);
    expect(await snapshot()).toEqual(before);
  });

  test('material changes invalidate completion; retraining archives the exact certificate and content', async () => {
    const start = await request(app).post(`/api/training/start/${courseId}`).set('Authorization',`Bearer ${token}`).send({});
    expect(start.status).toBe(200); const revision = start.body.data.contentRevision;
    expect(start.body.data).not.toHaveProperty('contentSnapshot');
    const complete = await send('quiz-pass'); expect(complete.status).toBe(200);
    const old = (await fixturePool.query('SELECT * FROM acc_training_records WHERE user_id=111')).rows[0];
    expect(old.content_snapshot.questions).toHaveLength(1);
    await fixturePool.query('UPDATE acc_training_questions SET question_text=$1 WHERE id=$2',['Changed material',questionId]);
    const current = (await fixturePool.query('SELECT content_revision FROM acc_training_courses WHERE id=$1',[courseId])).rows[0];
    expect(current.content_revision).toBe(revision+1);
    const compliance = await request(app).get('/api/training/compliance?userId=111').set('Authorization',`Bearer ${token}`);
    expect(compliance.body.data[0]).toMatchObject({completed:0,pending:1,isCompliant:false});
    expect((await request(app).post(`/api/training/start/${courseId}`).set('Authorization',`Bearer ${token}`).send({contentRevision:revision})).status).toBe(409);
    const restart = await request(app).post(`/api/training/start/${courseId}`).set('Authorization',`Bearer ${token}`).send({contentRevision:current.content_revision});
    expect(restart.status).toBe(200); expect(restart.body.data.certificateNumber).toBeNull();
    const history = (await fixturePool.query('SELECT record_snapshot FROM acc_training_record_history WHERE user_id=111')).rows;
    expect(history).toHaveLength(1);
    expect(history[0].record_snapshot.certificateNumber).toBe(old.certificate_number);
    expect(history[0].record_snapshot.contentSnapshot.questions[0].questionText).toBe('Owned fixture?');
    const response = await request(app).get('/api/training/my-record-history').set('Authorization',`Bearer ${token}`);
    expect(response.status).toBe(200); expect(response.body.data[0].record).not.toHaveProperty('contentSnapshot');
    expect(JSON.stringify(response.body)).not.toContain('isCorrect');
  });
  test('a revision changed during an attempt rejects its quiz before completion', async () => {
    await prepareQuiz('quiz-pass');
    await fixturePool.query('INSERT INTO acc_training_slides(course_id,title,content) VALUES($1,$2,$3)',[courseId,'New procedure','Updated content']);
    expect((await send('quiz-pass')).status).toBe(409);
    const record = (await fixturePool.query('SELECT status,certificate_number FROM acc_training_records WHERE user_id=111')).rows[0];
    expect(record).toEqual({status:'in_progress',certificate_number:null});
  });
  test('failed retraining audit rolls back archival and reset together', async () => {
    await prepareQuiz('quiz-pass'); expect((await send('quiz-pass')).status).toBe(200);
    await fixturePool.query("UPDATE acc_training_courses SET version='2' WHERE id=$1",[courseId]);
    const previous=(await fixturePool.query('SELECT * FROM acc_training_records WHERE user_id=111')).rows[0];
    await refuseAudit(); expect((await send('start')).status).toBe(500);
    expect((await fixturePool.query('SELECT * FROM acc_training_records WHERE user_id=111')).rows[0]).toEqual(previous);
    expect((await fixturePool.query('SELECT * FROM acc_training_record_history')).rows).toHaveLength(0);
  });

  test('an older tab cannot submit after another tab starts the new revision', async () => {
    await prepareQuiz('quiz-pass');
    await fixturePool.query("UPDATE acc_training_questions SET question_text='Updated question' WHERE id=$1",[questionId]);
    expect((await send('start')).status).toBe(200); // second tab binds current revision
    expect((await send('quiz-pass')).status).toBe(409); // first tab still sends revision 2
    expect((await fixturePool.query('SELECT status FROM acc_training_records WHERE user_id=111')).rows[0].status).toBe('in_progress');
  });

  test('concurrent startup migrations and course writes cannot bypass revision protection', async () => {
    const before=(await fixturePool.query('SELECT content_revision FROM acc_training_courses WHERE id=$1',[courseId])).rows[0].content_revision;
    await Promise.all([runMigrations(),runMigrations(),(async()=>{
      for(let i=0;i<12;i++) await fixturePool.query('UPDATE acc_training_courses SET description=$1 WHERE id=$2',[`Concurrent material ${i}`,courseId]);
    })()]);
    expect((await fixturePool.query('SELECT content_revision FROM acc_training_courses WHERE id=$1',[courseId])).rows[0].content_revision).toBe(before+12);
  });

});
