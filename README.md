# AccuraTrial Training Module

Standalone training and certification backend intended to support AccuraTrial staff training workflows. Deployment qualification and regulatory assessment are still required; this service does not establish Part 11 compliance by itself.

## Overview

This service provides server-side training management for clinical trial staff, including:

- **Course Management** — Create and manage GCP, HIPAA, CFR Part 11, and system-specific training courses
- **Server-Side Quiz Grading** - Answers are graded on the server; course content responses omit correct-answer flags.
- **Certificate Generation** — Unique, auditable certificate numbers for completed training
- **Training Tracking** - Required active courses counted by exact course ID, using native user roles and optional study-family scope.
- **Audit Trail** - Course creation/update/questions, training start/quiz/verification, and scheduled expiration commit their state change and audit entry together.
- **Expiration Enforcement** — Automated detection and flagging of expired certifications

## Architecture

Standalone Express/TypeScript service owning the `acc_training_*` tables. Native accounts, organizations and study memberships remain with `libreclinicaapi`, accessed through its authenticated `POST /api/training-authority/resolve` endpoint. Training does not query or copy native identity tables. It can use a dedicated training database or the existing training tables during a compatibility deployment; it does not create a second account authority.

The auth-core dependency is a checked-in immutable package in `vendor/`, built from unchanged source revision `d9758e5aebc66462a1a43b34784fb2ded0eb87a2`. Its receipt records source and package hashes; all 24 runtime/type/map files matched the previously installed package byte for byte. The lockfile and Dockerfile consume that artifact, so the training image does not need Git or an adjacent auth-core checkout. This packaging qualification does not claim a completed container build or deployment.

The current EDC API does not mount this standalone service or its training gate, and the EDC frontend training screens are not present. The API production compose file nevertheless defines a separate training container and publishes port 3002. This is a configured deployment path, not evidence that a running deployment was checked. These changes improve standalone readiness; they do not integrate a clinical workflow gate.

Each protected request uses the pinned `@accura-trial/auth-core` `AccuraAuthClient` to call native `GET /api/auth/verify`. This satellite does not receive `JWT_SECRET` or verify signatures locally. When deploying this version, remove the previous `JWT_SECRET` value from the training service's environment; the native API retains its own signing secret. No secret rotation or deployment is performed by these changes. There is no cache or local-only fallback. Unverified token decoding supplies only a positive user ID for comparison with the returned identity; it never authorizes a request. Authorization uses the current native username, role and organization memberships.

Deployment requires the native API's required and optional authentication middleware to adopt the pinned canonical access-token verifier: HS256, issuer `libreclinica-api`, audience `libreclinica-client`, integer issued-at/expiry with a valid lifetime, and valid user identity. Installing this satellite alone does not establish that producer contract. The authority also enforces active accounts, session revocation/timeout, credential changes and password-age expiry. A native 401/403 remains a refusal, including `PASSWORD_EXPIRED`; an unavailable authority or malformed identity returns 503 before training writes. Auth-core can read legacy tokens without a session ID, but the current native middleware requires an active session; the offline fixture's acceptance is not a claim about native session admission. These changes do not introduce Command Center assertions or establish native deployment qualification.

Set `ACCURA_API_URL` explicitly in every environment to the trusted native API root, without credentials, a path, query or fragment. The production compose network uses `http://api:3000`. `ACCURA_API_TIMEOUT_MS` defaults to the client's 10000 milliseconds and must be an integer from 1 through 30000. Missing or invalid configuration prevents startup. Never point this setting at an untrusted service: the initiating user's bearer is forwarded for verification.

Admin and canonical `data_manager` roles can manage training courses. Governed role aliases are resolved by auth-core. Existing course requirements using `manager` retain their data-manager meaning, but `manager` is not accepted as the current role returned by the authority. The previous local-only middleware checked the token's role; this middleware instead checks the fresh authoritative role, so a stale token role neither grants nor withholds current privileges. Compliance uses the native primary-role precedence (admin user type, explicit platform role, highest active legacy study role, then coordinator), not a study role promoted into a separate global authority. A supplied study ID must be an exact positive existing ID; reports include active memberships on that study or its child sites. Optional or inactive courses do not increase the required-course count or invalidate completed required training.

