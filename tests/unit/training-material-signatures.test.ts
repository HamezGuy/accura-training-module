/**
 * Part 11 material approval (T-3): the reviewer's signature over the exact accepted draft, bound in the review's
 * transaction or afterwards by the recorded reviewer, and named in later publication receipts. The native authority
 * and the EDC confirmation are fakes here; the EDC's native material suite runs them for real. Synthetic data only.
 */
import { trainingEvidenceHash } from '../../src/services/audit.service';
import { edcConfirmation, signatureReceipt, signatureStore } from '../fixtures/training-signature-fixtures';

const mockQuery = jest.fn(), mockResolveSignature = jest.fn();
const mockClient = { query: (...args: unknown[]) => mockQuery(...args), queryOne: async (...args: unknown[]) => (await mockQuery(...args)).rows[0] ?? null };
jest.mock('../../src/config/database', () => ({ query: (...args: unknown[]) => mockQuery(...args), queryOne: (...args: unknown[]) => mockClient.queryOne(...args),
  transaction: (fn: (client: unknown) => unknown) => fn(mockClient) }));
jest.mock('../../src/services/training-authority.service', () => ({
  // Current exact-scope training manager for every actor; the source stays current.
  inspectImpactSource: jest.fn(async () => ({})), resolveObligationScope: jest.fn(),
  observeMaterialSource: jest.fn(async (_authority: unknown, source: unknown) => ({ source, authorityHash: `sha256:${'9'.repeat(64)}` })),
  resolveSignature: (...args: unknown[]) => mockResolveSignature(...args),
}));

import { publishMaterialDraft, readMaterialSignatureSubject, reviewMaterialDraft, signMaterialApproval } from '../../src/services/training-materials.service';
import { materialApprovalSubject } from '../../src/services/training-signatures.service';

const draftId = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', fileId = '4b3a2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d';
const request = { schemaVersion: 'training-material-draft/1', idempotencyKey: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', courseId: null, expectedContentRevision: 0, expectedDraftId: null,
  source: { scope: { studyId: 100, siteId: 101 }, armIds: [], originals: [{ kind: 'duty', fileId, sha256: 'f'.repeat(64) }], sourceHash: 'c'.repeat(64) },
  reason: 'SYNTHETIC ENGINEERING STUDY. NOT A REAL TRIAL. Duty material for qualification.',
  material: { courseCode: 'SYN-DUTY', courseName: 'Synthetic duty', description: '', version: '1', passingScore: 80, durationMinutes: null, validityPeriodDays: 365, active: true,
    intendedUse: 'synthetic_qualification', lessons: [{ title: 'Synthetic lesson', text: 'SYNTHETIC ENGINEERING STUDY. NOT A REAL TRIAL.', citations: [{ fileId, locator: 'page 1' }] }],
    questions: [{ questionText: 'Synthetic question?', questionType: 'true_false', options: [{ text: 'Yes', isCorrect: true }, { text: 'No', isCorrect: false }], explanation: '' }] } };
const author = { actorUserId: 11, accessToken: 'author-token' }, reviewer = { actorUserId: 44, accessToken: 'reviewer-token' }, other = { actorUserId: 45, accessToken: 'other-token' };
const subject = materialApprovalSubject({ draftId, draftRevision: 1, requestHash: trainingEvidenceHash(request), courseId: 3, authorUserId: 11, sourceHash: 'c'.repeat(64),
  context: { studyId: 100, siteId: 101 } });
const approval = (patch: Record<string, unknown> = {}) => signatureReceipt({ decision: 'material-approval', signerUserId: 44, subjectHash: trainingEvidenceHash(subject), ...patch });
let draft: any, course: any, events: any[], audits: any[][], publications: any[], store: ReturnType<typeof signatureStore>;

