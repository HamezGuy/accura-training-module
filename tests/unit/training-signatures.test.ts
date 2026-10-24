/**
 * Part 11 signatures on training decisions (T-3): subject builders and the committed hash vectors, the EDC receipt
 * reader, the append-only binding and the EDC confirmation (authority op `signature`). Subjects built from records
 * are validated against this repository's own contracts/training-signature-subject-v1.schema.json. Synthetic values only.
 */
jest.mock('../../src/config/database', () => ({}));
jest.mock('../../src/config/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/config/environment', () => ({ config: { authority: { baseUrl: 'https://authority.invalid', timeoutMs: 1000 } } }));

import { canonicalTrainingEvidence, trainingEvidenceHash } from '../../src/services/audit.service';
import { bindSignatureReceipt, bindingStatus, materialApprovalSubject, readSignatureReceipt, recordDecisionSubject, signatureContext } from '../../src/services/training-signatures.service';
import { resolveSignature } from '../../src/services/training-authority.service';
import { conformsTo, edcConfirmation, SIGNATURE_CYCLE, signatureDraft, signatureReceipt, signatureRecord, signatureStore, signatureVectors } from '../fixtures/training-signature-fixtures';

const receipt = (patch: Record<string, unknown> = {}): any => signatureReceipt({ meaning: 'SYNTHETIC attestation meaning', signerUsername: 'syn_learner',
  signerFullName: 'Synthetic Learner', subjectHash: signatureVectors[0].subjectHash, ...patch });
const confirmation = edcConfirmation;
const inserts = (client: { query: jest.Mock }) => client.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT')).length;