Compliance detail and `is-compliant` reads require either the exact current user's ID or an oversight role (`admin`, `data_manager`, or `monitor`). An unfiltered compliance report, including a study-only filter, and the expiring list require oversight. Self-service callers must provide their exact `userId` when requesting `/compliance`; malformed or ambiguous IDs are refused. Existing `/my-records` self access and oversight-only `/user/:userId/records` remain unchanged. These are read permissions, not clinical workflow gate integration.

Oversight reports, other-user records and training verification are scoped to self or active members of the caller's active organizations. A study filter further narrows the report. Global scope requires an active native platform administrator and a successful lookup showing no organization memberships; a study-derived admin role or token claims cannot grant it. Account or membership lookup failure refuses oversight with an error instead of treating the scope as global. Shared course authoring and required-course configuration retain their existing behavior.

The native authority returns at most 200 directory users per keyset page, bounded by the initial maximum user ID. Training drains every page, preserves native database name ordering using the owner's ordinal, and validates the same caller-scope fingerprint on subsequent pages. Before returning compliance, it rechecks every collected user and observation hash with the owner. There is no fixed total-user cutoff and no partial successful report after a failed page. Pages are separate current observations, not one snapshot across requests. Each response is bounded to 8 MiB; the transport permits four concurrent reads, forwards the request-local native bearer only to the configured fixed origin, refuses redirects, and cancels on disconnect or the configured timeout. It has no identity cache or direct-SQL fallback.

Verification first resolves the record's owner and native permission, then locks the local record with both IDs and rechecks native permission before mutation. The training update and audit insertion commit or roll back together. That local transaction does not include the remote EDC authorization observation: a native grant can change after the final check. Expiry reports keyset-page local records and keep only authorized rows before a final target check. Existing public training response bodies remain unchanged.

Deploy the corresponding native authority endpoint before this consumer. `deploy/docker-compose.training.yml` is an optional single-replica deployment description with an explicit image, environment file and externally provisioned network; its health check is liveness only. A real database cutover must preserve user references, course/question/record/audit IDs and relationships, timestamps, certificates and sequence positions, and leave exactly one scheduled-expiry owner. Copying records, changing privileges, stopping the old service and launching the new service are operator-controlled cutover steps; this change performs none of them. Native `acc_user_training_status` belongs to the existing e-signature policy and is not moved or replaced by this course service.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Edit .env — match DATABASE_URL and set the actual ACCURA_API_URL
# Do not distribute the native API signing secret to this service.

# Run in development
npm run dev

# Run tests
npm test

# Build for production
npm run build
npm start
```

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/training/courses` | List courses |
| GET | `/api/training/courses/:id` | Course detail |
| POST | `/api/training/courses` | Create course (admin) |
| PUT | `/api/training/courses/:id` | Update course (admin) |
| POST | `/api/training/courses/:id/questions` | Add quiz questions (admin) |
| GET | `/api/training/my-records` | Current user's records |
| GET | `/api/training/user/:userId/records` | User records (admin) |
| POST | `/api/training/start/:courseId` | Start training |
| POST | `/api/training/submit-quiz/:courseId` | Submit quiz |
| POST | `/api/training/verify/:recordId` | Verify completion (supervisor) |
| GET | `/api/training/compliance` | Compliance report |
| GET | `/api/training/expiring` | Expiring certifications |
| GET | `/api/training/user/:userId/is-compliant` | Compliance check (inter-service) |

## Regulatory References

- **21 CFR Part 11 §11.10(i)** — Training documentation
- **HIPAA §164.308(a)(5)** — Security awareness training
- **ICH E6 (GCP)** — Investigator qualifications and training

## License

MIT

## Validation and recovery

`src/server.ts` retains its default Express app export and direct `node dist/server.js` entrypoint. Importing it does not start migrations, a listener, cron, or process handlers. The direct entrypoint checks the database and applies existing migrations before listening; startup failures exit nonzero after cleanup. `createApp()` and `startServer()` expose the same application for controlled qualification. Only one `startServer()` attempt may own the shared pool and reporter in a process; restart the process after shutdown or startup failure. Programmatic callers must await `stop()`; the direct entrypoint installs process handlers.

