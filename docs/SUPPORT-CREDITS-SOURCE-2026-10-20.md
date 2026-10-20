# TechlyUp support credits: source handoff

Status: source implementation and isolated acceptance fixtures. No production migration, deployment, provider credentials, payment order, capture, refund, real account link, or credit activation was performed. Existing public website payment consumers are unchanged. All optional feature flags remain off.

## Ownership and storage

- Product identity remains the existing D1 `learner_accounts` plus canonical app sessions. A standalone LIVE user is explicitly linked after both normal sign-ins, a five-minute challenge, one-use code and PKCE verification. Email matching never links accounts.
- `cloudflare/edge-monolith/src/support-credits.ts` and migration `0029_support_credits.sql` own the new canonical `TECHLYUP_SUPPORT_CREDIT` TEST asset, account revisions, balanced immutable journals, held units, question closures and gross 90/10 attribution. Existing generic CASH/PROMO/REWARD APIs are unchanged.
- Product migration `0052_support_credits.sql` owns link challenges, links, immutable source-principal request bindings, server-priced purchase intents, capture receipts and the funding delivery outbox. It stores no second wallet balance.
- Current packs are 100/250/500/1000 credits at one INR per credit; purchased units do not expire. Cash payout/beneficiary onboarding is not implemented or represented as complete. `mentorSubject` is the stable standalone session owner under trusted product attribution, not an inferred canonical payout account.
- The generic invoice engine was copied byte-for-byte from the existing website into `payment-service/packages/razorpay-invoice-core`, then packed as product dependency `vendor/appneurox-razorpay-invoice-core-0.1.0.tgz`. The website consumer was not edited. Its later package migration is separate work.

## Binding graph (configuration required; examples are not enabled)

The product Worker is named `techlyup-app-api`; Wrangler now builds `apps/api/src/worker.ts`, which wraps the existing HTTP handler and exports named `TechlyUpSupport` and `TechlyUpFunding` entrypoints. The common Worker is `appneurox-pure-monolith`.

1. Standalone Worker `SUPPORT_SERVICE` -> product `TechlyUpSupport`, with operator-managed binding props:
   `{clientId: "techlyup-live", product: "techlyup", tenantId: "<canonical TECHLYUP_ERP_ORG_ID>"}`.
   The separately gated CRM binding may target this same entrypoint and props.
2. Product `SUPPORT_LEDGER` -> common Worker default Fetch entrypoint. Only a server-held existing common SERVICE credential is accepted, with exact configured principal ID, tenant and current `support-credit.execute` permission. There is no public network fallback or browser credential handoff.
3. Common `SUPPORT_FUNDING_OWNER` -> product `TechlyUpFunding`, props:
   `{clientId: "edge-monolith", product: "techlyup", tenantId: "<canonical TECHLYUP_ERP_ORG_ID>"}`.
   This capability only reads verified immutable intent/capture evidence; it cannot create orders or spend credits.

Binding props come from Cloudflare deployment configuration, never method input or forwarded trusted headers. Public HTTP exposes only canonical link authorization and the signed payment webhook, not financial RPC commands or funding receipts.

## Required settings and defaults

Product settings (names only; no credential values belong in docs, client code, logs or receipts):

- `APP_ENABLED`, `APP_SUPPORT_CREDITS_ENABLED`, `APP_SUPPORT_TEST_PAYMENTS_ENABLED`: checked independently. Both new support flags default `false` in both Wrangler configs.
- `SUPPORT_EXPECTED_CLIENT_ID=techlyup-live`, canonical `TECHLYUP_ERP_ORG_ID`, and a fixed `SUPPORT_LEARNER_ISSUER` matching the common ledger configuration.
- `SUPPORT_PUBLIC_ORIGIN`: approved exact HTTPS product origin, also present in `APP_ALLOWED_ORIGINS`. Authorize page is `/support/link?challengeId=...`; normal auth stays on that origin. HTTP loopback is accepted only under test/development. No actual production authorize origin is activated by this change.
- `SUPPORT_LEDGER` binding, `SUPPORT_LEDGER_TENANT_ID`, private `SUPPORT_LEDGER_SERVICE_CREDENTIAL`. Optional `SUPPORT_LEDGER_ORIGIN` can only be `https://api.appneurox.com`.
- `SUPPORT_RAZORPAY_MODE=test`, a Test `SUPPORT_RAZORPAY_KEY_ID`, private `SUPPORT_RAZORPAY_KEY_SECRET` and `SUPPORT_RAZORPAY_WEBHOOK_SECRET`. Missing configuration fails closed; Live mode/keys are refused.

Common settings: `SUPPORT_CREDITS_ENABLED` (absent/off by default), exact `SUPPORT_PRODUCT_SERVICE_ID`, `SUPPORT_PRODUCT_TENANT_ID`, `SUPPORT_CREDIT_ISSUER`, and the private `SUPPORT_FUNDING_OWNER` binding. No source change grants an existing principal new permission or enables these settings.

Root-owned CRM has separate defaults-off `APP_CRM_WEBINAR_ENABLED` plus existing global CRM gates and migration `0053_webinar_crm.sql`; marketing declarations do not become verified marketing consent and no send/export is activated.

## RPC contract

