import { getUserRecords, getComplianceStatus, getExpiringTraining, checkUserCompliance, verifyTraining } from '../../src/services/training.service';

const mockQuery = jest.fn(), mockQueryOne = jest.fn();
jest.mock('../../src/config/database', () => ({ query: (...args: unknown[]) => mockQuery(...args), queryOne: (...args: unknown[]) => mockQueryOne(...args) }));
jest.mock('../../src/config/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../src/services/certificate.service', () => ({}));

const identity = { userId: 7, statusId: 1, userTypeId: 2, platformRole: 'monitor' };
const membership = (organizationId: number) => ({ organizationId });
beforeEach(() => { mockQuery.mockReset(); mockQueryOne.mockReset(); });

test('self records remain available without an organization lookup', async () => {
  mockQuery.mockResolvedValue({ rows: [{ id: 20, userId: 7 }] });
  expect(await getUserRecords(7, 7)).toEqual([{ id: 20, userId: 7 }]);
  expect(mockQueryOne).not.toHaveBeenCalled();
  expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('r.user_id = $1'), [7]);
});

test.each([0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses an invalid caller or target %s before SQL', async value => {
  await expect(getUserRecords(7, value)).rejects.toMatchObject({ statusCode: 400 });
  await expect(getUserRecords(value, 7)).rejects.toMatchObject({ statusCode: 400 });
  expect(mockQuery).not.toHaveBeenCalled(); expect(mockQueryOne).not.toHaveBeenCalled();
});

test('cross-organization target is refused before its records are read', async () => {
  mockQueryOne.mockResolvedValueOnce(identity).mockResolvedValueOnce(null);
  mockQuery.mockResolvedValueOnce({ rows: [membership(11)] });
  await expect(getUserRecords(8, 7)).rejects.toMatchObject({ statusCode: 403 });
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockQueryOne.mock.calls[1][1]).toEqual([8, [11]]);
});

test('an exact active shared membership permits the target read', async () => {
  mockQueryOne.mockResolvedValueOnce(identity).mockResolvedValueOnce({ userId: 8 });
  mockQuery.mockResolvedValueOnce({ rows: [membership(11)] }).mockResolvedValueOnce({ rows: [{ userId: 8 }] });
  expect(await getUserRecords(8, 7)).toEqual([{ userId: 8 }]);
  expect(mockQueryOne.mock.calls[1][0]).toContain("status = 'active'");
});

test.each([0, 1, 3, 4])('native administrator type %s is global only after a successful empty membership read', async userTypeId => {
  mockQueryOne.mockResolvedValueOnce({ ...identity, userTypeId });
  mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ userId: 8 }] });
  expect(await getUserRecords(8, 7)).toEqual([{ userId: 8 }]);
  expect(mockQueryOne).toHaveBeenCalledTimes(1);
  expect(mockQuery.mock.calls[0][0]).toContain('acc_organization_member');
});

test.each(['admin', 'sysadmin', 'tech-admin', 'tech_admin', 'system_administrator', 'technical administrator', 'system administrator', ' ADMIN '])('explicit platform identity %s supports the native organization-less exception', async platformRole => {
  mockQueryOne.mockResolvedValueOnce({ ...identity, platformRole });
  mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  await expect(getUserRecords(8, 7)).resolves.toEqual([]);
  expect(mockQueryOne).toHaveBeenCalledTimes(1);
});

