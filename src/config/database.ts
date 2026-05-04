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

const poolConfig = config.database.url
  ? {
      connectionString: config.database.url,
      ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    }
  : {
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      password: config.database.password,
      ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
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
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
