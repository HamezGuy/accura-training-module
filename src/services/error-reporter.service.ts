import nodemailer from 'nodemailer';
import os from 'os';
import { logger } from '../config/logger';

interface BufferedError {
  message: string;
  stack: string;
  timestamp: string;
}

const SERVICE_NAME = 'accura-training-module';
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const RECIPIENT = 'info@accuratrials.com';

let buffer: BufferedError[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let transporter: nodemailer.Transporter | null = null;
let inFlight: Promise<void> | null = null;
let stopping: Promise<void> | null = null;

function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT);
}

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth:
        process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    });
  }
  return transporter;
}

function buildHtml(errors: BufferedError[]): string {
  const rows = errors
    .map(
      (e) =>
        `<tr>
          <td style="padding:6px;border:1px solid #ddd;white-space:nowrap">${e.timestamp}</td>
          <td style="padding:6px;border:1px solid #ddd">${e.message}</td>
        </tr>`
    )
    .join('');

  const stacks = errors
    .map(
      (e) =>
        `<h4 style="margin:16px 0 4px">${e.timestamp} — ${e.message}</h4>
         <pre style="background:#f5f5f5;padding:12px;overflow:auto;font-size:12px">${e.stack}</pre>`
    )
    .join('');

  return `
    <h2>${errors.length} error(s) from ${SERVICE_NAME} on ${os.hostname()}</h2>
    <table style="border-collapse:collapse;width:100%">
      <tr><th style="padding:6px;border:1px solid #ddd;text-align:left">Time</th>
          <th style="padding:6px;border:1px solid #ddd;text-align:left">Message</th></tr>
      ${rows}
    </table>
    <hr/>
    <h3>Stack Traces</h3>
    ${stacks}`;
}

function flush(): Promise<void> {
  if (!inFlight) inFlight = flushBuffered().finally(() => { inFlight = null; });
  return inFlight;
}

async function flushBuffered(): Promise<void> {
  if (buffer.length === 0) return;

  const errors = [...buffer];
  buffer = [];

  if (!smtpConfigured()) {
    logger.warn(`ErrorReporter: ${errors.length} error(s) buffered but SMTP not configured — logged locally only`);
    return;
  }

  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM || 'errors@accuratrials.com',
      to: RECIPIENT,
      subject: `[AccuraTrials ${SERVICE_NAME}] ${errors.length} error(s) on ${os.hostname()}`,
      html: buildHtml(errors),
    });
    logger.info(`ErrorReporter: sent digest with ${errors.length} error(s)`);
  } catch (err) {
    logger.error('ErrorReporter: failed to send error digest email', {
      error: err instanceof Error ? err.message : String(err),
    });
    buffer.unshift(...errors);
    throw err;
  }
}

export function reportError(error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  buffer.push({
    message: err.message,
    stack: err.stack || 'No stack trace',
    timestamp: new Date().toISOString(),
  });
  logger.error('ErrorReporter: captured error', { error: err.message });
}

export function startErrorReporter(): void {
  if (stopping) throw new Error('Error reporter cannot restart after shutdown.');
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
  logger.info('ErrorReporter: started (flush every 5 min)');
}

export function stopErrorReporter(): Promise<void> {
  if (stopping) return stopping;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  stopping = (async () => {
    let failure: unknown;
    let failed = false;
    try {
      // A periodic send may already own a batch. Its failure has requeued it;
      // retry that batch together with any final errors in this final drain.
      if (inFlight) await inFlight.catch(() => {});
      while (buffer.length > 0) await flush();
    } catch (error) {
      failed = true;
      failure = error;
    }
    try { transporter?.close(); }
    catch (error) {
      if (!failed) { failed = true; failure = error; }
      else logger.error('ErrorReporter: transporter cleanup also failed');
    } finally { transporter = null; }
    if (failed) throw failure;
  })();
  return stopping;
}
