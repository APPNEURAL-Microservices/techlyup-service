import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { ApiError } from '../src/types';
import { workspaceDefinitions } from '../src/studio/definitions';
import { handleStudioRequest, canWriteOwnDrafts, studioStorage } from '../src/studio/http';
import { StudioRepository } from '../src/studio/repository';
import { validateValues } from '../src/studio/validation';
import { sqliteD1 } from './fixture';
import type { StudioActor, StudioEnv, StudioUser, WorkspaceRecord, WorkspaceResource, WorkspaceValue } from '../src/studio/contracts';

const root = new URL('../../../', import.meta.url);
const migration = readFileSync(new URL('migrations/studio/0001_studio_workspace.sql', root), 'utf8');
const teacher: StudioUser = { id: 'canonical_teacher_owner', name: 'Synthetic Teacher', roles: ['learner'], permissions: [], registration: { accountType: 'teacher' } };
const actor: StudioActor = { orgId: 'techlyup_test_org', issuer: 'techlyup-learner', accountId: teacher.id };
const foreign: StudioActor = { ...actor, accountId: 'canonical_other_teacher' };
const errorCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
function studioStore() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migration);
  return { sqlite, db: sqliteD1(sqlite) };
}

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
  assert.throws(() => studioStorage({ APP_ENV: 'test' }), errorCode('storage_unavailable'));
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

