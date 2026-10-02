import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron, { ScheduledTask } from 'node-cron';
import { createServer, Server } from 'node:http';
import { config } from './config/environment';
import { logger } from './config/logger';
import { runMigrations } from './config/migrations';
import { pool } from './config/database';
import { errorHandler } from './middleware/errorHandler.middleware';
import trainingRoutes from './routes/training.routes';
import { expireOverdueRecords } from './services/training.service';
import { reportError, startErrorReporter, stopErrorReporter } from './services/error-reporter.service';

/** Build the HTTP application without starting runtime resources. */
export function createApp(): express.Express {
  const application = express();
  application.use(helmet());
  application.use(cors({ origin: config.cors.origin, credentials: true }));
  application.use(express.json({ limit: '1mb' }));
  application.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));
  // Liveness only; dependency and native workflow qualification is separate.
  application.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'accura-training-module', version: '1.0.0', timestamp: new Date().toISOString() });
  });
  application.use('/api/training', trainingRoutes);
  application.use((err: import('./middleware/errorHandler.middleware').ApiError, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!err.statusCode || err.statusCode >= 500) reportError(err);
    errorHandler(err, req, res, next);
  });
  return application;
}

const app = createApp();
export default app;

export interface TrainingRuntime {
  server: Server;
  stop(): Promise<void>;
}

let startupAttempted = false;

/** One runtime per module/process owns the shared pool and reporter. */
export async function startServer(options: {
  app?: express.Express;
  port?: number;
  host?: string;
  shutdownTimeoutMs?: number;
  installProcessHandlers?: boolean;
} = {}): Promise<TrainingRuntime> {
  const timeoutMs = options.shutdownTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Shutdown timeout must be an integer from 1 to 30000 milliseconds.');
  if (!cron.validate(config.training.expirationCheckCron)) throw new Error('Invalid expiration check schedule.');
  if (startupAttempted) throw new Error('Training runtime already started; start a new process to restart closed resources.');
  startupAttempted = true;
  let server: Server | undefined;
  let task: ScheduledTask | undefined;
  let expiration: Promise<void> | undefined;
  let stopping = false;
  let reporterStarted = false;
  let shutdown: Promise<void> | undefined;
  let poolClosing: Promise<void> | undefined;
  let reporterClosing: Promise<void> | undefined;
  const closePool = () => poolClosing ??= Promise.resolve().then(() => pool.end());
  const closeReporter = () => reporterClosing ??= Promise.resolve().then(() => reporterStarted ? stopErrorReporter() : undefined);
  const handlers: Array<[string, (...args: any[]) => void]> = [];

  function stop(): Promise<void> {
    if (shutdown) return shutdown;
    stopping = true;
    shutdown = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Force-close only this runtime's HTTP connections. Do not cancel a
          // transaction mid-commit; report an incomplete drain as a failure.
          server?.closeAllConnections();
          void closePool().catch(() => {});
          void closeReporter().catch(() => {});
          reject(new Error('Training shutdown deadline exceeded; cleanup is incomplete.'));
        }, timeoutMs);
      });
      const cleanup = async () => {
        const drained = await Promise.allSettled([
          Promise.resolve().then(() => task?.stop()),
          new Promise<void>((resolve, reject) => {
            if (!server?.listening) { resolve(); return; }
            server.close(error => error ? reject(error) : resolve());
          }),
          expiration,
        ]);
        const closed = await Promise.allSettled([closeReporter(), closePool()]);
        if ([...drained, ...closed].some(result => result.status === 'rejected')) {
          throw new Error('Training shutdown failed to close every runtime resource.');
        }
      };
      try { await Promise.race([cleanup(), deadline]); }
      finally {
        if (timer) clearTimeout(timer);
        for (const [event, handler] of handlers) process.removeListener(event, handler);
      }
    })();
    return shutdown;
  }

  let terminating = false;
  let terminalExitCode = 0;
  function terminate(code: number, failure?: unknown): void {
    terminalExitCode = Math.max(terminalExitCode, code);
    if (failure !== undefined) {
      reportError(failure);
      logger.error('Fatal training runtime failure; shutting down');
    }
    if (terminating) return;
    terminating = true;
    void stop().then(() => process.exit(terminalExitCode), () => {
      logger.error('Training shutdown incomplete');
      process.exit(1);
    });
  }

  try {
    reporterStarted = true;
    startErrorReporter();
    await pool.query('SELECT 1');
    logger.info('Database connection established');
    await runMigrations();
    server = createServer(options.app ?? app);
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server!.removeListener('listening', listening); reject(error); };
      const listening = () => { server!.removeListener('error', failed); resolve(); };
      server!.once('error', failed);
      server!.once('listening', listening);
      server!.listen({ port: options.port ?? config.port, ...(options.host ? { host: options.host } : {}) });
    });
    task = cron.schedule(config.training.expirationCheckCron, () => {
      if (stopping || expiration) return;
      expiration = (async () => {
        logger.info('Running scheduled expiration check');
        try {
          const count = await expireOverdueRecords();
          if (count > 0) logger.info(`Expired ${count} overdue training records`);
        } catch (error: unknown) {
          reportError(error);
          logger.error('Expiration check failed');
        } finally { expiration = undefined; }
      })();
      return expiration;
    }, { noOverlap: true });
    if (options.installProcessHandlers) {
      handlers.push(['SIGTERM', () => terminate(0)], ['SIGINT', () => terminate(0)],
        ['uncaughtException', error => terminate(1, error)], ['unhandledRejection', reason => terminate(1, reason)]);
      for (const [event, handler] of handlers) process.on(event, handler);
    }
    logger.info(`Training module API running on port ${options.port ?? config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    return { server, stop };
  } catch (error) {
    try { await stop(); }
    catch (shutdownError) {
      if (error instanceof Error && Object.isExtensible(error)) Object.defineProperty(error, 'shutdownError', { value: shutdownError });
      logger.error('Training startup cleanup incomplete');
    }
    throw error;
  }
}

if (require.main === module) {
  void startServer({ installProcessHandlers: true }).catch(error => {
    logger.error('Failed to start server', { error: error instanceof Error ? error.message : 'Unknown startup failure' });
    process.exit(1);
  });
}
