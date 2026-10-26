# Studio apps at app.techlyup.com/studio — release runbook

Status: **built and accepted locally. Not deployed.** Every step below is an owner action.

## What changes

- The eight Studio apps (Courses, Mentorship, Certificates, Learners, Earnings, Promotion,
  Insights, AI Assistant) are served at `https://app.techlyup.com/studio/<app>/`. Each keeps its
  own Worker (`techlyup-<app>`, source in `TechlyUp-App/apps/<app>`) with no route of its own.
- `techlyup-app-api` is the gateway (`src/products/gateway.ts`). It forwards `/studio/<app>/*` through
  a `STUDIO_<APP>` service binding only when `APP_PRODUCTS_ENABLED` is on and the binding exists.
  Otherwise the central app's page answers, as today. Each app receives only its own cookies.
- Product sign-in callbacks go to `/studio/<app>/api/auth/callback`. The central approval page
  continues automatically for a signed-in person.
- Studio drafts move from PostgreSQL to a dedicated D1, `techlyup-studio` (binding `STUDIO_DB`,
  `migrations/studio`). No Hyperdrive or PostgreSQL is needed for Studio.
- Production config is deliberately unchanged until step 4: its D1 ID does not exist yet, and a
  binding to a missing Worker or database would block an unrelated hotfix deploy.

## Local evidence (25 October 2026)

| Check | Result |
| --- | --- |
| Backend typecheck, `npm test` | Pass; 127/127, including the gateway, owner-key and real workerd D1 tests |
| `wrangler d1 migrations apply STUDIO_DB --local` | Applied: 4 tables, 2 indexes, 3 triggers |
| Backend dry runs, local and `--env production` | Pass; production unchanged apart from `/studio/*` running the Worker first |
| App typecheck, lint, `npm test` | Pass; 67/67 |
| `npm run studio:build`; eight `wrangler deploy --dry-run --env production` | Pass |
| `qa:studio:runtime` + `qa:studio:api` (real workerd gateway, RPC, D1) | Pass: 8 apps, 22 resource journeys, 7 foreign-owner and learner-write denials, CSRF and canonical gates |
| Headless browser, desktop and 390 px | Pass: Studio card opens the app, one click signs in, page links stay below `/studio/<app>/`, reload keeps session, no horizontal scroll |

Not proven: anything on Cloudflare's network, real email, native devices.

## Rollout (owner)

Run from `Engineerings/Microservices/techlyup-service/apps/api` unless stated.

1. **Canonical D1: back up, then apply only 0057.**
   ```sh
   npx wrangler d1 time-travel info techlyup-registrations   # record the bookmark
   node ../../scripts/prepare-products-migrations.mjs --output /tmp/techlyup-products-migrations
   npx wrangler d1 migrations apply REGISTRATIONS_DB --config /tmp/techlyup-products-migrations/wrangler.jsonc --remote
   ```
   Never run an unscoped `migrations apply` on the canonical database: it would also apply the
   unreviewed `0048`–`0053`.
2. **Create the Studio D1.**
   ```sh
   npx wrangler d1 create techlyup-studio --location apac
   ```
3. **Deploy the eight app Workers, flags off.** From `TechlyUp-App`:
   ```sh
   npm ci && npm run studio:build
   for app in courses mentorship certificates learners earnings promotion insights assistant; do
     (cd apps/$app && npx wrangler deploy --env production) || break
   done
   ```
4. **Point the gateway at them.** In `wrangler.jsonc` `env.production`, add the Studio D1 (ID from
   step 2) after `REGISTRATIONS_DB`, and copy the eight top-level `services` entries:
   ```jsonc
   { "binding": "STUDIO_DB", "database_name": "techlyup-studio", "database_id": "<id>", "migrations_dir": "../../migrations/studio" }
   ```
   Then apply the Studio schema, rebuild the central web app and deploy, still with
   `APP_PRODUCTS_ENABLED` `"false"`:
   ```sh
   npx wrangler d1 migrations apply STUDIO_DB --env production --remote
   # from TechlyUp-App: npm run build:web && node scripts/backend.mjs sync-assets   (no local flag)
   npx wrangler deploy --config wrangler.jsonc --env production --keep-vars
   ```
   Check: `GET /api/v1/health` is `ready`; `/studio/courses` still shows the central page.
5. **Enable after acceptance.** Set `PRODUCT_ENABLED` `"true"` in each app's `env.production` and
   redeploy them, then `APP_PRODUCTS_ENABLED` `"true"` here and redeploy. With a real teacher
   account: open each app from Studio, create, edit and archive a draft, reload. With a learner
   account: no writes. Sign out centrally and confirm each app asks to sign in again. Mark the apps
   `available` in `TechlyUp-App/apps/mobile/src/screens/studio/apps.ts` in the same increment.

## Rollback

- Fastest: set `APP_PRODUCTS_ENABLED` `"false"` and redeploy `techlyup-app-api`, or
  `npx wrangler rollback <previous version> --env production`. The gateway stops forwarding at once
  and `/studio/<app>` shows the central page again.
- Keep both D1s and their tables. Never drop drafts, sessions or audit rows as a rollback.
- App Workers without the gateway are unreachable; they can stay deployed.