Browser requests use the exact configured `CORS_ORIGIN` (development default `http://localhost:4200`); arbitrary origins are not reflected. Bearer authorization is still required. With `DATABASE_SSL=true`, database certificate verification is enabled. Connection-string `sslmode`, if present, must be `verify-full`; conflicting or duplicate TLS options are refused. Existing PostgreSQL URL CA/client certificate parameters remain available. Configure the intended trusted CA through those established PostgreSQL settings when needed; there is no automatic verification bypass.

SIGTERM/SIGINT stop expiry scheduling, drain accepted HTTP requests and any running expiry transaction, then close the error reporter and database pool once. Fatal uncaught exceptions/rejections trigger the same cleanup and a nonzero exit, including failures arriving during an already-started graceful shutdown. Shutdown has one 10-second deadline; it force-closes this listener's remaining HTTP connections and exits nonzero if cleanup remains incomplete. It does not cancel a database transaction midway through commit or claim a clean shutdown on timeout. The error reporter finishes an already-running delivery and final buffered errors before closing its transport; failed final delivery makes shutdown fail while periodic delivery retains retries. Expiry checks use the existing implementation with overlap prevention. `/health` is a liveness response, not evidence that the authority or database remains available.

`npm test` runs the offline suite. Authentication tests exercise the real shared HTTP client with mocked fetch responses. Token-contract cases run the real canonical verifier inside that authority fixture; no service is contacted. The cross-repository PostgreSQL suite requires both `TRAINING_AUDIT_TEST_DATABASE_URL` (an explicitly owned, empty loopback database with `TRAINING_AUDIT_TEST_OWNED=yes`) and `TRAINING_NATIVE_AUTHORITY_ROOT` (the EDC checkout containing the matching producer). It loads the exact producer service and actual native role constants, emits their SHA-256 source hashes, and injects a distinct fixture pool. The training pool refuses native identity-table queries. Native authority results pass through the real training HTTP consumer; local training migrations, audit rollback and compliance calculations use real PostgreSQL. HTTP transport and native session admission are mocked in this fixture; EDC's own route tests and live deployment qualification must establish those separately. Missing opt-in resources skip this suite and do not count as qualification. No production code depends on that test checkout.

`npx tsc --noEmit -p tsconfig.test.json` checks source and test files; its explicit excludes prevent the production configuration's test exclusion from silently omitting tests. Runtime checks use actual ephemeral loopback HTTP and an occupied-port child entrypoint, with mocked database and authority dependencies. TLS configuration tests use the installed PostgreSQL parser without contacting a database; they do not qualify a deployment's certificate chain.

Provision a new empty disposable database on loopback named `training_audit_test_*`, then run in PowerShell:

```powershell
$env:TRAINING_AUDIT_TEST_DATABASE_URL = '<connection URL for the newly owned empty test database>'
$env:TRAINING_AUDIT_TEST_OWNED = 'yes'
$env:TRAINING_NATIVE_AUTHORITY_ROOT = 'C:/Projects/EDCProject/libreclinicaapi'
node node_modules/jest/bin/jest.js tests/integration/training-audit-postgres.test.ts --runInBand
```

The guard refuses a remote host, a nonmatching database name, URL parameters, or existing public tables. Never point this test at an application database. Retain test evidence and dispose of only the explicitly owned test database after review.

Startup runs the additive audit migration before listening. The atomic migration allows a null audit actor only for `training_expired` events carrying the scheduled-expiration actor marker and affected user ID; interactive actions still require a user ID. It is safe to run again. Scheduled events remain visible in the existing audit table.

For recovery, retain the audit rows and the nullable column with its restrictive CHECK. Do not delete system events or restore NOT NULL over them when rolling application code back. Prefer a forward repair of the transactional audit path; old code that swallows audit insert errors does not provide atomic evidence.

## Revision-bound learner workflow

EDC now exposes an authenticated `/training` learner screen and an allowlisted
`/api/training` integration. Set `TRAINING_SERVICE_URL` on the EDC API to this
service's root (HTTPS, or HTTP on loopback); keep this service's `ACCURA_API_URL`
pointing to the native EDC authority. An absent/unreachable service is reported
as unavailable, never as successful completion or an invented compliance rate.
No deployment configuration is changed automatically.

