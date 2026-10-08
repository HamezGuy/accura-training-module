import { authorizeTrainingTargets, readTrainingDirectory, revalidateTrainingDirectory, TrainingAuthorityTransport } from '../../src/services/training-authority.service';

jest.mock('../../src/config/environment', () => ({ config: { authority: { baseUrl: 'https://authority.invalid', timeoutMs: 100 } } }));

const context = { actorUserId: 7, accessToken: 'private-native-token' };
const scope = `sha256:${'a'.repeat(64)}`;
const user = (userId: number) => ({ userId, username: `person-${String(userId).padStart(6, '0')}`, firstName: null, lastName: 'Name', role: 'monitor', reportOrder: userId, observationHash: `sha256:${'b'.repeat(64)}` });
function success(input: any, extra: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ success: true, data: { schemaVersion: 'training-authority/1', op: input.op,
    actorUserId: 7, action: input.action, observedAt: '2026-10-07T00:00:00.000Z', scopeFingerprint: scope,
    consistency: 'current-page-observations-not-atomic', ...extra } }), { status: 200, headers: { 'content-type': 'application/json' } });
}
const inputOf = (options?: RequestInit) => JSON.parse(String(options?.body));
function page(input: any, users = [user(7)], overrides: Record<string, unknown> = {}): Response {
  return success(input, { filter: input.filter, users, complete: true,
    page: { afterUserId: input.page.afterUserId, upperUserId: 7, limit: 200, hasMore: false, nextAfterUserId: null, complete: true }, ...overrides });
}
afterEach(() => jest.restoreAllMocks());

test('preserves native ordinal ordering without guessing a JavaScript locale', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => page(inputOf(options), [
    { ...user(1), username: 'éclair', reportOrder: 2 }, { ...user(2), username: 'A10', reportOrder: 3 },
    { ...user(3), username: 'a2', reportOrder: 1 },
  ]));
  expect((await readTrainingDirectory(context)).users.map(value => value.username)).toEqual(['a2', 'éclair', 'A10']);
});

test('duplicate native ordinals refuse a changed report instead of inventing order', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => page(inputOf(options), [user(1), { ...user(2), reportOrder: 1 }]));
  await expect(readTrainingDirectory(context)).rejects.toMatchObject({ statusCode: 409, code: 'TRAINING_AUTHORITY_SELECTION_CHANGED' });
});

test('drains more than 5000 identities without truncation, pins the first upper bound and validates all final observations', async () => {
  const observed: any[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const input = inputOf(options); observed.push(input);
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer private-native-token');
    expect(options?.redirect).toBe('error');
    if (input.op === 'targets') return success(input, { filter: input.filter, upperUserId: input.upperUserId, complete: true, userIds: input.userIds,
      decisions: input.userIds.map((userId: number) => ({ userId, allowed: true })) });
    const after = input.page.afterUserId;
    const last = Math.min(after + 200, 6001);
    if (after) { expect(input.page.upperUserId).toBe(6001); expect(input.expectedScopeFingerprint).toBe(scope); }
    const hasMore = last < 6001;
    return page(input, Array.from({ length: last - after }, (_, index) => user(after + index + 1)), {
      complete: !hasMore, page: { afterUserId: after, upperUserId: 6001, limit: 200, hasMore, nextAfterUserId: hasMore ? last : null, complete: !hasMore },
    });
  });
  const directory = await readTrainingDirectory(context, { studyId: 9 });
  expect(directory.users).toHaveLength(6001);
  expect(directory.users[0].firstName).toBeNull();
  await revalidateTrainingDirectory(context, directory);
  const targets = observed.filter(input => input.op === 'targets');
  expect(targets.flatMap(input => input.userIds)).toEqual(directory.users.map(value => value.userId));
  for (const input of targets) {
    expect(input.userIds.length).toBeLessThanOrEqual(200);
    expect(input.filter).toEqual({ studyId: 9 });
    expect(input.expectedScopeFingerprint).toBe(scope);
    expect(input.userObservations).toEqual(input.userIds.map((userId: number) => ({ userId, hash: `sha256:${'b'.repeat(64)}` })));
  }
});

test.each([
  { actorUserId: 8 }, { scopeFingerprint: 'bad' }, { action: 'records:read' }, { filter: { userId: 8 } },
  { users: [user(7), user(7)] }, { users: [user(8)] }, { users: [{ ...user(7), role: 'manager' }] },
  { complete: false }, { page: { afterUserId: 0, upperUserId: 7, limit: 200, hasMore: true, nextAfterUserId: 7, complete: false }, complete: false },
])('refuses mismatched or incomplete directory metadata %j', async overrides => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => page(inputOf(options), [user(7)], overrides));
  await expect(readTrainingDirectory(context, { userId: 7 })).rejects.toMatchObject({ statusCode: 503 });
});

test('scope changes on a later page refuse the whole report', async () => {
  let calls = 0;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const input = inputOf(options);
    if (++calls === 1) return page(input, [user(7)], { complete: false,
      page: { afterUserId: 0, upperUserId: 9, limit: 200, hasMore: true, nextAfterUserId: 7, complete: false } });
    return page(input, [user(9)], { scopeFingerprint: `sha256:${'c'.repeat(64)}`,
      page: { afterUserId: 7, upperUserId: 9, limit: 200, hasMore: false, nextAfterUserId: null, complete: true } });
  });
  await expect(readTrainingDirectory(context)).rejects.toMatchObject({ statusCode: 409, code: 'TRAINING_AUTHORITY_SCOPE_CHANGED' });
  expect(calls).toBe(2);
});

