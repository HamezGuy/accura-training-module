import type { Transporter } from 'nodemailer';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('../../src/config/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

let reporter: typeof import('../../src/services/error-reporter.service');
let createTransport: jest.Mock;
let sendMail: jest.Mock;
let close: jest.Mock;
const priorHost = process.env.SMTP_HOST, priorPort = process.env.SMTP_PORT;
const microtasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.resetModules(); jest.useFakeTimers();
  process.env.SMTP_HOST = 'owned-smtp.invalid'; process.env.SMTP_PORT = '587';
  createTransport = require('nodemailer').createTransport;
  sendMail = jest.fn().mockResolvedValue(undefined); close = jest.fn();
  createTransport.mockReturnValue({ sendMail, close } as unknown as Transporter);
  reporter = require('../../src/services/error-reporter.service');
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
  reporter.startErrorReporter(); reporter.reportError(new Error('periodic-owned'));
  jest.advanceTimersByTime(300000); expect(sendMail).toHaveBeenCalledTimes(1);
  reporter.reportError(new Error('final-owned'));
  jest.advanceTimersByTime(300000); expect(sendMail).toHaveBeenCalledTimes(1);
  const stopped = reporter.stopErrorReporter(); expect(reporter.stopErrorReporter()).toBe(stopped);
  expect(close).not.toHaveBeenCalled();
  first.resolve(); await microtasks(); expect(sendMail).toHaveBeenCalledTimes(2);
  expect(sendMail.mock.calls[0][0].html).toContain('periodic-owned');
  expect(sendMail.mock.calls[1][0].html).toContain('final-owned');
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
  reporter.startErrorReporter(); reporter.reportError(new Error('first-owned'));
  jest.advanceTimersByTime(300000); reporter.reportError(new Error('last-owned'));
  const stopped = reporter.stopErrorReporter();
  pending.reject(new Error('owned send refusal')); await stopped;
  expect(sendMail).toHaveBeenCalledTimes(2);
  expect(sendMail.mock.calls[1][0].html).toContain('first-owned');
  expect(sendMail.mock.calls[1][0].html).toContain('last-owned');
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
  reporter.reportError(new Error('first-owned'));
  const stopped = reporter.stopErrorReporter(); reporter.reportError(new Error('during-drain-owned'));
  pending.resolve(); await stopped;
  expect(sendMail).toHaveBeenCalledTimes(2);
  expect(sendMail.mock.calls[1][0].html).toContain('during-drain-owned');
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
