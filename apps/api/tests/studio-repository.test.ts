import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { ApiError } from '../src/types';
import { workspaceDefinitions } from '../src/studio/definitions';
import { handleStudioRequest, canWriteOwnDrafts, studioConnection } from '../src/studio/http';
import { createStudioDatabase, StudioRepository } from '../src/studio/repository';
import { validateValues } from '../src/studio/validation';
import type { StudioActor, StudioEnv, StudioUser, WorkspaceRecord, WorkspaceResource, WorkspaceValue } from '../src/studio/contracts';

const root = new URL('../../../', import.meta.url);
const teacher: StudioUser = { id: 'canonical_teacher_owner', name: 'Synthetic Teacher', roles: ['learner'], permissions: [], registration: { accountType: 'teacher' } };
const actor: StudioActor = { orgId: 'techlyup_test_org', issuer: 'techlyup-learner', accountId: teacher.id };
const foreign: StudioActor = { ...actor, accountId: 'canonical_other_teacher' };
const errorCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

function example(resource: WorkspaceResource): Record<string, WorkspaceValue> {
  return Object.fromEntries(resource.fields.filter(field => field.required).map(field => {
    let value: WorkspaceValue;
    if (field.type === 'checkbox') value = true;
    else if (field.type === 'number') value = Math.max(field.min ?? 0, 1);
    else if (field.type === 'select') value = field.options![0].value;
    else if (field.type === 'date') value = '2026-11-01';
    else if (field.type === 'url') value = 'https://techlyup.com/courses';
    else if (field.name === 'timezone') value = 'Asia/Kolkata';
    else if (field.name === 'startsAt' || field.name === 'preferredTime') value = '10:00';
    else if (field.name === 'endsAt') value = '11:00';
    else if (field.name.endsWith('Reference')) value = 'assigned:opaque-reference-123';
    else value = `Synthetic ${field.label}`;
    return [field.name, value];
  }));
}

test('workspace definitions preserve eight apps and every requested subpage with honest canonical gates', () => {
  assert.equal(Object.keys(workspaceDefinitions).length, 8);
  assert.deepEqual(workspaceDefinitions.courses.pages.map(page => page.id), ['list','curriculum','batches','submissions']);
  assert.deepEqual(workspaceDefinitions.mentorship.pages.map(page => page.id), ['bookings','services','availability','questions']);
  assert.deepEqual(workspaceDefinitions.certificates.pages.map(page => page.id), ['issued','templates','eligibility']);
  assert.deepEqual(workspaceDefinitions.learners.pages.map(page => page.id), ['directory','groups','details','communication']);
  assert.deepEqual(workspaceDefinitions.earnings.pages.map(page => page.id), ['overview','pricing','orders','refunds','payouts','statements']);
  assert.deepEqual(workspaceDefinitions.promotion.pages.map(page => page.id), ['overview','public-profile','links','referrals','campaigns']);
  assert.deepEqual(workspaceDefinitions.insights.pages.map(page => page.id), ['performance','live','learning','mentorship','revenue']);
  assert.deepEqual(workspaceDefinitions.assistant.pages.map(page => page.id), ['workspace','drafts','summaries','history']);
  for (const definition of Object.values(workspaceDefinitions)) for (const resource of definition.resources) {
    if (resource.available) assert.ok(validateValues(resource, example(resource)).title);
    else assert.ok(resource.unavailableReason);
  }
  assert.equal(canWriteOwnDrafts(teacher), true);
  assert.equal(canWriteOwnDrafts({ id: 'learner', name: 'Learner', roles: ['learner'] }), false);
  assert.equal(canWriteOwnDrafts({ id: 'mentor', name: 'Mentor', roles: ['mentor'] }), true);
  assert.throws(() => studioConnection({ APP_ENV: 'production', STUDIO_DATABASE_URL: 'postgresql://127.0.0.1/studio_ci' }), errorCode('storage_unavailable'));
  assert.throws(() => studioConnection({ APP_ENV: 'test', STUDIO_DATABASE_URL: 'postgresql://remote.invalid/studio_ci' }), errorCode('storage_unavailable'));
  const course = workspaceDefinitions.courses.resources[0], valid = example(course);
  assert.throws(() => validateValues(course, { ...valid, ownerId: 'other-account' }), errorCode('validation_failed'));
  assert.throws(() => validateValues(course, { ...valid, status: 'published' }), errorCode('validation_failed'));
  const availability = workspaceDefinitions.mentorship.resources.find(resource => resource.id === 'availability')!;
  assert.throws(() => validateValues(availability, { ...example(availability), onDate: '2026-99-99' }), errorCode('validation_failed'));
  assert.throws(() => validateValues(availability, { ...example(availability), startsAt: '13:00', endsAt: '12:00' }), errorCode('validation_failed'));
  const directory = workspaceDefinitions.learners.resources[0];
  assert.throws(() => validateValues(directory, { ...example(directory), permissionConfirmed: false }), errorCode('validation_failed'));
  assert.throws(() => validateValues(directory, { ...example(directory), learnerReference: 'person@example.invalid' }), errorCode('validation_failed'));
  const links = workspaceDefinitions.promotion.resources.find(resource => resource.id === 'links')!;
  for (const url of ['https://techlyup.com/private?access_token=private', 'https://techlyup.com/#access_token=private', 'https://techlyup.com/?accessToken=private', 'https://techlyup.com/?api-key=private', 'https://techlyup.com/?passcode=private', 'https://techlyup.com/?X-Amz-Signature=private', 'https://techlyup.com/?code=private', 'https://techlyup.com/?sig=private']) assert.throws(() => validateValues(links, { ...example(links), url }), errorCode('validation_failed'));
  assert.equal(validateValues(links, { ...example(links), url: 'https://techlyup.com/courses?utm_source=teacher' }).url, 'https://techlyup.com/courses?utm_source=teacher');
});

