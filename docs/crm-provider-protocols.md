# Acquisition CRM integration boundaries

This product adapter belongs to `Microservices/techlyup-service`. It preserves the
website D1 learner realm and existing LIVE CRM. It does not create credentials,
commercial customers, registration confirmations, registration reminders, payments
or provider delivery authority.

## Reused owners

- The website `src/lib/live/crm/canonical.ts`, `communication-authority.ts`,
  `privacy.ts`, `projection.ts` and `internal-http.ts` own LIVE registration-linked
  CRM, current canonical authorization, suppression and delivery jobs. The existing
  D1 notification queue retains registration/reminder ownership.
- `notification-service/src/orchestration` owns native notification intents,
  immutable published type/template references, preferences and channel plans.
  Its older `src/infrastructure/providers.ts` is a compatibility artifact.
- `messaging-service/src/transport` owns provider transport, sender verification,
  suppression, ambiguous acceptance and native provider callbacks. It already has
  SendGrid, Twilio and an approved gateway; this product does not duplicate them.
- `integration-service` owns connections and native secret-service references.
  Provider credential references are tenant/account/connection bound; actual
  material never enters public CRM metadata.
- `customer-service` owns commercial relationships and Customer 360, independently
  of login identity. Acquisition lead records do not become duplicate customers.

The edge monolith `/v1/notification/notifications` contract is a different runtime
from native `/api/v1/notification-intents`. Configuring an edge SERVICE token does
not establish native notification authority. Both realms require explicit grants.

## Native intent adapter

The server sends only `POST /api/v1/notification-intents` and reads a previously
bound `GET /api/v1/notification-intents/:id`. The trusted destination is
`CRM_NOTIFICATION_ORIGIN` (HTTPS origin only); the credential and fixed
tenant/subject/type identifiers come from server secrets/configuration. Redirects
are rejected, requests stop after five seconds, streamed JSON is capped at 64 KiB,
and there are no automatic retries.

Create uses `Idempotency-Key: techlyup-crm:<job UUID>`, the same source event ID,
`sourceResourceType: techlyup-acquisition`, exact lead ID, and one trusted
`EXPLICIT_CONTACT`. The published type receives bounded `name`, `subject`, `body`
and `unsubscribeUrl` variables. The notification owner must register that exact
payload schema, workload, tenant, allowed type and resolver. Its source registry
must permit this explicit-contact resolver and its current policy must permit the
purpose. WhatsApp additionally needs its own verified contact opt-in and an
approved native owner template/sender route; generic email marketing permission
never grants WhatsApp permission.

The HTTP receipt must bind tenant, source subject, job and lead. It proves durable
intent acceptance. It never proves dispatch, delivery or read. Reconciliation
reads that exact native intent, reports native status and explicitly returns
`deliveryVerified: false`; administrators cannot post a claimed delivered status.
An unknown POST outcome becomes `uncertain` and is never blindly retried or sent
through a fallback provider. Missing current consent or owner configuration blocks
dispatch before provider I/O.

`POST /api/v1/crm/delivery/authorize` supplies a concrete final decision contract
for the native owner adapter. It uses the same HMAC protocol with the separate
`CRM_DELIVERY_AUTH_SECRET`, a consumed nonce, and strict body fields `tenantId`,
`jobId`, `leadId`, `channel`, `purpose`, `recipientHash`. The hash is the canonical
website SHA-256 of `channel + NUL + normalized contact`. The server compares all
fields to stored job/campaign/integration state and fresh canonical consent and
suppression; body claims never confer permission. The response has only `allowed`,
`reason`, a decision ID and a five-second expiry. It exposes no recipient value.

**Locally tested, production acceptance remains blocked:** the native owner source
now preserves stored intent/job/lead/type provenance through notification requests.
Messaging's registered `DELIVERY_AUTHORITY_ROUTES` selects a fixed tenant-bound
TechlyUp HTTPS origin, notification workload subject, source subject and allowed
type keys. A separate absolute secret file must be a regular non-symlink file
with no group/other permissions. Messages cannot select their callback origin or
key file. Only the registered authenticated notification SERVICE can create such
a message; its provenance is immutable after creation.

