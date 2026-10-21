# Account registration and TechlyUp LIVE sign-in release review

Published after the owner's explicit “map kr do” instruction. Only `0047` and
`0054` were applied; `techlyup-app-api` version
`3ee7db77-3763-4ee5-a8d4-fd422c480b32` serves 100 percent on
`https://app.techlyup.com`. [Read-only postdeployment verification](postdeploy-readiness.json)
confirms eight app tables/indexes, valid integrity, optional flags disabled and
the unchanged website version. The following preparation record is historical.

Scope: `app.techlyup.com` account registration/login and the PKCE sign-in bridge
to `live.techlyup.com`. This review does not activate learning, CRM, payments,
analytics, messaging or shared-platform access. No production migration, Worker
deployment, DNS change, account write or provider operation was performed.

## Current production findings

- Cloudflare reports `techlyup-app-api` does not exist (deployment API code10007).
  Its secret-name inventory is therefore unavailable. This narrow API needs no
  backend secrets; caller scope uses an operator-managed service binding and PKCE.
- Read-only D1 metadata confirms the canonical `techlyup-registrations` realm.
  Its migration ledger has36 entries,0001 through0036. `learner_accounts` and
  `webinar_erp_roles` exist; no required `app_*` tables or `live_core_staff_links`
  exist. Existing canonical account name/profile/password columns are compatible.
- Missing staff links intentionally grant learner access only. No staff grant,
  inferred teacher privilege, role migration or email-based account matching is
  required for this release.
- A schema-only export was used for local compatibility acceptance. No account,
  password hash, registration, user document or other production record was
  copied. The export itself is temporary; only its SHA256 is retained here.

## Minimal reviewed migration scope

Apply only these immutable files through Wrangler's D1 migration ledger:

| File | Purpose |
| --- | --- |
| `0047_native_app_foundation.sql` | Hashed app access/refresh sessions, atomic audit, bounded limiter and analytics storage |
| `0054_account_registration_live_login.sql` | Self-declared phone/account type/city/referral metadata and expiring one-use LIVE PKCE challenges |

These add8 app tables and their indexes. Existing canonical tables, schema
objects and records remain in place. Schema-only acceptance confirms website
migrations0037–0046 are not dependencies. Optional backend0048–0053 and all
PostgreSQL migrations are excluded. In particular, do not run the backend's
unscoped `migrations apply` against production: its directory includes unrelated
CRM and financial modules.

`scripts/prepare-account-live-migrations.mjs` creates a new, dedicated directory
containing exactly the two byte-identical files, a migrations-only Wrangler
config and a SHA256 manifest. It validates the current production target and
optional-disabled scope, refuses to overwrite a directory, and has no remote or
subprocess capability:

```sh
node scripts/prepare-account-live-migrations.mjs --output /tmp/techlyup-account-live-reviewed-production-20261021
```

The reviewed package was prepared at that path. Compare its manifest with
[`account-live-schema-rehearsal.json`](account-live-schema-rehearsal.json) before
use. Preparation is not approval or execution.

After explicit production approval, take an operator-private recoverable backup
or verified D1 Time Travel bookmark, record its successful recovery preflight,
and recheck the live schema/ledger for drift. Keep backup download URLs and
records out of logs. Review pending migrations using the scoped config; only
0047 and0054 may appear. Apply through that same config, then require no pending
migrations and all8 tables. Do not use a raw SQL import that omits ledger receipts.

```sh
node_modules/.bin/wrangler d1 migrations list REGISTRATIONS_DB --config /tmp/techlyup-account-live-reviewed-production-20261021/wrangler.jsonc --remote
node_modules/.bin/wrangler d1 migrations apply REGISTRATIONS_DB --config /tmp/techlyup-account-live-reviewed-production-20261021/wrangler.jsonc --remote
node_modules/.bin/wrangler d1 migrations list REGISTRATIONS_DB --config /tmp/techlyup-account-live-reviewed-production-20261021/wrangler.jsonc --remote
```

