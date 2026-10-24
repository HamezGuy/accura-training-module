import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { Pool } from 'pg';

/** Opt-in source compatibility harness, never loaded by the training runtime. */
export function nativeTrainingAuthority(root: string, nativePool: Pool) {
  const base = fs.realpathSync(root);
  const servicePath = path.join(base, 'src/services/database/training-authority.service.ts');
  const constantsPath = path.join(base, 'src/constants/roles.ts');
  const serviceSource = fs.readFileSync(servicePath, 'utf8');
  const constantsSource = fs.readFileSync(constantsPath, 'utf8');
  if (JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).name !== 'libreclinica-api'
    || !serviceSource.includes('export async function resolveTrainingAuthority')
    || !serviceSource.includes('training-authority-request/1') || !constantsSource.includes('@accura-trial/auth-core')) {
    throw new Error('TRAINING_NATIVE_AUTHORITY_ROOT must identify the expected EDC producer source.');
  }
  const sourceHashes = Object.fromEntries([[servicePath, serviceSource], [constantsPath, constantsSource]]
    .map(([filename, source]) => [path.relative(base, filename).replace(/\\/g, '/'), createHash('sha256').update(source).digest('hex')]));
  function compile(filename: string, source: string, replacements: Record<string, unknown>) {
    const output = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const localRequire = createRequire(filename);
    const module = { exports: {} as Record<string, any> };
    // Execute exact producer code with only its default DB replaced. Role rules
    // load from the actual native constants and installed shared package.
    new Function('require', 'module', 'exports', output)((name: string) => Object.prototype.hasOwnProperty.call(replacements, name)
      ? replacements[name] : localRequire(name), module, module.exports);
    return module.exports;
  }
  const constants = compile(constantsPath, constantsSource, {});
  const service = compile(servicePath, serviceSource, { '../../config/database': { pool: null }, '../../constants/roles': constants });
  // The EDC's signature table comes only from its own import-free migration source (T-3 there), compiled like the
  // authority; a copied DDL never stands in for it. An older EDC head has no such file and no op `signature`.
  const migrationPath = path.join(base, 'src/services/database/training-signature-migration.ts');
  let signatureMigration: string[] | null = null;
  if (fs.existsSync(migrationPath)) {
    const migrationSource = fs.readFileSync(migrationPath, 'utf8');
    sourceHashes[path.relative(base, migrationPath).replace(/\\/g, '/')] = createHash('sha256').update(migrationSource).digest('hex');
    signatureMigration = Object.values(compile(migrationPath, migrationSource, {}))
      .filter((value): value is string => typeof value === 'string' && value.includes('acc_esignature_training_decision'));
    if (!signatureMigration.length) throw new Error('The EDC training signature migration exports no SQL for acc_esignature_training_decision.');
  }
  const database = {
    async connect() {
      const client = await nativePool.connect();
      return {
        async query(sql: string, values?: any[]) {
          const result = await client.query(sql, values);
          return { rows: result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), value]))) };
        },
        release: (discard?: boolean) => client.release(discard),
      };
    },
  };
  return { sourceHashes, signatureMigration,
    resolve: (actorUserId: number, input: unknown): Promise<unknown> => service.resolveTrainingAuthority(actorUserId, input, database) };
}
