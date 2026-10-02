import express from 'express';
import request from 'supertest';
import jwt, { SignOptions } from 'jsonwebtoken';
import { authMiddleware } from '../../src/middleware/auth.middleware';
import { authorize } from '../../src/middleware/authorization.middleware';

jest.mock('../../src/config/environment', () => ({ config: { jwt: { secret: 'owned-auth-contract' } } }));
jest.mock('../../src/config/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

describe('canonical EDC authority token boundary', () => {
  const entered = jest.fn();
  const app = express();
  app.post('/protected', authMiddleware, authorize(['admin', 'data_manager']), (req, res) => {
    entered(); res.json({ success: true });
  });
  const claims = { userId: 17, username: 'owned', email: 'owned@example.invalid', role: 'admin', type: 'access' };
  function token(changes = {}, options: SignOptions = {}) {
    return jwt.sign({ ...claims, ...changes }, 'owned-auth-contract', {
      algorithm: 'HS256', issuer: 'libreclinica-api', audience: 'libreclinica-client', expiresIn: '1h', ...options,
    });
  }
  beforeEach(() => entered.mockClear());
  test.each([
    ['refresh', { type: 'refresh' }], ['missing ID', { userId: undefined }], ['fractional ID', { userId: 1.5 }],
    ['negative ID', { userId: -1 }], ['blank username', { username: ' ' }], ['missing email', { email: undefined }],
    ['unknown role', { role: 'manager' }], ['prototype role', { role: 'constructor' }],
  ])('refuses %s without executing the write', async (_name, changes) => {
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token(changes)}`)).status).toBe(401);
    expect(entered).not.toHaveBeenCalled();
  });
  test.each<SignOptions>([{ issuer: 'wrong' }, { audience: 'wrong' }, { algorithm: 'HS384' }, { expiresIn: -1 }])(
    'rejects the wrong token contract %j', async options => {
      expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({}, options)}`)).status).toBe(401);
      expect(entered).not.toHaveBeenCalled();
    });
  test.each(['admin', 'data_manager', 'study_director'])('accepts canonical role or governed alias %s', async role => {
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({ role })}`)).status).toBe(200);
    expect(entered).toHaveBeenCalledTimes(1);
  });
  test('keeps a valid lower-privilege token forbidden', async () => {
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({ role: 'monitor' })}`)).status).toBe(403);
    expect(entered).not.toHaveBeenCalled();
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
  });

  test.each([undefined, 'owned-native-session'])('accepts a valid lifetime with optional legacy session %p', async sid => {
    expect((await request(app).post('/protected').set('Authorization', `Bearer ${token({ sid })}`)).status).toBe(200);
    expect(entered).toHaveBeenCalledTimes(1);
  });

});