Every `TechlyUpSupport` method returns `{ok:true,data:T}` or `{ok:false,error:{code,message}}`. Sanitized failures never include provider bodies, credentials or raw input. `LiveContext` is `{liveSubject, sessionBinding}`; standalone supplies its verified stable user ID and SHA-256 binding of the current original auth session, not a browser-selected canonical account.

- `catalog()` supplies the canonical fixed packs, limits, policy version and TEST-only asset.
- `beginLink({...LiveContext,pkceChallenge})` returns `{challengeId,expiresAt,authorizeUrl}`. `consumeLink({...LiveContext,challengeId,code,verifier})` returns `{linked:true,accountDisplay}`. `unlink(LiveContext)` revokes the link and unconsumed challenges.
- `wallet(LiveContext)` returns `{linked:false}` or canonical posted/held/available/debt units, ACTIVE/FROZEN status, TEST mode and no expiry.
- `createPurchase({...LiveContext,requestId,packId})`, `checkout({...LiveContext,purchaseId})`, `purchaseStatus(...)`, `verifyPurchase({...LiveContext,purchaseId,razorpay_order_id,razorpay_payment_id,razorpay_signature})`. Checkout exposes only the provider public Test key ID, exact order, amount and currency. Capture pending canonical delivery is `CAPTURED_CREDITS_PENDING`; only an exact canonical receipt makes it `CREDITS_READY`.
- `giveSupport({...LiveContext,requestId,sessionId,mentorSubject,credits})` returns `{id,credits,status:'CONSUMED'}`.
- `reserveQuestion({...LiveContext,requestId,sessionId,questionId,mentorSubject,desiredCredits})` returns `{holdId,desiredCredits,status:'ACTIVE'}`. Increases hold only the delta; reducing/settled reservations fail. No spending occurs until capture.
- `settleQuestion({requestId,sessionId,questionId,command:'ANSWERED'|'RELEASED',managerSubject})` returns `{status:'CAPTURED'|'RELEASED',credits,receiptId}`. Only the trusted product binding may call it. Standalone must persist the pending command and apply actual question/manager authority before calling, and show ANSWERED only after its capture receipt.
- `questionStatus({sessionId,questionId})` is read-only actual-winner recovery: `{status:'ACTIVE'|'CAPTURED'|'RELEASED'|'NOT_RESERVED',credits,receiptId:string|null}`. Standalone applies question/host scope before exposing its own saved receipt; there is no public proxy.
- `ingestWebinarEvent({...LiveContext,...event})` resolves the current non-revoked canonical link, strips RPC context, then calls the existing bounded CRM ingress. No browser email or private question/chat content is accepted.

## Financial failure rules

Request IDs bind to the original canonical account before purchase/support/reserve. Unlinking then linking another account cannot replay that request against a second principal. Exact retries use the original request ID; a conflicting body is refused.

An unknown provider order outcome never repeats provider POST. It reconciles only by the exact immutable receipt and provider metadata; missing/ambiguous results remain review-required. A new purchase is blocked while the same account has an unknown creating order. Payment signature, exact provider payment, immutable priced intent and exact paid order must all match before a capture receipt exists. A browser capture assertion cannot fund the common asset.

The funding outbox replays the same idempotent receipt/refund revision. Each authoritative increased cumulative refund gets a fresh bounded ten-attempt budget; rereading the same exhausted revision cannot reset it. Grants/ceil-unit refund reversal are atomic canonical journals. Refund debt or fractional-unit ambiguity freezes further spending for staff review; no automatic unfreeze is implemented.

Answer/release races have one canonical winner. Release before an unknown reserve creates an immutable zero-credit closure, blocking late reservation. Same-size reserve rechecks ACTIVE revision at final commit. Unknown settlement callers use `questionStatus` to persist the actual terminal outcome rather than claiming the requested command won. Cross-database source/ledger actions are durable outboxes, not a fictitious cross-D1 transaction.

## Local validation and remaining acceptance

Executed source checks:

```sh
# From techlyup-service
npm run typecheck
npx tsx --test apps/api/tests/support-credits.test.ts apps/api/tests/support-rpc-runtime.test.ts apps/api/tests/security.test.ts apps/api/tests/webinar-crm.test.ts
npx wrangler deploy --dry-run --config apps/api/wrangler.ci.jsonc --outdir /tmp/techlyup-support-worker-dryrun

# From cloudflare/edge-monolith
npm run typecheck
node --test test/support-credits.test.ts test/finance.test.ts
```

Product suite: 26 passing tests, including actual Workerd operator props isolation and public HTTP denial, existing canonical auth regressions, source-principal pinning, refund revision retry budgets and CRM consent/privacy. Common suite: 18 passing tests (seven new paid-asset tests plus eleven unchanged generic finance tests), including actual D1 concurrency, capture-before-commit and release tombstones. Both typechecks and diff checks pass. Product Wrangler dry-run packages the named exports with support flags false. These are isolated fixtures/dry-runs, not provider/production acceptance.

Before any activation: independently back up and review additive migrations on isolated copies; configure the exact approved canonical origin, both directions of Cloudflare service bindings, least-privilege existing SERVICE authority and TEST-only private credentials; then explicitly accept real dual-auth linking/revocation, Test checkout, provider capture, webhook loss/replay, funding delivery, refund/debt freeze, two-client bid races/End recovery and UI status. No Live money, mentor payout, native/device acceptance or production rollout is established by this source work.
