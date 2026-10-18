# TechlyUp product backend

This independent repository owns the TechlyUp product adapter under `Engineerings/Microservices`. Android, iOS and web UI live in `Desktop/TechlyUp-App`. The existing `Websites/techlyup-next` website, URLs, assets, account data and deployment remain unchanged.

| Source | Ownership |
| --- | --- |
| `apps/api` | Versioned Cloudflare product API, canonical D1 identity adapter and private native/web sessions |
| `packages/contracts` | Strict DTOs, schemas, taxonomy and reviewed public content snapshots; packed for frontend consumption |
| `packages/platform-client` | Bounded server-only client for existing shared `/v1` flag/config/audit contracts |
| `migrations/d1` | Additive app session/audit metadata; no replacement canonical users |
| `vendor/appneurox-learning-postgres-0.1.0.tgz` | Pinned reusable learning implementation owned by existing `Microservices/learning-service/packages/learning-postgres` |
| `apps/api/public` | Ignored generated frontend export, prepared by the separate app launcher |

Canonical `learner_accounts` and existing ERP staff links/grants stay in the website's D1 realm. App sessions store only token hashes; canonical password changes invalidate app sessions. PostgreSQL `learning_core` stores external `techlyup-learner` account references and self-reported learning. It creates no credential or role authority. Existing common services are reused rather than copied into the client.

## Local setup

Use Node 24 or later. Keep the existing `cloudflare` checkout beside this repository for its actual source contract test. CI pins it to `6c4b52c8764a1500b0ca1a54bae9a33aa0055e67`:

```text
Microservices/
  cloudflare/
  techlyup-service/
  learning-service/
```

From `techlyup-service`:

```sh
npm ci
cp apps/api/.dev.vars.example apps/api/.dev.vars
npm run db:local
```

From sibling `cloudflare`, run `npm ci` at its repository root. The edge test harness resolves its locked dependencies from there; it has no separate package lock under `edge-monolith`.

From the separate `Desktop/TechlyUp-App` checkout:

```sh
npm ci
npm run build:web
npm run api:dev
```

The frontend launcher copies its generated export into `apps/api/public` and starts this backend on loopback port 8788. It never copies backend source into the app. Local bootstrap uses fixed `--local` arguments and creates no seeded login or staff grant. Sign up through the app with an isolated local account. Never apply the local fixture remotely.

Optional learning sync needs an isolated PostgreSQL database migrated with the existing learning package and its restricted runtime role. Configure private local `.dev.vars` values using the [API instructions](apps/api/README.md). Staging/production require Hyperdrive and reject direct loopback overrides. Optional shared-platform integration requires a narrow tenant-bound SERVICE credential and fixed project/environment scope. Credentials never enter client artifacts.

## Validation and CI

```sh
npm run typecheck
npm test
npm audit --audit-level=high
```

Acceptance includes real isolated SQLite transactions, actual workerd HTTP plus restricted-role PostgreSQL persistence, and the existing edge authentication/workspace/flag/config/audit handlers in disposable Miniflare/D1. For HTTP acceptance, provide a disposable loopback `APP_TEST_DATABASE_URL` ending in `_ci`, or install PostgreSQL tools so the test can start its own instance. It creates/cleans only its owned database and role. Never substitute production credentials. A skipped runtime test is not acceptance.

Package API source without generated app assets:

```sh
cd apps/api
npx wrangler deploy --config wrangler.ci.jsonc --dry-run --outdir dist
```

This source-only config has no web assets, public routes or live bindings. It is not a release target. Normal `npm run build` also packages prepared frontend assets and requires the app launcher to generate them. Both commands are packaging dry runs, not deployment.

The [validation workflow](.github/workflows/validate.yml) checks out this repository as `techlyup-service` and the reviewed shared-platform commit as sibling `cloudflare`, installs both lockfiles, runs PostgreSQL 18 acceptance and packages API source. It has no production/provider credentials or release step. A private shared repository requires a read-only `SHARED_PLATFORM_READ_TOKEN`; otherwise checkout falls back to the ordinary GitHub token. Forks without access fail checkout rather than silently skip the contract. Checkout credentials are not persisted for subsequent scripts. Adding this workflow does not mean a remote CI run executed.

Commit pinned vendor tarballs and lockfiles. Updating a shared package requires rebuilding its packed artifact and verifying consumers; do not silently depend on a mutable neighboring source symlink.

## Release boundaries

Committed Worker features default off. Tests/package output do not establish a production migration, deployment, provider transaction, email delivery, native installation or store publication. Shared platform access credentials expire within 900 seconds; activation requires an accepted private renewal/rotation integration. Existing edge audit ingestion is explicitly unsupported, so authentication/profile audits remain locally transaction-bound.

See [API/auth/security/deployment instructions](apps/api/README.md), the [shared-service audit](docs/shared-service-reuse-audit.md) and [platform client contract](packages/platform-client/README.md). The separate app repository records client bundle/device acceptance and remaining product phases.


Cross-owner acquisition delivery acceptance is explicit and separate:

```sh
npm run test:native-bridge
```

It requires reviewed sibling `notification-service`, `messaging-service` and
`cloudflare` source/dependencies; absence fails clearly. It uses disposable local
D1 plus a loopback synthetic gateway, never real messages or provider credentials.
See the [2026-10-16 backend release audit](docs/release-audit-2026-10-16/README.md)
for current measured evidence and unresolved deployment/provider gates.
