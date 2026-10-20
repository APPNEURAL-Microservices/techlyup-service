/** Actual workerd HTTP + Miniflare D1 + PostgreSQL acceptance. All stores and
 * role identities are disposable; no existing dev server or remote store is used. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { courseLessons, type AuthSession, type ApiResponse } from '@techlyup/contracts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const workerPort = 8898;
const origin = `http://127.0.0.1:${workerPort}`;

async function freePort(port = 0) {
  const listener = createServer();
  return new Promise<number>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') { listener.close(); reject(new Error('Isolated runtime port unavailable.')); return; }
      listener.close(() => resolve(address.port));
    });
  });
}
async function temporaryPostgres() {
  if (spawnSync('initdb', ['--version']).status !== 0 || spawnSync('pg_ctl', ['--version']).status !== 0) return null;
  const directory = await mkdtemp('/tmp/techlyup-http-pg-');
  const data = join(directory, 'data'), port = await freePort(), password = randomUUID().replaceAll('-', ''); let started = false;
  const passwordFile = join(directory, 'owner-password'); await writeFile(passwordFile, password, { mode: 0o600 });
  const run = (program: string, args: string[]) => { if (spawnSync(program, args, { timeout: 30000, encoding: 'utf8' }).status !== 0) throw new Error('Isolated PostgreSQL runtime fixture could not start.'); };
  const cleanup = async () => { try { if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); } finally { await rm(directory, { recursive: true, force: true }); } };
  try {
    run('initdb', ['-D', data, '--no-locale', '-E', 'UTF8', '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile', passwordFile, '-U', 'http_ci_owner']);
    run('pg_ctl', ['-D', data, '-l', join(directory, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start']); started = true;
    // Only the private Unix socket uses trust. HTTP Worker TCP uses SCRAM with
    // its throwaway restricted role, matching the CI PostgreSQL service.
    run('createdb', ['-h', directory, '-p', String(port), '-U', 'http_ci_owner', 'techlyup_http_ci']);
    return { url: `postgresql://http_ci_owner:${password}@127.0.0.1:${port}/techlyup_http_ci`, directory, port, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
async function stopWorker(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else resolve(); } catch { clearTimeout(timer); resolve(); }
  });
}

const runtimeEnabled = process.env.APP_RUNTIME_ACCEPTANCE !== 'false';
test('real workerd HTTP learning journey persists through PostgreSQL and rejects foreign access or invalid lessons', { timeout: 120000, skip: !runtimeEnabled }, async suite => {
  const local = process.env.APP_TEST_DATABASE_URL ? null : await temporaryPostgres();
  const testUrl = process.env.APP_TEST_DATABASE_URL ?? local?.url;
  if (!testUrl) { suite.skip('Provide isolated APP_TEST_DATABASE_URL or local PostgreSQL binaries for actual HTTP acceptance.'); return; }
  const target = new URL(testUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && /^[a-z0-9_]+_ci$/.test(target.pathname.slice(1)) && !target.search && !target.hash, 'Only isolated loopback *_ci databases are accepted.');
  const directory = await mkdtemp('/tmp/techlyup-http-worker-');
  const databaseName = `techlyup_http_${randomUUID().replaceAll('-', '')}_ci`, runtimeRole = `http_runtime_${randomUUID().replaceAll('-', '')}`, runtimePassword = randomUUID().replaceAll('-', '');
  const owner = new pg.Client(local ? { host: local.directory, port: local.port, user: 'http_ci_owner', database: 'techlyup_http_ci' } : { connectionString: target.toString() });
  let connected = false, databaseCreated = false, roleCreated = false, migration: pg.Client | undefined, worker: ChildProcess | undefined;
  try {
    await freePort(workerPort);
    await owner.connect(); connected = true;
    await owner.query(`CREATE DATABASE ${databaseName}`); databaseCreated = true;
    const isolated = new URL(target); isolated.hostname = '127.0.0.1'; isolated.pathname = `/${databaseName}`;
    migration = new pg.Client(local ? { host: local.directory, port: local.port, user: 'http_ci_owner', database: databaseName } : { connectionString: isolated.toString() });
    await migration.connect();
    const migrated = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve('@appneurox/learning-postgres/migrate')), '--apply'], { cwd: root, env: { ...process.env, LEARNING_POSTGRES_MIGRATION_URL: isolated.toString() }, encoding: 'utf8', timeout: 30000 });
    assert.equal(migrated.status, 0, 'Disposable PostgreSQL schema migration failed. Private diagnostics are not printed.');
    await owner.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`); roleCreated = true;
    const grants = (await readFile(fileURLToPath(import.meta.resolve('@appneurox/learning-postgres/runtime-grants.sql')), 'utf8')).replaceAll('learning_core_runtime', runtimeRole);
    await migration.query(grants);
    const runtimeUrl = new URL(isolated); runtimeUrl.username = runtimeRole; runtimeUrl.password = runtimePassword;
    // DSNs are written only to a private temporary dotenv file, never CLI args,
    // output, project configuration, persisted test receipts or request bodies.
    await writeFile(join(directory, '.dev.vars'), `APP_LOCAL_DATABASE_URL=${JSON.stringify(runtimeUrl.toString())}\n`, { mode: 0o600 });
    const configuration = {
      name: `techlyup-http-test-${randomUUID().slice(0, 8)}`,
      main: join(root, 'apps/api/src/index.ts'), compatibility_date: '2026-10-13', compatibility_flags: ['nodejs_compat'], workers_dev: false,
      vars: { APP_ENV: 'test', APP_ENABLED: 'true', APP_SIGNUP_ENABLED: 'true', APP_ANALYTICS_ENABLED: 'false', APP_LEARNING_ENABLED: 'true', APP_LOCAL_POSTGRES: 'true', TECHLYUP_ERP_ORG_ID: 'appneural', APP_ALLOWED_ORIGINS: origin },
      d1_databases: [{ binding: 'REGISTRATIONS_DB', database_name: 'techlyup-http-local-only', database_id: '00000000-0000-0000-0000-000000000047', migrations_dir: join(root, 'migrations/d1') }],
    };
    const config = join(directory, 'wrangler.json'); await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
    const persist = join(directory, 'state'), environment = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
    const command = (args: string[]) => {
      const result = spawnSync(process.execPath, [wrangler, ...args, '--config', config, '--persist-to', persist], { cwd: root, env: environment, encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 0, 'Disposable local D1 bootstrap failed. Private raw diagnostics are not printed.');
    };
    command(['d1', 'execute', 'REGISTRATIONS_DB', '--local', '--file', join(root, 'apps/api/tests/fixtures/canonical.sql')]);
    command(['d1', 'execute', 'REGISTRATIONS_DB', '--local', '--file', join(root, 'apps/api/tests/fixtures/canonical-crm.sql')]);
    command(['d1', 'migrations', 'apply', 'REGISTRATIONS_DB', '--local']);
    worker = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', config, '--persist-to', persist, '--ip', '127.0.0.1', '--port', String(workerPort), '--inspector-port', '0', '--log-level', 'error', '--show-interactive-dev-session=false'], { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Consume output without logging: local configuration can contain secrets.
    worker.stdout?.on('data', () => {}); worker.stderr?.on('data', () => {});
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (worker.exitCode !== null || worker.signalCode !== null) throw new Error('Disposable local Worker exited before readiness.');
      try { const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(500) }); if (response.status === 200 && (await response.json() as { data?: { status: string } }).data?.status === 'ready') { ready = true; break; } } catch { /* Wait for this owned Worker, never an existing server. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'Disposable local Worker did not become ready.');
    async function call<T>(path: string, options: { method?: string; body?: unknown; access?: string; key?: string } = {}) {
      const response = await fetch(`${origin}/api/v1${path}`, { method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'), headers: { 'X-TechlyUp-Client': 'ios', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.access ? { Authorization: `Bearer ${options.access}` } : {}), ...(options.key ? { 'Idempotency-Key': options.key } : {}) }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}), signal: AbortSignal.timeout(10000) });
      const body = await response.json() as ApiResponse<T>; return { status: response.status, body, data: 'data' in body ? body.data : null, error: 'error' in body ? body.error.code : null };
    }
    const signup = (email: string) => call<AuthSession>('/auth/signup', { body: { firstName: 'Synthetic', lastName: 'HTTP Learner', email, password: 'private synthetic HTTP password 123', phone: '9876543210', accountType: 'student', city: 'Jaipur', consent: true, consentVersion: '2026-10' } });
    const first = await signup('http-owner@example.invalid'); assert.equal(first.status, 201); assert.ok(first.data?.accessToken);
    const access = first.data!.accessToken, key = randomUUID(), item = { kind: 'course', id: 'course-ai-useful-answers' };
    const enrolled = await call<{ id: string }>('/learning/enrollments', { body: item, access, key }); assert.equal(enrolled.status, 201); assert.ok(enrolled.data?.id);
    const enrollmentId = enrolled.data!.id, progressPath = `/learning/enrollments/${enrollmentId}/progress`;
    const replay = await call<{ id: string }>('/learning/enrollments', { body: item, access, key }); assert.equal(replay.status, 201); assert.equal(replay.data?.id, enrollmentId);
    const progressKey = randomUUID(), lesson = { lessonRef: courseLessons[0].id, status: 'completed', expectedVersion: 0 };
    const saved = await call<{ version: number }>(progressPath, { method: 'PUT', body: lesson, access, key: progressKey }); assert.equal(saved.status, 200); assert.equal(saved.data?.version, 1);
    const repeated = await call<{ version: number }>(progressPath, { method: 'PUT', body: lesson, access, key: progressKey }); assert.equal(repeated.status, 200); assert.equal(repeated.data?.version, 1);
    const conflict = await call(progressPath, { method: 'PUT', body: { ...lesson, status: 'started' }, access, key: progressKey }); assert.equal(conflict.status, 409); assert.equal(conflict.error, 'idempotency_conflict');
    const reloaded = await call<{ progress: { lessonRef: string; version: number }[]; tracking: string }>(progressPath, { access }); assert.equal(reloaded.status, 200); assert.equal(reloaded.data?.tracking, 'self-reported'); assert.equal(reloaded.data?.progress[0]?.lessonRef, courseLessons[0].id); assert.equal(reloaded.data?.progress[0]?.version, 1);
    const other = await signup('http-other@example.invalid'); assert.equal(other.status, 201);
    const deniedRead = await call(progressPath, { access: other.data!.accessToken }); assert.equal(deniedRead.status, 404); assert.equal(deniedRead.error, 'enrollment_not_found');
    const deniedWrite = await call(progressPath, { method: 'PUT', body: lesson, access: other.data!.accessToken, key: randomUUID() }); assert.equal(deniedWrite.status, 404);
    const badLesson = await call(progressPath, { method: 'PUT', body: { ...lesson, lessonRef: 'unknown-or-paid-lesson' }, access, key: randomUUID() }); assert.equal(badLesson.status, 422);
    const badCourse = await call('/learning/enrollments', { body: { kind: 'course', id: 'paid-or-unknown-course' }, access, key: randomUUID() }); assert.equal(badCourse.status, 422);
    const unauthenticated = await call('/learning/enrollments'); assert.equal(unauthenticated.status, 401);
    const rows = await migration.query('SELECT e.account_id,p.lesson_ref,p.version FROM learning_core.learning_enrollments e JOIN learning_core.learning_progress p ON p.enrollment_id=e.id');
    assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].account_id, first.data!.user.id); assert.equal(rows.rows[0].version, 1);
    const audit = await migration.query('SELECT action FROM learning_core.audit_events ORDER BY created_at,id');
    assert.deepEqual(audit.rows.map(row => row.action).sort(), ['learning.enrolled', 'learning.progress_saved']);
  } finally {
    try {
      if (worker) await stopWorker(worker);
      if (migration) await migration.end();
      if (databaseCreated) await owner.query(`DROP DATABASE ${databaseName}`);
      if (roleCreated) await owner.query(`DROP ROLE ${runtimeRole}`);
    } finally { if (connected) await owner.end().catch(() => undefined); await rm(directory, { recursive: true, force: true }); if (local) await local.cleanup(); }
  }
});
