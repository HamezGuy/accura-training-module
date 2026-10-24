/**
 * Part 11 impact plan review (FX-TRN-01, IR-318): the independent reviewer's signature over the exact proposed plan,
 * bound in the review's transaction; apply refuses a binding that no longer names the reviewed plan and, only with
 * TRAINING_IMPACT_REVIEW_SIGNATURE_REQUIRED=true, an unsigned review. The native authority and the EDC confirmation
 * are fakes here; the EDC's native impact suite runs the unsigned routes for real. Synthetic data only.
 */
import { canonicalTrainingEvidence, trainingEvidenceHash } from '../../src/services/audit.service';
import { conformsTo, edcConfirmation, impactReviewVectors, signatureReceipt, signatureStore } from '../fixtures/training-signature-fixtures';

const mockQuery = jest.fn(), mockResolveSignature = jest.fn(), mockResolveImpactSource = jest.fn(), mockInspectImpactSource = jest.fn(), mockAssign = jest.fn();
const mockClient = { query: (...args: unknown[]) => mockQuery(...args), queryOne: async (...args: unknown[]) => (await mockQuery(...args)).rows[0] ?? null };
jest.mock('../../src/config/database', () => ({ query: (...args: unknown[]) => mockQuery(...args), queryOne: (...args: unknown[]) => mockClient.queryOne(...args),
  transaction: (fn: (client: unknown) => unknown) => fn(mockClient) }));
jest.mock('../../src/services/training-authority.service', () => ({
  // Current exact-scope training managers; the native source stays current; the learner keeps the declared role.
  resolveImpactSource: (...args: unknown[]) => mockResolveImpactSource(...args), inspectImpactSource: (...args: unknown[]) => mockInspectImpactSource(...args),
  resolveObligationScope: jest.fn(async () => ({ eligible: true, roles: ['coordinator'] })), resolveSignature: (...args: unknown[]) => mockResolveSignature(...args),
}));
jest.mock('../../src/services/training-obligations.service', () => ({ ...jest.requireActual('../../src/services/training-obligations.service'),
  assignObligationInTransaction: (...args: unknown[]) => mockAssign(...args) }));

import { applyImpactPlan, readImpactSignatureSubject, reviewImpactPlan } from '../../src/services/training-impact.service';
import { bindSignatureReceipt, impactReviewSubject, readSignatureReceipt } from '../../src/services/training-signatures.service';

const planId = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', observation = `sha256:${'e'.repeat(64)}`, authorityHash = `sha256:${'9'.repeat(64)}`;
const plan = { schemaVersion: 'training-impact-plan/1', idempotencyKey: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', scope: { studyId: 100, siteId: 101 },
  source: { nativeSourceHash: 'f'.repeat(64), lifecycleRevision: 3, originals: [] }, reason: 'SYNTHETIC ENGINEERING STUDY. NOT A REAL TRIAL. Impact mapping.',
  actions: [{ kind: 'assign', request: { userId: 22, courseId: 3, contentRevision: 1, role: 'coordinator', scope: { studyId: 100, siteId: 101, armId: 5 }, dueAt: '2026-11-01T00:00:00Z',
    reason: 'Synthetic affected duty' } }] };
const proposer = { actorUserId: 11, accessToken: 'proposer-token' }, reviewer = { actorUserId: 44, accessToken: 'reviewer-token' }, other = { actorUserId: 45, accessToken: 'other-token' };
const subject = impactReviewSubject({ planId, reviewedRevision: 1, planHash: trainingEvidenceHash(plan), sourceObservationHash: observation, proposerUserId: 11, context: { studyId: 100, siteId: 101 } });
const signedReview = (patch: Record<string, unknown> = {}) => signatureReceipt({ decision: 'impact-review', signerUserId: 44, subjectHash: trainingEvidenceHash(subject), ...patch });
let row: any, events: any[], audits: any[][], store: ReturnType<typeof signatureStore>;

