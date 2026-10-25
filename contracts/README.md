# Training service contracts

Versioned JSON Schemas (draft 2020-12) for records this service produces and another repository consumes. The
producer owns each schema. A consumer validates in its own code and may vendor a copy pinned by SHA-256, so these
files are stored byte for byte: `.gitattributes` marks `contracts/**` as `-text`, and they must keep LF line endings
on every checkout. A change of meaning is a new version (`/2`), never an edit of a published one.

| File | Contract | Produced by | Consumed by |
|---|---|---|---|
| `training-signature-subject-v1.schema.json` | `training-signature-subject/1` | `GET /api/training/signature-subject` | EDC training proxy (hash check before signing), EDC readiness verifier, Command Center harness |
| `training-signature-subject-v1.vectors.json` | hash vectors for `training-signature-subject/1` | this repository | this repository's tests and the EDC's tests: each side must reproduce `canonical` and `subjectHash` with its own canonicalizer |
| `training-impact-review-subject-v1.schema.json` | `training-impact-review-subject/1` | `GET /api/training/signature-subject?kind=impact-review` | EDC training proxy (hash check before signing), Command Center harness |
| `training-impact-review-subject-v1.vectors.json` | hash vectors for `training-impact-review-subject/1` | this repository | as for the signature subject vectors |
| `training-duty-readiness-v2.schema.json` | `training-duty-readiness/2` | `POST /api/training/duty-readiness` answering `training-duty-readiness-request/2` | EDC duty readiness consumer |
| `training-effort-observation-request-v1.schema.json` | `training-effort-observation-request/1` | Command Center (the requester) | `POST /api/training/effort-source/observe` (this service) |
| `training-effort-source-v1.schema.json` | `TrainingEffortSourceV1@1.0.0` | `POST /api/training/effort-source/observe`, the `data` of `TrainingEffortServiceObservationV1@1.0.0` | Command Center TA3 metrics register (plan item T-4/cc) |
| `training-inspection-evidence-v2.schema.json` | `training-inspection-evidence/2` | `POST /api/training/inspection-evidence` answering `training-inspection-evidence-request/2` (off unless `TRAINING_INSPECTION_SEGMENTS_ENABLED=true`) | EDC inspection copy (FX-EDC-118) |
| `training-inspection-segment-v1.schema.json` | `training-inspection-segment/1` | `POST /api/training/inspection-evidence/segment` answering `training-inspection-segment-request/1` | EDC inspection copy (FX-EDC-118) |

The subject hash is the hex SHA-256 of canonical JSON: object keys sorted by UTF-16 code unit, arrays in order,
scalars and strings as `JSON.stringify` writes them. It is the same canonical form as `policyHash` and
`evidenceHash` (`src/services/audit.service.ts` here, `canonicalStudyJson` in the EDC).

## Part 11 signatures on training decisions

People sign in the EDC, never in this service and never with a machine credential. The flow for each decision:

1. The EDC proxy reads `GET /api/training/signature-subject` with the signer's own bearer and compares the hash of
   the returned `subject` with the hash the person was shown. Query keys: `kind=completion-attestation` or
   `kind=verification` with `recordId`, `studyId` and optional `siteId`; or `kind=material-approval` with `draftId`;
   or `kind=impact-review` with `planId` (the subject is then `training-impact-review-subject/1`).
   The answer is `{subject, subjectHash, binding}`, where `binding` is `{status: 'unbound'}` or
   `{status: 'bound', signatureId, requestKey, signerUserId, signedAt}`.
2. The person signs with password re-entry; the EDC stores its signature row and hash-chained audit row.
3. The proxy forwards the decision with `signatureReceipt` (`training-signature-receipt/1`, owned by the EDC):
   `{schemaVersion, signatureId, requestKey, decision, meaning, signerUserId, signerUsername, signerFullName,
   signedAt, context, subjectHash, edcEffort}`, `edcEffort` being `null` or
   `{requestId, workStartedAt, startBasis: 'client-work-start' | 'not-supplied'}`.
4. Inside the decision's transaction this service recomputes the subject, asks the EDC to confirm the signature
   (authority op `signature`, below) and writes an append-only row in `acc_training_decision_signatures`. A refused
   decision leaves the EDC signature unconsumed; the client reads the subject's `binding.status` and retries only
   with the same request key.

