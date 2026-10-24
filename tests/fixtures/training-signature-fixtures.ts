/**
 * Shared offline fixtures for the Part 11 training signature tests (T-3). The store answers exactly the statements
 * of src/services/training-signatures.service.ts on acc_training_decision_signatures, with PostgreSQL's NULL
 * comparison and the camelized rows the training transaction client returns (BIGINT columns as text, TIMESTAMPTZ
 * as Date); the owned PostgreSQL suite covers the real table. Synthetic values only.
 */
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';

export function signatureStore() {
  const rows: any[] = []; let next = 1;
  const query = async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number } | undefined> => {
    if (sql.startsWith('SELECT * FROM acc_training_decision_signatures WHERE edc_signature_id=$1')) {
      const [signatureId, decision, recordId, cycleId, draftId] = params;
      const found = rows.filter(r => String(r.edcSignatureId) === String(signatureId) || r.decision === decision
        && (recordId !== null && cycleId !== null && r.recordId === recordId && r.assessmentCycleId === cycleId || draftId !== null && r.draftId === draftId));
      return { rows: found, rowCount: found.length };
    }
    if (sql.startsWith('SELECT * FROM acc_training_decision_signatures WHERE decision IN')) {
      const [recordIds, draftIds] = params;
      const found = rows.filter(r => r.recordId !== null && recordIds.includes(r.recordId) || r.draftId !== null && draftIds.includes(r.draftId));
      return { rows: found, rowCount: found.length };
    }
    if (sql.startsWith('INSERT INTO acc_training_decision_signatures')) {
      const [edc, decision, requestKey, signer, signedAt, context, subject, subjectHash, stored, observation, recordId, cycleId, draftId] = params;
      const row = { id: String(next++), edcSignatureId: String(edc), decision, requestKey, signerUserId: signer, signedAt: new Date(signedAt), context: JSON.parse(context),
        subject: JSON.parse(subject), subjectHash, receipt: JSON.parse(stored), edcObservationHash: observation, recordId, assessmentCycleId: cycleId, draftId, createdAt: new Date() };
      rows.push(row); return { rows: [row], rowCount: 1 };
    }
    return undefined;
  };
  // A training transaction client over the store alone: any other statement is a failure.
  const client: { query: jest.Mock } & any = { query: jest.fn(async (sql: string, params: any[] = []) => {
    const answer = await query(sql, params);
    if (!answer) throw new Error(`Unexpected signature store query: ${sql}`);
    return answer;
  }) };
  return { rows, query, client };
}

/** The EDC's own row for a receipt, as authority op `signature` answers it. */
export const edcConfirmation = (r: any, patch: Record<string, unknown> = {}): any => ({ signatureId: r.signatureId, requestKey: r.requestKey, decision: r.decision,
  studyId: r.context.siteId ?? r.context.studyId, subjectHash: r.subjectHash, meaning: r.meaning, signerUserId: r.signerUserId, signerUsername: r.signerUsername,
  signerFullName: r.signerFullName, signedAt: r.signedAt, effortRequestId: r.edcEffort?.requestId ?? null, observationHash: `sha256:${'e'.repeat(64)}`, ...patch });

/** A synthetic training-signature-receipt/1, as the EDC proxy would add it after a password re-entry signature. */
export const signatureReceipt = (patch: Record<string, unknown> = {}): any => ({ schemaVersion: 'training-signature-receipt/1', signatureId: 501,
  requestKey: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', decision: 'completion-attestation', meaning: 'SYNTHETIC signature meaning', signerUserId: 22,
  signerUsername: 'syn_signer', signerFullName: 'Synthetic Signer', signedAt: '2026-10-24T09:20:00.000Z', context: { studyId: 100, siteId: 101 }, subjectHash: 'a'.repeat(64),
  edcEffort: { requestId: '7d444840-9dc0-41d6-b2e5-1fbd3e2f3c4a', workStartedAt: null, startBasis: 'not-supplied' }, ...patch });

export const SIGNATURE_CYCLE = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';
/** A completed, verified record with its retained assessment cycle; the first committed vector is its attestation. */
export const signatureRecord = (patch: Record<string, unknown> = {}): any => ({ id: 7, userId: 22, courseId: 3, status: 'completed', courseVersion: '1.0', contentRevision: 4,
  assessmentCycleId: SIGNATURE_CYCLE, assessmentReceipt: { id: '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f', hash: 'a'.repeat(64), cycleId: SIGNATURE_CYCLE, attemptNumber: 1 },
  // PostgreSQL returns Date objects; a subject carries ISO instants.
  completedAt: new Date('2026-10-24T09:15:30.123Z'), certificateNumber: 'AT-CERT-SYN-22-MH7Q2K-1A2B3C', expirationDate: null,
  verifiedBy: 33, verifiedAt: new Date('2026-10-24T10:00:00.000Z'), notes: null, startedAt: '2026-10-24T09:00:00.000Z', score: 100, attempts: 1, ...patch });
/** The material identity of the committed material-approval vector (its draft ID in upper case on purpose). */
export const signatureDraft = { draftId: '9D8C7B6A-5F4E-4D3C-8B2A-1F0E9D8C7B6A', draftRevision: 1, requestHash: 'b'.repeat(64), courseId: 3, authorUserId: 11,
  sourceHash: 'c'.repeat(64), context: { studyId: 100, siteId: 101 } };

const contracts = path.join(__dirname, '../../contracts');
const json = (name: string) => JSON.parse(fs.readFileSync(path.join(contracts, name), 'utf8'));
export const signatureVectors = json('training-signature-subject-v1.vectors.json').vectors as Array<{ name: string; subject: any; canonical: string; subjectHash: string }>;
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(json('training-signature-subject-v1.schema.json'));
ajv.addSchema(json('training-duty-readiness-v2.schema.json'));
/** 'valid', or the validator's errors, for a value against one of this repository's own contract schemas. */
export function conformsTo(contract: 'training-signature-subject/1' | 'training-duty-readiness/2', value: unknown): string {
  const validate = ajv.getSchema(`https://schemas.accuratrials.com/training/${contract}`);
  if (!validate) throw new Error(`No schema for ${contract}`);
  return validate(value) ? 'valid' : JSON.stringify(validate.errors);
}
