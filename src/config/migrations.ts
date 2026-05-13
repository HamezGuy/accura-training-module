import { pool } from './database';
import { logger } from './logger';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS acc_training_courses (
    id SERIAL PRIMARY KEY,
    course_code VARCHAR(50) UNIQUE NOT NULL,
    course_name VARCHAR(255) NOT NULL,
    description TEXT,
    version VARCHAR(20) NOT NULL DEFAULT '1.0',
    duration_minutes INTEGER,
    passing_score INTEGER NOT NULL DEFAULT 80,
    required_for_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
    regulatory_reference VARCHAR(255),
    active BOOLEAN NOT NULL DEFAULT true,
    validity_period_days INTEGER DEFAULT 365,
    created_by INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS acc_training_questions (
    id SERIAL PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES acc_training_courses(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    question_type VARCHAR(20) NOT NULL CHECK (question_type IN ('multiple_choice', 'true_false', 'multi_select')),
    options JSONB NOT NULL DEFAULT '[]'::jsonb,
    explanation TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS acc_training_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL REFERENCES acc_training_courses(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed', 'expired')),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    score INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    certificate_number VARCHAR(100) UNIQUE,
    expiration_date TIMESTAMP WITH TIME ZONE,
    verified_by INTEGER,
    verified_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, course_id)
  )`,

  `CREATE TABLE IF NOT EXISTS acc_training_audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    action VARCHAR(50) NOT NULL,
    record_id INTEGER,
    course_id INTEGER,
    details JSONB DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_training_records_user_id ON acc_training_records(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_training_records_course_id ON acc_training_records(course_id)`,
  `CREATE INDEX IF NOT EXISTS idx_training_records_status ON acc_training_records(status)`,
  `CREATE INDEX IF NOT EXISTS idx_training_records_expiration ON acc_training_records(expiration_date) WHERE status = 'completed'`,
  `CREATE INDEX IF NOT EXISTS idx_training_audit_user_id ON acc_training_audit_log(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_training_audit_action ON acc_training_audit_log(action)`,
  `CREATE INDEX IF NOT EXISTS idx_training_audit_created_at ON acc_training_audit_log(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_training_questions_course_id ON acc_training_questions(course_id)`,

  `CREATE TABLE IF NOT EXISTS acc_training_slides (
    id SERIAL PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES acc_training_courses(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    slide_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (slide_type IN ('text', 'image', 'video', 'interactive', 'knowledge-check')),
    order_index INTEGER NOT NULL DEFAULT 0,
    media_url TEXT,
    interactive_config JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_training_slides_course_id ON acc_training_slides(course_id)`,
  `CREATE INDEX IF NOT EXISTS idx_training_slides_order ON acc_training_slides(course_id, order_index)`,

  `ALTER TABLE acc_training_slides DROP CONSTRAINT IF EXISTS acc_training_slides_slide_type_check`,
  `ALTER TABLE acc_training_slides ADD CONSTRAINT acc_training_slides_slide_type_check CHECK (slide_type IN ('text', 'image', 'video', 'interactive', 'knowledge-check'))`,
];

export async function runMigrations(): Promise<void> {
  logger.info('Running training module migrations...');

  for (const sql of MIGRATIONS) {
    try {
      await pool.query(sql);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists')) {
        logger.error('Migration failed', { sql: sql.substring(0, 80), error: message });
        throw error;
      }
    }
  }

  logger.info('Training module migrations complete');
}
