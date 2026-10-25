/**
 * training-inspection-evidence/2 refusals offline (FX-TRN-04): the switch, the request shapes, and the segment read's
 * actor, nonce and ordinal checks, which answer before any native observation or row read. The owned audit suite
 * exercises captures and segments on real PostgreSQL. Synthetic values only.
 */
import { createHash } from 'node:crypto';

const mockQueryOne = jest.fn();
const mockTransaction = jest.fn();
const mockObserve = jest.fn();
const mockAudit = jest.fn();
jest.mock('../../src/config/database', () => ({ query: jest.fn(), queryOne: (...args: unknown[]) => mockQueryOne(...args), transaction: (...args: unknown[]) => mockTransaction(...args) }));
jest.mock('../../src/config/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../../src/services/training-authority.service', () => ({ observeTrainingInspection: (...args: unknown[]) => mockObserve(...args) }));
jest.mock('../../src/services/audit.service', () => ({ ...jest.requireActual('../../src/services/audit.service'), logAudit: (...args: unknown[]) => mockAudit(...args) }));

import { getTrainingInspectionEvidence, getTrainingInspectionSegment, inspectionSegmentsEnabled } from '../../src/services/training-obligations.service';
import { trainingEvidenceHash } from '../../src/services/audit.service';

const authority = { actorUserId: 111 } as any;
const nonce = '0123456789abcdef0123456789abcdef', captureId = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const rows = [{ nativeJson: '{"id":7,"action":"course_updated"}' }, { nativeJson: '{"id":9,"action":"course_created"}' }];
const copies = rows.map(row => ({ nativeJson: row.nativeJson, sha256: sha(row.nativeJson) }));
const descriptor = { ordinal: 3, table: 'acc_training_audit_log', count: 2, contentHash: trainingEvidenceHash(copies), bytes: rows.reduce((n, r) => n + Buffer.byteLength(r.nativeJson), 0) };
const scopes = [{ studyId: 100 }];
const capture = (patch: Record<string, unknown> = {}) => ({ actorUserId: 111, nonceSha256: sha(nonce), nativeStudyId: 100, scopeFingerprint: `sha256:${'5'.repeat(64)}`,
  studyIds: [100], scopes, manifestHash: 'a'.repeat(64), segment: descriptor, rowKeys: ['7', '9'], ...patch });
const request = (patch: Record<string, unknown> = {}) => ({ schemaVersion: 'training-inspection-segment-request/1', captureId, nonce, ordinal: 3, ...patch });
let client: { query: jest.Mock };

beforeEach(() => {
  process.env.TRAINING_INSPECTION_SEGMENTS_ENABLED = 'true';
  mockQueryOne.mockReset(); mockTransaction.mockReset(); mockObserve.mockReset(); mockAudit.mockReset();
  client = { query: jest.fn(async (sql: string) => (/row_to_json/.test(sql) ? { rows } : { rows: [] })) };
  mockTransaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client));
  mockObserve.mockResolvedValue({ studyIds: [100], scopes });
});
afterAll(() => { delete process.env.TRAINING_INSPECTION_SEGMENTS_ENABLED; });

describe('switch', () => {
  test('off unless TRAINING_INSPECTION_SEGMENTS_ENABLED is exactly true, read at every call', () => {
    for (const value of [undefined, '', '1', 'TRUE', 'yes']) {
      if (value === undefined) delete process.env.TRAINING_INSPECTION_SEGMENTS_ENABLED; else process.env.TRAINING_INSPECTION_SEGMENTS_ENABLED = value;
      expect(inspectionSegmentsEnabled()).toBe(false);
    }
    process.env.TRAINING_INSPECTION_SEGMENTS_ENABLED = 'true'; expect(inspectionSegmentsEnabled()).toBe(true);
  });
  test('off, a /2 request and every segment request answer 503 before anything else; /1 is untouched', async () => {
    delete process.env.TRAINING_INSPECTION_SEGMENTS_ENABLED;
    await expect(getTrainingInspectionEvidence(authority, { schemaVersion: 'training-inspection-evidence-request/2', nativeStudyId: 100, nonce })).rejects.toMatchObject({ statusCode: 503 });
    await expect(getTrainingInspectionSegment(authority, request())).rejects.toMatchObject({ statusCode: 503 });
    await expect(getTrainingInspectionSegment(authority, 'not a request')).rejects.toMatchObject({ statusCode: 503 });
    expect(mockObserve).not.toHaveBeenCalled(); expect(mockQueryOne).not.toHaveBeenCalled(); expect(mockTransaction).not.toHaveBeenCalled();
    // A /1 body reaches the native observation exactly as before.
    mockObserve.mockRejectedValueOnce(Object.assign(new Error('synthetic native stop'), { statusCode: 403 }));
    await expect(getTrainingInspectionEvidence(authority, { nativeStudyId: 100, nonce })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockObserve).toHaveBeenCalledWith(authority, 100);
  });
});

