import { transaction } from './database';
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
  // A scheduled expiration has no human actor. Keep the affected user in the
  // event details and prohibit anonymous interactive events, including missing
  // JSON fields (SQL CHECK must not accept an unknown/null predicate).
  `DO $$ BEGIN
    ALTER TABLE acc_training_audit_log ALTER COLUMN user_id DROP NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'acc_training_audit_log'::regclass AND conname = 'acc_training_audit_actor_required') THEN
      ALTER TABLE acc_training_audit_log ADD CONSTRAINT acc_training_audit_actor_required CHECK (
        user_id IS NOT NULL OR (
          action = 'training_expired'
          AND COALESCE(details @> '{"actor":"scheduled-expiration"}'::jsonb, false)
          AND COALESCE(jsonb_typeof(details -> 'affectedUserId') = 'number', false)
        )
      );
    END IF;
  END; $$`,
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

  // Legacy completions deliberately remain unbound (NULL). Assigning today's
  // revision to historical records would manufacture evidence of what was seen.
  `ALTER TABLE acc_training_courses ADD COLUMN IF NOT EXISTS content_revision INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE acc_training_records ADD COLUMN IF NOT EXISTS course_version VARCHAR(20)`,
  `ALTER TABLE acc_training_records ADD COLUMN IF NOT EXISTS content_revision INTEGER`,
  `ALTER TABLE acc_training_records ADD COLUMN IF NOT EXISTS content_snapshot JSONB`,
  `CREATE TABLE IF NOT EXISTS acc_training_record_history (
    history_id BIGSERIAL PRIMARY KEY,
    record_id INTEGER NOT NULL REFERENCES acc_training_records(id),
    user_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL REFERENCES acc_training_courses(id),
    record_snapshot JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_training_history_user ON acc_training_record_history(user_id, archived_at)`,
  `CREATE OR REPLACE FUNCTION acc_training_course_revision() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
    IF ROW(NEW.course_name, NEW.description, NEW.version, NEW.passing_score, NEW.regulatory_reference, NEW.validity_period_days)
       IS DISTINCT FROM ROW(OLD.course_name, OLD.description, OLD.version, OLD.passing_score, OLD.regulatory_reference, OLD.validity_period_days) THEN
      NEW.content_revision := OLD.content_revision + 1;
    END IF;
    RETURN NEW;
   END; $$`,
  `DROP TRIGGER IF EXISTS acc_training_course_revision_trigger ON acc_training_courses`,
  `CREATE TRIGGER acc_training_course_revision_trigger BEFORE UPDATE ON acc_training_courses
   FOR EACH ROW EXECUTE FUNCTION acc_training_course_revision()`,
  `CREATE OR REPLACE FUNCTION acc_training_material_revision() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
    IF TG_OP <> 'INSERT' THEN
      UPDATE acc_training_courses SET content_revision = content_revision + 1, updated_at = NOW() WHERE id = OLD.course_id;
    END IF;
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.course_id IS DISTINCT FROM OLD.course_id) THEN
      UPDATE acc_training_courses SET content_revision = content_revision + 1, updated_at = NOW() WHERE id = NEW.course_id;
    END IF;
    RETURN NULL;
   END; $$`,
  `DROP TRIGGER IF EXISTS acc_training_question_revision_trigger ON acc_training_questions`,
  `CREATE TRIGGER acc_training_question_revision_trigger AFTER INSERT OR UPDATE OR DELETE ON acc_training_questions
   FOR EACH ROW EXECUTE FUNCTION acc_training_material_revision()`,
  `DROP TRIGGER IF EXISTS acc_training_slide_revision_trigger ON acc_training_slides`,
  `CREATE TRIGGER acc_training_slide_revision_trigger AFTER INSERT OR UPDATE OR DELETE ON acc_training_slides
   FOR EACH ROW EXECUTE FUNCTION acc_training_material_revision()`,
];

export async function runMigrations(): Promise<void> {
  logger.info('Running training module migrations...');
  // Serialize startup instances and keep trigger replacement invisible until
  // commit. A running peer can never write through a DROP/CREATE gap.
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(1734439534, 1)");
    for (const sql of MIGRATIONS) await client.query(sql);
  });
  logger.info('Training module migrations complete');
}