beforeEach(() => {
  delete process.env.TRAINING_IMPACT_REVIEW_SIGNATURE_REQUIRED;
  row = { id: planId, idempotencyKey: plan.idempotencyKey, createdBy: 11, plan, planHash: trainingEvidenceHash(plan),
    sourceObservation: { scope: plan.scope, source: plan.source, sourceObservationHash: observation, scopeFingerprint: `sha256:${'5'.repeat(64)}`, actorAuthorityHash: authorityHash },
    status: 'proposed', revision: 1, reviewedBy: null, reviewedAt: null, reviewReason: null, reviewAuthority: null, cancellationReason: null, application: null };
  events = []; audits = []; store = signatureStore();
  mockResolveImpactSource.mockReset().mockImplementation(async (_authority: unknown, scope: unknown, source: unknown) => ({ scope, source, sourceObservationHash: observation,
    scopeFingerprint: `sha256:${'5'.repeat(64)}`, actorAuthorityHash: authorityHash }));
  mockInspectImpactSource.mockReset().mockResolvedValue({});
  mockAssign.mockReset().mockResolvedValue({ id: 9, revision: 1 });
  mockResolveSignature.mockReset().mockImplementation(async (_authority: unknown, r: any, signed: unknown) => {
    expect(trainingEvidenceHash(signed)).toBe(r.subjectHash); return edcConfirmation(r);
  });
  mockQuery.mockReset().mockImplementation(async (sql: string, params: any[] = []) => {
    const bound = await store.query(sql, params); if (bound) return bound;
    const rows = (...values: any[]) => ({ rows: values, rowCount: values.length });
    if (sql.startsWith('SET TRANSACTION')) return rows();
    if (sql.startsWith('SELECT * FROM acc_training_impact_plans WHERE id=$1')) return rows(structuredClone(row));
    if (sql.startsWith('UPDATE acc_training_impact_plans SET status=$2')) {
      Object.assign(row, { status: params[1], revision: row.revision + 1, reviewedBy: params[2], reviewedAt: new Date(), reviewReason: params[3], reviewAuthority: JSON.parse(params[4]) });
      return rows(structuredClone(row));
    }
    if (sql.startsWith("UPDATE acc_training_impact_plans SET status='applied'")) { Object.assign(row, { status: 'applied', revision: row.revision + 1, application: JSON.parse(params[1]) }); return rows(structuredClone(row)); }
    if (sql.startsWith('INSERT INTO acc_training_impact_events')) { events.push({ planId: params[0], revision: params[1], action: params[3] }); return rows(); }
    if (sql.startsWith('SELECT revision FROM acc_training_impact_events')) return rows(...events.filter(e => e.planId === params[0] && e.action === 'training_impact_reviewed'));
    if (sql.includes('INSERT INTO acc_training_audit_log')) { audits.push(params); return rows(); }
    if (sql.startsWith('SELECT * FROM acc_training_courses WHERE id=$1')) return rows({ id: 3, active: true, contentRevision: 1 });
    if (sql.startsWith('SELECT id FROM acc_training_courses')) return rows();
    throw new Error(`Unexpected impact query: ${sql}`);
  });
});
afterAll(() => { delete process.env.TRAINING_IMPACT_REVIEW_SIGNATURE_REQUIRED; });
const review = (patch: Record<string, unknown> = {}) => ({ expectedRevision: 1, accepted: true, reason: 'Synthetic independent impact review', ...patch });
const auditActions = () => audits.map(params => params[1]);
const writes = () => mockQuery.mock.calls.filter(([sql]) => /^(UPDATE|INSERT)/.test(String(sql)));
const signatureReads = () => mockQuery.mock.calls.filter(([sql]) => String(sql).includes('acc_training_decision_signatures'));