test('every Studio statement carries the server-resolved owner key', () => {
  // D1 has no row-level security, so isolation depends on each statement binding the owner.
  const source = readFileSync(new URL('apps/api/src/studio/repository.ts', root), 'utf8');
  const literals = [...source.matchAll(/`([^`]*)`/g), ...source.matchAll(/'((?:SELECT|INSERT|UPDATE|DELETE)\b[^']*)'/g)].map(match => match[1]);
  const statements = literals.filter(sql => /^(?:SELECT|INSERT|UPDATE|DELETE)\b/.test(sql) && /\bstudio_[a-z_]+/.test(sql));
  assert.equal(statements.length, 11);
  for (const sql of statements) assert.ok(sql.includes('${ownerWhere}') || /\?1,\?2,\?3/.test(sql), `Unscoped Studio statement: ${sql.slice(0, 80)}`);
});

test('D1 persists every editable resource with atomic audit, idempotency, version protection and owner isolation', async () => {
  const { sqlite, db } = studioStore();
  try {
    const repository = new StudioRepository(db);
    await repository.ready();
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
    assert.equal((sqlite.prepare('SELECT count(*) AS count FROM studio_audit_events').get() as { count: number }).count, 22);
    const reloaded = new StudioRepository(db), original = created[0];
    assert.equal((await reloaded.record(actor, original.appId, original.id))?.values.title, original.values.title, 'A fresh repository reads persisted data.');
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
    const winner = (updates.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ record: WorkspaceRecord }>).value.record;
    assert.equal(updated.values.title, winner.values.title, 'The stored draft is the reported winner.');
    assert.equal((sqlite.prepare("SELECT count(*) AS count FROM studio_audit_events WHERE action='draft.updated'").get() as { count: number }).count, 1, 'The losing update leaves no audit event.');
    const duplicateKey = randomUUID(), duplicateValues = { ...original.values, title: 'Concurrent duplicate' };
    const duplicates = await Promise.all([reloaded.create(actor, 'courses', 'courses', duplicateValues, duplicateKey), reloaded.create(actor, 'courses', 'courses', duplicateValues, duplicateKey)]);
    assert.equal(duplicates[0].record.id, duplicates[1].record.id);
    assert.equal((sqlite.prepare("SELECT count(*) AS count FROM studio_records WHERE json_extract(field_values,'$.title')='Concurrent duplicate'").get() as { count: number }).count, 1);
    await assert.rejects(reloaded.create(actor, 'courses', 'courses', { ...duplicateValues, title: 'Changed same key' }, duplicateKey), errorCode('idempotency_conflict'));
    const archived = await reloaded.archive(actor, original.appId, original.id, 2, randomUUID()); assert.equal(archived.record.status, 'archived');
    assert.equal((await reloaded.list(actor, original.appId, original.resource)).some(record => record.id === original.id), false);
    await assert.rejects(reloaded.update(actor, original.appId, original.id, 3, original.values, randomUUID()), errorCode('record_archived'));
    assert.equal((await reloaded.list(actor, 'courses', 'courses', 'CONCURRENT dup')).length, 1, 'Search matches the title case-insensitively.');

    // A failed audit insert must roll back both the business row and the change key.
    sqlite.exec("CREATE TRIGGER reject_test_audit BEFORE INSERT ON studio_audit_events WHEN NEW.resource='curriculum' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
    const failedKey = randomUUID();
    await assert.rejects(reloaded.create(actor, 'courses', 'curriculum', { title: 'Atomic rollback marker' }, failedKey));
    assert.equal((sqlite.prepare("SELECT count(*) AS count FROM studio_records WHERE json_extract(field_values,'$.title')='Atomic rollback marker'").get() as { count: number }).count, 0);
    assert.equal((sqlite.prepare('SELECT count(*) AS count FROM studio_idempotency_operations WHERE idempotency_key=?').get(failedKey) as { count: number }).count, 0);
    sqlite.exec('DROP TRIGGER reject_test_audit');

    // The schema itself refuses to move a draft or rewrite history.
    assert.throws(() => sqlite.prepare('UPDATE studio_records SET account_id=? WHERE id=?').run(foreign.accountId, created[1].id), /ownership is fixed/);
    assert.throws(() => sqlite.prepare("UPDATE studio_audit_events SET action='draft.created'").run(), /append-only/);
    assert.throws(() => sqlite.prepare("UPDATE studio_idempotency_operations SET response='{}'").run(), /fixed/);
    assert.equal((await reloaded.record(actor, created[1].appId, created[1].id))?.values.title, created[1].values.title);
    const insights = await reloaded.overview(actor, workspaceDefinitions.insights);
    assert.equal(insights.source, 'own_workspace_records'); assert.ok(insights.counts.some(row => row.resource === 'courses/courses')); assert.ok(insights.recentActivity.length > 0);
    assert.equal((await reloaded.overview(foreign, workspaceDefinitions.insights)).counts.length, 0);
    const courses = await reloaded.overview(actor, workspaceDefinitions.courses);
    assert.ok(courses.recentActivity.every(item => item.appId === 'courses'));

    const env: StudioEnv = { APP_ENV: 'test', APP_PRODUCTS_ENABLED: 'true', TECHLYUP_ERP_ORG_ID: actor.orgId, STUDIO_DB: db };
    const metadata = await handleStudioRequest(env, 'assistant', teacher, { method: 'GET', path: '/' });
    const capability = (metadata.body as { capabilities: { storage: string; ownDrafts: boolean; aiGeneration: boolean } }).capabilities;
    assert.equal(capability.storage, 'ready'); assert.equal(capability.ownDrafts, true); assert.equal(capability.aiGeneration, false);
    await assert.rejects(handleStudioRequest(env, 'earnings', teacher, { method: 'GET', path: '/records?resource=payouts' }), errorCode('integration_required'));
    await assert.rejects(handleStudioRequest(env, 'certificates', teacher, { method: 'POST', path: '/records', body: { resource: 'issued', values: {} }, idempotencyKey: randomUUID() }), errorCode('integration_required'));
    await assert.rejects(handleStudioRequest(env, 'courses', { id: 'learner', name: 'Learner', roles: ['learner'] }, { method: 'POST', path: '/records', body: { resource: 'courses', values: original.values }, idempotencyKey: randomUUID() }), errorCode('forbidden'));
    const empty = new DatabaseSync(':memory:');
    try { assert.equal(((await handleStudioRequest({ ...env, STUDIO_DB: sqliteD1(empty) }, 'courses', teacher, { method: 'GET', path: '/' })).body as { capabilities: { storage: string } }).capabilities.storage, 'unavailable', 'A database without the migration is reported, not used.'); }
    finally { empty.close(); }
  } finally { sqlite.close(); }
});

test('actual workerd D1 keeps Studio changes atomic, idempotent and version-safe', { timeout: 60000 }, async () => {
  const bundle = await build({ stdin: { contents: `import {handleStudioRequest} from './apps/api/src/studio/http.ts'; const user=${JSON.stringify(teacher)}; export default {async fetch(request,env){const url=new URL(request.url);try{const result=await handleStudioRequest(env,'courses',user,{method:request.method,path:url.pathname+url.search,body:request.method==='GET'?undefined:await request.json(),idempotencyKey:request.headers.get('Idempotency-Key')||undefined});return Response.json(result.body,{status:result.status});}catch(error){return Response.json({error:{code:error.code||'unavailable'}},{status:error.status||503});}}};`, resolveDir: fileURLToPath(root), sourcefile: 'studio-d1-workerd-fixture.ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', conditions: ['workerd'], mainFields: ['module', 'main'], external: ['cloudflare:*', 'node:*'] });
  const worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-13', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE), d1Databases: { STUDIO_DB: 'studio-workerd-test' }, bindings: { APP_ENV: 'test', APP_PRODUCTS_ENABLED: 'true', TECHLYUP_ERP_ORG_ID: actor.orgId } }));
  try {
    // Apply the reviewed migration object by object, as wrangler does statement by statement.
    const d1 = await worker.getD1Database('STUDIO_DB'), schema = new DatabaseSync(':memory:');
    try { schema.exec(migration); for (const object of schema.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all() as { sql: string }[]) await d1.prepare(object.sql).run(); }
    finally { schema.close(); }
    const call = async (path: string, method = 'GET', body?: unknown, key?: string) => {
      const response = await worker.dispatchFetch('https://workspace.example.test' + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() as any };
    };
    assert.equal((await call('/')).body.capabilities.storage, 'ready');
    const value = validateValues(workspaceDefinitions.courses.resources[0], { ...example(workspaceDefinitions.courses.resources[0]), title: 'Synthetic Workerd persistent course' }), key = randomUUID();
    const pair = await Promise.all([call('/records', 'POST', { resource: 'courses', values: value }, key), call('/records', 'POST', { resource: 'courses', values: value }, key)]);
    assert.ok(pair.every(result => result.status === 201)); assert.equal(pair[0].body.record.id, pair[1].body.record.id);
    const saved = pair[0];
    const fetched = await call('/records?resource=courses&q=synthetic%20workerd'); assert.equal(fetched.status, 200); assert.equal(fetched.body.records.length, 1); assert.equal(fetched.body.records[0].id, saved.body.record.id);
    const edits = await Promise.all(['A', 'B'].map(letter => call('/records/' + saved.body.record.id, 'PATCH', { version: 1, values: { ...value, title: `Synthetic Workerd edit ${letter}` } }, randomUUID())));
    assert.deepEqual(edits.map(result => result.status).sort(), [200, 409]);
    const closed = await call('/records/' + saved.body.record.id + '/archive', 'POST', { version: 2 }, randomUUID()); assert.equal(closed.status, 200); assert.equal(closed.body.record.status, 'archived');
    assert.equal((await call('/records?resource=courses&q=Synthetic%20Workerd')).body.records.length, 0);
    const audit = await d1.prepare("SELECT action FROM studio_audit_events ORDER BY created_at,action").all<{ action: string }>();
    assert.deepEqual(audit.results.map(row => row.action), ['draft.created', 'draft.updated', 'draft.archived']);
    assert.equal((await call('/overview')).body.counts.find((row: { resource: string }) => row.resource === 'courses')?.count, 0);
  } finally { await worker.dispose(); }
});
