# Acquisition CRM storage foundation

Source owner: `Microservices/techlyup-service`. Migration `0048_crm_acquisition.sql`
is additive to the website's existing canonical D1. It does not create users,
passwords or webinar registrations, migrate the commercial Customer Service, or
replace the existing PostgreSQL LIVE CRM and notification queue.

## Authority and records

`crm_contacts` stores prospect contact handles. Only normalized provided email
is a deduplication key. Phone-only captures remain distinct; conflicting/shared
phone observations become review hints and never merge identities. The first
contact name and phone survive later public duplicate submissions. A contact can
link to a canonical account only through the server's explicit proof option and
a current canonical email match. Email equality alone never creates that link.

`crm_leads` stores category, interest, first/last attribution, assigned current
staff account, explained score and versioned pipeline state. Related tables hold
activities, tasks, pipeline history, sparse source-event deduplication, typed
score/automation rules, rule-run receipts, integration metadata, approved campaign
snapshots, queued jobs and provider attempts. Visitor identity and local drafts
are separate privacy boundaries owned by migration 0050/client code.

All acquisition keys and queries include organization scope. Staff assignment
uses current canonical staff links, expiry, revocation, account email and ERP
functional roles. Mutations recheck assignment and owner scope inside their
atomic D1 batch, including a compare-and-set guard. Existing canonical role
storage stays authoritative.

A task assignee must be the current lead owner or a current global CRM manager
(owner/admin/manager/operations/academic admin/coordinator). Task assignment does
not grant contact access. The write atomically verifies the lead owner/version
and current assignee roles. Changing a lead owner moves open tasks assigned to
scoped staff to the new owner and increments their task versions; manager-owned
tasks remain assigned to those managers. Removing an owner requires closing open
scoped tasks or reassigning them to a current CRM manager first. The lead and task
changes share the command/audit transaction.

## Consent and delivery

Public capture requires an explicit current-notice service-processing request
before contact persistence. Approved signed external forms retain a separate
processing receipt (source ID, event ID, notice and occurrence time); that receipt
never verifies the contact or grants marketing. Public fields are declarations;
they cannot claim contact verification. Email
marketing and WhatsApp opt-in are separate purposes/channels. Service consent
never enables marketing. Public capture requires notice 2026-10; a legacy
newsletter import records `legacy-newsletter-unversioned`, does not invent a
notice receipt and grants no broader acquisition campaign permission. Historical
newsletter delivery stays with its existing owner.

Consent observations, pipeline history and audit events are append-only. Intake
never regrants a withdrawn permission. Every send attempt requires a current
verified canonical contact, a purpose-specific verified acquisition permission,
local suppression checks, canonical channel suppression, canonical account-level
email suppression and current newsletter status. Account suppression is a
negative privacy check even for an unlinked prospect; it never links identity.
Canonical contact digests match `techlyup-next/src/lib/live/crm/hashes.ts`: SHA-256
of channel, a runtime NUL separator and normalized contact value.

Preference tokens contain 256 random bits; only their hashes are stored. A valid
token withdraws both purposes for its bound channel, appends evidence, writes
local and canonical suppressions and suppresses queued acquisition jobs. Tokens
cannot change any other contact or channel. Replaying a consumed token is safe.

Campaign queuing and typed automation create durable intentions, never provider
HTTP calls. Jobs snapshot the approved campaign version/template/integration;
those intention fields are immutable. A lease claim and attempt receipt commit
before provider I/O. A lost or ambiguous send becomes `uncertain` and is never
blindly retried. Actual dispatch and final signed authorization belong to the
server-only native notification adapter. Configuration and delivery flags default
off. WhatsApp declaration alone cannot satisfy current verified phone proof.

## Transaction and load boundaries

Each command commits its idempotency receipt, mutations, outbox intention and
audit together using D1 batch atomicity. Stable request keys are 8–180 identifier
characters. Reusing a key with different input fails; source events additionally
require unique organization/source/external ID and matching payload digest.
Storage failure is distinguished from an already consumed webhook nonce.

Lead reads use bounded keyset pagination. CRM activity/task/job responses are
bounded. Exports reject more than 1,000 matches and log the exported count.
Campaign preview/queue SQL applies filters before enforcing a maximum of 100
prospects per reviewed batch; larger audiences require narrower filters, without
silent truncation. The scheduled adapter drains a bounded number of events/jobs.
Validate the target Worker/D1 quota and staging latency before enabling dispatch;
these local tests are not a capacity benchmark.

The scheduled retention helper deletes at most 100 expired rows from each transient
receipt/nonce/token table per invocation and organization. Idempotency receipts
expire after 7 days, webhook nonces after 24 hours and preference tokens after 90 days.
Consent, contact and audit deletion are intentionally outside this transient
cleanup: a separately authorized retention/erasure policy must cover those
records before production retention claims are made.

## Local acceptance evidence

`npx tsx --test apps/api/tests/crm-repository.test.ts` passed 22 tests with no skips
on 2026-10-16, against actual isolated SQLite transactions and foreign keys. Tests
cover strict intake, deduplication, source replay/mismatch, identity boundaries,
tenant/owner isolation, stale versions, roles revoked immediately before commit,
audit rollback, current canonical suppression, the website's actual digest test
vector, unversioned newsletter boundaries, opaque withdrawal, queue leases,
unknown-outcome no-retry, immutable intentions, explained rules, approved follow-up
queuing, export bounds and transient retention. HTTP/provider/source/privacy tests
are separate suites maintained by the API/root owners. No remote migration,
provider delivery, deployment or native-device acceptance is implied.

`npx tsx --test apps/api/tests/crm-runtime.test.ts` additionally passed the actual
workerd/D1 HTTP acceptance on 2026-10-16 (33.2 seconds, no skips). It verifies the
SHA-256 provenance of the complete website migrations 0001–0046 schema snapshot,
applies additive migrations 0047–0050 to a disposable local database, and uses a
separate Worker on port 8899. The journey covers canonical signup and staff grant,
public capture/deduplication, private search, versioned pipeline/note/task writes,
reload persistence, learner and revoked-staff denial, visitor consent/withdrawal,
actual D1 audit rollback and canonical form outbox projection through the scheduled
handler. No provider is configured or called. The owned process and temporary
state are cleaned up afterward; this does not establish deployment or delivery.
