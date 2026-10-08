import express from 'express';
import request from 'supertest';
import jwt, { SignOptions } from 'jsonwebtoken';
import { createJwtService } from '@accura-trial/auth-core';
import { authMiddleware, AuthRequest } from '../../src/middleware/auth.middleware';
import { authorize } from '../../src/middleware/authorization.middleware';
import { logger } from '../../src/config/logger';

jest.mock('../../src/config/environment', () => ({ config: {
  authority: { baseUrl: 'http://authority.invalid', timeoutMs: 25 } } }));
jest.mock('../../src/config/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

describe('canonical EDC authority token boundary', () => {
  const entered = jest.fn();
  const app = express();
  app.post('/protected', authMiddleware, authorize(['admin', 'data_manager']), (req: AuthRequest, res) => {
    entered(); res.json({ success: true, user: req.user });
  });
  const claims = { userId: 17, username: 'owned', email: 'owned@example.invalid', role: 'admin', type: 'access' };
  function token(changes = {}, options: SignOptions = {}) {
    return jwt.sign({ ...claims, ...changes }, 'owned-auth-contract', {
      algorithm: 'HS256', issuer: 'libreclinica-api', audience: 'libreclinica-client', expiresIn: '1h', ...options,
    });
  }
  const fresh = { userId: 17, username: 'fresh-owned', email: '', role: 'admin', userType: 'user',
    studyIds: [101], organizationIds: [202] };
  const authorityResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  // The real canonical verifier runs on the mocked authority side. The
  // satellite has no signing secret and uses the real shared HTTP client.
  const nativeVerifier = createJwtService({ secret: 'owned-auth-contract' });
  function nativeResponse(data = fresh) {
    return async (_url: unknown, options?: RequestInit) => {
      const bearer = new Headers(options?.headers).get('Authorization')!.slice('Bearer '.length);
      return nativeVerifier.verifyAccessToken(bearer)
        ? authorityResponse({ success: true, data })
        : authorityResponse({ success: false, error: { code: 'INVALID_TOKEN' } }, 401);
    };
  }
  let authorityFetch: jest.SpyInstance;
  beforeEach(() => {
    entered.mockClear(); jest.clearAllMocks();
    authorityFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(nativeResponse());
  });
  afterEach(() => jest.restoreAllMocks());
  test.each(['success', 'failure'])('a delayed authority %s after disconnect never enters training', async outcome => {
    let resolve!: (value: Response) => void, reject!: (error: Error) => void;
    authorityFetch.mockImplementation(() => new Promise<Response>((accept, refuse) => { resolve = accept; reject = refuse; }));
    const req = { headers: { authorization: `Bearer ${token()}` }, aborted: false } as AuthRequest;
    const res = { destroyed: false, status: jest.fn(), json: jest.fn() };
    const next = jest.fn();
    const pending = authMiddleware(req, res as unknown as express.Response, next);
    res.destroyed = true;
    if (outcome === 'success') resolve(authorityResponse({ success: true, data: fresh }));
    else reject(new Error('Transport ended after disconnect'));
    await pending;
    expect(next).not.toHaveBeenCalled(); expect(res.status).not.toHaveBeenCalled();
    expect(req.trainingAuthority).toBeUndefined();
  });
  test.each([
    ['refresh', { type: 'refresh' }], ['missing ID', { userId: undefined }], ['fractional ID', { userId: 1.5 }],
    ['negative ID', { userId: -1 }], ['blank username', { username: ' ' }], ['missing email', { email: undefined }],
  ])('refuses %s without executing the write', async (_name, changes) => {
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token(changes)}`)).status).toBe(401);
    expect(entered).not.toHaveBeenCalled();
  });
  test.each(['manager', 'constructor', 'viewer'])('authorizes using the fresh native role, never decoded role %s', async role => {
    const response = await request(app).post('/protected').set('Authorization', `Bearer ${token({ role })}`);
    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe('admin');
    expect(authorityFetch).toHaveBeenCalledTimes(1);
  });
  test('a decodable token with a forged signature cannot enter a protected write', async () => {
    const forged = jwt.sign(claims, 'different-untrusted-key', {
      issuer: 'libreclinica-api', audience: 'libreclinica-client', expiresIn: '1h',
    });
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    expect(authorityFetch).toHaveBeenCalledTimes(1);
    expect(entered).not.toHaveBeenCalled();
  });
  test('a missing bearer is refused before contacting the authority', async () => {
    expect((await request(app).post('/protected')).status).toBe(401);
    expect(authorityFetch).not.toHaveBeenCalled(); expect(entered).not.toHaveBeenCalled();
  });
  test.each<SignOptions>([{ issuer: 'wrong' }, { audience: 'wrong' }, { algorithm: 'HS384' }, { expiresIn: -1 }])(
    'rejects the wrong token contract %j', async options => {
      expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({}, options)}`)).status).toBe(401);
      expect(entered).not.toHaveBeenCalled();
      expect(authorityFetch).toHaveBeenCalledTimes(1);
    });
  test.each(['admin', 'data_manager', 'study_director'])('accepts canonical role or governed alias %s', async role => {
    authorityFetch.mockImplementation(nativeResponse({ ...fresh, role }));
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({ role })}`)).status).toBe(200);
    expect(entered).toHaveBeenCalledTimes(1);
  });
  test('keeps a valid lower-privilege token forbidden', async () => {
    authorityFetch.mockImplementation(nativeResponse({ ...fresh, role: 'monitor' }));
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({ role: 'monitor' })}`)).status).toBe(403);
    expect(entered).not.toHaveBeenCalled();
    expect(authorityFetch).toHaveBeenCalledTimes(1);
  });
  test('preserves a native legacy empty-email identity', async () => {
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({email:''})}`)).status).toBe(200);
    expect(entered).toHaveBeenCalledTimes(1);
  });

  test.each(['missing expiry', 'missing issued-at', 'fractional expiry', 'fractional issued-at',
    'nonincreasing lifetime', 'null session'])('refuses %s before entering the protected write', async kind => {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = { ...claims, iat: now, exp: now + 3600 };
    if (kind === 'missing expiry') delete payload.exp;
    if (kind === 'fractional expiry') payload.exp = now + 3600.5;
    if (kind === 'fractional issued-at') payload.iat = now + 0.5;
    if (kind === 'nonincreasing lifetime') payload.iat = now + 3600;
    if (kind === 'null session') payload.sid = null;
    // jsonwebtoken normally supplies iat. noTimestamp deliberately produces
    // a signed token without it, so this exercises the verifier's boundary.
    const bearer = jwt.sign(payload, 'owned-auth-contract', {
      algorithm: 'HS256', issuer: 'libreclinica-api', audience: 'libreclinica-client',
      ...(kind === 'missing issued-at' ? { noTimestamp: true } : {}),
    });
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${bearer}`)).status).toBe(401);
    expect(entered).not.toHaveBeenCalled();
    expect(authorityFetch).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, 'owned-native-session'])('accepts a valid lifetime with optional legacy session %p', async sid => {
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({ sid })}`)).status).toBe(200);
    expect(entered).toHaveBeenCalledTimes(1);
    expect(authorityFetch).toHaveBeenCalledTimes(1); // Authority fixture acceptance, not native session qualification.
  });

  test('uses the exact current native identity and memberships on every request', async () => {
    const bearer = token({ organizationIds: [999] });
    const response = await request(app).post('/protected').set('Authorization', `Bearer ${bearer}`);
    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({ userId: 17, username: 'fresh-owned', role: 'admin', organizationIds: [202] });
    expect(authorityFetch).toHaveBeenCalledWith('http://authority.invalid/api/auth/verify', expect.objectContaining({
      method: 'GET', headers: { Authorization: `Bearer ${bearer}` }, redirect: 'error', signal: expect.any(AbortSignal),
    }));
    authorityFetch.mockImplementation(nativeResponse({ ...fresh, role: 'viewer' }));
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${bearer}`)).status).toBe(403);
    expect(authorityFetch).toHaveBeenCalledTimes(2);
    expect(entered).toHaveBeenCalledTimes(1); // No cached admin grant survives a native downgrade.
  });

  test.each([
    [401, 'TOKEN_REVOKED'], [401, 'SESSION_REVOKED'], [401, 'ACCOUNT_INACTIVE'],
    [401, 'SESSION_NOT_ACTIVE'], [401, 'CREDENTIALS_CHANGED'], [403, 'PASSWORD_EXPIRED'],
  ])('retains native refusal %i/%s before any write', async (status, code) => {
    authorityFetch.mockResolvedValue(authorityResponse({ success: false, error: { code, message: 'native refusal' } }, status as number));
    const response = await request(app).post('/protected').set('Authorization', `Bearer ${token()}`);
    expect(response.status).toBe(status); expect(response.body.code).toBe(code);
    expect(entered).not.toHaveBeenCalled();
  });

  test.each([401, 403, 503])('HTTP status %i cannot be replaced by success or status inside the body', async status => {
    authorityFetch.mockResolvedValue(authorityResponse({ success: true, httpStatus: 200, data: fresh }, status));
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token()}`)).status).toBe(status);
    expect(entered).not.toHaveBeenCalled();
  });

  test.each([null, [], {}, { success: false }, { success: 'true', data: fresh },
    { success: true }, { success: true, user: fresh }, { success: true, data: [] }])(
    'holds malformed or negative successful-HTTP response %j', async body => {
      authorityFetch.mockResolvedValue(authorityResponse(body));
      expect((await request(app).post('/protected').set('Authorization', `Bearer ${token()}`)).status).toBe(503);
      expect(entered).not.toHaveBeenCalled();
    });

  test.each([
    { userId: 18 }, { userId: 0 }, { userId: 17.5 }, { username: ' ' }, { username: null },
    { email: null }, { userType: null }, { role: 'manager' }, { role: 'constructor' },
    { organizationIds: undefined }, { organizationIds: null }, { organizationIds: '202' },
    { organizationIds: [0] }, { organizationIds: [1.5] }, { studyIds: undefined },
    { studyIds: null }, { studyIds: '101' }, { studyIds: [0] }, { studyIds: [1.5] },
  ])('holds malformed or mismatched authoritative identity %j', async changes => {
    authorityFetch.mockResolvedValue(authorityResponse({ success: true, data: { ...fresh, ...changes } }));
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({ organizationIds: [999] })}`)).status).toBe(503);
    expect(entered).not.toHaveBeenCalled();
  });

  test.each(['network', 'body-transport', 'invalid-json', 'timeout'])('holds %s failures without leaking a bearer or entering a write', async kind => {
    const bearer = token();
    if (kind === 'network') authorityFetch.mockRejectedValue(new Error(`Transport details must stay private: ${bearer}`));
    if (kind === 'body-transport') authorityFetch.mockResolvedValue({ ok: true, status: 200,
      json: async () => { throw new TypeError(`Body transport details: ${bearer}`); } });
    if (kind === 'invalid-json') authorityFetch.mockResolvedValue(new Response('not JSON', { status: 200 }));
    if (kind === 'timeout') authorityFetch.mockImplementation((_url: unknown, options: RequestInit) =>
      new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error(`Timeout: ${bearer}`)), { once: true })));
    const response = await request(app).post('/protected').set('Authorization', `Bearer ${bearer}`);
    expect(response.status).toBe(503); expect(response.body.code).toBe('AUTH_TEMPORARILY_UNAVAILABLE');
    expect(entered).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain(bearer);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(bearer);
  });

});
