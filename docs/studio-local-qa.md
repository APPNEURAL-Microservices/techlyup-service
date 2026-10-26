# Separate app local acceptance

The local harness starts the central account Worker on `127.0.0.1:8788` with the
eight separate app Workers behind its gateway at `/studio/<app>`, exactly as in
production: Courses, Mentorship, Certificates, Learners, Earnings, Promotion,
Insights, AI Assistant. All calls use the actual `STUDIO_<APP>` and
`TechlyUpProducts` service bindings with fixed operator-owned app/tenant props,
real PKCE and app-specific HttpOnly cookies.

Requirements: Node 24+, installed backend and frontend dependencies and port 8788
free. The harness refuses an occupied port and never stops an existing server. It
creates a disposable Studio D1 from `migrations/studio` and builds an isolated
canonical D1 schema from checked-in fixtures and migrations through `0057`.
No remote database, production identity or external provider is used.

Prepare the frontend in the separate TechlyUp app checkout:

```sh
npm run studio:build
EXPO_PUBLIC_STUDIO_LOCAL_APPS=true npm run build:web
```

Run this backend checkout with a supplied frontend checkout when needed:

```sh
TECHLYUP_APPS_ROOT=/absolute/path/to/TechlyUp-App npm run qa:studio:runtime
```

The frontend default is the sibling `Desktop/TechlyUp-App` location derived
relative to this backend checkout. No user-specific absolute path is committed.
The local ASSETS binding reads built files from disk, so rebuilding frontend
assets is visible without restarting the database or runtime. Backend/Worker
source changes require restarting the harness.

Local-only synthetic teacher and learner sign-in URLs are written with mode 600
to ignored `test-results/studio-apps-20261021/runtime-status.json`. Opening one
uses an isolated synthetic code challenge and the canonical signup/login code,
then sets the ordinary HttpOnly refresh cookie. Nothing is sent to an inbox.
These helper routes exist only in the local harness, use random paths, and are
never part of the release Worker. Do not publish the URLs, cookies or tokens.
The teacher registration grants ownership of private preparation drafts only;
it creates no canonical staff, finance, publishing or certificate permissions.

With the runtime still running, execute actual API acceptance in a second shell:

```sh
npm run qa:studio:api
```

This signs in through the real central account and each app's PKCE callback,
then creates, replays, searches/reloads, edits, rejects a stale version and
archives all 22 editable resources. It also verifies canonical feature gates,
cross-site mutation denial, foreign-owner read isolation and learner mutation
denial. Every workspace request carries the UI's expected nonsecret canonical
account ID; missing context returns 428 and a changed account returns 409 before
any domain request. This prevents an old form from being saved under an account
selected in another tab. All fixture rows are clearly marked synthetic and archived afterward.
The sanitized receipt is `test-results/studio-apps-20261021/api-acceptance.json`.
Tests keep tokens and private connection strings in memory/private temporary
files and do not print them.

Browser acceptance should additionally check the central approval step (it continues
automatically for a signed-in person), opening an app from the central Studio page,
each separate app's default/subpages, create/edit/archive/search, reload,
keyboard focus, desktop/phone menu, accurate empty/error states and the disabled
canonical actions. Coordinate teacher/learner fixture switches when sharing a
browser profile. All apps share one origin; their cookies are named per app and
the gateway forwards each app only its own.

Stop with Ctrl-C or SIGTERM. The harness disposes Miniflare, with its D1 data,
and removes private temporary storage. It marks the status
receipt stopped. Re-run from clean fixtures for a new acceptance session.
The harness owns its process termination signals and keeps Node alive until
disposal, private-file removal and the stopped receipt finish. Miniflare's
default synchronous signal-exit hooks are replaced inside this QA process so
they cannot interrupt that awaited cleanup.

Passing this harness proves isolated web/RPC/database behavior. It does not
deploy the apps, apply production migrations, confirm inbox delivery, publish
courses, issue credentials, confirm bookings, transfer money, call an AI model,
test a physical native device or publish a store app.
