import { createHash } from 'crypto';
import nodemailer from 'nodemailer';
import os from 'os';
import { logger } from '../config/logger';
import { escapeHtml } from './html-escape';

// The digest leaves the service by mail, so it carries no message or stack:
// only the error name, status code, time and a SHA-256 fingerprint of message
// plus stack that matches the local log entry.
interface BufferedError {
  name: string;
  statusCode: number | null;
  fingerprint: string;
  timestamp: string;
}

const SERVICE_NAME = 'accura-training-module';
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const RECIPIENT = 'info@accuratrials.com';
const MAX_BUFFERED = 100;

let buffer: BufferedError[] = [];
let dropped = 0;
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

function buildHtml(errors: BufferedError[], droppedCount: number): string {
  const cell = 'padding:6px;border:1px solid #ddd';
  const rows = errors
    .map(
      (e) =>
        `<tr>
          <td style="${cell};white-space:nowrap">${escapeHtml(e.timestamp)}</td>
          <td style="${cell}">${escapeHtml(e.name)}</td>
          <td style="${cell}">${e.statusCode === null ? '' : escapeHtml(String(e.statusCode))}</td>
          <td style="${cell};font-family:monospace">${escapeHtml(e.fingerprint)}</td>
        </tr>`
    )
    .join('');

  const droppedNote = droppedCount > 0
    ? `<p>${droppedCount} further error(s) were not buffered because the digest buffer was full.</p>`
    : '';

  return `
    <h2>${errors.length} error(s) from ${escapeHtml(SERVICE_NAME)} on ${escapeHtml(os.hostname())}</h2>
    ${droppedNote}
    <table style="border-collapse:collapse;width:100%">
      <tr><th style="${cell};text-align:left">Time</th>
          <th style="${cell};text-align:left">Error</th>
          <th style="${cell};text-align:left">Status</th>
          <th style="${cell};text-align:left">Fingerprint (SHA-256 of message and stack)</th></tr>
      ${rows}
    </table>
    <p>Messages and stacks stay in the service log; find them by fingerprint.</p>`;
}

function flush(): Promise<void> {
  if (!inFlight) inFlight = flushBuffered().finally(() => { inFlight = null; });
  return inFlight;
}

async function flushBuffered(): Promise<void> {
  if (buffer.length === 0) return;

  const errors = [...buffer];
  const droppedCount = dropped;
  buffer = [];
  dropped = 0;

  if (!smtpConfigured()) {
    logger.warn(`ErrorReporter: ${errors.length} error(s) buffered but SMTP not configured — logged locally only`);
    if (droppedCount > 0) logger.warn(`ErrorReporter: ${droppedCount} further error(s) were not buffered because the digest buffer was full`);
    return;
  }

  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM || 'errors@accuratrials.com',
      to: RECIPIENT,
      subject: `[AccuraTrials ${SERVICE_NAME}] ${errors.length} error(s) on ${os.hostname()}`,
      html: buildHtml(errors, droppedCount),
    });
    logger.info(`ErrorReporter: sent digest with ${errors.length} error(s)`);
  } catch (err) {
    logger.error('ErrorReporter: failed to send error digest email', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Requeue oldest first, then keep the buffer within its bound.
    buffer = [...errors, ...buffer];
    dropped += droppedCount + Math.max(0, buffer.length - MAX_BUFFERED);
    buffer = buffer.slice(0, MAX_BUFFERED);
    throw err;
  }
}

export function reportError(error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const stack = err.stack || 'No stack trace';
  const fingerprint = createHash('sha256').update(`${err.message}\n${stack}`, 'utf8').digest('hex');
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (buffer.length < MAX_BUFFERED) {
    buffer.push({
      name: String(err.name),
      statusCode: Number.isSafeInteger(statusCode) ? statusCode as number : null,
      fingerprint,
      timestamp: new Date().toISOString(),
    });
  } else {
    dropped += 1;
  }
  logger.error('ErrorReporter: captured error', { error: err.message, fingerprint });
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