describe('request shapes', () => {
  test.each([
    ['an unknown evidence request version', { schemaVersion: 'training-inspection-evidence-request/3', nativeStudyId: 100, nonce }],
    ['a /1 body with another key', { nativeStudyId: 100, nonce, segments: true }],
    ['a /2 body with another key', { schemaVersion: 'training-inspection-evidence-request/2', nativeStudyId: 100, nonce, limit: 1 }],
    ['a /2 body with a short nonce', { schemaVersion: 'training-inspection-evidence-request/2', nativeStudyId: 100, nonce: 'abc' }],
  ])('%s is refused 400 before any native observation', async (_name, body) => {
    await expect(getTrainingInspectionEvidence(authority, body)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockObserve).not.toHaveBeenCalled();
  });
  test.each([
    ['another request version', request({ schemaVersion: 'training-inspection-segment-request/2' })], ['an extra key', request({ table: 'acc_training_audit_log' })],
    ['a missing ordinal', request({ ordinal: undefined })], ['a negative ordinal', request({ ordinal: -1 })], ['a fractional ordinal', request({ ordinal: 1.5 })],
    ['an ordinal past the declared bound', request({ ordinal: 256 })], ['a string ordinal', request({ ordinal: '3' })],
    ['an upper-case capture ID', request({ captureId: captureId.toUpperCase() })], ['a capture ID that is no UUID', request({ captureId: 'capture-1' })],
    ['a short nonce', request({ nonce: nonce.slice(1) })], ['an array', [request()]], ['null', null],
  ])('a segment request with %s is refused 400 before any read', async (_name, body) => {
    await expect(getTrainingInspectionSegment(authority, body)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQueryOne).not.toHaveBeenCalled(); expect(mockObserve).not.toHaveBeenCalled();
  });
});

describe('segment read', () => {
  test('answers the capture actor with its nonce, rows re-read by key in capture order and rechecked against the manifest', async () => {
    mockQueryOne.mockResolvedValueOnce(capture());
    const segment = await getTrainingInspectionSegment(authority, request());
    expect(segment).toEqual({ schemaVersion: 'training-inspection-segment/1', captureId, ...descriptor, manifestHash: 'a'.repeat(64), rows: copies });
    expect(mockQueryOne.mock.calls[0][1]).toEqual([captureId, 3]);
    const read = client.query.mock.calls.find(([sql]) => /row_to_json/.test(sql))!;
    expect(read[0]).toMatch(/FROM \(SELECT id,user_id,action,record_id,course_id,details,created_at FROM acc_training_audit_log\) t\s+JOIN unnest\(\$1::int\[\]\) WITH ORDINALITY/);
    expect(read[1]).toEqual([['7', '9']]);
    expect(client.query.mock.calls.map(([sql]) => sql).slice(0, 2)).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET LOCAL TIME ZONE 'UTC'"]);
    // Native authority before and after the read, each pinned to the captured scope fingerprint.
    expect(mockObserve.mock.calls).toEqual([[authority, 100, [], `sha256:${'5'.repeat(64)}`], [authority, 100, [], `sha256:${'5'.repeat(64)}`]]);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: 111, action: 'training_inspection_segment_read', details: expect.objectContaining({ captureId, ordinal: 3 }) }));
  });
  test.each([
    ['another actor', { actorUserId: 222 }], ['another nonce', { nonceSha256: sha('f'.repeat(32)) }],
  ])('%s gets the same 404 as an unknown capture, before any native observation or row read', async (_name, patch) => {
    mockQueryOne.mockResolvedValueOnce(capture(patch));
    const refused = await getTrainingInspectionSegment(authority, request()).catch(error => error);
    mockQueryOne.mockResolvedValueOnce(null);
    const unknown = await getTrainingInspectionSegment(authority, request()).catch(error => error);
    expect([refused.statusCode, refused.message]).toEqual([404, unknown.message]); expect(unknown.statusCode).toBe(404);
    expect(mockObserve).not.toHaveBeenCalled(); expect(mockTransaction).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
  });
  test('an ordinal past the capture census is 404 for its actor, before any native observation', async () => {
    mockQueryOne.mockResolvedValueOnce(capture({ segment: null, rowKeys: null }));
    await expect(getTrainingInspectionSegment(authority, request({ ordinal: 200 }))).rejects.toMatchObject({ statusCode: 404, message: 'The training inspection capture has no segment with this ordinal' });
    expect(mockObserve).not.toHaveBeenCalled(); expect(mockTransaction).not.toHaveBeenCalled();
  });
  test.each([
    ['a census naming an undeclared table', { segment: { ...descriptor, table: 'constructor' } }],
    ['a census whose keys disagree with its count', { rowKeys: ['7'] }], ['a census stored under another ordinal', { segment: { ...descriptor, ordinal: 4 } }],
  ])('%s is refused 409 and nothing is read', async (_name, patch) => {
    mockQueryOne.mockResolvedValueOnce(capture(patch));
    await expect(getTrainingInspectionSegment(authority, request())).rejects.toMatchObject({ statusCode: 409 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  test.each([
    ['a changed row', [{ nativeJson: '{"id":7,"action":"course_created"}' }, rows[1]]], ['a missing row', [rows[0]]], ['reordered rows', [rows[1], rows[0]]],
  ])('%s after capture is refused 409 and never answered', async (_name, current) => {
    mockQueryOne.mockResolvedValueOnce(capture());
    client.query.mockImplementation(async (sql: string) => (/row_to_json/.test(sql) ? { rows: current } : { rows: [] }));
    await expect(getTrainingInspectionSegment(authority, request())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('changed after its capture') });
    expect(mockAudit).not.toHaveBeenCalled();
  });
  test('a native scope that changed since capture is refused 409 before the rows are read', async () => {
    mockQueryOne.mockResolvedValueOnce(capture());
    mockObserve.mockResolvedValueOnce({ studyIds: [100, 101], scopes: [{ studyId: 100 }, { studyId: 100, siteId: 101 }] });
    await expect(getTrainingInspectionSegment(authority, request())).rejects.toMatchObject({ statusCode: 409 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  test('a native refusal of the actor passes through unchanged', async () => {
    mockQueryOne.mockResolvedValueOnce(capture());
    mockObserve.mockRejectedValueOnce(Object.assign(new Error('Current exact inspection authority is required'), { statusCode: 403 }));
    await expect(getTrainingInspectionSegment(authority, request())).rejects.toMatchObject({ statusCode: 403 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
