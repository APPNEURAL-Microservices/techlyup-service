# TechlyUp app API — Phase 0

Cloudflare Worker hosting the Android/iOS/web app backend at `/api/v1`. Existing `techlyup.com` website routes, cookies, data and deployments are untouched. This Worker uses the same canonical D1 `learner_accounts` realm; its additive app sessions do not create another user/password database. PostgreSQL is only for app learning records linked to opaque canonical account IDs.

## Local development

From the backend root, `Microservices/techlyup-service`:

```sh
npm ci
cp apps/api/.dev.vars.example apps/api/.dev.vars
npm run db:local
```

Then from the separate `Desktop/TechlyUp-App` frontend checkout:

```sh
npm ci
npm run build:web
npm run api:dev
```

The frontend launcher copies the generated web export into the backend's ignored `apps/api/public` directory and starts this Worker. Backend source and migrations remain in Microservices; no reusable API implementation is copied into the frontend.

Open `http://localhost:8788` for same-origin web + API. `http://localhost:8788/api/v1/health` should report `ready` only after local setup. The local bootstrap has fixed `--local` arguments, accepts no extra arguments, loads a self-contained canonical **test/development schema only**, then applies migration 0047. It imports no production records, creates no demo accounts or staff grants and never needs the website's absolute source path. Sign up through the app to create an isolated local account. Do not apply the local fixture to any remote database.

