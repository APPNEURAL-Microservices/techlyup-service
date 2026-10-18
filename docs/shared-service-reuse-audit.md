# Shared backend ownership and reuse — 2026-10-16

The existing website remains in `Websites/techlyup-next`. Android/iOS/web UI remains in `Desktop/TechlyUp-App`. Product backend/API/DTO source now lives in this independent `Microservices/techlyup-service` package. The reusable PostgreSQL learning repository lives in the existing `Microservices/learning-service/packages/learning-postgres` package and is consumed as a pinned packed artifact. No production deployment, existing shared-service credentials, migrations or remote grants were changed during this work.

## Two existing monolith runtimes

`Microservices/monolith` is the native Node/Nest modular host. Its `package.json` exports `src/app.ts`; `createMonolith()` starts built sibling service entries in worker threads and exposes `consume(prefix,path,init)` through the existing HTTP contracts. `monolith/src/registry.ts` defaults each entry to `dist/main.js`, resolves independent service dependencies/environments and isolates namespaced variables. It is a Node host with worker threads, HTTP/net/TLS and native dependencies, not a library that can be bundled unchanged into an Expo client or Cloudflare Worker. Its sibling services retain independent packages/databases.

`Microservices/cloudflare/edge-monolith` is the existing Cloudflare Worker `/v1` runtime. `src/worker.ts` imports the module dispatchers; its private `package.json` does not publish a stable general-purpose library export. It uses the platform's own `DB` D1 binding and `edge_*` identity, credential, access, workspace and business tables. Its readiness/implemented core, original native parity, provider delivery and end-to-end business outcomes are distinct claims. Historical README deployment receipts were not used as proof of a current live release in this audit.

## Current reuse contracts

The edge runtime accepts `Authorization: Bearer <edge credential or access JWT>` and a current tenant-bound principal. `X-Tenant-ID` must match that principal; selecting another tenant is reserved for an explicitly global platform administrator. There is no general application-key header. Writes require the platform's configured public origin, so the product adapter sends an upstream request with the fixed platform URL/Origin, never forwards the app's browser Origin. Credential bounds intersect with current persisted grants on every call (`edge-monolith/src/identity.ts:170`); user-supplied role lists and tenant headers do not grant permissions.

| Module | Existing edge endpoints | Product decision |
| --- | --- | --- |
| Authentication | `/v1/authentication/me`, `/token`, `/refresh`, `/browser-session`, `/credentials`, `/session` | These operate on existing edge principals/credentials. They are not public email/password/signup endpoints for TechlyUp's D1 learners. Use only an approved server SERVICE credential for shared-module access. |
| Identity/access | `/v1/identity/principals`, `/v1/access/roles`, `/memberships`, `/check` | Keep current TechlyUp ERP grants authoritative. Do not auto-create shared principals or grant new roles by email. |
| User/profile | `/v1/user/users`, `/user/application-policies`, `/v1/profile/profiles`, `/profile-types`, `/profile-schemas` | Existing separate platform records have ownership/schema/lifecycle rules. Creating one is not a migration of a canonical `acct_` learner. No duplicate account/profile writer is enabled. |
| Feature flags | POST `/v1/featureflag/evaluate/batch`, server SDK snapshot/revision endpoints | Reused now through `packages/platform-client` with fixed scope and public Boolean allowlist. No flag definitions or SERVICE credentials enter the mobile/web bundle. |
| Config | POST `/v1/config/configurations/resolve` | Reused now for fixed `techlyup-app` namespace and one explicitly public display-name key; typed client strips other values. |
| Audit | GET `/v1/audit/capabilities`, `/events`; POST `/verify` | Reused capability read now. Existing edge source explicitly denies client-event ingestion; retain local transaction-bound authentication audits rather than claim an unsupported shared sink. |
| Catalog | `/v1/catalog/catalogs`, catalog placements, product/type/price APIs | These are shared commerce catalog/product definitions, not the website's reviewed course/session authority. Existing edge source reports external-owner source bridges unsupported. Keep the versioned website content snapshot until an explicit content mapping/provenance bridge is accepted. |

The native `authentication-service` is richer: `/api/v1/auth/login/password`, `/oauth/token`, JWKS, factors/recovery and federation clients. It resolves subjects through `IdentityServicePort`, uses native client/tenant/audience contracts and Argon2 credential storage (`authentication-service/src/infrastructure/crypto/passwords.ts`). It cannot verify the website's scrypt account table simply by changing a URL. Its PKCE ADR describes a federation **client**, not a general OIDC authorization server. `user-service/docs/identity-vs-user.md` separately assigns identity, credentials, user account state and profile content to their respective owners.

## Canonical identity preservation

TechlyUp's D1 `learner_accounts`, password hashes and signed ERP links remain canonical. The product-specific adapter preserves that realm and adds native/web app token transport without changing the website. Learning references carry issuer `techlyup-learner` plus the existing `acct_` ID. Neither a shared SERVICE principal, email/domain text, a catalog ID nor a PostgreSQL account reference proves learner identity or grants paid access.

A future shared identity migration needs a separately tested external-subject bridge with signed provenance, explicit issuer/subject mapping, current revocation/introspection and consent/lifecycle behavior. It must preserve existing credentials/sessions/data and cannot silently auto-link by matching email. This compatibility requirement is why the product adapter remains explicit instead of pretending the existing shared realm already owns website learners.

The edge's current access/opaque credential cap is 900 seconds. Shared bridge production activation therefore also needs an accepted durable credential renewal/rotation integration; a token injected for an isolated local acceptance run is not a permanent application key or evidence of long-running platform access. The bridge remains disabled by default, and expired/missing authority fails closed.

## Accepted local evidence

The platform-client contract test uses the actual neighboring edge dispatcher code and its complete D1 migration set in disposable Miniflare. A genuine local `SERVICE` principal authenticates, evaluates flags, resolves owned scoped configuration and reads audit capabilities. Wrong tenant and permission withdrawal fail closed. Separate tests cover origin pinning, private token transport, strict Boolean/key/size validation, disabled defaults and the canonical-admin diagnostic gate. These are local contract evidence, not activation of the live platform for TechlyUp.