beforeEach(() => {
  draft = { id: draftId, courseId: 3, createdBy: 11, idempotencyKey: request.idempotencyKey, request, requestHash: trainingEvidenceHash(request), authorAuthorityHash: `sha256:${'8'.repeat(64)}`,
    status: 'draft', revision: 1, reviewedBy: null, reviewAuthorityHash: null, reviewReason: null, reviewedAt: null, createdAt: new Date() };
  course = { id: 3, courseCode: 'SYN-DUTY', version: '1', contentRevision: 1, active: false, materialScope: { studyId: 100, siteId: 101 }, materialDraftId: draftId, materialPublicationId: null };
  events = []; audits = []; publications = []; store = signatureStore();
  mockResolveSignature.mockReset().mockImplementation(async (_authority: unknown, r: any, signed: unknown) => {
    expect(trainingEvidenceHash(signed)).toBe(r.subjectHash); return edcConfirmation(r);
  });
  mockQuery.mockReset().mockImplementation(async (sql: string, params: any[] = []) => {
    const bound = await store.query(sql, params); if (bound) return bound;
    const rows = (...values: any[]) => ({ rows: values, rowCount: values.length });
    if (sql.startsWith('SET TRANSACTION')) return rows();
    if (sql.startsWith('SELECT * FROM acc_training_material_drafts WHERE id=$1')) return rows(structuredClone(draft));
    if (sql.startsWith('SELECT * FROM acc_training_courses WHERE id=$1')) return rows({ ...course });
    if (sql.startsWith('UPDATE acc_training_material_drafts SET status=$2')) {
      Object.assign(draft, { status: params[1], revision: draft.revision + 1, reviewedBy: params[2], reviewAuthorityHash: params[3], reviewReason: params[4], reviewedAt: new Date() });
      return rows(structuredClone(draft));
    }
    if (sql.startsWith("UPDATE acc_training_material_drafts SET status='published'")) { Object.assign(draft, { status: 'published', revision: draft.revision + 1 }); return rows(structuredClone(draft)); }
    if (sql.startsWith('INSERT INTO acc_training_material_events')) { events.push({ draftId: params[0], revision: params[1], action: params[3] }); return rows(); }
    if (sql.startsWith("SELECT revision FROM acc_training_material_events")) return rows(...events.filter(e => e.draftId === params[0] && e.action === 'training_material_reviewed'));
    if (sql.includes('INSERT INTO acc_training_audit_log')) { audits.push(params); return rows(); }
    if (sql.startsWith('UPDATE acc_training_courses SET course_name')) { course = { ...course, contentRevision: course.contentRevision + 1, active: true }; return rows({ ...course }); }
    if (sql.startsWith('INSERT INTO acc_training_material_publications')) { publications.push(JSON.parse(params[6])); return rows(); }
    if (/^(DELETE FROM|INSERT INTO) acc_training_(slides|questions)|^UPDATE acc_training_courses SET material_publication_id|^SELECT id,(title|question_text)/.test(sql)) return rows();
    throw new Error(`Unexpected material query: ${sql}`);
  });
});
const review = (patch: Record<string, unknown> = {}) => ({ expectedRevision: 1, requestHash: trainingEvidenceHash(request), accepted: true, reason: 'Synthetic independent review', ...patch });
const auditActions = () => audits.map(params => params[1]);

test('the reviewer reads the exact unreviewed draft subject; the author cannot', async () => {
  expect(await readMaterialSignatureSubject(reviewer, draftId)).toEqual({ subject, subjectHash: trainingEvidenceHash(subject), binding: { status: 'unbound' } });
  await expect(readMaterialSignatureSubject(author, draftId)).rejects.toMatchObject({ statusCode: 403 });
});

test('an accepted signed review binds the reviewer\'s approval in its own transaction, once', async () => {
  const signed: any = await reviewMaterialDraft(reviewer, draftId, review({ signatureReceipt: approval() }));
  expect(signed).toMatchObject({ status: 'reviewed', reviewedBy: 44, replayed: false, signature: { signatureId: 501, subjectHash: trainingEvidenceHash(subject) } });
  expect(store.rows).toHaveLength(1);
  expect(store.rows[0]).toMatchObject({ decision: 'material-approval', draftId, signerUserId: 44, recordId: null, subject });
  expect(auditActions()).toEqual(['training_material_reviewed', 'training_signature_bound']);
  expect(JSON.parse(audits[1][4])).toEqual({ draftId, signatureId: 501, decision: 'material-approval', subjectHash: trainingEvidenceHash(subject), signedAt: '2026-10-24T09:20:00.000Z' });
  // The subject read now reports the binding; the same signed review again replays without a second review or row.
  expect((await readMaterialSignatureSubject(reviewer, draftId)).binding).toMatchObject({ status: 'bound', signatureId: 501, signerUserId: 44 });
  expect(await reviewMaterialDraft(reviewer, draftId, review({ signatureReceipt: approval() }))).toMatchObject({ replayed: true, revision: 2 });
  expect(store.rows).toHaveLength(1); expect(events).toHaveLength(1);
});

