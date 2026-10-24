/**
 * Training effort (T-4): the EDC work-start rule port, the start basis of each kind, and the interval writer. The
 * switch is read from process.env at every call: the owned suites' partial config mock below is the one they use,
 * unchanged, and has no effort setting. With TRAINING_NATIVE_AUTHORITY_ROOT set, the EDC's own checkedWorkStart is
 * compiled from that checkout and answers the same vectors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import Ajv2020 from 'ajv/dist/2020';
import { checkedWorkStart, computeTrainingEffortSource, effortLedgerEnabled, effortStart, observeTrainingEffortSource, recordEffortInterval, servedOf, MAX_ACTIVE_INTERVAL_MS,
  type EffortInterval, type EffortSnapshot } from '../../src/services/training-effort.service';
import { TRAINING_MIGRATION_STATEMENTS } from '../../src/config/migrations';
import { trainingEvidenceHash } from '../../src/services/audit.service';
import type { TrainingEffortArm } from '../../src/types/training.types';

jest.mock('../../src/config/environment', () => ({ config: { authority: { baseUrl: 'https://authority.invalid', timeoutMs: 1000 }, training: { certificateValidityDays: 365 } } }));
jest.mock('../../src/config/database', () => ({ transaction: jest.fn() }));
jest.mock('../../src/config/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));

const SIGNED = '2026-10-21T12:00:00.000Z';
const INVALID = { error: 'workStartedAt must be an exact instant with an explicit time zone' };
const AFTER = { error: 'workStartedAt cannot be after the signature' };
const EARLY = { error: 'workStartedAt can precede the signature by at most 12 hours' };
// The EDC's own vectors (libreclinicaapi tests/unit/effort-capture.unit.test.ts) first, then edges read from its rule.
const VECTORS: Array<[string | undefined, unknown]> = [
  [undefined, { workStartedAt: null }],
  ['2026-10-21T06:30:00-05:00', { workStartedAt: '2026-10-21T11:30:00.000Z' }],
  ['2026-10-21T07:30:00-05:00', AFTER],
  ['2026-10-21T11:00:00Z', { workStartedAt: '2026-10-21T11:00:00.000Z' }],
  ['2026-10-21T12:01:00Z', { workStartedAt: SIGNED }],
  ['2026-10-21T12:05:00Z', AFTER],
  [new Date(Date.parse(SIGNED) - MAX_ACTIVE_INTERVAL_MS - 1000).toISOString(), EARLY],
  ['2026-10-21', INVALID], ['2026-10-21T11:00:00', INVALID], ['2026-02-30T11:00:00Z', INVALID], ['yesterday', INVALID],
  ['2026-10-21T00:00:00.000Z', { workStartedAt: '2026-10-21T00:00:00.000Z' }],
  ['2026-10-20T23:59:59.999Z', EARLY],
  ['', INVALID], [' 2026-10-21T11:00:00Z', INVALID], ['2026-10-21t11:00:00Z', INVALID], ['+002026-10-21T11:00:00Z', INVALID],
  ['2026-13-01T00:00:00Z', INVALID], ['2026-10-21T11:00:00.1234567Z', INVALID],
  ['2026-10-21T11:00Z', { workStartedAt: '2026-10-21T11:00:00.000Z' }],
  ['2026-10-21T11:00:00.123456Z', { workStartedAt: '2026-10-21T11:00:00.123Z' }],
  ['2026-10-21T11:00:00-00:00', { workStartedAt: '2026-10-21T11:00:00.000Z' }],
  ['2026-10-21T11:00:00.5+05:30', { workStartedAt: '2026-10-21T05:30:00.500Z' }],
  ['2026-10-21T11:00:00+14:00', EARLY],
  ['2026-10-21T12:02:00.000Z', { workStartedAt: SIGNED }],
  ['2026-10-21T12:02:00.001Z', AFTER],
  ['2026-10-21T24:00:00Z', AFTER],
];

const edcRoot = process.env['TRAINING_NATIVE_AUTHORITY_ROOT'];
function compiledEdcRule(root: string): typeof checkedWorkStart {
  const file = path.join(fs.realpathSync(root), 'src/services/database/effort-capture.ts'), source = fs.readFileSync(file, 'utf8');
  console.info('TRAINING_EFFORT_EDC_RULE_SOURCE', JSON.stringify({ 'src/services/database/effort-capture.ts': createHash('sha256').update(source).digest('hex') }));
  const output = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} as Record<string, any> };
  // The rule needs no import. The role helper the EDC adds beside it (TA3 V-1) gets a stub that refuses any use.
  new Function('require', 'module', 'exports', output)((name: string) => {
    if (name === '../../constants/roles') return { getRoleByName: () => { throw new Error('checkedWorkStart reads no role'); } };
    throw new Error(`Unexpected EDC effort-capture import ${name}`);
  }, module, module.exports);
  return module.exports.checkedWorkStart;
}

const receiptKey = '7d444840-9dc0-41d6-b2e5-1fbd3e2f3c4a', effortKey = 'b1d6a3f0-55b2-4c55-9a9e-0c8f1f6e2a11';
const signedReceipt = (edcEffort: unknown) => ({ requestKey: receiptKey, signedAt: SIGNED, edcEffort }) as any;

afterEach(() => { delete process.env.TRAINING_EFFORT_LEDGER_ENABLED; });

describe('the EDC work-start rule (effort-capture.ts:42-53) ported unchanged', () => {
  test.each(VECTORS)('port: %j', (value, expected) => expect(checkedWorkStart(value, SIGNED)).toEqual(expected));
  test('the compiled EDC rule answers every vector the same way', () => {
    if (!edcRoot) { console.info('SKIPPED compiled EDC checkedWorkStart: TRAINING_NATIVE_AUTHORITY_ROOT is not set'); return; }
    const edc = compiledEdcRule(edcRoot);
    for (const [value, expected] of VECTORS) expect({ value, answer: edc(value, SIGNED) }).toEqual({ value, answer: expected });
  });
});

describe('start basis of each kind (P25 5.2 A)', () => {
  const learning = (extra: object) => effortStart({ kind: 'learning', endedAt: SIGNED, ...extra });
  test('learning takes a valid stated start first', () => {
    expect(learning({ workStartedAt: '2026-10-21T11:15:00Z', cycle: { startedAt: '2026-10-21T11:50:00Z', previousAssessedAt: null } }))
      .toEqual({ workStartedAt: '2026-10-21T11:15:00.000Z', startBasis: 'client-work-start', edcEffortRequestId: null });
  });
  test('a stated start the rule refuses at the end falls through to the server cycle start, never a refusal', () => {
    expect(learning({ workStartedAt: '2026-10-20T23:00:00Z', cycle: { startedAt: new Date('2026-10-21T11:00:00Z'), previousAssessedAt: null } }))
      .toEqual({ workStartedAt: '2026-10-21T11:00:00.000Z', startBasis: 'server-cycle-start', edcEffortRequestId: null });
    expect(learning({ workStartedAt: 'yesterday', cycle: { startedAt: '2026-10-21T11:00:00.000Z', previousAssessedAt: null } }).startBasis).toBe('server-cycle-start');
  });
  test('the later of the cycle start and the previous attempt of the cycle, only within 12 hours', () => {
    expect(learning({ cycle: { startedAt: '2026-10-21T09:00:00.000Z', previousAssessedAt: '2026-10-21T11:40:00.000Z' } }))
      .toEqual({ workStartedAt: '2026-10-21T11:40:00.000Z', startBasis: 'server-cycle-start', edcEffortRequestId: null });
    expect(learning({ cycle: { startedAt: '2026-10-20T08:00:00.000Z', previousAssessedAt: null } }))
      .toEqual({ workStartedAt: null, startBasis: 'not-supplied', edcEffortRequestId: null });
    expect(learning({ cycle: { startedAt: null, previousAssessedAt: null } }).startBasis).toBe('not-supplied');
    // A cycle start a little after the grading time (clock skew) is clamped to a zero-length interval, as the EDC does.
    expect(learning({ cycle: { startedAt: '2026-10-21T12:01:00.000Z', previousAssessedAt: null } }).workStartedAt).toBe(SIGNED);
  });
  test('signed attestation and verification copy the receipt effort and its EDC request id, and ignore the header', () => {
    for (const kind of ['attestation', 'verification'] as const) {
      expect(effortStart({ kind, endedAt: SIGNED, workStartedAt: '2026-10-21T11:59:00Z',
        receipt: signedReceipt({ requestId: effortKey, workStartedAt: '2026-10-21T10:30:00.000Z', startBasis: 'client-work-start' }) }))
        .toEqual({ workStartedAt: '2026-10-21T10:30:00.000Z', startBasis: 'edc-signed-effort', edcEffortRequestId: effortKey });
      expect(effortStart({ kind, endedAt: SIGNED, workStartedAt: '2026-10-21T11:59:00Z', receipt: signedReceipt({ requestId: effortKey, workStartedAt: null, startBasis: 'not-supplied' }) }))
        .toEqual({ workStartedAt: null, startBasis: 'not-supplied', edcEffortRequestId: effortKey });
      expect(effortStart({ kind, endedAt: SIGNED, workStartedAt: '2026-10-21T11:59:00Z', receipt: signedReceipt(null) }))
        .toEqual({ workStartedAt: null, startBasis: 'not-supplied', edcEffortRequestId: null });
      // A receipt start inconsistent with its own signature keeps the EDC request but no start.
      expect(effortStart({ kind, endedAt: SIGNED, receipt: signedReceipt({ requestId: effortKey, workStartedAt: '2026-10-21T13:00:00.000Z', startBasis: 'client-work-start' }) }))
        .toEqual({ workStartedAt: null, startBasis: 'not-supplied', edcEffortRequestId: effortKey });
    }
  });
  test('an unsigned verification takes the header or nothing; it has no server start', () => {
    expect(effortStart({ kind: 'verification', endedAt: SIGNED, workStartedAt: '2026-10-21T11:20:00Z' }))
      .toEqual({ workStartedAt: '2026-10-21T11:20:00.000Z', startBasis: 'client-work-start', edcEffortRequestId: null });
    expect(effortStart({ kind: 'verification', endedAt: SIGNED, workStartedAt: '2026-10-21T11:20:00', cycle: { startedAt: '2026-10-21T11:00:00Z', previousAssessedAt: null } }))
      .toEqual({ workStartedAt: null, startBasis: 'not-supplied', edcEffortRequestId: null });
  });
});

describe('interval writer', () => {
  const capture = (extra: object = {}) => ({ kind: 'learning' as const, actorUserId: 22, learnerUserId: 22, recordId: 7, courseId: 3,
    assessmentCycleId: 'A1B2C3D4-0000-4000-8000-000000000001', requestKey: 'C0FFEE00-0000-4000-8000-000000000002', endedAt: SIGNED,
    served: [{ id: 9, revision: 2, role: 'coordinator', scope: { armId: 5, siteId: 101, studyId: 100 } }, { id: 4, revision: 1, role: 'investigator', scope: { studyId: 100 } }], ...extra });
  const inserts = (query: jest.Mock) => query.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO acc_training_effort_intervals'));
  /** A decision transaction stand-in: query answers rows(sql); every call is recorded. */
  const mockClient = (rows: (sql: string) => unknown[] = () => []) => ({ query: jest.fn(async (sql: string, _values?: unknown[]) => ({ rows: rows(sql) as any[], rowCount: 0 })) });
  test('the switch is read at every call: unset, on, any other value, unset again', async () => {
    const client = mockClient();
    expect(effortLedgerEnabled()).toBe(false);
    await recordEffortInterval(client, capture()); expect(client.query).not.toHaveBeenCalled();
    process.env.TRAINING_EFFORT_LEDGER_ENABLED = 'true'; expect(effortLedgerEnabled()).toBe(true);
    await recordEffortInterval(client, capture()); expect(inserts(client.query)).toHaveLength(1);
    for (const value of ['TRUE', 'yes', '1', 'on', '']) { process.env.TRAINING_EFFORT_LEDGER_ENABLED = value; await recordEffortInterval(client, capture()); }
    delete process.env.TRAINING_EFFORT_LEDGER_ENABLED; await recordEffortInterval(client, capture());
    expect(client.query).toHaveBeenCalledTimes(1);
  });
  test('a learning row: lower-case keys, the served obligations sorted and exact, no role, no EDC request', async () => {
    process.env.TRAINING_EFFORT_LEDGER_ENABLED = 'true';
    const client = mockClient();
    await recordEffortInterval(client, capture({ input: { workStartedAt: '2026-10-21T11:00:00Z', actorRole: 'coordinator' } }));
    const [sql, values] = inserts(client.query)[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT DO NOTHING$/);
    expect(values).toEqual(['c0ffee00-0000-4000-8000-000000000002', 'learning', 22, null, 22, 7, 3, 'a1b2c3d4-0000-4000-8000-000000000001',
      JSON.stringify([{ obligationId: 4, revision: 1, role: 'investigator', scope: { studyId: 100 } }, { obligationId: 9, revision: 2, role: 'coordinator', scope: { studyId: 100, siteId: 101, armId: 5 } }]),
      '2026-10-21T11:00:00.000Z', SIGNED, 'client-work-start', null]);
  });
  test('verification keeps the verifier platform role; it reads the learner assigned obligations when the decision holds none', async () => {
    process.env.TRAINING_EFFORT_LEDGER_ENABLED = 'true';
    const client = mockClient(sql => sql.startsWith('SELECT id,revision,role,scope') ? [{ id: 9, revision: 1, role: 'coordinator', scope: { studyId: 100, siteId: 101 } }] : []);
    await recordEffortInterval(client, { kind: 'verification', actorUserId: 33, learnerUserId: 22, recordId: 7, courseId: 3, assessmentCycleId: null, input: { actorRole: 'monitor' } });
    expect(client.query.mock.calls[0]).toEqual([expect.stringContaining("FROM acc_training_obligations WHERE user_id=$1 AND course_id=$2 AND status='assigned'"), [22, 3]]);
    const values = inserts(client.query)[0][1] as unknown[];
    expect(values[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(values.slice(1, 8)).toEqual(['verification', 33, 'monitor', 22, 7, 3, null]);
    expect(values.slice(9)).toEqual([null, expect.any(String), 'not-supplied', null]);
    // An unrecognized role is recorded as not stated, never as text a client chose.
    await recordEffortInterval(client, { kind: 'verification', actorUserId: 33, learnerUserId: 22, recordId: 7, courseId: 3, assessmentCycleId: null, input: { actorRole: 'Admin; DROP' } });
    expect((inserts(client.query)[1][1] as unknown[])[3]).toBeNull();
  });
  test('a signed decision ends at the EDC signature, keys by the receipt and copies, never mints, the EDC effort request id', async () => {
    process.env.TRAINING_EFFORT_LEDGER_ENABLED = 'true';
    const client = mockClient();
    const receipt = signedReceipt({ requestId: effortKey, workStartedAt: '2026-10-21T11:45:00.000Z', startBasis: 'client-work-start' });
    await recordEffortInterval(client, { ...capture({ kind: 'attestation', requestKey: undefined, endedAt: '2030-01-01T00:00:00.000Z' }), receipt });
    const values = inserts(client.query)[0][1] as unknown[];
    expect([values[0], values[1], values[9], values[10], values[11], values[12]]).toEqual([receiptKey, 'attestation', '2026-10-21T11:45:00.000Z', SIGNED, 'edc-signed-effort', effortKey]);
    // A second interval naming the same EDC effort request is absorbed by the partial unique index, not counted twice.
    const statements = TRAINING_MIGRATION_STATEMENTS.map(sql => sql.replace(/\s+/g, ' '));
    expect(statements).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_training_effort_edc_request ON acc_training_effort_intervals (edc_effort_request_id) WHERE edc_effort_request_id IS NOT NULL');
    expect(statements).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_training_effort_request ON acc_training_effort_intervals (kind,actor_user_id,record_id,(COALESCE(assessment_cycle_id::text,'')),request_key)");
  });
  test('served obligations are exact native scopes in obligation order', () => {
    expect(servedOf([{ id: 2, revision: 3, role: 'ra', scope: { armId: 8, studyId: 1 } as any }, { id: 1, revision: 1, role: 'ra', scope: { siteId: 4, studyId: 1 } }]))
      .toEqual([{ obligationId: 1, revision: 1, role: 'ra', scope: { studyId: 1, siteId: 4 } }, { obligationId: 2, revision: 3, role: 'ra', scope: { studyId: 1, armId: 8 } }]);
  });
});

