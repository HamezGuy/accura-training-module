/**
 * Offline check of the ordered startup statements (src/config/migrations.ts). Every append-only training table
 * refuses UPDATE and DELETE row by row and TRUNCATE by statement, and every guard trigger is set ENABLE ALWAYS after
 * its last CREATE: each startup re-creates a guard in the default (origin) state, which
 * session_replication_role = replica silences. The owned PostgreSQL audit suite proves the same on a real database.
 */
import fs from 'node:fs';
import path from 'node:path';

const mockTransaction = jest.fn();
jest.mock('../../src/config/database', () => ({ transaction: (...args: unknown[]) => mockTransaction(...args) }));
jest.mock('../../src/config/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

import { runMigrations, TRAINING_MIGRATION_STATEMENTS } from '../../src/config/migrations';

const APPEND_ONLY = ['acc_training_audit_log', 'acc_training_obligation_events', 'acc_training_record_history',
  'acc_training_impact_events', 'acc_training_material_publications', 'acc_training_material_events', 'acc_training_decision_signatures',
  'acc_training_effort_intervals', 'acc_training_inspection_captures'];
const IMMUTABLE = 'acc_training_immutable_history';

const statements = TRAINING_MIGRATION_STATEMENTS.map(sql => sql.replace(/\s+/g, ' ').trim());
const creates = statements.flatMap((sql, index) => {
  const match = /^CREATE TRIGGER (\w+) (BEFORE|AFTER) (\w+(?: OR \w+)*) ON (\w+) FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION (\w+)\(\)$/.exec(sql);
  return match ? [{ index, name: match[1], timing: match[2], events: match[3].split(' OR '), table: match[4], level: match[5], fn: match[6] }] : [];
});
const enables = statements.flatMap((sql, index) => {
  const match = /^ALTER TABLE (\w+) ENABLE ALWAYS TRIGGER (\w+)$/.exec(sql);
  return match ? [{ index, table: match[1], name: match[2] }] : [];
});
const guards = creates.filter(create => create.name.endsWith('_guard'));
const lastCreate = (table: string, name: string) => Math.max(...creates.filter(c => c.table === table && c.name === name).map(c => c.index));

describe('training migration guards', () => {
  it('parses every trigger statement, so no guard can be missed by the checks below', () => {
    expect(statements.filter(sql => /CREATE TRIGGER/i.test(sql))).toHaveLength(creates.length);
    expect(statements.filter(sql => /ENABLE (ALWAYS )?TRIGGER/i.test(sql))).toHaveLength(enables.length);
    expect(statements.filter(sql => /DISABLE TRIGGER|ENABLE REPLICA/i.test(sql))).toEqual([]);
    // Every trigger on the immutable-history function is a named guard.
    expect(creates.filter(create => create.fn === IMMUTABLE && !create.name.endsWith('_guard'))).toEqual([]);
  });

  it('refuses UPDATE and DELETE of every append-only row and TRUNCATE of every append-only table', () => {
    for (const table of APPEND_ONLY) {
      const rowGuards = creates.filter(c => c.table === table && c.fn === IMMUTABLE && c.timing === 'BEFORE' && c.level === 'ROW');
      expect({ table, events: rowGuards.flatMap(c => c.events).sort() }).toEqual({ table, events: ['DELETE', 'UPDATE'] });
      const truncateGuards = creates.filter(c => c.table === table && c.fn === IMMUTABLE && c.timing === 'BEFORE' && c.level === 'STATEMENT');
      expect({ table, events: truncateGuards.flatMap(c => c.events) }).toEqual({ table, events: ['TRUNCATE'] });
    }
    const raise = statements.find(sql => sql.startsWith(`CREATE OR REPLACE FUNCTION ${IMMUTABLE}()`));
    expect(raise).toContain("RAISE EXCEPTION 'Training history is append-only'");
    expect(statements.findIndex(sql => sql === raise)).toBeLessThan(Math.min(...creates.filter(c => c.fn === IMMUTABLE).map(c => c.index)));
  });

  it('sets every guard ENABLE ALWAYS after its last CREATE, including the retained-source guards', () => {
    expect(guards.length).toBeGreaterThanOrEqual(16);
    for (const guard of guards) {
      const enabled = enables.filter(e => e.table === guard.table && e.name === guard.name).map(e => e.index);
      expect({ guard: guard.name, after: enabled.some(index => index > lastCreate(guard.table, guard.name)) })
        .toEqual({ guard: guard.name, after: true });
    }
    expect(guards.map(g => g.name)).toEqual(expect.arrayContaining(['acc_training_impact_source_guard', 'acc_training_material_draft_guard']));
    // Every ENABLE ALWAYS names a guard that this list creates on that table.
    for (const enable of enables) expect(guards.some(g => g.table === enable.table && g.name === enable.name)).toBe(true);
  });

  it('drops each trigger before it is created, so the list stays idempotent at every startup', () => {
    for (const create of creates) {
      const drop = statements.lastIndexOf(`DROP TRIGGER IF EXISTS ${create.name} ON ${create.table}`, create.index);
      expect({ trigger: create.name, dropped: drop >= 0 && !creates.some(c => c.name === create.name && c.index > drop && c.index < create.index) })
        .toEqual({ trigger: create.name, dropped: true });
    }
  });

  it('keeps service code to inserts and reads of every append-only table', () => {
    const root = path.join(__dirname, '../../src');
    const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter(file => file.endsWith('.ts'));
    const writes = new RegExp(`\\b(UPDATE|DELETE\\s+FROM|TRUNCATE(\\s+TABLE)?)\\s+(${APPEND_ONLY.join('|')})\\b`, 'i');
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter(file => writes.test(fs.readFileSync(path.join(root, file), 'utf8')))).toEqual([]);
  });

  it('runs exactly this frozen list under the startup lock without changing runMigrations', async () => {
    const executed: string[] = [];
    mockTransaction.mockImplementation(async (fn: (client: { query(sql: string): Promise<void> }) => Promise<void>) =>
      fn({ query: async (sql: string) => { executed.push(sql); } }));
    await runMigrations();
    expect(executed[0]).toBe('SELECT pg_advisory_xact_lock(1734439534, 1)');
    expect(executed.slice(1)).toEqual([...TRAINING_MIGRATION_STATEMENTS]);
    expect(Object.isFrozen(TRAINING_MIGRATION_STATEMENTS)).toBe(true);
  });
});
