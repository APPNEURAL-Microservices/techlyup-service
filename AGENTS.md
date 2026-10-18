# TechlyUp product backend

- This independent backend repository owns `apps/api`, product API contracts,
  content snapshots, additive D1 migrations and server-side integration clients.
  Android/iOS/web UI belongs in `Desktop/TechlyUp-App`; the public website remains
  in `Websites/techlyup-next`. Preserve its URLs, data, logo and deployment.
- D1 `learner_accounts` and existing ERP staff links/grants remain canonical.
  Native/web token transport must not create another user realm or silently
  match existing registrations by email.
- Reusable learning source belongs in the existing
  `Microservices/learning-service/packages/learning-postgres`. Consume its pinned
  packed artifact in `vendor`; do not restore copied repository/schema code.
  PostgreSQL `learning_core` stores external issuer/account references and
  self-reported learning, never passwords or inferred roles.
- Existing common `/v1` modules belong to `Microservices/cloudflare/edge-monolith`.
  Use the bounded server-only platform client and exact current contracts. No
  arbitrary proxy, unsupported audit ingestion or SERVICE authority reaches apps.
- Keep passwords, bearer tokens, cookie values, private documents, DSNs and raw
  bodies out of logs/test output. Browser refresh tokens are HttpOnly; native
  refresh storage belongs to the frontend. Public build variables contain no
  backend secrets.
- Keep optional flags off in committed deployment configs. Validate environment
  dependencies, streamed body bounds, current grants, token rotation, atomic
  audit writes and explicit empty/unavailable states.
- No automatic production migrations/deployment. Local bootstrap has fixed
  `--local` arguments. Preserve existing schema history and data.
- Generated web assets live in ignored `apps/api/public`. Commit pinned vendor
  tarballs and lockfiles. `wrangler.ci.jsonc` packages API source without UI
  assets and is not a release target; do not weaken release configuration.
- Source checks: `npm ci`, `npm run typecheck`, `npm test`,
  `npm audit --audit-level=high`. The source contract test needs sibling
  `cloudflare` at its pinned CI commit, with `npm ci` at that repository root.
  Real Worker/PostgreSQL tests need disposable loopback `*_ci` access or local
  PostgreSQL tools, never production credentials.
- Report tests, packaging, remote CI, deployments, provider delivery and device/
  store acceptance separately. A skipped test or unexecuted workflow is no pass.
