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
  jwt: {
    secret: string;
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
  jwt: {
    secret: requireEnv('JWT_SECRET'),
  },
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
