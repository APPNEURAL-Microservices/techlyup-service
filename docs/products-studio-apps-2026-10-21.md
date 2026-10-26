# TechlyUp product apps — local implementation, 21 October 2026

This release candidate adds central sign-in and private preparation storage for
Courses, Mentorship, Certificates, Learners, Earnings, Promotion, Insights and AI
Assistant. Their UIs and serving Workers belong to `Desktop/TechlyUp-App/apps/`.
Home and Account stay in the central app. The existing LIVE sign-in flow and
public website remain separate.

> **25 October update.** The apps are now served at `https://app.techlyup.com/studio/<app>`
> by the central Worker's gateway instead of separate subdomains, so callbacks go to
> `/studio/<app>/api/auth/callback` and approval continues automatically for a signed-in
> person. Studio storage moved from PostgreSQL to a dedicated D1 (`STUDIO_DB`). See
> [studio-path-gateway-release.md](studio-path-gateway-release.md). Destination and PostgreSQL
> details below are historical.

## Release boundary

No production migration, deployment, domain activation, payment, external
communication or AI generation was performed for this implementation.
`APP_PRODUCTS_ENABLED` is explicitly `false` in default, CI and production
Wrangler variables. Each product Worker also requires its own release flag.

These are owner-scoped preparation apps. Saved course, booking, certificate
template, group, pricing, campaign and assistant records are drafts. They never
grant a canonical enrollment, confirm an appointment, issue a credential, move
money, deliver a message or establish an AI result. Canonical integrations stay
unavailable until their ownership, permissions and real acceptance are proved.

## One account and current access

Only the central app creates accounts. Product Workers use the named
`TechlyUpProducts` service-binding entrypoint, with operator-managed props:
`{ clientId: 'techlyup-<app>', product: 'techlyup', tenantId: 'appneural' }`.
Browser payloads cannot choose a caller, tenant, account, callback or permission.

`beginProductLogin` creates a five-minute app-bound PKCE challenge. The central
approval page is `/products/sign-in?challengeId=…`. Its authenticated metadata and
approval endpoints are `GET /api/v1/products/sign-in/request` and
`POST /api/v1/products/sign-in/authorize`. Approval sends a one-use code only to
`https://<app>.techlyup.com/api/auth/callback` for the recorded app.

Redemption creates a 256-bit opaque product session. Only its SHA-256 hash is
stored in D1. The product Worker keeps the credential in its own HttpOnly cookie;
it does not enter browser JavaScript or a URL. The session is bounded by 24 hours
and its canonical parent session, whichever expires first. Every session lookup
and domain request checks parent revocation, expiry, the current canonical
password fingerprint and fresh account grants. Logging out of the parent
invalidates its linked product sessions.

Product apps receive only account ID, name, email, email-verification status,
current roles/permissions and registration account type/teaching specialty.
Phones, city, referral data and profile interests stay with the central account.
Self-declared teaching registration permits private drafts; it is never an
official publishing, finance, certificate or delegated learner-directory grant.

## Storage and migrations

- D1 `migrations/d1/0057_products_login.sql` adds only product challenges and
  hash-stored sessions with foreign keys to existing canonical accounts and app
  sessions. It requires the accepted existing canonical schema and app migrations
  `0047`, `0054`, `0055` and `0056`; it does not recreate identity tables.
- PostgreSQL `migrations/studio/0001_owned_workspace.sql` creates the dedicated
  `studio_workspace` schema: external account references, draft records,
  idempotency operations and audit events. Do not apply it to learning storage by
  assumption. `migrations/studio/runtime-grants.sql` is the reviewed runtime-role
  grants template.
- Every table forces row-level security for organization, canonical issuer and
  account. Every repository query also filters those identifiers. Product/resource
  checks prevent cross-app record access. Mutations, audit and stable idempotency
  receipts commit together; optimistic versions reject stale updates.
- Runtime access must use a dedicated non-owner PostgreSQL role with
  `NOSUPERUSER NOBYPASSRLS`. Direct DSNs are accepted only for loopback
  development/test. Staging/production requires the dedicated
  `STUDIO_HYPERDRIVE` binding; it never falls back to existing learning storage.

The D1 and PostgreSQL migrations are separate. Keep their application receipts,
backup/restore evidence and runtime grants separate. Do not use the default D1
directory to apply unrelated pending migrations in production.

## Local verification

Executed successfully for central sign-in:

```sh
npm run typecheck -w @techlyup/api
node --import tsx --test apps/api/tests/products-identity.test.ts apps/api/tests/products-rpc-runtime.test.ts
```

Result: **9/9 tests passed**, including an actual workerd RPC journey with
operator-managed bindings and disposable D1. Coverage includes fixed callback
destinations, caller/tenant denial, app binding, PKCE/replay/attempt limits,
hash-only session storage, current-grant changes, parent revocation/password
changes, atomic audit failure, logout, request-size bounds and explicit local
origin configuration. Error statuses survive RPC transport, including 409 for
expired/replayed approval and 401 for revoked product sessions.

`GET /api/v1/products/overview` also authenticates the current central account
and returns only its Studio counts and recent draft activity through the same
owner-scoped repository. The Home client guards account changes and ignores
responses after unmount. Its test rejects anonymous access, browser-supplied
owner selection and disabled features.

The PostgreSQL acceptance is separate:

```sh
node --import tsx --test apps/api/tests/studio-repository.test.ts
```

That test uses its isolated loopback PostgreSQL fixture. Source checks and local
fixtures do not establish production data migration, Hyperdrive grants/TLS,
live SSO, provider delivery or native/store publication. The root app checkout
keeps additional browser/build evidence for its own candidate.

## Controlled release and rollback

1. Review the exact source candidate and both migration files. Confirm canonical
   D1 migration receipts and a separate dedicated Studio PostgreSQL target.
2. Rehearse against disposable local data, then an isolated staging copy. Verify
   existing identity/LIVE routes, least-privilege grants, forced RLS and restore.
3. Prepare a D1 migration-only release artifact containing exactly `0057`; apply
   it only after the release owner authorizes the target. Apply the PostgreSQL
   schema with its migration owner, then the reviewed restricted runtime grants.
4. Bind the product Workers to `TechlyUpProducts` with their exact app props,
   configure the dedicated Hyperdrive, and preserve the default-off flags until
   staging cross-app acceptance passes. The production origins are fixed; local
   origin overrides are refused outside development/test.
5. Publish and activate only the accepted app/version pair. Record Worker
   versions, domain mapping, migration/grants receipts, authenticated reload,
   cross-owner denial, stale-write behavior and parent logout for each app.

For rollback, turn off the product flags and roll back the serving Worker
versions. Preserve the additive schema and user drafts; do not drop tables or
reverse canonical migrations. Existing website/LIVE access does not depend on
the new product flag. No automatic deployment or production migration is wired.