test('disabled and unconfigured workspaces expose honest capabilities without creating any store', async () => {
  const response = await handleStudioRequest({ TECHLYUP_ERP_ORG_ID: actor.orgId }, 'courses', teacher, { method: 'GET', path: '/' });
  const body = response.body as { capabilities: { storage: string; ownDrafts: boolean; aiGeneration: boolean } };
  assert.equal(body.capabilities.storage, 'disabled'); assert.equal(body.capabilities.ownDrafts, false); assert.equal(body.capabilities.aiGeneration, false);
  await assert.rejects(handleStudioRequest({ TECHLYUP_ERP_ORG_ID: actor.orgId }, 'courses', teacher, { method: 'POST', path: '/records', body: {} }), errorCode('feature_disabled'));
  const unavailable = await handleStudioRequest({ TECHLYUP_ERP_ORG_ID: actor.orgId, APP_PRODUCTS_ENABLED: 'true' }, 'courses', teacher, { method: 'GET', path: '/' });
  assert.equal((unavailable.body as { capabilities: { storage: string } }).capabilities.storage, 'unavailable');
});

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { server.close(); reject(new Error('Fixture port unavailable.')); return; } server.close(() => resolve(address.port)); });
  });
}

test('actual disposable PostgreSQL persists every editable resource with RLS, atomic audit, idempotency and version protection', { timeout: 120000 }, async suite => {
  if (spawnSync('initdb', ['--version']).status !== 0 || spawnSync('pg_ctl', ['--version']).status !== 0) { suite.skip('Local PostgreSQL binaries are required for isolated real storage acceptance.'); return; }
  const directory = await mkdtemp('/tmp/techlyup-studio-pg-'), data = join(directory, 'data'), port = await freePort();
  const ownerName = 'studio_ci_owner', runtimeName = 'studio_ci_runtime', databaseName = 'techlyup_studio_ci';
  const password = randomUUID().replaceAll('-', ''), runtimePassword = randomUUID().replaceAll('-', '');
  const passwordFile = join(directory, 'owner-password');
  await writeFile(passwordFile, password, { mode: 0o600 });
  const run = (program: string, args: string[]) => { if (spawnSync(program, args, { timeout: 30000, encoding: 'utf8' }).status !== 0) throw new Error('Isolated Studio PostgreSQL fixture failed. Private diagnostics are not printed.'); };
  let started = false, owner: pg.Client | undefined, pool: pg.Pool | undefined;
  try {
    run('initdb', ['-D', data, '--no-locale', '-E', 'UTF8', '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile', passwordFile, '-U', ownerName]);
    run('pg_ctl', ['-D', data, '-l', join(directory, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start']); started = true;
    run('createdb', ['-h', directory, '-p', String(port), '-U', ownerName, databaseName]);
    owner = new pg.Client({ host: directory, port, user: ownerName, database: databaseName }); await owner.connect();
    await owner.query(await readFile(new URL('migrations/studio/0001_owned_workspace.sql', root), 'utf8'));
    await owner.query(`CREATE ROLE ${runtimeName} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.query((await readFile(new URL('migrations/studio/runtime-grants.sql', root), 'utf8')).replaceAll('studio_workspace_runtime', runtimeName));
    const runtimeUrl = new URL(`postgresql://127.0.0.1:${port}/${databaseName}`); runtimeUrl.username = runtimeName; runtimeUrl.password = runtimePassword;
    pool = createStudioDatabase(runtimeUrl.toString());
    const repository = new StudioRepository(pool);
    await repository.ready(actor);
    const created: WorkspaceRecord[] = [];
    for (const definition of Object.values(workspaceDefinitions)) for (const resource of definition.resources.filter(resource => resource.available)) {
      const values = validateValues(resource, example(resource)), key = randomUUID();
      const result = await repository.create(actor, definition.id, resource.id, values, key); created.push(result.record);
      const replay = await repository.create(actor, definition.id, resource.id, values, key);
      assert.equal(replay.record.id, result.record.id); assert.equal(replay.replay, true);
      assert.equal((await repository.list(actor, definition.id, resource.id))[0].values.title, values.title);
      assert.equal((await repository.list(foreign, definition.id, resource.id)).length, 0);
    }
    assert.equal(created.length, 22);
    const auditBefore = await owner.query('SELECT count(*)::int count FROM studio_workspace.audit_events'); assert.equal(auditBefore.rows[0].count, 22);
    await pool.end(); pool = createStudioDatabase(runtimeUrl.toString());
    const reloaded = new StudioRepository(pool), original = created[0];
    assert.equal((await reloaded.record(actor, original.appId, original.id))?.values.title, original.values.title, 'A fresh pool reads persisted data.');
    assert.equal(await reloaded.record(foreign, original.appId, original.id), undefined);
    assert.equal(await reloaded.record({ ...actor, orgId: 'another_org' }, original.appId, original.id), undefined);
    await assert.rejects(reloaded.update(foreign, original.appId, original.id, 1, original.values, randomUUID()), errorCode('not_found'));
    const updates = await Promise.allSettled([
      reloaded.update(actor, original.appId, original.id, 1, { ...original.values, title: 'Changed title A' }, randomUUID()),
      reloaded.update(actor, original.appId, original.id, 1, { ...original.values, title: 'Changed title B' }, randomUUID()),
    ]);
    assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(updates.filter(result => result.status === 'rejected' && errorCode('version_conflict')(result.reason)).length, 1);
    const updated = (await reloaded.record(actor, original.appId, original.id))!; assert.equal(updated.version, 2);
    const duplicateKey = randomUUID(), duplicateValues = { ...original.values, title: 'Concurrent duplicate' };
    const duplicates = await Promise.all([reloaded.create(actor, 'courses', 'courses', duplicateValues, duplicateKey), reloaded.create(actor, 'courses', 'courses', duplicateValues, duplicateKey)]);
    assert.equal(duplicates[0].record.id, duplicates[1].record.id);
    await assert.rejects(reloaded.create(actor, 'courses', 'courses', { ...duplicateValues, title: 'Changed same key' }, duplicateKey), errorCode('idempotency_conflict'));
    const archived = await reloaded.archive(actor, original.appId, original.id, 2, randomUUID()); assert.equal(archived.record.status, 'archived');
    assert.equal((await reloaded.list(actor, original.appId, original.resource)).some(record => record.id === original.id), false);
    await assert.rejects(reloaded.update(actor, original.appId, original.id, 3, original.values, randomUUID()), errorCode('record_archived'));

    // A failed audit insert must roll back both the business row and the change key.
    await owner.query(`CREATE FUNCTION studio_workspace.reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource='curriculum' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_audit BEFORE INSERT ON studio_workspace.audit_events FOR EACH ROW EXECUTE FUNCTION studio_workspace.reject_test_audit()`);
    const failedKey = randomUUID();
    await assert.rejects(reloaded.create(actor, 'courses', 'curriculum', { title: 'Atomic rollback marker' }, failedKey));
    assert.equal((await owner.query("SELECT count(*)::int count FROM studio_workspace.records WHERE values->>'title'='Atomic rollback marker'")).rows[0].count, 0);
    assert.equal((await owner.query('SELECT count(*)::int count FROM studio_workspace.idempotency_operations WHERE idempotency_key=$1', [failedKey])).rows[0].count, 0);
    await owner.query('DROP TRIGGER reject_test_audit ON studio_workspace.audit_events; DROP FUNCTION studio_workspace.reject_test_audit()');

    const direct = await pool.connect();
    try {
      assert.equal((await direct.query('SELECT count(*)::int count FROM studio_workspace.records')).rows[0].count, 0, 'Unscoped runtime SQL sees no owner records.');
      await direct.query('BEGIN');
      await direct.query("SELECT set_config('app.studio_org',$1,true),set_config('app.studio_issuer',$2,true),set_config('app.studio_account',$3,true)", [foreign.orgId, foreign.issuer, foreign.accountId]);
      assert.equal((await direct.query('SELECT id FROM studio_workspace.records WHERE id=$1', [created[1].id])).rowCount, 0, 'Forced RLS rejects foreign SQL even without application predicates.');
      assert.equal((await direct.query('UPDATE studio_workspace.records SET values=$2::jsonb WHERE id=$1 RETURNING id', [created[1].id, JSON.stringify({ title: 'Foreign modification' })])).rowCount, 0);
      await direct.query('ROLLBACK');
    } finally { direct.release(); }
    assert.equal((await reloaded.record(actor, created[1].appId, created[1].id))?.values.title, created[1].values.title);
    const insights = await reloaded.overview(actor, workspaceDefinitions.insights);
    assert.equal(insights.source, 'own_workspace_records'); assert.ok(insights.counts.some(row => row.resource === 'courses/courses')); assert.ok(insights.recentActivity.length > 0);
    assert.equal((await reloaded.overview(foreign, workspaceDefinitions.insights)).counts.length, 0);

    const env: StudioEnv = { APP_ENV: 'test', APP_PRODUCTS_ENABLED: 'true', TECHLYUP_ERP_ORG_ID: actor.orgId, STUDIO_DATABASE_URL: runtimeUrl.toString() };
    const metadata = await handleStudioRequest(env, 'assistant', teacher, { method: 'GET', path: '/' });
    const capability = (metadata.body as { capabilities: { storage: string; ownDrafts: boolean; aiGeneration: boolean } }).capabilities;
    assert.equal(capability.storage, 'ready'); assert.equal(capability.ownDrafts, true); assert.equal(capability.aiGeneration, false);
    await assert.rejects(handleStudioRequest(env, 'earnings', teacher, { method: 'GET', path: '/records?resource=payouts' }), errorCode('integration_required'));
    await assert.rejects(handleStudioRequest(env, 'certificates', teacher, { method: 'POST', path: '/records', body: { resource: 'issued', values: {} }, idempotencyKey: randomUUID() }), errorCode('integration_required'));
    await assert.rejects(handleStudioRequest(env, 'courses', { id: 'learner', name: 'Learner', roles: ['learner'] }, { method: 'POST', path: '/records', body: { resource: 'courses', values: original.values }, idempotencyKey: randomUUID() }), errorCode('forbidden'));

    // Actual workerd TCP/PostgreSQL acceptance, in addition to the Node-side
    // repository checks above. The workerd package condition is necessary for
    // pg-cloudflare's real socket export; the Node default is an empty shim.
    const bundle = await build({ stdin: { contents: `import {handleStudioRequest} from './apps/api/src/studio/http.ts'; const user=${JSON.stringify(teacher)}; export default {async fetch(request,env){const url=new URL(request.url);try{const result=await handleStudioRequest(env,'courses',user,{method:request.method,path:url.pathname+url.search,body:request.method==='GET'?undefined:await request.json(),idempotencyKey:request.headers.get('Idempotency-Key')||undefined});return Response.json(result.body,{status:result.status});}catch(error){return Response.json({error:{code:error.code||'unavailable'}},{status:error.status||503});}}};`, resolveDir: fileURLToPath(root), sourcefile: 'studio-postgres-workerd-fixture.ts' }, bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', conditions: ['workerd'], mainFields: ['module','main'], external: ['cloudflare:*','node:*','pg-native'], banner: { js: "import {createRequire as __studioTestRequire} from 'node:module'; const require=__studioTestRequire('/worker.js');" } });
    const worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-13', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE), bindings: { APP_ENV: 'test', APP_PRODUCTS_ENABLED: 'true', TECHLYUP_ERP_ORG_ID: actor.orgId, STUDIO_DATABASE_URL: runtimeUrl.toString() } }));
    try {
      const call = async (path: string, method = 'GET', body?: unknown, key?: string) => {
        const response = await worker.dispatchFetch('https://workspace.example.test' + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json() as any };
      };
      assert.equal((await call('/')).body.capabilities.storage, 'ready');
      const value = { ...original.values, title: 'Synthetic Workerd persistent course' }, key = randomUUID();
      const saved = await call('/records', 'POST', { resource: 'courses', values: value }, key); assert.equal(saved.status, 201);
      const repeated = await call('/records', 'POST', { resource: 'courses', values: value }, key); assert.equal(repeated.body.record.id, saved.body.record.id);
      const fetched = await call('/records?resource=courses&q=Synthetic%20Workerd'); assert.equal(fetched.status, 200); assert.equal(fetched.body.records[0].id, saved.body.record.id);
      const edited = await call('/records/' + saved.body.record.id, 'PATCH', { version: 1, values: { ...value, title: 'Synthetic Workerd edited course' } }, randomUUID()); assert.equal(edited.status, 200); assert.equal(edited.body.record.version, 2);
      const closed = await call('/records/' + saved.body.record.id + '/archive', 'POST', { version: 2 }, randomUUID()); assert.equal(closed.status, 200); assert.equal(closed.body.record.status, 'archived');
      assert.equal((await call('/records?resource=courses&q=Synthetic%20Workerd')).body.records.length, 0);
    } finally { await worker.dispose(); }
    const ownerPool = createStudioDatabase(`postgresql://${ownerName}:${password}@127.0.0.1:${port}/${databaseName}`);
    try { await assert.rejects(new StudioRepository(ownerPool).ready(actor), errorCode('unsafe_storage_role')); } finally { await ownerPool.end(); }
  } finally {
    if (pool) await pool.end().catch(() => undefined);
    if (owner) await owner.end().catch(() => undefined);
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    await rm(directory, { recursive: true, force: true });
  }
});