describe('training-impact-review-subject/1', () => {
  test.each(impactReviewVectors.map(v => [v.name, v] as const))('vector %s: canonical JSON and hash reproduce, and the subject conforms', (_name, vector) => {
    expect(canonicalTrainingEvidence(vector.subject)).toBe(vector.canonical);
    expect(trainingEvidenceHash(vector.subject)).toBe(vector.subjectHash);
    expect(conformsTo('training-impact-review-subject/1', vector.subject)).toBe('valid');
    // A new contract, not a new kind of training-signature-subject/1: the published v1 schema still refuses it.
    expect(conformsTo('training-signature-subject/1', vector.subject)).not.toBe('valid');
    const { planId: id, reviewedRevision, planHash, sourceObservationHash, proposerUserId, context } = vector.subject;
    expect(impactReviewSubject({ planId: id.toUpperCase(), reviewedRevision, planHash, sourceObservationHash, proposerUserId, context })).toEqual(vector.subject);
  });
  test('names the plan, its hash and source observation and the proposer, never a learner or arm', () => {
    expect(Object.keys(subject).sort()).toEqual(['context', 'disposition', 'kind', 'planHash', 'planId', 'proposerUserId', 'reviewedRevision', 'schemaVersion', 'sourceObservationHash']);
    expect(JSON.stringify(subject)).not.toMatch(/armId|learner|userId"?:22/);
  });
  test.each([['a plan ID that is not a UUID', { planId: 'plan-1' }], ['a bare source hash', { sourceObservationHash: 'e'.repeat(64) }], ['a zero revision', { reviewedRevision: 0 }],
    ['an arm in the context', { context: { studyId: 100, armId: 5 } }]])('refuses %s', (_name, patch) => {
    expect(() => impactReviewSubject({ planId, reviewedRevision: 1, planHash: 'd'.repeat(64), sourceObservationHash: observation, proposerUserId: 11, context: { studyId: 100 }, ...patch } as any))
      .toThrow();
  });
});

describe('signed impact review', () => {
  test('a reviewer reads the exact proposed plan subject; the proposer cannot', async () => {
    expect(await readImpactSignatureSubject(reviewer, planId)).toEqual({ subject, subjectHash: trainingEvidenceHash(subject), binding: { status: 'unbound' } });
    expect(mockInspectImpactSource).toHaveBeenCalledTimes(2);
    await expect(readImpactSignatureSubject(proposer, planId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(readImpactSignatureSubject(reviewer, 'not-a-plan')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('an accepted signed review binds the reviewer\'s signature in its own transaction, once, and the same receipt replays', async () => {
    const signed: any = await reviewImpactPlan(reviewer, planId, review({ signatureReceipt: signedReview() }));
    expect(signed).toMatchObject({ status: 'reviewed', revision: 2, reviewedBy: 44, replayed: false, signature: { signatureId: 501, subjectHash: trainingEvidenceHash(subject), signedAt: '2026-10-24T09:20:00.000Z' } });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ decision: 'impact-review', impactPlanId: planId, signerUserId: 44, recordId: null, draftId: null, assessmentCycleId: null, subject });
    expect(auditActions()).toEqual(['training_impact_reviewed', 'training_signature_bound']);
    expect(JSON.parse(audits[1][4])).toEqual({ planId, signatureId: 501, decision: 'impact-review', subjectHash: trainingEvidenceHash(subject), signedAt: '2026-10-24T09:20:00.000Z' });
    expect(mockResolveSignature).toHaveBeenCalledWith(reviewer, expect.objectContaining({ decision: 'impact-review', signatureId: 501 }), subject);
    // The recorded reviewer reads the same subject, now bound; the same signed review replays without a second review or row.
    expect(await readImpactSignatureSubject(reviewer, planId)).toEqual({ subject, subjectHash: trainingEvidenceHash(subject),
      binding: { status: 'bound', signatureId: 501, requestKey: signedReview().requestKey, signerUserId: 44, signedAt: '2026-10-24T09:20:00.000Z' } });
    await expect(readImpactSignatureSubject(other, planId)).rejects.toMatchObject({ statusCode: 403 });
    expect(await reviewImpactPlan(reviewer, planId, review({ signatureReceipt: signedReview() }))).toMatchObject({ replayed: true, revision: 2, signature: { signatureId: 501 } });
    expect(store.rows).toHaveLength(1); expect(events).toHaveLength(1);
    // Another signature for the reviewed plan neither replays nor reviews again.
    await expect(reviewImpactPlan(reviewer, planId, review({ signatureReceipt: signedReview({ signatureId: 502 }) }))).rejects.toMatchObject({ statusCode: 409 });
    expect(store.rows).toHaveLength(1);
  });

  test('an unsigned review is unchanged: no signature read, no binding, the same returned plan', async () => {
    const reviewed: any = await reviewImpactPlan(reviewer, planId, review());
    expect(reviewed).toEqual(row); expect('signature' in reviewed).toBe(false);
    expect(signatureReads()).toEqual([]); expect(mockResolveSignature).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(['training_impact_reviewed']);
  });

  test.each([
    ['a rejection', review({ accepted: false, signatureReceipt: signedReview() }), 400],
    ['a malformed receipt', review({ signatureReceipt: { ...signedReview(), password: 'never forwarded' } }), 400],
    ['a receipt over another subject', review({ signatureReceipt: signedReview({ subjectHash: 'd'.repeat(64) }) }), 409],
    ['a receipt for another decision', review({ signatureReceipt: signedReview({ decision: 'material-approval' }) }), 409],
    ['a receipt signed by someone else', review({ signatureReceipt: signedReview({ signerUserId: 45 }) }), 403],
    ['a receipt over a stale revision', review({ signatureReceipt: signedReview({ subjectHash: trainingEvidenceHash({ ...subject, reviewedRevision: 2 }) }) }), 409],
  ])('%s cannot carry a review signature: refused before any write or native source read', async (_name, body, status) => {
    await expect(reviewImpactPlan(reviewer, planId, body)).rejects.toMatchObject({ statusCode: status });
    expect(row.status).toBe('proposed'); expect(writes()).toEqual([]); expect(store.rows).toHaveLength(0);
    expect(mockResolveImpactSource).not.toHaveBeenCalled(); expect(mockResolveSignature).not.toHaveBeenCalled();
  });

  test('the proposer cannot sign their own plan\'s review', async () => {
    await expect(reviewImpactPlan(proposer, planId, review({ signatureReceipt: signedReview({ signerUserId: 11 }) }))).rejects.toMatchObject({ statusCode: 403 });
    expect(writes()).toEqual([]);
  });
});

describe('apply of a signed or unsigned review', () => {
  const apply = () => applyImpactPlan(proposer, planId, { expectedRevision: 2 });
  test('an unsigned review applies as before while TRAINING_IMPACT_REVIEW_SIGNATURE_REQUIRED is unset', async () => {
    await reviewImpactPlan(reviewer, planId, review());
    expect(await apply()).toMatchObject({ status: 'applied', revision: 3 });
    expect(mockAssign).toHaveBeenCalledTimes(1);
  });
  test.each([['true', 409], ['false', 200], ['1', 200]])('with the switch %s an unsigned review is %s, read on every call', async (value, status) => {
    await reviewImpactPlan(reviewer, planId, review());
    process.env.TRAINING_IMPACT_REVIEW_SIGNATURE_REQUIRED = value;
    if (status === 409) {
      await expect(apply()).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Part 11 signed') });
      expect(row.status).toBe('reviewed'); expect(mockAssign).not.toHaveBeenCalled();
      // The switch is read per call: unset, the same plan applies.
      delete process.env.TRAINING_IMPACT_REVIEW_SIGNATURE_REQUIRED;
    }
    expect(await apply()).toMatchObject({ status: 'applied' });
  });
  test('a signed review applies with the switch on', async () => {
    await reviewImpactPlan(reviewer, planId, review({ signatureReceipt: signedReview() }));
    process.env.TRAINING_IMPACT_REVIEW_SIGNATURE_REQUIRED = 'true';
    expect(await apply()).toMatchObject({ status: 'applied', revision: 3 });
    expect(mockAssign).toHaveBeenCalledTimes(1);
  });
  test('a retained binding that does not name the reviewed plan is refused before any write, switch or not', async () => {
    await reviewImpactPlan(reviewer, planId, review());
    // A binding over another revision of this plan, as a defective writer might have left it.
    const stale = { ...subject, reviewedRevision: 2 }, receipt = readSignatureReceipt(signedReview({ subjectHash: trainingEvidenceHash(stale) }));
    await bindSignatureReceipt(store.client, receipt, edcConfirmation(receipt), { decision: 'impact-review', subject: stale as any, subjectHash: trainingEvidenceHash(stale), signerUserId: 44, impactPlanId: planId });
    mockQuery.mockClear();
    await expect(apply()).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('does not match') });
    expect(writes()).toEqual([]); expect(mockAssign).not.toHaveBeenCalled(); expect(row.status).toBe('reviewed');
  });
});

describe('binding table target', () => {
  test('an impact review binds by plan only; the plan slot holds one signature', async () => {
    const { client, rows } = signatureStore(), r = readSignatureReceipt(signedReview()), hash = trainingEvidenceHash(subject);
    await expect(bindSignatureReceipt(client, r, edcConfirmation(r), { decision: 'impact-review', subject, subjectHash: hash, signerUserId: 44, impactPlanId: planId, draftId: planId }))
      .rejects.toMatchObject({ statusCode: 500 });
    await expect(bindSignatureReceipt(client, r, edcConfirmation(r), { decision: 'impact-review', subject, subjectHash: hash, signerUserId: 44 })).rejects.toMatchObject({ statusCode: 500 });
    expect((await bindSignatureReceipt(client, r, edcConfirmation(r), { decision: 'impact-review', subject, subjectHash: hash, signerUserId: 44, impactPlanId: planId.toUpperCase() })).binding)
      .toMatchObject({ decision: 'impact-review', impactPlanId: planId, recordId: null, draftId: null });
    const second = readSignatureReceipt(signedReview({ signatureId: 502, requestKey: '9b2d4a8e-1c3f-4e5a-8b7c-6d5e4f3a2b1c' }));
    await expect(bindSignatureReceipt(client, second, edcConfirmation(second), { decision: 'impact-review', subject, subjectHash: hash, signerUserId: 44, impactPlanId: planId }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('different signature') });
    expect(rows).toHaveLength(1);
  });
});