describe('training-signature-subject/1', () => {
  test.each(signatureVectors.map(v => [v.name, v] as const))('vector %s: canonical JSON and hash reproduce, and the subject conforms', (_name, vector) => {
    expect(canonicalTrainingEvidence(vector.subject)).toBe(vector.canonical);
    expect(trainingEvidenceHash(vector.subject)).toBe(vector.subjectHash);
    expect(conformsTo('training-signature-subject/1', vector.subject)).toBe('valid');
  });

  test('a completion subject is the exact retained completion, the same for attestation and verification', () => {
    const attestation = recordDecisionSubject('completion-attestation', signatureRecord(), { studyId: 100, siteId: 101 });
    expect(attestation).toEqual(signatureVectors[0].subject);
    const verification = recordDecisionSubject('verification', signatureRecord({ verifiedBy: null, verifiedAt: null, notes: 'notes are not signed' }), { studyId: 100 });
    expect(verification).toEqual(signatureVectors[1].subject);
    for (const subject of [attestation, verification]) expect(conformsTo('training-signature-subject/1', subject)).toBe('valid');
    // No participant data and no arm: the subject never carries more than the completion and its context.
    expect(JSON.stringify(attestation)).not.toMatch(/arm|participant|subject_id/i);
  });

  test.each([
    ['in progress', { status: 'in_progress' }], ['marked expired', { status: 'expired' }], ['legacy summary-only', { assessmentCycleId: null, assessmentReceipt: null }],
    ['receipted in another cycle', { assessmentReceipt: { id: '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f', hash: 'a'.repeat(64), cycleId: '11111111-1111-4111-8111-111111111111', attemptNumber: 1 } }],
    ['without a certificate', { certificateNumber: null }], ['without a completion time', { completedAt: null }], ['without a content pin', { contentRevision: null }],
  ])('a record that is %s has no signable subject', (_name, patch) => {
    expect(() => recordDecisionSubject('completion-attestation', signatureRecord(patch), { studyId: 100 })).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  test('the material subject is the accepted immutable draft, with canonical lowercase identity', () => {
    const subject = materialApprovalSubject(signatureDraft);
    expect(subject).toEqual(signatureVectors[2].subject);
    expect(conformsTo('training-signature-subject/1', subject)).toBe('valid');
    expect(() => materialApprovalSubject({ ...signatureDraft, requestHash: 'B'.repeat(64) })).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  test.each([{ studyId: 100, armId: 5 }, { studyId: 0 }, { siteId: 101 }, { studyId: 100, siteId: '101' }, null, [100]])('context %j is refused', value => {
    expect(() => signatureContext(value)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('training-signature-receipt/1 reader', () => {
  test('an exact receipt is read with canonical lowercase keys', () => {
    const read = readSignatureReceipt(receipt({ requestKey: '3F2504E0-4F89-41D3-9A0C-0305E82C3301' }));
    expect(read).toEqual(receipt());
    expect(readSignatureReceipt(receipt({ edcEffort: null })).edcEffort).toBeNull();
    expect(readSignatureReceipt(receipt({ edcEffort: { requestId: '7d444840-9dc0-41d6-b2e5-1fbd3e2f3c4a', workStartedAt: '2026-10-24T09:10:00.000Z', startBasis: 'client-work-start' } })).edcEffort)
      .toEqual({ requestId: '7d444840-9dc0-41d6-b2e5-1fbd3e2f3c4a', workStartedAt: '2026-10-24T09:10:00.000Z', startBasis: 'client-work-start' });
  });
  test.each([
    ['an extra key', { password: 'never forwarded' }], ['a missing key', { edcEffort: undefined }], ['another version', { schemaVersion: 'training-signature-receipt/2' }],
    ['a version 1 request key', { requestKey: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }], ['an unknown decision', { decision: 'publication' }],
    ['an uppercase subject hash', { subjectHash: 'F'.repeat(64) }], ['an instant without zone', { signedAt: '2026-10-24T09:20:00' }],
    ['an arm in the context', { context: { studyId: 100, armId: 5 } }], ['an empty meaning', { meaning: ' ' }], ['a zero signature id', { signatureId: 0 }],
    ['a stated start with basis not-supplied', { edcEffort: { requestId: '7d444840-9dc0-41d6-b2e5-1fbd3e2f3c4a', workStartedAt: '2026-10-24T09:10:00.000Z', startBasis: 'not-supplied' } }],
    ['a client start without its instant', { edcEffort: { requestId: '7d444840-9dc0-41d6-b2e5-1fbd3e2f3c4a', workStartedAt: null, startBasis: 'client-work-start' } }],
  ])('a receipt with %s is refused 400, never dropped', (_name, patch) => {
    const value = receipt(patch); if ('edcEffort' in patch && patch.edcEffort === undefined) delete value.edcEffort;
    expect(() => readSignatureReceipt(value)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  test.each([['undefined', undefined], ['null', null], ['a string', 'receipt'], ['an array', [receipt()]]])('a non-object receipt (%s) is refused', (_name, value) => {
    expect(() => readSignatureReceipt(value)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('append-only binding', () => {
  const expected = (patch: Record<string, unknown> = {}): any => ({ decision: 'completion-attestation', subject: signatureVectors[0].subject, subjectHash: signatureVectors[0].subjectHash,
    signerUserId: 22, recordId: 7, assessmentCycleId: SIGNATURE_CYCLE, ...patch });
  test('binds a confirmed signature once; the same receipt again replays without a second row', async () => {
    const { client, rows } = signatureStore(), r = readSignatureReceipt(receipt());
    const first = await bindSignatureReceipt(client, r, confirmation(r), expected());
    expect(first.replayed).toBe(false);
    expect(first.binding).toMatchObject({ signatureId: 501, decision: 'completion-attestation', signerUserId: 22, recordId: 7, assessmentCycleId: SIGNATURE_CYCLE, draftId: null,
      subjectHash: signatureVectors[0].subjectHash, signedAt: '2026-10-24T09:20:00.000Z', context: { studyId: 100, siteId: 101 } });
    expect(rows[0].receipt).toEqual(r);
    const again = await bindSignatureReceipt(client, r, confirmation(r), expected());
    expect(again).toEqual({ binding: first.binding, replayed: true });
    expect(rows).toHaveLength(1); expect(inserts(client)).toBe(1);
    expect(bindingStatus(again.binding)).toEqual({ status: 'bound', signatureId: 501, requestKey: r.requestKey, signerUserId: 22, signedAt: '2026-10-24T09:20:00.000Z' });
    expect(bindingStatus(undefined)).toEqual({ status: 'unbound' });
  });
  test.each([
    ['a different subject hash', {}, { subjectHash: signatureVectors[1].subjectHash }, 409],
    ['a different decision', { decision: 'verification' }, {}, 409],
    ['a signer who is not the person deciding', { signerUserId: 23 }, {}, 403],
    ['a context other than the subject\'s', { context: { studyId: 100 } }, {}, 409],
  ])('refuses a receipt with %s before any row', async (_name, receiptPatch, expectedPatch, status) => {
    const { client } = signatureStore(), r = readSignatureReceipt(receipt(receiptPatch));
    await expect(bindSignatureReceipt(client, r, confirmation(r), expected(expectedPatch))).rejects.toMatchObject({ statusCode: status });
    expect(client.query).not.toHaveBeenCalled();
  });
  test.each([['signatureId', 502], ['meaning', 'another meaning'], ['signerFullName', 'Someone Else'], ['signedAt', '2026-10-24T09:21:00.000Z'], ['studyId', 100],
    ['effortRequestId', null], ['requestKey', '9b2d4a8e-1c3f-4e5a-8b7c-6d5e4f3a2b1c']] as const)('refuses an EDC confirmation whose %s differs from the receipt', async (field, value) => {
    const { client } = signatureStore(), r = readSignatureReceipt(receipt());
    await expect(bindSignatureReceipt(client, r, confirmation(r, { [field]: value }), expected())).rejects.toMatchObject({ statusCode: 409 });
    expect(client.query).not.toHaveBeenCalled();
  });
  test('a second signature for a signed decision, or one EDC signature for two decisions, is refused, never overwritten', async () => {
    const { client, rows } = signatureStore(), r = readSignatureReceipt(receipt());
    await bindSignatureReceipt(client, r, confirmation(r), expected());
    const other = readSignatureReceipt(receipt({ signatureId: 502, requestKey: '9b2d4a8e-1c3f-4e5a-8b7c-6d5e4f3a2b1c' }));
    await expect(bindSignatureReceipt(client, other, confirmation(other), expected())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('different signature') });
    const reused = readSignatureReceipt(receipt({ decision: 'verification', signerUserId: 22, subjectHash: signatureVectors[1].subjectHash, context: { studyId: 100 } }));
    await expect(bindSignatureReceipt(client, reused, confirmation(reused), expected({ decision: 'verification', subject: signatureVectors[1].subject, subjectHash: signatureVectors[1].subjectHash })))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('another training decision') });
    expect(rows).toHaveLength(1);
  });
  test('material approval binds by draft; matrix approval stays reserved', async () => {
    const { client, rows } = signatureStore(), subject = materialApprovalSubject(signatureDraft), hash = trainingEvidenceHash(subject);
    const r = readSignatureReceipt(receipt({ decision: 'material-approval', signerUserId: 44, subjectHash: hash }));
    const bound = await bindSignatureReceipt(client, r, confirmation(r), { decision: 'material-approval', subject, subjectHash: hash, signerUserId: 44, draftId: subject.draftId });
    expect(bound.binding).toMatchObject({ decision: 'material-approval', draftId: subject.draftId, recordId: null, assessmentCycleId: null });
    const matrix = readSignatureReceipt(receipt({ decision: 'matrix-approval', signatureId: 503 }));
    await expect(bindSignatureReceipt(client, matrix, confirmation(matrix), { ...expected(), decision: 'matrix-approval' })).rejects.toMatchObject({ statusCode: 409 });
    expect(rows).toHaveLength(1);
  });
  test('a concurrent unique violation is a conflict, not a server error', async () => {
    const r = readSignatureReceipt(receipt());
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' })) };
    await expect(bindSignatureReceipt(client, r, confirmation(r), expected())).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('EDC confirmation through authority op signature', () => {
  const context = { actorUserId: 22, accessToken: 'request-local-native-token' };
  const answer = (input: any, signature: Record<string, unknown>, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ success: true, data: {
    schemaVersion: 'training-authority/1', op: input.op, action: input.action, actorUserId: 22, observedAt: '2026-10-24T09:20:01.000Z', scopeFingerprint: `sha256:${'a'.repeat(64)}`,
    consistency: 'current-page-observations-not-atomic', complete: true, observationHash: `sha256:${'f'.repeat(64)}`, signature, ...extra } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const row = (r: any, patch: Record<string, unknown> = {}) => ({ signatureId: r.signatureId, requestKey: r.requestKey, decision: r.decision, studyId: 101, subject: signatureVectors[0].subject,
    subjectHash: r.subjectHash, meaning: r.meaning, signerUserId: 22, signerUsername: r.signerUsername, signerFullName: r.signerFullName, signedAt: r.signedAt,
    effortRequestId: r.edcEffort.requestId, ...patch });
  afterEach(() => jest.restoreAllMocks());
  test('asks for exactly the receipt\'s signature with the signer\'s bearer and returns the EDC row', async () => {
    const r = readSignatureReceipt(receipt()), seen: any[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const input = JSON.parse(String(options?.body)); seen.push({ url: String(url), auth: new Headers(options?.headers).get('Authorization'), input });
      return answer(input, row(r));
    });
    const confirmed = await resolveSignature(context, r, signatureVectors[0].subject);
    expect(seen).toEqual([{ url: 'https://authority.invalid/api/training-authority/resolve', auth: 'Bearer request-local-native-token', input: {
      schemaVersion: 'training-authority-request/1', op: 'signature', action: 'signatures:read', signatureId: 501, requestKey: r.requestKey, decision: 'completion-attestation', subjectHash: r.subjectHash } }]);
    expect(confirmed).toEqual(confirmation(r, { observationHash: `sha256:${'f'.repeat(64)}` }));
  });
  test.each([['another signer', { signerUserId: 23 }], ['another subject', { subject: signatureVectors[1].subject }], ['another signature', { signatureId: 777 }],
    ['another decision', { decision: 'verification' }], ['another subject hash', { subjectHash: signatureVectors[1].subjectHash }]])('a row naming %s does not confirm', async (_name, patch) => {
    const r = readSignatureReceipt(receipt());
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => answer(JSON.parse(String(options?.body)), row(r, patch)));
    await expect(resolveSignature(context, r, signatureVectors[0].subject)).rejects.toMatchObject({ statusCode: 409, code: 'TRAINING_SIGNATURE_UNCONFIRMED' });
  });
  test.each([['a missing observation hash', {}, { observationHash: undefined }], ['an incomplete answer', {}, { complete: false }],
    ['a text signature id', { signatureId: '501' }, {}], ['a missing effort request', { effortRequestId: undefined }, {}]])('%s is an invalid answer', async (_name, patch, extra) => {
    const r = readSignatureReceipt(receipt());
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => answer(JSON.parse(String(options?.body)), row(r, patch), extra));
    await expect(resolveSignature(context, r, signatureVectors[0].subject)).rejects.toMatchObject({ statusCode: 503 });
  });
  test('an unknown signature is a conflict and a refused bearer stays refused', async () => {
    const r = readSignatureReceipt(receipt());
    const refusal = (status: number, code: string) => new Response(JSON.stringify({ success: false, error: { code } }), { status, headers: { 'content-type': 'application/json' } });
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(refusal(404, 'TRAINING_AUTHORITY_SIGNATURE_NOT_FOUND')).mockResolvedValueOnce(refusal(403, 'TRAINING_AUTHORITY_FORBIDDEN'));
    await expect(resolveSignature(context, r, signatureVectors[0].subject)).rejects.toMatchObject({ statusCode: 409, code: 'TRAINING_AUTHORITY_SIGNATURE_NOT_FOUND' });
    await expect(resolveSignature(context, r, signatureVectors[0].subject)).rejects.toMatchObject({ statusCode: 403 });
  });
});