| Route | Decision | Receipt |
|---|---|---|
| `POST /attest/:recordId` | `completion-attestation`, by the learner | required |
| `POST /verify/:recordId` | `verification`, by an independent verifier | optional; without it the verification is unsigned, as before |
| `POST /verify/:recordId/signature` | `verification`, by the person who already recorded it | required; binding only |
| `POST /material-drafts/:id/review` | `material-approval`, by the reviewer, accepted reviews only | optional |
| `POST /material-drafts/:id/approval-signature` | `material-approval`, by the recorded reviewer | required; binding only |
| `POST /impact-plans/:id/review` | `impact-review`, by the independent reviewer, accepted reviews only | optional; `POST /impact-plans/:id/apply` requires it only with `TRAINING_IMPACT_REVIEW_SIGNATURE_REQUIRED=true` |

`matrix-approval` is reserved for the curriculum matrix (plan item T-1): it is in the decision vocabulary, but no
route produces it and no row shape admits it.

`impact-review` (FX-TRN-01) is a decision of `training-signature-receipt/1` whose subject is a separate contract,
`training-impact-review-subject/1`, so `training-signature-subject/1` is unchanged: `{schemaVersion, kind:
'impact-review', context, planId, reviewedRevision, planHash, sourceObservationHash, proposerUserId, disposition:
'accepted'}`, `context` being the plan's study or site scope and `reviewedRevision` the proposed revision the review
accepted. The EDC answers op `signature` for it exactly as for the other decisions (`studyId` the context site, else
the study).

Authority op `signature` (request `training-authority-request/1`, answered by the EDC): request
`{schemaVersion, op: 'signature', action: 'signatures:read', signatureId, requestKey, decision, subjectHash}`;
answer the common `training-authority/1` fields plus `complete: true`, `observationHash` (`sha256:<hex>`) and
`signature: {signatureId, requestKey, decision, studyId, subject, subjectHash, meaning, signerUserId,
signerUsername, signerFullName, signedAt, effortRequestId}`, where `signatureId` is a JSON number, `studyId` is the
context site, else the study, and `effortRequestId` is a UUID or `null`. Only the signer may read it. An unknown
signature is answered 404 with code `TRAINING_AUTHORITY_SIGNATURE_NOT_FOUND`.

`training-duty-policy/2` is `training-duty-policy/1` plus `signatures: 'part11-required'`. Under it a pin that
`/1` reports complete is complete only when the record's current assessment cycle carries the learner's attestation
and the recorded verifier's signature, and, for governed material, the current publication's draft carries its
reviewer's approval; otherwise it reads `signature_required`, whose blocker names no arm. A readiness request `/2`
carries exactly a `/2` policy and a request `/1` exactly a `/1` policy.

## Training effort (plan item T-4)

Off unless this service runs with `TRAINING_EFFORT_LEDGER_ENABLED=true`; otherwise `POST
/api/training/effort-source/observe` answers 503 `TRAINING_EFFORT_DISABLED` to every request, and the EDC forwards
that machine path only with its own `ENABLE_TRAINING_EFFORT=true`.

Request `training-effort-observation-request/1` (`x-api-key: atk_...` with scope `training:due-source:read`, no
query): `{schemaVersion, requestId, installationId, scope: {studyId}, expectedAuthorityHash?}`, a root study only.

The answer is `{success: true, data}` with `data` the envelope `TrainingEffortServiceObservationV1@1.0.0`, shaped
like `TrainingDueServiceObservationV1@1.0.0`: `{schemaVersion, requestId, requestHash, installationId, scope,
authority: {apiKeyId, serviceUserId, authorityHash, observedAt, expiresAt}, data, consistency:
'current-observations-not-atomic', externalDeliveryConfirmed: false}`. `requestHash` is the hex SHA-256 of the
canonical request; `authority` is the EDC service authority admitted on the transport (the EDC's last answer); the
credential never appears. The inner `data` is `TrainingEffortSourceV1@1.0.0` (`training-effort-source-v1.schema.json`).

How it is observed: the training service asks the EDC `POST /api/training-authority/resolve-due` (request
`training-due-authority-request/1`, op `arms`, `scope: {studyId}` and no other selector) for the root's Arm-type
census, `data: {scope, arms, armsObservationHash}` with exactly `{armId, classId, disclosureLevel, groupStatus,
lifecycleState, onboardedAt, onboardEventId}` per arm in `armId` order and `armsObservationHash` =
`sha256:` + the canonical hash of `{scope, arms}`; reads one REPEATABLE READ READ ONLY snapshot of its own effort
intervals and arm-scoped obligations; computes the document against that census; and asks for the census again. A
changed census is refused 409 `TRAINING_EFFORT_SOURCE_CHANGED`; a malformed one 503; the EDC's 500-arm bound passes
through as 413 `TRAINING_EFFORT_TOO_LARGE`, as do this service's own bounds (100,000 intervals, 10,000 arm-scoped
obligations). Other refusals: 400 `TRAINING_EFFORT_INVALID_REQUEST`, 401 `TRAINING_EFFORT_SERVICE_CREDENTIAL_REQUIRED`,
401, 403 or 409 `TRAINING_EFFORT_AUTHORITY_REFUSED`, 409 `TRAINING_EFFORT_AUTHORITY_CHANGED`, 503
`TRAINING_EFFORT_BUSY`, `_CANCELLED`, `_TIMEOUT` (the whole observation, local snapshot included, has 30 seconds)
and `_UNAVAILABLE`. Nothing partial is ever answered.

