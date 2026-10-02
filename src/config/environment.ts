import dotenv from 'dotenv';

dotenv.config();

export interface EnvironmentConfig {
  port: number;
  nodeEnv: string;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    ssl: boolean;
    url?: string;
  };
  authority: {
    baseUrl: string;
    timeoutMs: number;
  };
  cors: {
    origin: string;
  };
  logging: {
    level: string;
  };
  training: {
    certificateValidityDays: number;
    expirationCheckCron: string;
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function authorityConfig(): EnvironmentConfig['authority'] {
  const value = requireEnv('ACCURA_API_URL');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('ACCURA_API_URL must be an explicit HTTP(S) authority root URL.'); }
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value) || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || value.includes('@') || value.includes('?') || value.includes('#')
    || url.pathname !== '/') {
    throw new Error('ACCURA_API_URL must be an HTTP(S) root URL without credentials, query or fragment.');
  }
  const timeout = process.env['ACCURA_API_TIMEOUT_MS'] ?? '10000';
  const timeoutMs = Number(timeout);
  if (!/^\d+$/.test(timeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new Error('ACCURA_API_TIMEOUT_MS must be an integer from 1 to 30000 milliseconds.');
  }
  return { baseUrl: url.origin, timeoutMs };
}

export const config: EnvironmentConfig = {
  port: parseInt(process.env['PORT'] || '3002', 10),
  nodeEnv: process.env['NODE_ENV'] || 'development',
  database: {
    host: process.env['DATABASE_HOST'] || 'localhost',
    port: parseInt(process.env['DATABASE_PORT'] || '5432', 10),
    name: process.env['DATABASE_NAME'] || 'libreclinica',
    user: process.env['DATABASE_USER'] || 'postgres',
    password: process.env['DATABASE_PASSWORD'] || 'postgres',
    ssl: process.env['DATABASE_SSL'] === 'true',
    url: process.env['DATABASE_URL'],
  },
  authority: authorityConfig(),
  cors: {
    origin: process.env['CORS_ORIGIN'] || 'http://localhost:4200',
  },
  logging: {
    level: process.env['LOG_LEVEL'] || 'info',
  },
  training: {
    certificateValidityDays: parseInt(process.env['CERTIFICATE_VALIDITY_DAYS'] || '365', 10),
    expirationCheckCron: process.env['EXPIRATION_CHECK_CRON'] || '0 2 * * *',
  },
};
