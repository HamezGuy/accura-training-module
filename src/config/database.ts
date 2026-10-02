import { Pool, PoolClient, QueryResult } from 'pg';
import { config } from './environment';
import { logger } from './logger';

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function camelizeRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => {
    const camelized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      camelized[toCamelCase(key)] = value;
    }
    return camelized as T;
  });
}

// pg reparses connectionString after its other configuration and lets URL TLS
// options override ssl. Refuse options that weaken explicitly verified TLS.
// Existing explicit CA/client certificate URL parameters remain supported.
if (config.database.ssl && config.database.url) {
  const params = new URL(config.database.url).searchParams;
  if (params.getAll('ssl').length > 1 || params.getAll('sslmode').length > 1
    || (params.has('ssl') && params.get('ssl') !== 'true')
    || (params.has('sslmode') && params.get('sslmode') !== 'verify-full')
    || params.has('uselibpqcompat')) {
    throw new Error('DATABASE_SSL requires verified TLS; conflicting database URL TLS options are not allowed.');
  }
}

const poolConfig = config.database.url
  ? {
      connectionString: config.database.url,
      ssl: config.database.ssl ? { rejectUnauthorized: true } : false,
    }
  : {
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      password: config.database.password,
      ssl: config.database.ssl ? { rejectUnauthorized: true } : false,
    };

export const pool = new Pool({
  ...poolConfig,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected pool error', { error: err.message });
});

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number | null }> {
  const result: QueryResult = await pool.query(text, params);
  return {
    rows: camelizeRows<T>(result.rows as Record<string, unknown>[]),
    rowCount: result.rowCount,
  };
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const { rows } = await query<T>(text, params);
  return rows[0] ?? null;
}

export interface TransactionClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  queryOne<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null>;
}

export async function transaction<T>(
  fn: (client: TransactionClient) => Promise<T>
): Promise<T> {
  const client: PoolClient = await pool.connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');

    const txClient: TransactionClient = {
      async query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
        const result = await client.query(text, params);
        return {
          rows: camelizeRows<R>(result.rows as Record<string, unknown>[]),
          rowCount: result.rowCount,
        };
      },
      async queryOne<R = Record<string, unknown>>(text: string, params?: unknown[]) {
        const result = await client.query(text, params);
        const rows = camelizeRows<R>(result.rows as Record<string, unknown>[]);
        return rows[0] ?? null;
      },
    };

    const result = await fn(txClient);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) {
      discardClient = true;
      // Keep the operation's original failure, and retain the separate rollback
      // failure without returning an unusable connection to the pool.
      if (error instanceof Error && Object.isExtensible(error) && !Object.prototype.hasOwnProperty.call(error, 'rollbackError')) {
        Object.defineProperty(error, 'rollbackError', { value: rollbackError });
        throw error;
      }
      const failure = new Error(error instanceof Error ? error.message : 'Transaction failed');
      Object.defineProperties(failure, { cause: { value: error }, rollbackError: { value: rollbackError } });
      throw failure;
    }
    throw error;
  } finally {
    if (discardClient) client.release(true);
    else client.release();
  }
}