These remote commands are a plan and were not run. The package config has no
Worker entrypoint, assets, routes or feature activation, so it cannot deploy an
application. Deploy the separately accepted final client/API artifact with
`apps/api/wrangler.jsonc --env production`, followed by the separately reviewed
LIVE auth-only candidate with the exact `TechlyUpIdentity` binding props. Verify
the custom domain and TLS before account journeys. No learning/Hyperdrive,
financial/provider secret or existing website deployment is part of this scope.

Rollback is forward-safe: disable the new app/SSO flags or roll back the new
Worker code. Retain additive tables and migration receipts; do not drop tables
or reset canonical account data. Newly created accounts belong to the canonical
website realm and must survive an app rollback.

## Executed evidence

| Check | Result |
| --- | --- |
| Backend initial `npm run typecheck && npm test` |99 passed,0 failed,0 skipped; real Workerd/D1, local PostgreSQL and current common `/v1` source integration included |
| Backend clean-install reproduction |`npm ci` and typecheck passed;98 tests passed and1 could not bind8898 because the separate LIVE SSO fixture owned that port. After stopping that owned server, the affected real learning HTTP/PostgreSQL test passed1/1 with0 skips. |
| Backend `npm audit --audit-level=high --json` |0 vulnerabilities |
| Learning `npm ci`, `npm run typecheck && npm test` |9 passed,0 failed,0 skipped against disposable local PostgreSQL with restricted runtime roles/RLS |
| Exact remote schema-only offline account/LIVE rehearsal |15 checks, pass;8 app tables only, all existing schema objects unchanged, valid foreign keys |
| Actual Wrangler migration runner against isolated D1 |Applied exactly0047+0054; second apply reported no migrations to apply |
| Rehearsal script strict TypeScript check |Pass |
| API-only Wrangler dry run with `wrangler.ci.jsonc` |1253.54 KiB /228.04 KiB gzip, pass; no client assets or production deployment |
| Real separate local API+LIVE Workers |Start302, canonical login200, approval200, callback302, LIVE session200, draft webinar201, callback replay rejected |
| Actual web concurrent-refresh HTTP probe |Same cookie sent concurrently returned200+401; strict replay policy revoked the winner's family as expected. See `web-refresh-runtime-replay.json`. |
| Production Worker deployment/secret list |Worker absent; no remote mutation |
| Production D1 schema/ledger metadata |Read-only, rows written0 |

The offline rehearsal executes real product auth code with synthetic local
records: signup, secure HttpOnly browser cookie, restore, canonical identity,
admin denial, fresh login, one-use PKCE approval/consumption and logout
revocation. It confirms unverified accounts remain unverified. LIVE must retain
its own verification/admission controls.

The separate local Workers then completed the actual service-binding chain with
a synthetic account in isolated D1. This caught a missing deployment setting:
the LIVE binding requires `entrypoint: TechlyUpIdentity` and operator-managed
`props: {clientId:'techlyup-live',product:'techlyup',tenantId:'appneural'}`. The
LIVE release candidate now includes those exact props. The synthetic local
account was explicitly marked email-verified only in disposable local D1, so
this does not prove real verification email delivery. The sanitized acceptance
receipt belongs to the separate LIVE release review.

Reproduce with a privately obtained current **schema-only** export:

```sh
node_modules/.bin/tsx scripts/rehearse-account-live-release.mts --schema /tmp/techlyup-production-schema-2026-10-21.sql --output /tmp/account-live-schema-rehearsal.json
```

The script uses in-memory SQLite only, rejects any input containing records and
prints no credentials. Its local ledger simulation is supported separately by
the actual Wrangler/D1 apply/reapply acceptance above.

Browser cross-tab cookie restoration needs client serialization: the server
deliberately revokes a family when a consumed refresh token is reused. Existing
concurrent-refresh acceptance confirms one200, one401 and a revoked winning
family; do not weaken replay protection to mask concurrent browser refreshes.
The client release must include and accept Web Locks serialization before the
account release is accepted.

Production DNS/TLS, authenticated end-to-end browser flow, native secure storage,
email delivery, deployed rollback/recovery and device/store publication remain
separate evidence. Local runtime proof does not establish those outcomes.
