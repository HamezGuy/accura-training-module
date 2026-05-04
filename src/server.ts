import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import { config } from './config/environment';
import { logger } from './config/logger';
import { runMigrations } from './config/migrations';
import { pool } from './config/database';
import { errorHandler } from './middleware/errorHandler.middleware';
import trainingRoutes from './routes/training.routes';
import { expireOverdueRecords } from './services/training.service';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({ origin: config.cors.origin, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'accura-training-module',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Training routes
app.use('/api/training', trainingRoutes);

// Global error handler
app.use(errorHandler);

// Start server
async function start(): Promise<void> {
  try {
    // Verify database connection
    await pool.query('SELECT 1');
    logger.info('Database connection established');

    // Run migrations
    await runMigrations();

    // Schedule expiration check cron job
    cron.schedule(config.training.expirationCheckCron, async () => {
      logger.info('Running scheduled expiration check');
      try {
        const count = await expireOverdueRecords();
        if (count > 0) {
          logger.info(`Expired ${count} overdue training records`);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Expiration check failed', { error: message });
      }
    });

    app.listen(config.port, () => {
      logger.info(`Training module API running on port ${config.port}`);
      logger.info(`Environment: ${config.nodeEnv}`);
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start server', { error: message });
    process.exit(1);
  }
}

start();

export default app;
