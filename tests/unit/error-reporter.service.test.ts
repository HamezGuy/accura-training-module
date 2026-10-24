import { createHash } from 'crypto';
import type { Transporter } from 'nodemailer';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('../../src/config/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

let reporter: typeof import('../../src/services/error-reporter.service');
let createTransport: jest.Mock;
let sendMail: jest.Mock;
let close: jest.Mock;
const priorHost = process.env.SMTP_HOST, priorPort = process.env.SMTP_PORT;
const microtasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
// The digest names each error by SHA-256 of its message and stack, never by the text itself.
const fp = (e: Error) => createHash('sha256').update(`${e.message}\n${e.stack}`, 'utf8').digest('hex');
const html = (call: number): string => sendMail.mock.calls[call][0].html;
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.resetModules(); jest.useFakeTimers();
  process.env.SMTP_HOST = 'owned-smtp.invalid'; process.env.SMTP_PORT = '587';
  /* eslint-disable @typescript-eslint/no-require-imports -- a fresh module registry is reloaded synchronously */
  createTransport = require('nodemailer').createTransport;
  sendMail = jest.fn().mockResolvedValue(undefined); close = jest.fn();
  createTransport.mockReturnValue({ sendMail, close } as unknown as Transporter);
  reporter = require('../../src/services/error-reporter.service');
  /* eslint-enable @typescript-eslint/no-require-imports */
});
afterEach(async () => {
  await reporter.stopErrorReporter().catch(() => {});
  jest.useRealTimers();
  if (priorHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = priorHost;
  if (priorPort === undefined) delete process.env.SMTP_PORT; else process.env.SMTP_PORT = priorPort;
});

test('shutdown waits for a periodic send, drains later errors serially, and closes once', async () => {
  const first = deferred(), final = deferred();
  sendMail.mockReturnValueOnce(first.promise).mockReturnValueOnce(final.promise);
  const periodic = new Error('periodic-owned'), last = new Error('final-owned');
  reporter.startErrorReporter(); reporter.reportError(periodic);
  jest.advanceTimersByTime(300000); expect(sendMail).toHaveBeenCalledTimes(1);
  reporter.reportError(last);
  jest.advanceTimersByTime(300000); expect(sendMail).toHaveBeenCalledTimes(1);
  const stopped = reporter.stopErrorReporter(); expect(reporter.stopErrorReporter()).toBe(stopped);
  expect(close).not.toHaveBeenCalled();
  first.resolve(); await microtasks(); expect(sendMail).toHaveBeenCalledTimes(2);
  expect(html(0)).toContain(fp(periodic)); expect(html(0)).not.toContain(fp(last));
  expect(html(1)).toContain(fp(last)); expect(html(1)).not.toContain(fp(periodic));
  expect(close).not.toHaveBeenCalled(); final.resolve(); await stopped;
  expect(close).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(600000); expect(sendMail).toHaveBeenCalledTimes(2);
});

test('periodic failure requeues the exact batch for the next scheduled retry', async () => {
  sendMail.mockRejectedValueOnce(new Error('owned periodic refusal'));
  reporter.startErrorReporter(); reporter.reportError(new Error('retain-owned'));
  jest.advanceTimersByTime(300000); await microtasks();
  expect(sendMail).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  jest.advanceTimersByTime(300000); await microtasks();
  expect(sendMail).toHaveBeenCalledTimes(2);
  expect(sendMail.mock.calls[1][0].html).toBe(sendMail.mock.calls[0][0].html);
  await reporter.stopErrorReporter(); expect(close).toHaveBeenCalledTimes(1);
});

test('shutdown retries a failed in-flight periodic batch together with final buffered errors', async () => {
  const pending = deferred(); sendMail.mockReturnValueOnce(pending.promise);
  const first = new Error('first-owned'), last = new Error('last-owned');
  reporter.startErrorReporter(); reporter.reportError(first);
  jest.advanceTimersByTime(300000); reporter.reportError(last);
  const stopped = reporter.stopErrorReporter();
  pending.reject(new Error('owned send refusal')); await stopped;
  expect(sendMail).toHaveBeenCalledTimes(2);
  expect(html(1).indexOf(fp(first))).toBeGreaterThan(-1);
  expect(html(1).indexOf(fp(last))).toBeGreaterThan(html(1).indexOf(fp(first)));
  expect(close).toHaveBeenCalledTimes(1);
});

test('failed final delivery rejects shutdown instead of claiming a clean flush', async () => {
  const failure = new Error('owned final refusal'); sendMail.mockRejectedValue(failure);
  reporter.reportError(new Error('final-owned'));
  const stopped = reporter.stopErrorReporter();
  await expect(stopped).rejects.toBe(failure); await expect(reporter.stopErrorReporter()).rejects.toBe(failure);
  expect(sendMail).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
});

test('errors captured during the final send are also drained before transport close', async () => {
  const pending = deferred(); sendMail.mockReturnValueOnce(pending.promise);
  const during = new Error('during-drain-owned');
  reporter.reportError(new Error('first-owned'));
  const stopped = reporter.stopErrorReporter(); reporter.reportError(during);
  pending.resolve(); await stopped;
  expect(sendMail).toHaveBeenCalledTimes(2);
  expect(html(1)).toContain(fp(during));
  expect(close).toHaveBeenCalledTimes(1);
});

test('unconfigured SMTP uses the existing local-only behavior without opening a transport', async () => {
  delete process.env.SMTP_HOST; reporter.reportError(new Error('local-owned'));
  await reporter.stopErrorReporter(); expect(createTransport).not.toHaveBeenCalled();
});

test('transport cleanup failure is observable, with an earlier delivery failure preserved', async () => {
  const delivery = new Error('owned delivery refusal'), cleanup = new Error('owned cleanup refusal');
  sendMail.mockRejectedValue(delivery); close.mockImplementation(() => { throw cleanup; });
  reporter.reportError(new Error('retain-owned'));
  await expect(reporter.stopErrorReporter()).rejects.toBe(delivery); expect(close).toHaveBeenCalledTimes(1);
});

test('the reporter cannot start a new timer after it has stopped', async () => {
  reporter.startErrorReporter(); await reporter.stopErrorReporter();
  expect(() => reporter.startErrorReporter()).toThrow('cannot restart');
  expect(jest.getTimerCount()).toBe(0);
});

test('the digest carries only name, status, time and fingerprint, with every field escaped', async () => {
  const leak = Object.assign(new Error('<script>alert(1)</script> SELECT * FROM users WHERE id = 1; -- db-primary.internal.owned:5432'),
    { name: '<b>OwnedError</b>', statusCode: 503 });
  leak.stack = `${leak.name}: ${leak.message}\n    at ownedFrame (C:/owned/secret-path.ts:7:11)`;
  reporter.reportError(leak); await reporter.stopErrorReporter();
  const mail = sendMail.mock.calls[0][0];
  for (const field of [mail.html, mail.subject]) {
    for (const raw of ['<script>', 'alert(1)', 'SELECT * FROM users', 'db-primary.internal.owned', 'ownedFrame', 'secret-path', '<b>'])
      expect(field).not.toContain(raw);
  }
  expect(mail.html).toContain(fp(leak)); expect(mail.html).toContain('&lt;b&gt;OwnedError&lt;/b&gt;');
  expect(mail.html).toContain('>503<'); expect(mail.subject).toContain('1 error(s)');
  const { logger } = require('../../src/config/logger'); // eslint-disable-line @typescript-eslint/no-require-imports
  expect(logger.error).toHaveBeenCalledWith('ErrorReporter: captured error', { error: leak.message, fingerprint: fp(leak) });
});

test('the host name in the digest is escaped', async () => {
  const os = require('os'); // eslint-disable-line @typescript-eslint/no-require-imports
  const hostname = jest.spyOn(os, 'hostname').mockReturnValue('<i>owned-host</i>');
  try {
    reporter.reportError(new Error('host-owned')); await reporter.stopErrorReporter();
    expect(html(0)).not.toContain('<i>'); expect(html(0)).toContain('&lt;i&gt;owned-host&lt;/i&gt;');
  } finally { hostname.mockRestore(); }
});

test('150 errors through failed sends keep the oldest 100 and report the dropped count in the next digest', async () => {
  sendMail.mockRejectedValue(new Error('owned outage'));
  reporter.startErrorReporter();
  const errors = Array.from({ length: 150 }, (_, i) => new Error(`bounded-owned-${i}`));
  for (const e of errors) { reporter.reportError(e); jest.advanceTimersByTime(300000); await microtasks(); }
  expect(sendMail).toHaveBeenCalledTimes(150);
  sendMail.mockReset(); sendMail.mockResolvedValue(undefined);
  await reporter.stopErrorReporter();
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(sendMail.mock.calls[0][0].subject).toContain('100 error(s)');
  errors.slice(0, 100).forEach((e, i) => { if (i > 0) expect(html(0).indexOf(fp(e))).toBeGreaterThan(html(0).indexOf(fp(errors[i - 1]))); });
  for (const e of errors.slice(100)) expect(html(0)).not.toContain(fp(e));
  expect(html(0)).toContain('50 further error(s) were not buffered');
});

test('a failed send requeues within the bound when the buffer refilled while it was in flight', async () => {
  const pending = deferred(); sendMail.mockReturnValueOnce(pending.promise);
  const errors = Array.from({ length: 200 }, (_, i) => new Error(`requeue-owned-${i}`));
  reporter.startErrorReporter();
  errors.slice(0, 100).forEach(e => reporter.reportError(e));
  jest.advanceTimersByTime(300000);
  errors.slice(100).forEach(e => reporter.reportError(e));
  pending.reject(new Error('owned in-flight refusal')); await microtasks();
  await reporter.stopErrorReporter();
  expect(sendMail).toHaveBeenCalledTimes(2);
  for (const e of errors.slice(0, 100)) expect(html(1)).toContain(fp(e));
  for (const e of errors.slice(100)) expect(html(1)).not.toContain(fp(e));
  expect(html(1)).toContain('100 further error(s) were not buffered');
  expect(html(0)).not.toContain('further error(s)');
});
