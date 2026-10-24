/**
 * training-duty-policy/2 and training-duty-readiness/2 (T-3): a pin complete by the /1 rules also needs the learner's
 * attestation, the recorded verifier's signature and, for governed material, the reviewer's approval; /1 is answered
 * exactly as before. Obligations, courses, records and bindings come from a fake local snapshot and the native scope
 * answer is fixed; the owned PostgreSQL suite runs the same rules over real rows. Replies are validated against this
 * repository's own contracts/training-duty-readiness-v2.schema.json. Synthetic values only.
 */
const mockTransaction = jest.fn(), mockScope = jest.fn(), mockPublication = jest.fn();
jest.mock('../../src/config/database', () => ({ transaction: (fn: unknown) => mockTransaction(fn) }));
jest.mock('../../src/config/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/config/environment', () => ({ config: { authority: { baseUrl: 'https://authority.invalid', timeoutMs: 1000 } } }));
jest.mock('../../src/services/training-authority.service', () => ({
  ...jest.requireActual('../../src/services/training-authority.service'), resolveObligationScope: (...args: unknown[]) => mockScope(...args),
}));
// Assessment closure is covered by its own tests; here a retained cycle counts as verified.
jest.mock('../../src/services/training-assessment-evidence', () => ({
  ...jest.requireActual('../../src/services/training-assessment-evidence'),
  verifyRecordAssessment: async (_client: unknown, record: { assessmentCycleId?: string | null; assessmentEvidenceVerified?: boolean }) => { record.assessmentEvidenceVerified = Boolean(record.assessmentCycleId); },
}));
jest.mock('../../src/services/training-materials.service', () => ({
  publishedMaterial: async (_client: unknown, course: { materialScope?: unknown }) => course.materialScope ? mockPublication() : null,
  observePublication: async () => ({ observed: 'synthetic material source' }), assertMaterialUse: jest.fn(), validateInspectionMaterial: jest.fn(),
}));

import { trainingEvidenceHash } from '../../src/services/audit.service';
import { bindSignatureReceipt, materialApprovalSubject, readSignatureReceipt, recordDecisionSubject } from '../../src/services/training-signatures.service';
import { getDutyReadiness, trainingDutyHash } from '../../src/services/training-obligations.service';
import { conformsTo, edcConfirmation, SIGNATURE_CYCLE, signatureDraft, signatureReceipt, signatureRecord, signatureStore } from '../fixtures/training-signature-fixtures';

const receipt = (patch: Record<string, unknown> = {}): any => signatureReceipt({ meaning: 'SYNTHETIC attestation meaning', ...patch });
const confirmation = edcConfirmation;

