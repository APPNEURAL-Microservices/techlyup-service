import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fetch as appFetch } from '../apps/api/src/index.ts';
import { beginLiveLogin, consumeLiveLogin, type LiveLoginEnv } from '../apps/api/src/live/login.ts';
import type { D1Database, D1Statement } from '../apps/api/src/types.ts';

// Offline rehearsal only: no network client, production data, persisted database or remote command.
// Input must be a schema-only D1 export. Output contains hashes/statuses, never accounts or tokens.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--schema' || args[2] !== '--output') {
  throw new Error('Usage: tsx scripts/rehearse-account-live-release.mts --schema <schema-only.sql> --output <report.json>');
}
const source = readFileSync(args[1], 'utf8');
if (/\b(?:ATTACH|DETACH|load_extension)\b/i.test(source)) throw new Error('A standalone schema-only export is required.');
const sqlite = new DatabaseSync(':memory:');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const checks: Record<string, boolean | number | string> = {};
const migrationNames = ['0047_native_app_foundation.sql', '0054_account_registration_live_login.sql'];
const appTables = ['app_sessions', 'app_access_tokens', 'app_refresh_tokens', 'app_audit_events', 'app_analytics_events', 'app_rate_limits', 'app_account_registrations', 'app_live_login_challenges'];
try {
  sqlite.exec(source);
  const originalObjects = sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; sql: string }[];
  for (const table of originalObjects.filter(row => row.type === 'table')) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${quote(table.name)}`).get()?.n, 0, 'Schema export must not contain any records.');
  }
  assert.ok(originalObjects.some(row => row.name === 'learner_accounts'));
  assert.ok(originalObjects.some(row => row.name === 'webinar_erp_roles'));
  assert.ok(appTables.every(name => !originalObjects.some(row => row.name === name)), 'This rehearsal expects the reviewed pre-app schema.');
  checks.inputContainsNoRecords = true;
  const migrations = migrationNames.map(name => ({ name, sql: readFileSync(new URL('../migrations/d1/' + name, import.meta.url), 'utf8') }));
  // Rehearse migration-ledger semantics: each DDL and its receipt share one local transaction.
  let applied = 0;
  function apply() {
    for (const migration of migrations) {
      if (sqlite.prepare('SELECT 1 FROM d1_migrations WHERE name=?').get(migration.name)) continue;
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        sqlite.exec(migration.sql);
        sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(migration.name);
        sqlite.exec('COMMIT');
        applied++;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  }
  apply();
  assert.equal(applied, 2);
  apply();
  assert.equal(applied, 2);
  checks.migrationLedgerReapplySkipsBoth = true;
  for (const original of originalObjects) {
    assert.equal(sqlite.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(original.type, original.name)?.sql, original.sql);
  }
  checks.existingSchemaObjectsUnchanged = true;
  const actualAddedTables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'app_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  assert.deepEqual(actualAddedTables, [...appTables].sort());
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  checks.onlyEightAccountLiveTablesAdded = true;
  checks.crmSupportLearningTablesAdded = false;

  class Statement implements D1Statement {
    constructor(readonly sql: string, readonly values: unknown[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values); }
    execute() { const result = sqlite.prepare(this.sql).run(...this.values as (string | number | null)[]); return { meta: { changes: Number(result.changes) } }; }
    async first<T>() { return (sqlite.prepare(this.sql).get(...this.values as (string | number | null)[]) ?? null) as T | null; }
    async all<T>() { return { results: sqlite.prepare(this.sql).all(...this.values as (string | number | null)[]) as T[] }; }
    async run() { return this.execute(); }
  }
  const db: D1Database = { prepare: sql => new Statement(sql), async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = statements.map(statement => (statement as Statement).execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const env: LiveLoginEnv = {
    APP_ENV: 'production', APP_ENABLED: 'true', APP_SIGNUP_ENABLED: 'true', APP_ALLOWED_ORIGINS: 'https://app.techlyup.com',
    TECHLYUP_ERP_ORG_ID: 'appneural', REGISTRATIONS_DB: db, APP_LIVE_LOGIN_ENABLED: 'true', LIVE_LOGIN_CLIENT_ID: 'techlyup-live',
    LIVE_LOGIN_APP_ORIGIN: 'https://app.techlyup.com', LIVE_LOGIN_CALLBACK_URL: 'https://live.techlyup.com/api/auth/techlyup/callback',
  };
  async function call(path: string, body?: unknown, access?: string, cookie?: string) {
    const response = await appFetch(new Request('https://app.techlyup.com/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-techlyup-client': 'web', origin: 'https://app.techlyup.com', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(access ? { authorization: 'Bearer ' + access } : {}), ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { response, body: await response.json() as any };
  }
  const health = await call('/health');
  assert.equal(health.response.status, 200);
  checks.healthReady = health.body.data.status === 'ready';
  checks.staffLinksPresent = health.body.data.staffLinks;
  const input = { firstName: 'Offline', lastName: 'Rehearsal', email: 'offline-rehearsal@example.invalid', password: 'synthetic-local-only password 2026', phone: '9876543210', accountType: 'student', city: 'Jaipur', consent: true, consentVersion: '2026-10' };
  const signup = await call('/auth/signup', input);
  assert.equal(signup.response.status, 201);
  assert.deepEqual(signup.body.data.user.roles, ['learner']);
  assert.deepEqual(signup.body.data.user.permissions, []);
  assert.equal('refreshToken' in signup.body.data, false);
  const setCookie = signup.response.headers.get('set-cookie')!;
  for (const part of ['__Host-tlu_app_refresh=', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(setCookie.includes(part));
  checks.signupCanonicalLearnerOnly = true;
  checks.browserRefreshIsPrivateSecureCookie = true;
  const refresh = await call('/auth/refresh', {}, undefined, setCookie.split(';')[0]);
  assert.equal(refresh.response.status, 200);
  const me = await call('/me', undefined, refresh.body.data.accessToken);
  assert.equal(me.response.status, 200);
  assert.equal(me.body.data.id, signup.body.data.user.id);
  assert.equal((await call('/admin/overview', undefined, refresh.body.data.accessToken)).response.status, 403);
  checks.cookieRestoreKeepsCanonicalIdentity = true;
  checks.learnerCannotBecomeAdmin = true;
  const props = { clientId: 'techlyup-live', product: 'techlyup' as const, tenantId: 'appneural' };
  const verifier = 'rehearsal-v'.repeat(5), pkceChallenge = createHash('sha256').update(verifier).digest('base64url');
  const begun = await beginLiveLogin(env, props, { pkceChallenge });
  const approved = await call('/live/sign-in/authorize', { challengeId: begun.challengeId }, refresh.body.data.accessToken);
  assert.equal(approved.response.status, 200);
  const redirect = new URL(approved.body.data.redirectUrl);
  assert.equal(redirect.origin + redirect.pathname, env.LIVE_LOGIN_CALLBACK_URL);
  const redeem = { challengeId: begun.challengeId, code: redirect.searchParams.get('code')!, verifier };
  const identity = await consumeLiveLogin(env, props, redeem);
  assert.equal(identity.accountId, signup.body.data.user.id);
  assert.equal(identity.emailVerified, false);
  assert.equal(identity.accountType, 'student');
  await assert.rejects(consumeLiveLogin(env, props, redeem), /invalid or expired/);
  checks.livePkceCanonicalIdentityAndReplayProtection = true;
  const logout = await call('/auth/logout', {}, undefined, refresh.response.headers.get('set-cookie')!.split(';')[0]);
  assert.equal(logout.response.status, 200);
  assert.equal((await call('/me', undefined, refresh.body.data.accessToken)).response.status, 401);
  checks.logoutRevokesAppAccess = true;
  const login = await call('/auth/login', { email: input.email, password: input.password });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.data.user.id, signup.body.data.user.id);
  checks.freshLoginKeepsCanonicalIdentity = true;
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  checks.foreignKeysValidAfterJourneys = true;
  const report = {
    date: '2026-10-21', scope: 'Offline in-memory rehearsal using a current production schema-only export and synthetic local records. No production writes, deployments, DNS changes, messages or providers.',
    schemaSha256: hash(source), migrations: migrations.map(({ name, sql }) => ({ name, sha256: hash(sql) })),
    migrationLedger: 'Only selected app0047+0054 receipts; a second apply skipped both. Website0037-0046 and optional app0048-0053 were not applied.',
    addedTables: actualAddedTables, checks, result: 'pass',
  };
  writeFileSync(args[3], JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ result: 'pass', output: args[3], checks: Object.keys(checks).length, noRemoteMutation: true }) + '\n');
} catch {
  process.stderr.write('Offline account/LIVE release rehearsal failed. No remote operation was attempted.\n');
  process.exitCode = 1;
} finally { sqlite.close(); }