What the document says, and does not: hours come from the append-only effort intervals (one per graded quiz attempt,
completion attestation and verification recorded while the switch is on), by role and kind, for the platform and
for each arm whose class the EDC declares `regimen` or `cohort`. Learning and attestation take the served
obligation's role, verification the verifier's platform role. An arm row takes the whole of every interval that
served the arm. Lead time runs from the arm's EDC onboard event to `trainedAt`, the latest over the arm's assigned
arm-scoped obligations of the later of the record's verification and the obligation's current revision, once all
are complete; `open` reports days elapsed so far; `incomplete` names its reason. Every other arm (a
`treatment-assignment` class, or no declaration) appears with its id and declared level only: no hours rows, no
lead time, no counts. No learner or actor identity appears. Signed attestation and verification time is also EDC
observed signed-action effort and must not be added to it. `limitations` lists the rest. `sourceHash` is the
canonical hash of the document without `asOf` and `sourceHash`, so a later observation of unchanged rows, with no
`open` arm, hashes the same.

## Segmented inspection evidence (FX-TRN-04)

Off unless this service runs with `TRAINING_INSPECTION_SEGMENTS_ENABLED=true`; otherwise both requests below answer
503. `training-inspection-evidence/1` (request `{nativeStudyId, nonce}`) is unchanged.

Request `training-inspection-evidence-request/2`: `{schemaVersion, nativeStudyId, nonce}`, `nonce` 32 lowercase hex.
The answer is the manifest `training-inspection-evidence/2`: the `/1` fields without `tables`, plus `captureId`,
`limits: {maxSegments: 256, maxSegmentRows: 10000, maxSegmentBytes: 8388608}`, `segments` and `manifestHash`. The
segments cover, in this order, the 13 `/1` tables, `acc_training_decision_signatures` and
`acc_training_effort_intervals`; ordinals run from 0 without gaps and every table has at least one segment. The rows
of a `/1` table and the concatenated rows of its `/2` segments are equal, so a `/1` table `contentHash` recomputes
from them. A signature binding or effort interval that names a study or site outside the inspection is withheld
whole and counted in `gaps`.

Request `training-inspection-segment-request/1`: `{schemaVersion, captureId, nonce, ordinal}`. The answer
`training-inspection-segment/1` is `{schemaVersion, captureId, ordinal, table, count, contentHash, bytes,
manifestHash, rows: [{nativeJson, sha256}]}`, equal to the manifest's segment at that ordinal. Refusals: 400 for a
malformed request; 404 for an unknown capture, another actor or another nonce (one answer for all three) and for an
ordinal past the census; 409 when the native inspection scope changed or the re-read rows no longer hash to the
manifest (capture again); the native authority's 401 and 403 pass through; 503 when four inspection reads are
already running.

Hashes: `sha256` is the hex SHA-256 of the exact `nativeJson` text; `contentHash` the hex SHA-256 of the canonical
JSON of `rows`; `bytes` the sum of the UTF-8 byte lengths of the `nativeJson` texts; `manifestHash` the hex SHA-256
of the canonical JSON of `{captureId, capturedAt, segments}`; `evidenceHash` the hex SHA-256 of the canonical JSON of
the manifest without `schemaVersion`, `nonce`, `observedAt`, `consistency` and `evidenceHash`. These are the hashes
of the EDC segmented inspection copy (`docs/inspection-copy-segmentation-contract.md` in the EDC repository).