describe('training-duty-policy/2 and training-duty-readiness/2', () => {
  const authority = { actorUserId: 22, accessToken: 'request-local-native-token' };
  const pin = { id: 9, revision: 1, courseId: 3, courseVersion: '1.0', contentRevision: 4 };
  const policy = (version: 1 | 2): any => ({ schemaVersion: `training-duty-policy/${version}`, scope: { studyId: 100, siteId: 101 }, ...(version === 2 ? { signatures: 'part11-required' } : {}),
    assignments: [{ userId: 22, role: 'coordinator', disposition: 'required', rationale: 'Synthetic delegated data entry', duties: ['data_entry'], obligations: [pin] }] });
  const request = (version: 1 | 2, policyVersion: 1 | 2 = version) => ({ schemaVersion: `training-duty-readiness-request/${version}`, nonce: 'd'.repeat(32),
    policy: policy(policyVersion), actorUserId: 22, duty: 'data_entry', armIds: [] });
  const obligation = { id: 9, userId: 22, courseId: 3, courseVersion: '1.0', contentRevision: 4, role: 'coordinator', scope: { studyId: 100, siteId: 101 }, status: 'assigned',
    revision: 1, dueAt: '2026-11-01T00:00:00.000Z', reason: 'Synthetic', assignedBy: 11 };
  let course: any, store: ReturnType<typeof signatureStore>, queries: string[];
  const publication = { id: '5a5a5a5a-1b1b-4c4c-8d8d-9e9e9e9e9e9e', courseId: 3, draftId: signatureDraft.draftId.toLowerCase(), contentRevision: 4,
    receipt: { schemaVersion: 'training-material-publication/1', draftId: signatureDraft.draftId.toLowerCase(), requestHash: signatureDraft.requestHash, courseId: 3, authorUserId: 11, reviewerUserId: 44,
      source: { scope: { studyId: 100, siteId: 101 }, armIds: [], originals: [], sourceHash: signatureDraft.sourceHash } } };
  beforeEach(() => {
    course = { id: 3, courseCode: 'SYN-DUTY', active: true, version: '1.0', contentRevision: 4, materialScope: null };
    store = signatureStore(); queries = []; mockTransaction.mockReset();
    mockPublication.mockReturnValue(publication);
    mockScope.mockImplementation(async (_context, _action, userId: number, scope: unknown) => ({ scope, userId, eligible: true, roles: ['coordinator'],
      observationHash: `sha256:${'1'.repeat(64)}`, scopeFingerprint: `sha256:${'2'.repeat(64)}` }));
    mockTransaction.mockImplementation(async (fn: (client: unknown) => unknown) => fn({ query: async (sql: string, params?: any[]) => {
      queries.push(sql);
      if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
      if (sql.startsWith('SELECT * FROM acc_training_obligations')) return { rows: [obligation] };
      if (sql.startsWith('SELECT * FROM acc_training_courses')) return { rows: [course] };
      if (sql.startsWith('SELECT * FROM acc_training_records')) return { rows: [signatureRecord()] };
      return store.client.query(sql, params);
    } }));
  });
  async function bind(decision: 'completion-attestation' | 'verification', signer: number, signatureId: number, subjectPatch: Record<string, unknown> = {}) {
    const subject = { ...recordDecisionSubject(decision, signatureRecord(), { studyId: 100, siteId: 101 }), ...subjectPatch }, subjectHash = trainingEvidenceHash(subject);
    const r = readSignatureReceipt(receipt({ decision, signerUserId: signer, signatureId, requestKey: `3f2504e0-4f89-41d3-9a0c-0305e82c${String(signatureId).padStart(4, '0')}`, subjectHash }));
    await bindSignatureReceipt(store.client, r, confirmation(r), { decision, subject: subject as any, subjectHash, signerUserId: signer, recordId: 7, assessmentCycleId: SIGNATURE_CYCLE });
  }
  async function bindApproval(signer: number) {
    const subject = materialApprovalSubject(signatureDraft), subjectHash = trainingEvidenceHash(subject);
    const r = readSignatureReceipt(receipt({ decision: 'material-approval', signerUserId: signer, signatureId: 600, requestKey: '3f2504e0-4f89-41d3-9a0c-0305e82c0600', subjectHash }));
    await bindSignatureReceipt(store.client, r, confirmation(r), { decision: 'material-approval', subject, subjectHash, signerUserId: signer, draftId: subject.draftId });
  }
  const evidenceHashHolds = (reply: any) => { const { schemaVersion: _v, nonce: _n, observedAt: _o, consistency: _c, evidenceHash, ...evidence } = reply; return trainingDutyHash(evidence) === evidenceHash; };

  test.each([[1, 2], [2, 1]] as const)('request /%s with a /%s policy is refused before any read', async (version, policyVersion) => {
    await expect(getDutyReadiness(authority, request(version, policyVersion))).rejects.toMatchObject({ statusCode: 400 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  test('/1 is answered exactly as before: no signature read and no signatures key', async () => {
    const reply: any = await getDutyReadiness(authority, request(1));
    expect(reply).toMatchObject({ schemaVersion: 'training-duty-readiness/1', ready: true, blockers: [] });
    expect(Object.keys(reply.assignments[0].obligations[0]).sort()).toEqual(['completedAt', 'certificateNumber', 'contentRevision', 'courseId', 'courseVersion', 'id', 'readiness',
      'recordId', 'retainedScope', 'retainedScopeObservationHash', 'revision', 'verifiedAt', 'verifiedBy'].sort());
    expect(queries.some(sql => sql.includes('acc_training_decision_signatures'))).toBe(false);
    expect(evidenceHashHolds(reply)).toBe(true);
  });
  test('/2: a verified but unsigned completion is signature_required, its blocker names no arm, and the reply conforms', async () => {
    const reply: any = await getDutyReadiness(authority, request(2));
    expect(reply).toMatchObject({ schemaVersion: 'training-duty-readiness/2', ready: false, blockers: ['Learner 22, obligation 9: signature_required.'] });
    expect(reply.assignments[0].obligations[0]).toMatchObject({ readiness: 'signature_required', signatures: { attestation: null, verification: null, materialApproval: null } });
    expect(conformsTo('training-duty-readiness/2', reply)).toBe('valid'); expect(evidenceHashHolds(reply)).toBe(true);
    await bind('completion-attestation', 22, 501);
    const attestedOnly: any = await getDutyReadiness(authority, request(2));
    expect(attestedOnly.assignments[0].obligations[0]).toMatchObject({ readiness: 'signature_required', signatures: { attestation: { signatureId: 501 }, verification: null } });
  });
  test('/2: the learner\'s attestation and the recorded verifier\'s signature make the pin complete, citing the signed subjects', async () => {
    await bind('completion-attestation', 22, 501); await bind('verification', 33, 502);
    const reply: any = await getDutyReadiness(authority, request(2));
    expect(reply).toMatchObject({ ready: true, blockers: [] });
    const cited = reply.assignments[0].obligations[0];
    expect(cited.readiness).toBe('complete');
    expect(cited.signatures.attestation).toEqual({ signatureId: 501, subjectHash: trainingEvidenceHash(cited.signatures.attestation.subject), subject: recordDecisionSubject('completion-attestation', signatureRecord(), { studyId: 100, siteId: 101 }) });
    expect(cited.signatures.verification.subject.kind).toBe('verification'); expect(cited.signatures.materialApproval).toBeNull();
    expect(conformsTo('training-duty-readiness/2', reply)).toBe('valid'); expect(evidenceHashHolds(reply)).toBe(true);
  });
  test('/2: a retained binding that no longer matches its completion refuses the observation instead of reading as unsigned', async () => {
    await bind('completion-attestation', 22, 501, { certificateNumber: 'AT-CERT-SYN-OTHER' }); await bind('verification', 33, 502);
    await expect(getDutyReadiness(authority, request(2))).rejects.toMatchObject({ statusCode: 409 });
  });
  test('/2: a verification signed by someone other than the recorded verifier refuses the observation', async () => {
    await bind('completion-attestation', 22, 501); await bind('verification', 34, 502);
    await expect(getDutyReadiness(authority, request(2))).rejects.toMatchObject({ statusCode: 409 });
  });
  test('/2: governed material also needs the reviewer\'s approval of the current publication', async () => {
    course = { ...course, materialScope: { studyId: 100, siteId: 101 } };
    await bind('completion-attestation', 22, 501); await bind('verification', 33, 502);
    const unapproved: any = await getDutyReadiness(authority, request(2));
    expect(unapproved.assignments[0].obligations[0]).toMatchObject({ readiness: 'signature_required', signatures: { materialApproval: null } });
    await bindApproval(44);
    const approved: any = await getDutyReadiness(authority, request(2));
    expect(approved).toMatchObject({ ready: true });
    expect(approved.assignments[0].obligations[0].signatures.materialApproval).toMatchObject({ signatureId: 600, subject: { kind: 'material-approval', authorUserId: 11 } });
    expect(conformsTo('training-duty-readiness/2', approved)).toBe('valid');
  });
  test('/2: an approval signed by the author never satisfies governed material', async () => {
    course = { ...course, materialScope: { studyId: 100, siteId: 101 } };
    await bind('completion-attestation', 22, 501); await bind('verification', 33, 502); await bindApproval(11);
    await expect(getDutyReadiness(authority, request(2))).rejects.toMatchObject({ statusCode: 409 });
  });
});