describe('TrainingEffortSourceV1@1.0.0 (P25 5.2 B)', () => {
  const contracts = new Ajv2020({ allErrors: true, strict: true });
  for (const name of ['training-effort-source-v1.schema.json', 'training-effort-observation-request-v1.schema.json'])
    contracts.addSchema(JSON.parse(fs.readFileSync(path.join(__dirname, '../../contracts', name), 'utf8')));
  const conforms = (id: string, value: unknown) => { const validate = contracts.getSchema(`https://schemas.accuratrials.com/training/${id}`)!; return validate(value) ? 'valid' : JSON.stringify(validate.errors); };
  const at = (iso: string) => Date.parse(iso);
  const served = (obligationId: number, role: string, scope: Record<string, number>) => ({ obligationId, revision: 1, role, scope: scope as any });
  const interval = (id: number, kind: EffortInterval['kind'], actorUserId: number, items: ReturnType<typeof served>[], minutes: number | null, actorRole: string | null = null): EffortInterval =>
    ({ id, kind, actorUserId, actorRole, served: items, durationMs: minutes === null ? null : minutes * 60000 });
  const site5 = [served(1, 'coordinator', { studyId: 100, siteId: 101, armId: 5 }), served(2, 'coordinator', { studyId: 100, siteId: 101 })];
  const arm6 = [served(3, 'investigator', { studyId: 100, siteId: 102, armId: 6 })];
  const arm = (armId: number, disclosureLevel: TrainingEffortArm['disclosureLevel'], onboardedAt: string | null, onboardEventId: number | null): TrainingEffortArm =>
    ({ armId, classId: 2, disclosureLevel, groupStatus: null, lifecycleState: onboardedAt ? 'pending' : null, onboardedAt, onboardEventId });
  const arms = [arm(5, 'regimen', '2026-10-01T00:00:00.000Z', 41), arm(6, 'treatment-assignment', '2026-10-02T00:00:00.000Z', 45), arm(7, 'regimen', null, null),
    arm(8, 'cohort', '2026-10-05T00:00:00.000Z', 42), arm(9, null, null, null), arm(10, 'regimen', '2026-10-10T00:00:00.000Z', 43), arm(11, 'regimen', '2026-10-20T00:00:00.000Z', 44)];
  const obligation = (id: number, userId: number, scope: Record<string, number>, revision = 1) => ({ id, userId, revision, scope }) as any;
  const done = (verifiedAt: string) => ({ readiness: 'complete', record: { verifiedAt } as any });
  function snapshot(extra: Partial<EffortSnapshot> = {}): EffortSnapshot {
    return {
      asOf: '2026-10-24T00:00:00.000Z',
      intervals: [
        interval(1, 'learning', 22, site5, 30), interval(2, 'learning', 22, site5, null), interval(3, 'attestation', 22, site5, 10), interval(4, 'verification', 33, site5, 15, 'monitor'),
        interval(5, 'learning', 44, arm6, 20), interval(6, 'learning', 55, [served(9, 'coordinator', { studyId: 200, armId: 5 })], 60),
        interval(7, 'verification', 33, arm6, 5, null),
        interval(8, 'learning', 22, [served(1, 'coordinator', { studyId: 100, siteId: 101, armId: 5 }), served(4, 'investigator', { studyId: 100, siteId: 101, armId: 5 })], 6),
      ],
      obligations: [obligation(1, 22, { studyId: 100, siteId: 101, armId: 5 }), obligation(3, 44, { studyId: 100, siteId: 102, armId: 6 }), obligation(4, 22, { studyId: 100, siteId: 101, armId: 5 }, 2),
        obligation(5, 66, { studyId: 100, siteId: 101, armId: 7 }), obligation(6, 22, { studyId: 100, armId: 10 }), obligation(7, 77, { studyId: 100, siteId: 103, armId: 11 }),
        obligation(8, 88, { studyId: 100, siteId: 101, armId: 99 })],
      readiness: new Map<number, any>([[1, done('2026-10-03T00:00:00.000Z')], [3, done('2026-10-03T00:00:00.000Z')], [4, done('2026-10-02T00:00:00.000Z')],
        [5, { readiness: 'pending', record: null }], [6, { readiness: 'awaiting_verification', record: {} }], [7, done('2026-10-15T00:00:00.000Z')], [8, { readiness: 'pending', record: null }]]),
      revisedAt: new Map([['1:1', at('2026-09-20T00:00:00.000Z')], ['3:1', at('2026-09-20T00:00:00.000Z')], ['4:2', at('2026-10-04T12:00:00.000Z')], ['7:1', at('2026-10-12T00:00:00.000Z')]]),
      ...extra,
    };
  }
  const compute = (extra: Partial<EffortSnapshot> = {}, dataClass: 'synthetic' | 'not-stated' = 'synthetic', census = arms) =>
    computeTrainingEffortSource({ studyId: 100, arms: census, snapshot: snapshot(extra), dataClass });
  const row = (level: string, armId: number | null, kind: string, role: string | null, hours: number, intervals: number, unknownIntervals: number, actors: number) =>
    ({ level, armId, role, roleBasis: kind === 'verification' ? 'actor-platform-role' : 'obligation-role', kind, hours, intervals, unknownIntervals, actors,
      disclosure: level === 'platform' ? 'platform' : 'regimen-or-cohort' });

  test('hours by role and kind for the platform and for each regimen or cohort arm; other studies and withheld arms add no row', () => {
    const doc = compute();
    expect(doc.hours).toEqual([
      row('platform', null, 'learning', 'coordinator', 0.6, 3, 1, 1), row('platform', null, 'learning', 'investigator', 0.433, 2, 0, 2),
      row('platform', null, 'attestation', 'coordinator', 0.167, 1, 0, 1), row('platform', null, 'verification', null, 0.083, 1, 0, 1),
      row('platform', null, 'verification', 'monitor', 0.25, 1, 0, 1),
      row('arm', 5, 'learning', 'coordinator', 0.6, 3, 1, 1), row('arm', 5, 'learning', 'investigator', 0.1, 1, 0, 1), row('arm', 5, 'attestation', 'coordinator', 0.167, 1, 0, 1),
      row('arm', 5, 'verification', 'monitor', 0.25, 1, 0, 1)]);
    // Interval 6 served only another study; interval 8 served two roles and counts once in each.
    expect(doc.counts).toEqual({ intervals: 7, throughIntervalId: 8 });
    expect(doc.hours.some(r => r.armId === 6)).toBe(false);
  });
  test('lead time: measured, open, incomplete for both reasons, withheld for every arm not declared regimen or cohort', () => {
    const byArm = new Map(compute().arms.map(a => [a.armId, a]));
    expect(byArm.get(5)).toEqual({ armId: 5, disclosureLevel: 'regimen', onboardedAt: '2026-10-01T00:00:00.000Z', onboardEventId: 41, leadTime: { status: 'measured', days: 3.5,
      startedAt: '2026-10-01T00:00:00.000Z', trainedAt: '2026-10-04T12:00:00.000Z', obligations: { assigned: 2, complete: 2 }, learners: 1, sites: 1, trainedBeforeOnboarding: false, reason: null } });
    const withheld = { status: 'withheld', days: null, startedAt: null, trainedAt: null, obligations: null, learners: null, sites: null, trainedBeforeOnboarding: null,
      reason: 'per-arm values are given only for arms whose class is declared regimen or cohort' };
    expect(byArm.get(6)).toEqual({ armId: 6, disclosureLevel: 'treatment-assignment', onboardedAt: null, onboardEventId: null, leadTime: withheld });
    expect(byArm.get(9)).toEqual({ armId: 9, disclosureLevel: null, onboardedAt: null, onboardEventId: null, leadTime: withheld });
    expect(byArm.get(7)!.leadTime).toEqual({ status: 'incomplete', days: null, startedAt: null, trainedAt: null, obligations: { assigned: 1, complete: 0 }, learners: 1, sites: 1,
      trainedBeforeOnboarding: false, reason: 'arm present from study start' });
    expect(byArm.get(8)!.leadTime).toEqual({ status: 'incomplete', days: null, startedAt: null, trainedAt: null, obligations: { assigned: 0, complete: 0 }, learners: 0, sites: 0,
      trainedBeforeOnboarding: false, reason: 'no assigned arm-scoped training obligations; coverage is T-2' });
    expect(byArm.get(10)!.leadTime).toEqual({ status: 'open', days: 14, startedAt: '2026-10-10T00:00:00.000Z', trainedAt: null, obligations: { assigned: 1, complete: 0 }, learners: 1, sites: 0,
      trainedBeforeOnboarding: false, reason: null });
    expect(byArm.get(11)!.leadTime).toMatchObject({ status: 'measured', days: 0, trainedAt: '2026-10-15T00:00:00.000Z', trainedBeforeOnboarding: true });
    expect([...byArm.keys()]).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });
  test('a retraining or a later obligation revision moves trainedAt later; a lost verification reopens the arm', () => {
    expect(compute({ revisedAt: new Map([...snapshot().revisedAt, ['4:2', at('2026-10-06T00:00:00.000Z')]]) }).arms[0].leadTime).toMatchObject({ days: 5, trainedAt: '2026-10-06T00:00:00.000Z' });
    const reopened = compute({ readiness: new Map([...snapshot().readiness, [4, { readiness: 'retraining_required', record: null }]]) }).arms[0].leadTime;
    expect(reopened).toMatchObject({ status: 'open', days: 23, trainedAt: null, obligations: { assigned: 2, complete: 1 } });
    // A complete obligation whose current revision event is missing refuses the whole document; it is never guessed.
    expect(() => compute({ revisedAt: new Map() })).toThrow(expect.objectContaining({ statusCode: 409, code: 'TRAINING_EFFORT_UNAVAILABLE' }));
  });
  test('validates against the producer schema, names no person, and hashes everything but asOf', () => {
    for (const dataClass of ['synthetic', 'not-stated'] as const) {
      const doc = compute({}, dataClass);
      expect(conforms('TrainingEffortSourceV1@1.0.0', doc)).toBe('valid');
      expect(doc.limitations[0].startsWith('SYNTHETIC ENGINEERING STUDY. NOT A REAL TRIAL.')).toBe(dataClass === 'synthetic');
      const { asOf: _asOf, sourceHash, ...body } = doc;
      expect(sourceHash).toBe(trainingEvidenceHash(body));
    }
    const names = (v: unknown): string[] => Array.isArray(v) ? v.flatMap(names) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...names(x)]) : [];
    expect(names(compute()).filter(k => /user|learner(?!s$)|actor(?!s$)|obligationId|recordId/i.test(k))).toEqual([]);
    // Without an open arm the content does not depend on asOf, so a later poll of the same rows hashes the same.
    const steady = arms.filter(a => a.armId !== 10);
    expect(compute({ asOf: '2026-10-25T00:00:00.000Z' }, 'synthetic', steady).sourceHash).toBe(compute({}, 'synthetic', steady).sourceHash);
    expect(compute({ asOf: '2026-10-25T00:00:00.000Z' }).sourceHash).not.toBe(compute().sourceHash);
    // The schema itself refuses a withheld arm that carries a value, and an arm row for a withheld level.
    const doc = compute();
    expect(conforms('TrainingEffortSourceV1@1.0.0', { ...doc, arms: [{ ...doc.arms[1], onboardedAt: '2026-10-02T00:00:00.000Z' }] })).not.toBe('valid');
    expect(conforms('TrainingEffortSourceV1@1.0.0', { ...doc, hours: [{ ...doc.hours[5], disclosure: 'withheld' }] })).not.toBe('valid');
  });
  test('the request contract: a root study only', () => {
    const request = { schemaVersion: 'training-effort-observation-request/1', requestId: '0f8fad5b-d9cb-469f-a165-70867728950e', installationId: 'synthetic-installation', scope: { studyId: 100 } };
    expect(conforms('training-effort-observation-request/1', request)).toBe('valid');
    expect(conforms('training-effort-observation-request/1', { ...request, expectedAuthorityHash: 'a'.repeat(64) })).toBe('valid');
    expect(conforms('training-effort-observation-request/1', { ...request, scope: { studyId: 100, siteId: 101 } })).not.toBe('valid');
    expect(conforms('training-effort-observation-request/1', { ...request, originals: [] })).not.toBe('valid');
  });
  test('the observation refuses to read anything while the ledger is off', async () => {
    await expect(observeTrainingEffortSource({ studyId: 100 }, arms)).rejects.toMatchObject({ statusCode: 503, code: 'TRAINING_EFFORT_DISABLED' });
  });
});
