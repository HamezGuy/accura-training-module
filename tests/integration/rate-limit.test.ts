/**
 * The public per-address limit stays 200 requests per 15 minutes for every caller, while the EDC's duty-readiness
 * observations (POST /api/training/duty-readiness) use their own higher bucket, so a burst of clinical saves on the
 * EDC never spends the browsers' budget or is refused by it (EDC defect D-EDC-7). A synthetic test stack may raise
 * the public limit with TRAINING_PUBLIC_RATE_LIMIT; unset, it is unchanged.
 */
import request from 'supertest';

jest.mock('../../src/config/environment', () => ({ config: { port: 3002, nodeEnv: 'test',
  cors: { origin: 'https://owned-ui.invalid' }, training: { expirationCheckCron: '0 2 * * *' } } }));
jest.mock('../../src/config/database', () => ({ pool: { query: jest.fn(), end: jest.fn() } }));
jest.mock('../../src/config/migrations', () => ({ runMigrations: jest.fn() }));
jest.mock('../../src/config/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../../src/services/training.service', () => ({ expireOverdueRecords: jest.fn() }));
jest.mock('../../src/services/error-reporter.service', () => ({ reportError: jest.fn(), startErrorReporter: jest.fn(), stopErrorReporter: jest.fn() }));
jest.mock('../../src/routes/training.routes', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a hoisted jest.mock factory cannot use imports
  const router = require('express').Router();
  router.post('/duty-readiness', (_req: any, res: any) => res.json({ success: true }));
  router.get('/courses', (_req: any, res: any) => res.json({ success: true }));
  return router;
});

import { createApp, dutyReadinessRateLimit, PUBLIC_RATE_LIMIT, publicRateLimit } from '../../src/server';

describe('training service rate limits', () => {
  afterEach(() => { delete process.env['TRAINING_DUTY_READINESS_RATE_LIMIT']; delete process.env['TRAINING_PUBLIC_RATE_LIMIT']; });

  it('keeps the public limit for browsers and gives duty readiness its own higher bucket', async () => {
    const app = createApp();
    for (let i = 0; i < 300; i++) expect((await request(app).post('/api/training/duty-readiness').send({})).status).toBe(200);
    for (let i = 0; i < PUBLIC_RATE_LIMIT.max; i++) expect((await request(app).get('/api/training/courses')).status).toBe(200);
    const refused = await request(app).get('/api/training/courses');
    expect(refused.status).toBe(429);
    expect(refused.headers['ratelimit-reset']).toBeDefined();
    // The browsers' budget is spent; the EDC's duty observations still pass on their own bucket.
    expect((await request(app).post('/api/training/duty-readiness').send({})).status).toBe(200);
  }, 60000);

  it('enforces the duty-readiness bucket itself and validates its setting', async () => {
    process.env['TRAINING_DUTY_READINESS_RATE_LIMIT'] = '5';
    const app = createApp();
    for (let i = 0; i < 5; i++) expect((await request(app).post('/api/training/duty-readiness').send({})).status).toBe(200);
    const limited = await request(app).post('/api/training/duty-readiness').send({});
    expect(limited.status).toBe(429);
    expect(limited.headers['ratelimit-reset']).toBeDefined();
    expect((await request(app).get('/api/training/courses')).status).toBe(200);
    process.env['TRAINING_DUTY_READINESS_RATE_LIMIT'] = 'many';
    expect(() => dutyReadinessRateLimit()).toThrow('TRAINING_DUTY_READINESS_RATE_LIMIT');
    delete process.env['TRAINING_DUTY_READINESS_RATE_LIMIT'];
    expect(dutyReadinessRateLimit()).toBe(6000);
  }, 60000);

  it('lets a test stack raise the public bucket only through a valid TRAINING_PUBLIC_RATE_LIMIT', async () => {
    expect(publicRateLimit()).toBe(PUBLIC_RATE_LIMIT.max);
    process.env['TRAINING_PUBLIC_RATE_LIMIT'] = '';
    expect(publicRateLimit()).toBe(200);
    process.env['TRAINING_PUBLIC_RATE_LIMIT'] = '250';
    const app = createApp();
    for (let i = 0; i < 250; i++) expect((await request(app).get('/api/training/courses')).status).toBe(200);
    const refused = await request(app).get('/api/training/courses');
    expect(refused.status).toBe(429);
    expect(refused.headers['ratelimit-limit']).toBe('250');
    // Duty readiness keeps its own bucket.
    expect((await request(app).post('/api/training/duty-readiness').send({})).status).toBe(200);
    for (const invalid of ['0', '-1', '1.5', 'many', '1000001']) {
      process.env['TRAINING_PUBLIC_RATE_LIMIT'] = invalid;
      expect(() => publicRateLimit()).toThrow('TRAINING_PUBLIC_RATE_LIMIT must be an integer from 1 to 1000000.');
      expect(() => createApp()).toThrow('TRAINING_PUBLIC_RATE_LIMIT');
    }
  }, 60000);
});