test('an unsigned review is unchanged: no signature read, no binding, the same returned draft', async () => {
  const reviewed: any = await reviewMaterialDraft(reviewer, draftId, review());
  expect(reviewed).toEqual(draft); expect('signature' in reviewed).toBe(false);
  expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('acc_training_decision_signatures'))).toBe(false);
  expect(mockResolveSignature).not.toHaveBeenCalled();
});

test.each([
  ['a rejection', review({ accepted: false, signatureReceipt: approval() }), 400],
  ['a malformed receipt', review({ signatureReceipt: { ...approval(), password: 'never forwarded' } }), 400],
  ['a receipt over another subject', review({ signatureReceipt: approval({ subjectHash: 'd'.repeat(64) }) }), 409],
  ['a receipt signed by someone else', review({ signatureReceipt: approval({ signerUserId: 45 }) }), 403],
])('%s cannot carry an approval signature, and nothing is reviewed', async (_name, body, status) => {
  await expect(reviewMaterialDraft(reviewer, draftId, body)).rejects.toMatchObject({ statusCode: status });
  expect(draft.status).toBe('draft'); expect(store.rows).toHaveLength(0);
});

test('the recorded reviewer signs an accepted review afterwards; no one else can, and nothing is rewritten', async () => {
  await expect(signMaterialApproval(reviewer, draftId, { signatureReceipt: approval() })).rejects.toMatchObject({ statusCode: 409 });
  await reviewMaterialDraft(reviewer, draftId, review());
  await expect(signMaterialApproval(other, draftId, { signatureReceipt: approval({ signerUserId: 45 }) })).rejects.toMatchObject({ statusCode: 403 });
  await expect(signMaterialApproval(author, draftId, { signatureReceipt: approval({ signerUserId: 11 }) })).rejects.toMatchObject({ statusCode: 403 });
  const before = structuredClone(draft);
  expect(await signMaterialApproval(reviewer, draftId, { signatureReceipt: approval() })).toMatchObject({ draftId, signed: true, replayed: false, signature: { signatureId: 501 } });
  expect(draft).toEqual(before);
  expect(await signMaterialApproval(reviewer, draftId, { signatureReceipt: approval() })).toMatchObject({ replayed: true });
  expect(store.rows).toHaveLength(1); expect(auditActions()).toEqual(['training_material_reviewed', 'training_signature_bound']);
  await expect(signMaterialApproval(reviewer, draftId, { signatureReceipt: approval(), extra: true })).rejects.toMatchObject({ statusCode: 400 });
});

test('a publication names the bound approval signature, and null when the review was unsigned', async () => {
  await reviewMaterialDraft(reviewer, draftId, review({ signatureReceipt: approval() }));
  const published: any = await publishMaterialDraft(author, draftId, { expectedRevision: 2, requestHash: trainingEvidenceHash(request) });
  expect(published.publication.reviewSignature).toEqual({ signatureId: 501, subjectHash: trainingEvidenceHash(subject) });
  expect(publications[0].reviewSignature).toEqual(published.publication.reviewSignature);
  // The recorded reviewer can still sign the approval of a published draft; it replays the bound one here.
  expect(await signMaterialApproval(reviewer, draftId, { signatureReceipt: approval() })).toMatchObject({ replayed: true });

  draft = { ...draft, status: 'draft', revision: 1, reviewedBy: null, reviewAuthorityHash: null, reviewReason: null, reviewedAt: null };
  course = { ...course, contentRevision: 1, materialPublicationId: null }; store = signatureStore(); events = []; publications = [];
  await reviewMaterialDraft(reviewer, draftId, review());
  expect((await publishMaterialDraft(author, draftId, { expectedRevision: 2, requestHash: trainingEvidenceHash(request) }) as any).publication.reviewSignature).toBeNull();
});