test('empty self report still performs its final current-scope check', async () => {
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const input = inputOf(options);
    return success(input, { filter: input.filter, upperUserId: input.upperUserId, complete: true, userIds: [], decisions: [] });
  });
  await revalidateTrainingDirectory(context, { users: [], filter: { userId: 7 }, scopeFingerprint: scope, upperUserId: 0 });
  expect(inputOf(fetcher.mock.calls[0][1])).toMatchObject({ op: 'targets', userIds: [], filter: { userId: 7 }, expectedScopeFingerprint: scope });
});

test('a final membership refusal does not return partial compliance', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const input = inputOf(options);
    return success(input, { filter: input.filter, upperUserId: input.upperUserId, complete: true, userIds: [7], decisions: [{ userId: 7, allowed: false }] });
  });
  await expect(revalidateTrainingDirectory(context, { users: [user(7)], filter: {}, scopeFingerprint: scope, upperUserId: 7 })).rejects.toMatchObject({ statusCode: 409 });
});

test.each([401, 403, 503])('preserves native refusal class %s without leaking native response text', async status => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: false,
    error: { code: 'ACCOUNT_INACTIVE', message: 'private upstream detail' } }), { status, headers: { 'content-type': 'application/json' } }));
  const error = await authorizeTrainingTargets(context, 'records:read', [7]).catch(value => value);
  expect(error.statusCode).toBe(status);
  expect(error.message).not.toContain('private upstream detail');
});

test.each(['TRAINING_AUTHORITY_SCOPE_CHANGED', 'TRAINING_AUTHORITY_SELECTION_CHANGED'])('preserves native continuity refusal %s', async code => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: false, error: { code } }), {
    status: 409, headers: { 'content-type': 'application/json' },
  }));
  await expect(authorizeTrainingTargets(context, 'records:read', [7])).rejects.toMatchObject({ statusCode: 409, code });
});

test('transport exceptions cannot inject a public status or expose credential-bearing messages', async () => {
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('private-native-token upstream detail'), { statusCode: 418, code: 'UPSTREAM_DETAIL' }));
  const error = await authorizeTrainingTargets(context, 'records:read', [7]).catch(value => value);
  expect(error.statusCode).toBe(503); expect(error.message).not.toContain('private-native-token');
});

test('the explicitly configured trusted HTTP origin remains supported for the existing compose network', async () => {
  const fetcher = jest.fn().mockResolvedValue(success({ op: 'targets', action: 'records:read' }, { complete: true, userIds: [], decisions: [] }));
  const transport = new TrainingAuthorityTransport({ baseUrl: 'http://api:3000', timeoutMs: 100 }, fetcher);
  await transport.resolve(context, { op: 'targets', action: 'records:read', userIds: [] });
  expect(String(fetcher.mock.calls[0][0])).toBe('http://api:3000/api/training-authority/resolve');
  expect(fetcher.mock.calls[0][1].redirect).toBe('error');
});

test.each(['ftp://remote.invalid', 'https://authority.invalid/path', 'https://user:secret@authority.invalid', 'https://authority.invalid?query=1'])('refuses unsafe destination before sending credentials: %s', async baseUrl => {
  const fetcher = jest.fn();
  const transport = new TrainingAuthorityTransport({ baseUrl, timeoutMs: 100 }, fetcher);
  await expect(transport.resolve(context, { op: 'targets', action: 'records:read', userIds: [7] })).rejects.toMatchObject({ statusCode: 503 });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  () => new Response('{}', { headers: { 'content-type': 'text/plain' } }),
  () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }),
  () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) } }),
])('rejects malformed or oversized body and releases admission', async makeResponse => {
  const fetcher = jest.fn().mockImplementation(async () => makeResponse());
  const transport = new TrainingAuthorityTransport({ baseUrl: 'https://authority.invalid', timeoutMs: 100 }, fetcher);
  for (let count = 0; count < 6; count += 1) await expect(transport.resolve(context, { op: 'targets', action: 'records:read' })).rejects.toMatchObject({ statusCode: 503 });
  expect(fetcher).toHaveBeenCalledTimes(6);
});

test('bounded admission rejects a fifth request and cancellation frees every slot', async () => {
  const fetcher = jest.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const transport = new TrainingAuthorityTransport({ baseUrl: 'http://127.0.0.1:3000', timeoutMs: 1000 }, fetcher);
  const cancellation = new AbortController();
  const pending = Array.from({ length: 4 }, () => transport.resolve({ ...context, signal: cancellation.signal }, { op: 'targets', action: 'records:read' }).catch(value => value));
  await expect(transport.resolve(context, { op: 'targets', action: 'records:read' })).rejects.toMatchObject({ code: 'TRAINING_AUTHORITY_BUSY' });
  expect(fetcher).toHaveBeenCalledTimes(4);
  cancellation.abort();
  for (const error of await Promise.all(pending)) expect(error.statusCode).toBe(503);
  fetcher.mockResolvedValue(success({ op: 'targets', action: 'records:read' }, { complete: true, userIds: [], decisions: [] }));
  await expect(transport.resolve(context, { op: 'targets', action: 'records:read' })).resolves.toMatchObject({ complete: true });
});
