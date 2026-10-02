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

Standalone Express/TypeScript service intended to share PostgreSQL with `libreclinicaapi`. It owns `acc_training_*` tables and reads the existing `user_account`, `user_account_extended`, `study`, and `study_user_role` identity/membership tables. It does not create a second account authority.

The current EDC API does not mount this standalone service or its training gate, and the EDC frontend training screens are not present. The API production compose file nevertheless defines a separate training container and publishes port 3002. This is a configured deployment path, not evidence that a running deployment was checked. These changes improve standalone readiness; they do not integrate a clinical workflow gate.

Each protected request uses the pinned `@accura-trial/auth-core` `AccuraAuthClient` to call native `GET /api/auth/verify`. This satellite does not receive `JWT_SECRET` or verify signatures locally. When deploying this version, remove the previous `JWT_SECRET` value from the training service's environment; the native API retains its own signing secret. No secret rotation or deployment is performed by these changes. There is no cache or local-only fallback. Unverified token decoding supplies only a positive user ID for comparison with the returned identity; it never authorizes a request. Authorization uses the current native username, role and organization memberships.

Deployment requires the native API's required and optional authentication middleware to adopt the pinned canonical access-token verifier: HS256, issuer `libreclinica-api`, audience `libreclinica-client`, integer issued-at/expiry with a valid lifetime, and valid user identity. Installing this satellite alone does not establish that producer contract. The authority also enforces active accounts, session revocation/timeout, credential changes and password-age expiry. A native 401/403 remains a refusal, including `PASSWORD_EXPIRED`; an unavailable authority or malformed identity returns 503 before training writes. Auth-core can read legacy tokens without a session ID, but the current native middleware requires an active session; the offline fixture's acceptance is not a claim about native session admission. These changes do not introduce Command Center assertions or establish native deployment qualification.

Set `ACCURA_API_URL` explicitly in every environment to the trusted native API root, without credentials, a path, query or fragment. The production compose network uses `http://api:3000`. `ACCURA_API_TIMEOUT_MS` defaults to the client's 10000 milliseconds and must be an integer from 1 through 30000. Missing or invalid configuration prevents startup. Never point this setting at an untrusted service: the initiating user's bearer is forwarded for verification.

Admin and canonical `data_manager` roles can manage training courses. Governed role aliases are resolved by auth-core. Existing course requirements using `manager` retain their data-manager meaning, but `manager` is not accepted as the current role returned by the authority. The previous local-only middleware checked the token's role; this middleware instead checks the fresh authoritative role, so a stale token role neither grants nor withholds current privileges. Compliance uses the native primary-role precedence (admin user type, explicit platform role, highest active legacy study role, then coordinator), not a study role promoted into a separate global authority. A supplied study ID must be an exact positive existing ID; reports include active memberships on that study or its child sites. Optional or inactive courses do not increase the required-course count or invalidate completed required training.

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

`npm test` runs the offline suite. Authentication tests exercise the real shared HTTP client with mocked fetch responses. Token-contract cases run the real canonical verifier inside that authority fixture; no service is contacted. PostgreSQL tests are opt-in and skipped by default. They exercise actual migrations, transactions, rollback on audit insertion refusal, system audit rows, and compliance SQL against a minimal projection of the native EDC schema; their authority response is also mocked. They do not exercise the complete deployed EDC, actual native session validation or browser workflow. Deployment qualification must verify the canonical producer adoption, current native session/account refusals and authority-outage behavior against the configured service.

Provision a new empty disposable database on loopback named `training_audit_test_*`, then run in PowerShell:

```powershell
$env:TRAINING_AUDIT_TEST_DATABASE_URL = '<connection URL for the newly owned empty test database>'
$env:TRAINING_AUDIT_TEST_OWNED = 'yes'
node node_modules/jest/bin/jest.js tests/integration/training-audit-postgres.test.ts --runInBand
```

The guard refuses a remote host, a nonmatching database name, URL parameters, or existing public tables. Never point this test at an application database. Retain test evidence and dispose of only the explicitly owned test database after review.

Startup runs the additive audit migration before listening. The atomic migration allows a null audit actor only for `training_expired` events carrying the scheduled-expiration actor marker and affected user ID; interactive actions still require a user ID. It is safe to run again. Scheduled events remain visible in the existing audit table.

For recovery, retain the audit rows and the nullable column with its restrictive CHECK. Do not delete system events or restore NOT NULL over them when rolling application code back. Prefer a forward repair of the transactional audit path; old code that swallows audit insert errors does not provide atomic evidence.