Course content receives a database revision. Course material changes, quiz
changes, and slide changes increment it. Start accepts the viewed revision;
quiz submission requires `contentRevision` and refuses a stale revision even
when another browser tab has restarted the current attempt. Completion binds
both the version and revision and retains an internal content snapshot. Learner
responses never include the snapshot's correct answers. Retraining archives the
previous record (including certificate and verification) before resetting the
current attempt, in the same transaction as its actor audit. History remains
available through `/my-record-history`.

Existing completion records retain NULL version/revision pins. They cannot be
claimed as completion of today's material and appear as needing retraining;
no historical evidence is fabricated during migration. Plan that operational
retraining before rollout. Migration trigger replacement and schema changes run
in one transaction under an advisory lock. Keep the new columns, snapshots,
history and triggers if reverting application code; prefer a forward repair.
Old quiz clients must send the required revision field before rollout.

The compliance percentage is completed current required courses divided by
required courses across the authorized user census. An empty census or zero
requirements is unavailable/not applicable, not 100%. The training features and
tests do not establish protocol-specific curriculum approval, verified learner
identity in a deployed environment, or clinical training qualification.
# Study, site and arm obligations

The existing Training page now supports explicit obligations in addition to global
role courses. Managers select a native learner, parent study, optional exact site
and optional native Arm group, current course, native scope role and due time.
Assignments are checked by the EDC authority, persisted with their course version
and content revision, and included in the existing compliance reports. Assignment
is explicit per learner; it does not silently enroll every future member of a role.

The selected site must be a retained active, pending or suspended child of a
retained active, pending or suspended parent study. Training preparation grants
no clinical conduct permission; clinical activation and enrollment remain gated.
The learner must have the selected active native role at that exact site (or exact
parent study when no site is specified). An arm is a native `study_group` in an
active `study_group_class` of type `Arm` belonging to the parent study; arbitrary
groups and arms from another study are refused. Native administrators or authorized
data managers with membership at the exact scope can assign and revise training.
Withdrawal permits a closed scope but still requires the same exact-scope management
authority. Organization membership alone cannot remove another site's requirement.

Native EDC has no staff-to-arm membership roster. Arm responsibility is therefore an
explicit manager assignment to a verified study/site learner, with durable reason
and history. It is not a claim that an independent arm roster was checked.

An obligation is current only when the native scope remains valid, the course and
completion match its exact revision, the certificate has not expired, and another
authorized person has verified the completion. Course changes require revising the
obligation and completing current training; original attempts and certificates
remain archived. A previous verification cannot be overwritten. Due dates are
evaluated on read, including pending, overdue, completion-after-due and
verification-after-due indicators. The existing scheduled expiry job remains in
use; this change does not send automatic reminders or contact staff.

Managers can revise the course pin or due date with a reason, or withdraw an
obligation with a reason. Learner, course and scope cannot be silently changed on
an existing obligation. Changes require the expected revision and atomically write
the obligation, append-only history and audit; concurrent or failed requests do
not manufacture a successful assignment. Assignment and completion documentation
can be exported from the page as JSON, including the selected learner's relevant
audit history. Other learners' records and quiz answer keys are excluded.

Deploy the matching EDC authority and training proxy changes before the training
service/UI changes. The training service's existing startup migration runner adds
the obligation tables and append-only history triggers; no shared EDC database
tables, signing secrets or package dependency changes are required. Native accounts,
organizations, study/site memberships, Arm groups and course materials must already
be configured. An older or unavailable authority fails closed for scope readiness.

Scope checks are current remote observations, not a distributed transaction with
the training database. Reports do not prove every clinical duty has an assigned
curriculum; the sponsor must approve and populate the study training plan and
validate it in deployment. Independent review here uses the existing authenticated
training verification workflow; it is not a new signature/re-authentication policy.
The matching native EDC lifecycle now consumes an independently reviewed,
versioned `training-duty-policy/1` in its existing clinical decision packet.
Structured authoring accounts for every active staff role and common plus each
native intervention arm. Each declaration explicitly names delegated activities
and exact obligation/course/content revisions, or gives a reviewed reason that
no additional training is required. An empty assignment is never a completion.