For Android emulators, use an API endpoint reachable from the emulator (Android's host alias is commonly `10.0.2.2`). Physical devices require a reachable development address and reviewed HTTPS transport; the default Worker dev command binds loopback only. A publicly reachable native build must use an explicitly configured HTTPS API origin. Browser deployment is same-origin. Do not expose an unrestricted dev server as production.

Optional local PostgreSQL learning sync requires a database migrated with `@appneurox/learning-postgres`, owned in the existing `Microservices/learning-service/packages/learning-postgres`, and its restricted runtime role. Its CLI uses private `LEARNING_POSTGRES_MIGRATION_URL`; its schema is `learning_core`. Set these privately in `.dev.vars`:

```dotenv
APP_LEARNING_ENABLED="true"
APP_LOCAL_POSTGRES="true"
APP_LOCAL_DATABASE_URL="postgresql://<runtime-role>:<private-password>@127.0.0.1:<port>/<isolated-db>"
```

Direct connections are accepted only for loopback hosts in `development`/`test`. Staging/production require an `APP_POSTGRES` Hyperdrive binding and reject the local override. No actual local/remote database credential belongs in committed source or test output.

## Contract

All responses use `{data,meta:{requestId,apiVersion:'v1'}}` or `{error:{code,message,fields?},meta}`. API responses are private/no-store, non-indexable, protected against MIME sniffing and frame embedding. HTTPS responses include HSTS. Production HTTP is rejected. `X-TechlyUp-Client` is `web`, `ios` or `android`; this selects token transport and never grants permissions.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/api/v1/health` | `disabled` when API is disabled; checks all required app/canonical tables before D1 readiness. No secrets or counts. |
| GET | `/api/v1/catalog?kind=course&q=ai` | Reviewed website snapshot with source/date; expired scheduled webinar entries are removed. No live seat/capacity claim. |
| POST | `/api/v1/auth/signup` | Shared strict signup schema; new canonical learner + app session + audit in one D1 transaction. Requires signup flag. |
| POST | `/api/v1/auth/login` | Existing canonical email/password; same scrypt format and work factor as website. |
| POST | `/api/v1/auth/refresh` | Native `{refreshToken}`; web `{}` with HttpOnly cookie. Rotates once; reuse revokes that device family. |
| POST | `/api/v1/auth/logout` | Authenticated `{}` or native `{refreshToken}`; web uses secure refresh cookie. Revokes current app device family and clears browser cookie. |
| GET | `/api/v1/me` | Bearer access token; current profile/roles/permissions. |
| PATCH | `/api/v1/profile` | Shared profile schema; updates canonical names/preferences plus audit atomically. Current canonical middle name is preserved. No email/role/account-ID writes. |
| GET | `/api/v1/admin/overview` | Current canonical admin permission required. Verified account, active native-device session and audit counts. |
| POST | `/api/v1/events` | Authenticated shared analytics schema; enumerated screen/event/kind only, no arbitrary properties/PII. Requires analytics flag. |
| GET | `/api/v1/featureflags` | Two fixed public Boolean keys from the existing shared platform; explicit disabled defaults and local-capability restrictions. No caller-selected keys/targets/tenant. |
| GET | `/api/v1/platform/capabilities` | Current canonical admin only; measured scoped shared-service flag/config/audit metadata. Disabled by default; no token or raw config values. |
| GET | `/api/v1/learning/enrollments` | Optional PostgreSQL own enrollments; `{enrollments,tracking:'self-reported'}`. |
| POST | `/api/v1/learning/enrollments` | `{kind:'course',id:'course-ai-useful-answers'}` plus stable UUID `Idempotency-Key`. Only this reviewed free course. |
| GET | `/api/v1/learning/enrollments/:id/progress` | Own active, supported free-course enrollment; `{progress,tracking:'self-reported'}`. |
| PUT | `/api/v1/learning/enrollments/:id/progress` | `{lessonRef,status:'started'|'completed',expectedVersion}` plus stable UUID `Idempotency-Key`. Known published lesson IDs only. |

Access tokens expire after 15 minutes. Refresh families expire 14 days after issuance; refreshing does not extend their absolute lifetime. Tokens contain 256 random bits and are SHA-256 hashed at rest. Web access tokens stay in memory; refresh tokens are omitted from browser JSON and live in a Secure/HttpOnly/SameSite=Strict host cookie (local HTTP has a separate unprefixed development cookie). Native refresh tokens go only to native secure storage. Never use browser localStorage for either token.

Every Origin-bearing API request must match the explicit allowlist. Browser mutations require Origin; production also requires exact same origin as the Worker request. Native mutations without Origin use the declared native transport and bearer/refresh proof. No cookie alone authorizes profile/admin/learning/event APIs. CORS uses an exact origin and credential support, never `*`.

Current roles are loaded from unrevoked/unexpired D1 `live_core_staff_links`, mailbox consistency and `webinar_erp_roles`, following the existing ERP mapping. Token payloads and client fields cannot supply a role. A canonical website password change invalidates app sessions immediately through the stored password fingerprint, without changing website code. Signup leaves email unverified; email text/domain never grants staff permissions.

## Environment and deployment

`wrangler.jsonc` is deliberately disabled (`APP_ENABLED=false`, signup/analytics/learning flags false), has no public routes or workers.dev URL and uses a zero placeholder D1 ID. This is preparation, not a release target. No deploy script or automatic production mutation is provided. `npm run build -w @techlyup/api` is a packaging dry run only.

For an approved separate app deployment:

1. Export the web app and verify its brand/assets and authenticated flows. Use a dedicated app hostname; keep `techlyup.com` and its existing Worker/routes untouched.
2. Review the canonical remote D1 target and its website migrations 0001–0046. Back up before applying the additive `migrations/d1/0047_native_app_foundation.sql` with an approved migration workflow. Never run the local fixture remotely or reapply historical website migrations blindly.
3. Create a separate environment-specific Worker config with `APP_ENV=staging`/`production`, exact HTTPS allowed origin, canonical D1 binding and `ASSETS`. Keep optional features disabled until their acceptance tests pass. For learning, migrate the new PostgreSQL schema with the dedicated migrator identity and bind Hyperdrive using its restricted runtime identity. Database connection strings stay in bindings/secrets.
4. Run D1/PG migration checks, Worker packaging, isolated API/DB tests and staging browser/native checks. Readiness, client tests, provider delivery and production verification are distinct evidence.
5. Promote only the tested source/artifact using the owner's release workflow. Verify exact app URL, account persistence across reload, current roles/protected API, token rotation/logout and optional learning persistence. A successful dry run is not a deployment.

The optional `APP_PLATFORM_ENABLED` bridge also defaults false. It uses `PLATFORM_SERVICE_CREDENTIAL`, `PLATFORM_TENANT_ID`, `PLATFORM_PROJECT_ID` and `PLATFORM_ENVIRONMENT_ID` only on the server. It consumes the existing `cloudflare/edge-monolith` contracts through `@appneurox/platform-client`, validates a tenant-bound SERVICE principal with narrow current grants and never grants that principal's authority to app users. Public flag keys are fixed in source; shared config resolution is limited to `techlyup-app` / `app.display-name` and is not returned as a generic public proxy. The existing audit module reports client ingestion unsupported, so local transaction-bound auth audits remain the authoritative record. See the [reuse audit](../../docs/shared-service-reuse-audit.md).

Existing edge access/opaque credentials expire within 900 seconds. A production shared bridge needs an accepted private credential renewal/rotation provider before activation; the configured credential is not a permanent API key and this Phase 0 client does not invent a new provisioning authority. Local contract tests prove current short-lived SERVICE use, not live provisioning or long-running renewal.

The hourly scheduled handler deletes at most 1,000 expired rate counters, 1,000 expired access tokens, 1,000 expired refresh tokens and 50 sessions expired over seven days ago per invocation. It retains active refresh/replay evidence and never deletes audit or analytics records. It is a no-op while the API is disabled. Monitor retained audit/analytics volume and define an approved retention policy before substantial traffic. Canonical-compatible scrypt uses 32 MiB per hash; measure paid-Worker CPU/memory and concurrent auth capacity on staging before making capacity claims.

## Acceptance and remaining boundaries

```sh
npm run typecheck -w @techlyup/api
npm run test -w @techlyup/api
npm run build -w @techlyup/api
```

Tests use real isolated SQLite transactions for canonical login compatibility, hash-only session storage, native/web transport, rotation/replay/concurrent refresh, immediate password invalidation, current RBAC, strict taxonomy/identity validation, audit rollback, rate/storage failure, analytics privacy and bounded cleanup. Learning HTTP tests validate the server-resolved account, exact free course/lessons and idempotency/ownership guards; PostgreSQL repository tests separately exercise actual transactions, RLS, grants and audit rollback. A packaged Worker must still pass real local/staging browser/device acceptance.

Password recovery, native mailbox-verification delivery, paid content, real webinar enrollment/media, live mentorship booking, payment execution, notifications, provider analytics delivery and production deployment are outside Phase 0 acceptance. Learning progress is self-reported practice tracking and grants no paid entitlement, seat, attendance credit or certificate.
