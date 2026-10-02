import { request as httpRequest, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TrainingRuntime } from '../../src/server';

let app: typeof import('../../src/server').default;
let createApp: typeof import('../../src/server').createApp;
let startServer: typeof import('../../src/server').startServer;
let cron: typeof import('node-cron').default;
let pool: typeof import('../../src/config/database').pool;
let config: typeof import('../../src/config/environment').config;
let runMigrations: typeof import('../../src/config/migrations').runMigrations;
let expireOverdueRecords: typeof import('../../src/services/training.service').expireOverdueRecords;
let reportError: typeof import('../../src/services/error-reporter.service').reportError;
let startErrorReporter: typeof import('../../src/services/error-reporter.service').startErrorReporter;
let stopErrorReporter: typeof import('../../src/services/error-reporter.service').stopErrorReporter;

jest.mock('../../src/config/environment', () => ({ config: { port: 3002, nodeEnv: 'test',
  cors: { origin: 'https://owned-ui.invalid' }, training: { expirationCheckCron: '0 2 * * *' } } }));
jest.mock('../../src/config/database', () => ({ pool: { query: jest.fn(), end: jest.fn() } }));
jest.mock('../../src/config/migrations', () => ({ runMigrations: jest.fn() }));
jest.mock('../../src/config/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../../src/services/training.service', () => ({ expireOverdueRecords: jest.fn() }));
jest.mock('../../src/services/error-reporter.service', () => ({ reportError: jest.fn(), startErrorReporter: jest.fn(), stopErrorReporter: jest.fn() }));
jest.mock('node-cron', () => ({ ...jest.requireActual('node-cron'), schedule: jest.fn() }));
jest.mock('../../src/routes/training.routes', () => {
  const router = require('express').Router();
  router.get('/owned-error', () => { throw new Error('Private owned failure detail'); });
  return router;
});

let importCalls: number[];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function get(runtime: TrainingRuntime, route: string, origin?: string) {
  const port = (runtime.server.address() as AddressInfo).port;
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port, path: route, agent: false, headers: origin ? { Origin: origin } : {} }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
      response.on('error', reject);
    }).on('error', reject).end();
  });
}
let runtimes: TrainingRuntime[];
let stopTask: jest.Mock;
async function start(options: Parameters<typeof startServer>[0] = {}) {
  const runtime = await startServer({ port: 0, host: '127.0.0.1', shutdownTimeoutMs: 500, ...options });
  runtimes.push(runtime); return runtime;
}