test.each(['root', 'techadmin', 'site_admin_assistant', 'constructor', '__proto__'])('generic or forged alias %s cannot widen the native platform exception', async platformRole => {
  mockQueryOne.mockResolvedValueOnce({ ...identity, platformRole }).mockResolvedValueOnce(null);
  mockQuery.mockResolvedValueOnce({ rows: [] });
  await expect(getUserRecords(8, 7)).rejects.toMatchObject({ statusCode: 403 });
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

test('an administrator with an organization cannot read a foreign target', async () => {
  mockQueryOne.mockResolvedValueOnce({ ...identity, userTypeId: 1, platformRole: 'admin' }).mockResolvedValueOnce(null);
  mockQuery.mockResolvedValueOnce({ rows: [membership(11)] });
  await expect(checkUserCompliance(8, 7)).rejects.toMatchObject({ statusCode: 403 });
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

test.each([2, null])('study-derived admin claims cannot turn native type %s and empty memberships into global scope', async userTypeId => {
  mockQueryOne.mockResolvedValueOnce({ ...identity, userTypeId, platformRole: null, studyRoles: ['admin'] }).mockResolvedValueOnce(null);
  mockQuery.mockResolvedValueOnce({ rows: [] });
  await expect(getUserRecords(8, 7)).rejects.toMatchObject({ statusCode: 403 });
  expect(mockQueryOne.mock.calls[1][1]).toEqual([8, []]);
});

test.each(['identity', 'memberships', 'target'])('%s lookup failure is unavailable, never an empty/global successful response', async phase => {
  const failure = new Error('private SQL details');
  if (phase === 'identity') mockQueryOne.mockRejectedValueOnce(failure);
  else {
    mockQueryOne.mockResolvedValueOnce({ ...identity, userTypeId: 1 });
    if (phase === 'memberships') mockQuery.mockRejectedValueOnce(failure);
    else { mockQuery.mockResolvedValueOnce({ rows: [membership(11)] }); mockQueryOne.mockRejectedValueOnce(failure); }
  }
  const error = await getUserRecords(8, 7).then(() => null, value => value);
  expect(error).toMatchObject({ statusCode: 503, cause: failure });
  expect(error.message).not.toContain('private SQL');
});

test.each([null, { ...identity, userId: 8 }, { ...identity, statusId: 0 }])('missing, mismatched or inactive actor cannot obtain oversight (%j)', async actor => {
  mockQueryOne.mockResolvedValueOnce(actor);
  await expect(getExpiringTraining(7)).rejects.toMatchObject({ statusCode: 403 });
  expect(mockQuery).not.toHaveBeenCalled();
});

test.each([0, -1, null, '11'])('malformed membership %s cannot become global or be coerced', async organizationId => {
  mockQueryOne.mockResolvedValueOnce({ ...identity, userTypeId: 1 });
  mockQuery.mockResolvedValueOnce({ rows: [{ organizationId }] });
  await expect(getExpiringTraining(7)).rejects.toMatchObject({ statusCode: 503 });
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

test('unfiltered compliance applies actor/organization scope in its native user query', async () => {
  mockQueryOne.mockResolvedValueOnce(identity);
  mockQuery.mockResolvedValueOnce({ rows: [membership(11), membership(12)] }).mockResolvedValueOnce({ rows: [] });
  expect(await getComplianceStatus(7)).toEqual([]);
  const [sql, params] = mockQuery.mock.calls[1];
  expect(sql).toContain('u.user_id = $1 OR EXISTS');
  expect(sql).toContain('training_scope.organization_id = ANY($2::integer[])');
  expect(params).toEqual([7, [11, 12]]);
});

test('expiry list applies the same scope while preserving the requested horizon', async () => {
  mockQueryOne.mockResolvedValueOnce(identity);
  mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  await getExpiringTraining(7, 14);
  const [sql, params] = mockQuery.mock.calls[1];
  expect(sql).toContain('r.user_id = $2 OR EXISTS');
  expect(sql).toContain('training_scope.organization_id = ANY($3::integer[])');
  expect(params).toEqual([14, 7, []]);
});

test('sign-off scopes its locked record read through the supplied transaction and never updates an excluded row', async () => {
  const client = { queryOne: jest.fn().mockResolvedValueOnce(identity).mockResolvedValueOnce(null),
    query: jest.fn().mockResolvedValueOnce({ rows: [membership(11)], rowCount: 1 }) };
  await expect(verifyTraining(80, 7, 'reviewed', client)).rejects.toMatchObject({ statusCode: 404 });
  const [sql, params] = client.queryOne.mock.calls[1];
  expect(sql).toContain('FOR UPDATE'); expect(sql).toContain('r.user_id = $2 OR EXISTS');
  expect(params).toEqual([80, 7, [11]]);
  expect(client.query).toHaveBeenCalledTimes(1);
  expect(mockQuery).not.toHaveBeenCalled(); expect(mockQueryOne).not.toHaveBeenCalled();
});
