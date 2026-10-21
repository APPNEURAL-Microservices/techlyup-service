# Private product workspace storage

This additive schema is for the eight separate TechlyUp apps. It contains private
teacher preparation drafts and external canonical account references. It does not
copy identity/password records or replace `learning-service` enrollment/progress.

`0001_owned_workspace.sql` creates four tables in `studio_workspace`. All four
enable **and force** owner/org row security. The application refuses superuser
and `BYPASSRLS` connections. Use a dedicated restricted Studio runtime role and
Hyperdrive binding; never reuse the learning runtime role or migration owner.

Apply this migration to an isolated local database first. Review backups,
compatibility and target identity before any separately authorized production
migration. No startup path runs migrations and no deployment enables the feature.
Production requires `STUDIO_HYPERDRIVE`; direct `STUDIO_DATABASE_URL` accepts only
loopback development/test connections. `APP_PRODUCTS_ENABLED` defaults off.

After creating a reviewed runtime role with `NOSUPERUSER NOBYPASSRLS NOCREATEDB
NOCREATEROLE`, substitute its name in `runtime-grants.sql` and apply those grants
with the migration owner. The runtime receives no schema ownership, deletion,
audit editing, role administration or other database privileges.

Every mutation uses one database transaction for the draft, audit event and
idempotency response. Version conflicts return 409. A lost response can be
retried using the same UUID change key and identical payload. Changed content
with the same key returns 409. Archived drafts remain stored, leave active
listings and cannot be edited through the API.

The initial release supports 22 typed draft resources. All changes remain drafts.
Official issuance, live course publication, confirmed appointment scheduling,
learner enrollment/messaging, referral attribution, orders/refunds/payouts,
AI generation and real outcome/revenue reports are unavailable until their
canonical ownership, permissions and provider integrations are accepted.
Insights counts only this account's actual saved preparation records; it never
derives earnings, attendance, credentials or teaching results from those drafts.

Validation: `npx tsx --test apps/api/tests/studio-repository.test.ts` starts and
destroys its own loopback `*_ci` PostgreSQL cluster, migrates it and uses a role
without RLS bypass. It verifies all editable resources, persistence across a
fresh pool, cross-account/org isolation, direct SQL RLS, concurrent version and
idempotency behavior, audit rollback, archive behavior and honest feature gates.

Rollback: switch `APP_PRODUCTS_ENABLED` off in a separately reviewed release.
Keep schema/data intact. Do not drop tables or reverse this additive migration
as an application rollback. Export/deletion and retention administration must be
implemented and accepted before production personal-data use; the directory
currently accepts opaque references and explicit teaching permission only.
