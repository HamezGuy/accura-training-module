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
import { checkedWorkStart, effortLedgerEnabled, effortStart, recordEffortInterval, servedOf, MAX_ACTIVE_INTERVAL_MS } from '../../src/services/training-effort.service';
import { TRAINING_MIGRATION_STATEMENTS } from '../../src/config/migrations';

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