beforeEach(() => {
  // Each process gets one singleton pool/reporter. Reload the module for each
  // independent fixture rather than permitting an unsupported runtime restart.
  jest.resetModules();
  ({ default: app, createApp, startServer } = require('../../src/server'));
  cron = require('node-cron');
  ({ pool } = require('../../src/config/database'));
  ({ config } = require('../../src/config/environment'));
  ({ runMigrations } = require('../../src/config/migrations'));
  ({ expireOverdueRecords } = require('../../src/services/training.service'));
  ({ reportError, startErrorReporter, stopErrorReporter } = require('../../src/services/error-reporter.service'));
  importCalls = [pool.query, runMigrations, cron.schedule, startErrorReporter].map(fn => (fn as jest.Mock).mock.calls.length);
  jest.clearAllMocks(); runtimes = []; stopTask = jest.fn();
  config.training.expirationCheckCron = '0 2 * * *';
  (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
  (pool.end as jest.Mock).mockResolvedValue(undefined);
  (runMigrations as jest.Mock).mockResolvedValue(undefined);
  (stopErrorReporter as jest.Mock).mockResolvedValue(undefined);
  (expireOverdueRecords as jest.Mock).mockResolvedValue(0);
  (cron.schedule as jest.Mock).mockImplementation(() => ({ stop: stopTask }));
});
afterEach(async () => {
  await Promise.allSettled(runtimes.map(runtime => runtime.stop()));
  jest.restoreAllMocks();
});

test('import preserves the default app without startup, migrations, cron or reporter side effects', () => {
  expect(typeof app).toBe('function'); expect(importCalls).toEqual([0, 0, 0, 0]);
});
test('actual loopback HTTP honors configured CORS and preserves private error handling', async () => {
  const runtime = await start();
  const trusted = await get(runtime, '/health', 'https://owned-ui.invalid');
  expect(trusted.status).toBe(200); expect(trusted.headers['access-control-allow-origin']).toBe('https://owned-ui.invalid');
  const other = await get(runtime, '/health', 'https://untrusted.invalid');
  expect(other.headers['access-control-allow-origin']).not.toBe('https://untrusted.invalid');
  const failure = await get(runtime, '/api/training/owned-error');
  expect(failure.status).toBe(500); expect(JSON.parse(failure.body)).toEqual({ success: false, message: 'Internal server error' });
  expect(reportError).toHaveBeenCalledTimes(1);
});
test.each(['database', 'migration', 'scheduler'])('%s startup failure closes allocated resources and preserves the original failure', async stage => {
  const failure = new Error(`Owned ${stage} failure`);
  if (stage === 'database') (pool.query as jest.Mock).mockRejectedValueOnce(failure);
  if (stage === 'migration') (runMigrations as jest.Mock).mockRejectedValueOnce(failure);
  if (stage === 'scheduler') (cron.schedule as jest.Mock).mockImplementationOnce(() => { throw failure; });
  await expect(start()).rejects.toBe(failure);
  expect(pool.end).toHaveBeenCalledTimes(1); expect(stopErrorReporter).toHaveBeenCalledTimes(1);
});
test('invalid schedule fails before allocating runtime resources', async () => {
  config.training.expirationCheckCron = 'invalid';
  await expect(start()).rejects.toThrow('Invalid expiration check schedule');
  expect(pool.query).not.toHaveBeenCalled(); expect(startErrorReporter).not.toHaveBeenCalled();
});
test('an occupied actual TCP port rejects startup and cleans up', async () => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try { await expect(start({ port: (occupied.address() as AddressInfo).port })).rejects.toMatchObject({ code: 'EADDRINUSE' }); }
  finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  expect(pool.end).toHaveBeenCalledTimes(1); expect(stopErrorReporter).toHaveBeenCalledTimes(1);
});
test('HTTP drain finishes an accepted request before closing the database and repeated stop closes once', async () => {
  const entered = deferred<void>(), finish = deferred<void>();
  const application = createApp();
  application.get('/slow', (_req, res) => { entered.resolve(); void finish.promise.then(() => res.json({ complete: true })); });
  const runtime = await start({ app: application });
  const response = get(runtime, '/slow'); await entered.promise;
  const first = runtime.stop(); expect(runtime.stop()).toBe(first);
  await tick(); expect(pool.end).not.toHaveBeenCalled(); expect(stopTask).toHaveBeenCalledTimes(1);
  finish.resolve(); expect((await response).status).toBe(200); await first;
  expect(pool.end).toHaveBeenCalledTimes(1); expect(stopErrorReporter).toHaveBeenCalledTimes(1);
});
test('expiry does not overlap and shutdown waits for its transaction to finish', async () => {
  const transaction = deferred<number>(); (expireOverdueRecords as jest.Mock).mockReturnValue(transaction.promise);
  const runtime = await start();
  const [, scheduled, options] = (cron.schedule as jest.Mock).mock.calls[0];
  expect(options.noOverlap).toBe(true);
  const running = scheduled(); scheduled(); expect(expireOverdueRecords).toHaveBeenCalledTimes(1);
  const stopping = runtime.stop(); scheduled(); await tick(); expect(pool.end).not.toHaveBeenCalled();
  transaction.resolve(1); await running; await stopping;
  expect(pool.end).toHaveBeenCalledTimes(1); expect(expireOverdueRecords).toHaveBeenCalledTimes(1);
});
test('expiry failure remains observable and does not disable later scheduled checks', async () => {
  const failure = new Error('Owned expiry refusal'); (expireOverdueRecords as jest.Mock).mockRejectedValueOnce(failure);
  await start(); const scheduled = (cron.schedule as jest.Mock).mock.calls[0][1];
  await scheduled(); await scheduled();
  expect(reportError).toHaveBeenCalledWith(failure); expect(expireOverdueRecords).toHaveBeenCalledTimes(2);
});
test('deadline closes owned HTTP sockets and reports failure while cleanup remains pending', async () => {
  const entered = deferred<void>(), reporter = deferred<void>();
  (stopErrorReporter as jest.Mock).mockReturnValue(reporter.promise);
  const application = createApp(); application.get('/stuck', () => { entered.resolve(); });
  const runtime = await start({ app: application, shutdownTimeoutMs: 30 });
  const response = get(runtime, '/stuck').catch(error => error); await entered.promise;
  await expect(runtime.stop()).rejects.toThrow('deadline exceeded');
  expect(await response).toMatchObject({ code: 'ECONNRESET' });
  expect(pool.end).toHaveBeenCalledTimes(1); expect(stopErrorReporter).toHaveBeenCalledTimes(1);
  reporter.resolve(); await tick(); expect(runtime.server.listening).toBe(false);
});
test.each(['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'])(
  '%s stops runtime resources once and reports the correct exit outcome', async event => {
    const events: EventEmitter = process;
    const before = events.listeners(event);
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const runtime = await start({ installProcessHandlers: true });
    const handler = events.listeners(event).find(candidate => !before.includes(candidate))!;
    const failure = new Error('Owned fatal failure'); handler(failure); handler(failure);
    await runtime.stop(); await tick();
    expect(exit).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledWith(event.startsWith('SIG') ? 0 : 1);
    expect(pool.end).toHaveBeenCalledTimes(1); expect(stopTask).toHaveBeenCalledTimes(1);
    expect(events.listeners(event)).not.toContain(handler);
  });