The instrumented native provider invokes `TransportService.confirmDispatch`
after content/credential preparation and before its HTTP POST. The guard calls
the actual CRM decision, checks fresh native sender/route/suppression state and
rejects an expired five-second decision. Literal NUL contact hashing and newline
HMAC encoding are covered by cross-owner acceptance. Acquisition digests are
unsupported: new digest configuration is rejected, recipient digest preferences
suppress the attempt, existing frozen digest requests fail closed, and a frozen
normal request must retain its exact stored provenance. Other notification
sources keep their existing digest behavior.

Run `npm run test:native-bridge` with the reviewed notification-service,
messaging-service and cloudflare sibling sources/dependencies present. This
explicit check fails when they are absent; independent backend CI does not
pretend to have exercised another service's uninstalled code. The current local
test uses disposable D1 and a loopback synthetic gateway. A valid decision permits
one synthetic POST; withdrawal, recipient swap, expired decision, authority
outage, forged HMAC and replay produce zero additional provider POSTs. It does
not establish deployed owner configuration, JWT renewal, sender/template approval
or real recipient delivery. Publish and validate the owner changes together,
reconcile any older queued/frozen requests, then prove current policy and
revocation in the controlled environment before enabling sending.
`CRM_NOTIFICATION_AUTHORITY_APPROVED` remains a default-off deployment gate,
not deployment or vendor-delivery evidence.

`CRM_NOTIFICATION_ALLOW_LOCAL=true` permits only loopback HTTP in development/test.
It is unavailable in staging/production. Production flags stay off until actual
owner registrations, identity renewal, permissions, templates, sender verification,
unsubscribe destination and native provider delivery are approved and exercised.
The approved `CRM_PUBLIC_ORIGIN` must be an exact HTTPS TechlyUp origin in the app
origin allowlist. Email links use `/communication-preferences#token=<opaque>`;
the fragment stays out of server access URLs. Withdrawal is an explicit POST with
`{token}` and persists both service and marketing vetoes for the token-bound
channel in acquisition and canonical LIVE suppression storage. Repeated valid
tokens confirm the withdrawal; unknown or expired links return a bounded
`preference_link_invalid` error without revealing personal details.

## Approved lead normalization relay

The only inbound provider entry is `POST /api/v1/crm/webhooks/relay`. It is for an
approved server normalization relay, not raw Meta/LinkedIn vendor callbacks. The
existing webhook-service owns raw provider signature validation; unsupported
native adapters need a reviewed signed normalization relay before activation.

Sign the exact UTF-8 JSON bytes with HMAC-SHA256 using `CRM_WEBHOOK_SECRET`:

```
<13-digit timestamp milliseconds>\n<UUID nonce>\n<exact pathname>\n<hex SHA256 of raw body>
```

Send `x-techlyup-crm-time`, `x-techlyup-crm-nonce`, and lowercase hexadecimal
`x-techlyup-crm-signature`. The signature expires after five minutes and each nonce
is durably consumed once. The body is capped at 16,000 bytes. Its strict envelope
contains `provider: meta|linkedin|external`, `integrationId`, `sourceRef`, `externalId`,
`processing: {policyVersion: "2026-10", occurredAt, serviceRequested: true}`, and
`capture` in the shared capture schema. Processing proof must be no more than 30
days old and cannot be in the future. The referenced integration must be
active and match the provider and registered source reference; the corresponding server approval flag must be
true. Stable source identity makes normalized-event replay idempotent independently
of the signature nonce. Explicit submission-processing proof is retained as a
declared service processing basis; it does not verify contact ownership. A raw
checkbox or the availability of an address cannot grant marketing or WhatsApp
permission. Public app intake also requires acceptance of the current service
contact notice before any personal details are persisted. Staff manual entry
uses staff authority and cannot grant a recipient permission.

## Executed versus activation evidence

Focused local tests exercise real loopback HTTP requests against a strict synthetic
native notification endpoint and the exact relay signature algorithm. They also
test cross-tenant/source binding, malformed/oversize JSON, redirects, refusal before
send, uncertain acceptance and no automatic retry. These tests do not establish
deployment, a working webhook-service normalization subscription, native owner
production registration, a vendor approval or any real recipient delivery.
