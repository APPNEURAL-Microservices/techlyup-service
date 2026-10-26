# Private product workspace storage

This schema is for the eight separate TechlyUp Studio apps. It holds private
teacher preparation drafts and external canonical account references. It does not
copy identity/password records or replace `learning-service` enrollment/progress.

It lives in a dedicated Cloudflare D1 database (`techlyup-studio`, binding
`STUDIO_DB`), never in the canonical `techlyup-registrations` store.
`0001_studio_workspace.sql` creates four tables, two indexes and three triggers.

D1 has no row-level security. Every repository statement binds the
server-resolved owner (`org_id`, `issuer`, `account_id`) and filters or writes it;
`studio-repository.test.ts` fails if a statement touches a Studio table without
it. Triggers keep a draft's owner, app and resource fixed and stop audit events and
stored change responses from being rewritten. Drafts can still be deleted, so
later export/deletion workflows remain possible.

Apply this migration to a local database first. Review backups, compatibility
and the target before any separately authorized production migration. No startup
path runs migrations and no deployment enables the feature. `APP_PRODUCTS_ENABLED`
defaults off.

Every change is one atomic D1 batch: the draft, its audit event and the change
key's stored response. The audit and response rows are written only if that
exact draft write landed, identified by its `write_id`. Version conflicts return
409. A lost response can be retried using the same UUID change key and identical
payload. Changed content with the same key returns 409. Archived drafts remain
stored, leave active listings and cannot be edited through the API.

The initial release supports 22 typed draft resources. All changes remain drafts.
Official issuance, live course publication, confirmed appointment scheduling,
learner enrollment/messaging, referral attribution, orders/refunds/payouts,
AI generation and real outcome/revenue reports are unavailable until their
canonical ownership, permissions and provider integrations are accepted.
Insights counts only this account's actual saved preparation records; it never
derives earnings, attendance, credentials or teaching results from those drafts.

Validation: `npx tsx --test apps/api/tests/studio-repository.test.ts` checks the
owner key in every statement, then exercises all editable resources on in-memory
SQLite and on actual workerd D1 through Miniflare: persistence, cross-account/org
isolation, concurrent version and idempotency behavior, audit rollback, the
schema triggers, archive behavior and honest feature gates.
`npx wrangler d1 migrations apply STUDIO_DB --local` applies the file through
Wrangler's own statement splitter.

Rollback: switch `APP_PRODUCTS_ENABLED` off in a separately reviewed release.
Keep schema/data intact. Do not drop tables or reverse this additive migration
as an application rollback. Export/deletion and retention administration must be
implemented and accepted before production personal-data use; the directory
currently accepts opaque references and explicit teaching permission only.