test('one runtime owns the singleton resources during startup and after stop', async () => {
  const database = deferred<{ rows: never[] }>(); (pool.query as jest.Mock).mockReturnValueOnce(database.promise);
  const first = start();
  await expect(start()).rejects.toThrow('Training runtime already started');
  expect(pool.query).toHaveBeenCalledTimes(1); expect(startErrorReporter).toHaveBeenCalledTimes(1);
  database.resolve({ rows: [] }); const runtime = await first; await runtime.stop();
  await expect(start()).rejects.toThrow('Training runtime already started');
  expect(pool.end).toHaveBeenCalledTimes(1); expect(stopErrorReporter).toHaveBeenCalledTimes(1);
});

test.each(['uncaughtException', 'unhandledRejection'])(
  'SIGTERM followed by %s while draining reports the fatal error and exits nonzero once', async event => {
    const entered = deferred<void>(), finish = deferred<void>();
    const application = createApp();
    application.get('/slow', (_req, res) => { entered.resolve(); void finish.promise.then(() => res.end('done')); });
    const events: EventEmitter = process;
    const signalsBefore = events.listeners('SIGTERM'), failuresBefore = events.listeners(event);
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const runtime = await start({ app: application, installProcessHandlers: true });
    const signal = events.listeners('SIGTERM').find(handler => !signalsBefore.includes(handler))!;
    const fatal = events.listeners(event).find(handler => !failuresBefore.includes(handler))!;
    const response = get(runtime, '/slow'); await entered.promise;
    signal(); await tick(); expect(exit).not.toHaveBeenCalled();
    const failure = new Error('Owned fatal error during drain'); fatal(failure); signal();
    expect(reportError).toHaveBeenCalledWith(failure);
    finish.resolve(); await response; await runtime.stop(); await tick();
    expect(exit).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledWith(1);
    expect(pool.end).toHaveBeenCalledTimes(1); expect(stopTask).toHaveBeenCalledTimes(1);
    expect(stopErrorReporter).toHaveBeenCalledTimes(1);
  });

test('shutdown resource refusal produces an observable failure', async () => {
  (pool.end as jest.Mock).mockRejectedValueOnce(new Error('Owned pool close refusal'));
  const runtime = await start();
  await expect(runtime.stop()).rejects.toThrow('failed to close every runtime resource');
  expect(stopErrorReporter).toHaveBeenCalledTimes(1);
});
test('the real direct child entrypoint exits nonzero on an occupied port after cleanup', async () => {
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, resolve));
  const directory = mkdtempSync(path.join(tmpdir(), 'training-entrypoint-'));
  const preload = path.join(directory, 'preload.cjs');
  writeFileSync(preload, `const Module=require('node:module');const original=Module._load;
Module._load=function(request,parent,isMain){
 if(request.endsWith('/config/database'))return {pool:{query:async()=>({rows:[]}),end:async()=>console.log('OWNED_POOL_CLOSED')}};
 if(request.endsWith('/config/migrations'))return {runMigrations:async()=>{}};
 if(request.endsWith('/config/logger'))return {logger:{info:()=>{},error:()=>console.log('OWNED_RUNTIME_ERROR'),warn:()=>{}}};
 if(request.endsWith('/services/error-reporter.service'))return {reportError:()=>{},startErrorReporter:()=>{},stopErrorReporter:async()=>console.log('OWNED_REPORTER_CLOSED')};
 if(request==='node-cron')return {validate:()=>true,schedule:()=>({stop:()=>{}})};
 return original.apply(this,arguments);
};`);
  try {
    const child = spawnSync(process.execPath, ['-r', 'ts-node/register', '-r', preload, 'src/server.ts'], {
      cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, NODE_ENV: 'test', TS_NODE_TRANSPILE_ONLY: 'true', PORT: String((occupied.address() as AddressInfo).port), ACCURA_API_URL: 'http://authority.invalid' },
    });
    expect({ error: child.error, status: child.status, stdout: child.stdout, stderr: child.stderr })
      .toMatchObject({ error: undefined, status: 1 });
    expect(child.stdout).toContain('OWNED_POOL_CLOSED'); expect(child.stdout).toContain('OWNED_REPORTER_CLOSED');
  } finally {
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    const relative = path.relative(tmpdir(), directory);
    if (path.isAbsolute(relative) || relative.startsWith('..') || !path.basename(directory).startsWith('training-entrypoint-')) {
      throw new Error('Owned child fixture directory escaped its temporary root.');
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
