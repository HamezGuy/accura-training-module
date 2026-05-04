import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function runSeed(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env['DATABASE_URL'] || `postgresql://${process.env['DATABASE_USER'] || 'postgres'}:${process.env['DATABASE_PASSWORD'] || 'postgres'}@${process.env['DATABASE_HOST'] || 'localhost'}:${process.env['DATABASE_PORT'] || '5432'}/${process.env['DATABASE_NAME'] || 'libreclinica'}`,
  });

  try {
    const sqlPath = join(__dirname, 'default-courses.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('Running seed data...');
    await pool.query(sql);
    console.log('Seed data applied successfully');
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runSeed();