Authenticated `POST /api/training/duty-readiness` returns a nonce-bound, hashed
current observation. The native actor may read their own duty evidence; an exact
scope investigator or training manager may assess the minimal activation census.
That purpose-specific census permission does not grant general training management.
Retained obligation scope and declared policy scope are both reauthorized; an
explicit common course can apply across arms without changing its custody.
Obligations, courses and completions are read from one short local PostgreSQL
snapshot, released before native HTTP callbacks. Native identity observations are
rechecked and the clinical transaction refreshes the exact proof before audit and
commit. The consumer has a 15-second deadline and four concurrent observations;
unavailable, changed, malformed or incomplete evidence refuses the clinical action.
Bearer credentials remain request-local and never enter the retained proof.

The implemented duties are site activation, new participant enrollment and arm
assignment. An approved historical activation receipt cannot authorize a new
clinical action after its required course changes. Existing data entry, safety
reporting, supply handling, reads and ongoing care do not receive a new blanket
training gate. Cross-service observations are not a distributed atomic commit;
the clinical receipt records this limitation. These controls do not by themselves
establish clinical curriculum adequacy, regulatory compliance or TA3 performance.

Focused qualification uses the actual training HTTP routes and native EDC authority
source against disposable PostgreSQL. Run `npm test`, `npm run build`, and the
opt-in `training-obligations.postgres.test.ts` with an explicitly owned empty
loopback database named `training_obligation_test_*`,
`TRAINING_OBLIGATION_TEST_DATABASE_URL`, `TRAINING_OBLIGATION_TEST_OWNED=yes`, and
`TRAINING_NATIVE_AUTHORITY_ROOT` pointing at the matching primary EDC API checkout.
The existing `training-audit-postgres.test.ts` uses its separately named empty
`training_audit_test_*` database and documented `TRAINING_AUDIT_TEST_*` variables.

### Reviewed training change impact

The existing training page now supports `training-impact-plan/1`: select the
native master/site, retained original files and their purpose; queue affected
assignments, revisions or withdrawals; retain the exact mapping; have a different
currently authorized manager accept or reject it; then apply the reviewed batch.
The current native source observation covers the existing lifecycle's study,
definition/amendment, staff, arm and authority source. Selected originals are
reopened through the existing custody path and checked against their exact bytes
and scope. They can be downloaded from the review page. This establishes source
custody and human training-applicability review, not clinical protocol approval,
curriculum adequacy, or automatic interpretation of a protocol/product change.

The native authority requires current exact-scope management and retains the
independent reviewer's authority epoch. Source, role, obligation or course changes
refuse application; revoking and regranting the reviewer's role does not revive
the old review. Each plan contains 1–50 explicit affected actions with reasons.
Larger changes need separately reviewed complete batches. There is no silent
truncation or automatic assertion that every affected learner was identified.

Application factors the existing obligation writers into one training transaction,
locks courses and obligations in stable order, and rechecks native source and
review authority after writes. Assignment snapshots, impact events and audit
commit together. Original plans and decision events are immutable; cancellation
preserves the independent review and its separate cancellation reason. Exact
idempotency keys recover uncertain proposals/applications without duplicating
obligations. Current management remains required to read/recover retained plans.
Native observations and the training commit remain separate service transactions.

Authenticated `POST /api/training/obligation-due-source` exposes
`TrainingObligationDueSourceV1@1.0.0`: every retained obligation in the exact
study/site, stable obligation/revision identity, course pins, due time, current
scope and completion evidence, and effective open/satisfied/blocked/inactive
status. Withdrawn or invalid retained scopes remain explicit. More than 1,000
rows refuses the entire census. Course/completion data comes from one local
snapshot; final native rechecks and one final expiry cutoff are explicit current
observations, not a distributed snapshot. This is an authenticated source for a
future task adapter. It does not schedule reminders, grant worker authority,
send messages or prove delivery. T.5 reminder/escalation execution still requires
an authenticated bridge into the existing CommandCenter task/timer workflow.

Deploy the matching EDC authority/proxy before the training service and UI. The
existing training startup migration transaction adds impact plans/events and
their retention triggers; no new EDC migration or signing secret is required.
The opt-in EDC `training-impact.native.postgres.test.ts` exercises the actual
training HTTP routes and native authority against two isolated synthetic
PostgreSQL databases, including review, exact source custody, concurrent retries,
revocation, rollback, retained history and due-state transitions. Fixture session
admission is synthetic; native authorization and database persistence are real.
