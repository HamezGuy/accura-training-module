import { getUserRecords, getComplianceStatus, getExpiringTraining, verifyTraining } from '../../src/services/training.service';
const mockQuery = jest.fn(), mockQueryOne = jest.fn(), mockTargets = jest.fn(), mockDirectory = jest.fn(), mockRevalidate = jest.fn();
jest.mock('../../src/config/database', () => ({ query: (...args: unknown[]) => mockQuery(...args), queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (fn: any) => fn({ query: (sql: string, ...args: unknown[]) => sql.startsWith('SET TRANSACTION') ? Promise.resolve({ rows: [] }) : mockQuery(sql, ...args),
    queryOne: (...args: unknown[]) => mockQueryOne(...args) }),
}));
jest.mock('../../src/config/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../src/services/certificate.service', () => ({}));
jest.mock('../../src/services/training-authority.service', () => ({
  authorizeTrainingTargets: (...args: unknown[]) => mockTargets(...args), readTrainingDirectory: (...args: unknown[]) => mockDirectory(...args),
  revalidateTrainingDirectory: (...args: unknown[]) => mockRevalidate(...args),
}));
const authority = { actorUserId: 7, accessToken: 'request-local-token' }, scope = 'owned-scope';
beforeEach(() => {
  for (const mock of [mockQuery, mockQueryOne, mockTargets, mockDirectory, mockRevalidate]) mock.mockReset();
  mockTargets.mockImplementation(async (_context, _action, ids: number[]) => ({ scopeFingerprint: scope, decisions: ids.map(userId => ({ userId, allowed: true })) }));
  mockRevalidate.mockResolvedValue(undefined);
});
test('target records preserve native actor identity and recheck after the local read', async () => {
  mockQuery.mockResolvedValue({ rows: [{ id: 20, userId: 8 }] });
  expect(await getUserRecords(8, authority)).toEqual([{ id: 20, userId: 8 }]);
  expect(mockTargets.mock.calls).toEqual([[authority, 'records:read', [8]], [authority, 'records:read', [8], { scopeFingerprint: scope }]]);
  expect(mockQuery.mock.calls[0][0]).toContain('acc_training_records'); expect(mockQueryOne).not.toHaveBeenCalled();
});
test('native cross-organization refusal precedes local records', async () => {
  mockTargets.mockResolvedValue({ scopeFingerprint: scope, decisions: [{ userId: 8, allowed: false }] });
  await expect(getUserRecords(8, authority)).rejects.toMatchObject({ statusCode: 403 }); expect(mockQuery).not.toHaveBeenCalled();
});
test('revocation during the local read refuses the entire result', async () => {
  mockQuery.mockResolvedValue({ rows: [{ id: 20, userId: 8 }] });
  mockTargets.mockResolvedValueOnce({ scopeFingerprint: scope, decisions: [{ userId: 8, allowed: true }] })
    .mockResolvedValueOnce({ scopeFingerprint: scope, decisions: [{ userId: 8, allowed: false }] });
  await expect(getUserRecords(8, authority)).rejects.toMatchObject({ statusCode: 403 });
});
test.each([401, 403, 409, 503])('authority refusal %s never falls back to native SQL', async statusCode => {
  const failure = Object.assign(new Error('Authority refused'), { statusCode }); mockTargets.mockRejectedValue(failure);
  await expect(getUserRecords(8, authority)).rejects.toBe(failure); expect(mockQuery).not.toHaveBeenCalled(); expect(mockQueryOne).not.toHaveBeenCalled();
});
test('empty compliance still has final authority validation', async () => {
  const directory = { users: [], filter: {}, scopeFingerprint: scope, upperUserId: 0 }; mockDirectory.mockResolvedValue(directory);
  expect(await getComplianceStatus(authority)).toEqual([]); expect(mockRevalidate).toHaveBeenCalledWith(authority, directory); expect(mockQuery).not.toHaveBeenCalled();
});
test('expiry pages keep only authorized peers and preserve requested horizon', async () => {
  mockQueryOne.mockResolvedValue({ referenceTime: '2026-10-07 00:00:00.000001+00', upperRecordId: 20 });
  mockQuery.mockResolvedValue({ rows: [{ id: 11, userId: 8, authorityCursorExpiration: '2026-10-08 00:00:00.000001+00' },
    { id: 12, userId: 9, authorityCursorExpiration: '2026-10-08 00:00:00.000002+00' }] });
  mockTargets.mockImplementation(async (_context, _action, ids: number[]) => ({ scopeFingerprint: scope, decisions: ids.map(userId => ({ userId, allowed: userId === 8 })) }));
  expect(await getExpiringTraining(authority, 14)).toEqual([{ id: 11, userId: 8 }]);
  expect(mockQuery.mock.calls[0][1]).toEqual([14, '2026-10-07 00:00:00.000001+00', 20, null, 0]);
  expect(mockQuery.mock.calls[0][0]).toContain('LIMIT 200');
  expect(mockTargets).toHaveBeenLastCalledWith(authority, 'records:expiring', [8], { scopeFingerprint: scope });
});
test('expiry keyset retains PostgreSQL microsecond text while discarding excluded rows', async () => {
  mockQueryOne.mockResolvedValue({ referenceTime: '2026-10-07 00:00:00+00', upperRecordId: 201 });
  mockQuery.mockResolvedValueOnce({ rows: Array.from({ length: 200 }, (_, index) => ({ id: index + 1, userId: 9,
    authorityCursorExpiration: `2026-10-08 00:00:00.${String(index + 1).padStart(6, '0')}+00` })) }).mockResolvedValueOnce({ rows: [] });
  mockTargets.mockImplementation(async (_context, _action, ids: number[]) => ({ scopeFingerprint: scope, decisions: ids.map(userId => ({ userId, allowed: false })) }));
  expect(await getExpiringTraining(authority)).toEqual([]);
  expect(mockQuery.mock.calls[1][1].slice(3)).toEqual(['2026-10-08 00:00:00.000200+00', 200]);
});
test('foreign sign-off is refused before locking or updating', async () => {
  const client = { queryOne: jest.fn().mockResolvedValue({ userId: 8 }), query: jest.fn() };
  mockTargets.mockImplementation(async (_context, _action, ids: number[]) => ({ scopeFingerprint: scope, decisions: ids.map(userId => ({ userId, allowed: false })) }));
  await expect(verifyTraining(80, authority, 'reviewed', client)).rejects.toMatchObject({ statusCode: 404 });
  expect(client.queryOne).toHaveBeenCalledTimes(1); expect(client.queryOne.mock.calls[0][0]).not.toContain('FOR UPDATE'); expect(client.query).not.toHaveBeenCalled();
});
test('sign-off pins locked owner and rechecks before local mutation', async () => {
  const client = { queryOne: jest.fn().mockResolvedValueOnce({ userId: 8 }).mockResolvedValueOnce({ id: 80, userId: 8, status: 'completed' }),
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
  expect(await verifyTraining(80, authority, 'reviewed', client)).toEqual({ verified: true });
  expect(client.queryOne.mock.calls[1]).toEqual([expect.stringContaining('r.user_id = $2 FOR UPDATE'), [80, 8]]);
  expect(mockTargets).toHaveBeenCalledTimes(3); expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE acc_training_records'), [7, 'reviewed', 80]);
  expect(mockQuery).not.toHaveBeenCalled(); expect(mockQueryOne).not.toHaveBeenCalled();
});
test('target revoked after locking cannot be updated', async () => {
  const client = { queryOne: jest.fn().mockResolvedValueOnce({ userId: 8 }).mockResolvedValueOnce({ id: 80, userId: 8, status: 'completed' }), query: jest.fn() };
  mockTargets.mockResolvedValueOnce({ scopeFingerprint: scope, decisions: [] })
    .mockResolvedValueOnce({ scopeFingerprint: scope, decisions: [{ userId: 8, allowed: true }] })
    .mockResolvedValueOnce({ scopeFingerprint: scope, decisions: [{ userId: 8, allowed: false }] });
  await expect(verifyTraining(80, authority, 'reviewed', client)).rejects.toMatchObject({ statusCode: 404 }); expect(client.query).not.toHaveBeenCalled();
});
