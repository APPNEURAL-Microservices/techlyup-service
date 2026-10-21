import { z } from 'zod';
import { ApiError } from '../types';
import { definitionFor } from './definitions';
import { createStudioDatabase, StudioRepository } from './repository';
import { validateValues } from './validation';
import type { StudioActor, StudioEnv, StudioRequest, StudioResponse, StudioUser, WorkspaceCapabilities, WorkspaceResource } from './contracts';

const createSchema = z.object({ resource: z.string().min(1).max(40), values: z.unknown(), idempotencyKey: z.uuid().optional() }).strict();
const updateSchema = z.object({ version: z.number().int().min(1).max(2147483646), values: z.unknown(), idempotencyKey: z.uuid().optional() }).strict();
const archiveSchema = z.object({ version: z.number().int().min(1).max(2147483646), idempotencyKey: z.uuid().optional() }).strict();
const TEACHING_ROLES = new Set(['owner', 'admin', 'manager', 'teacher', 'instructor', 'trainer', 'mentor', 'co_trainer', 'academic_admin']);
export function canWriteOwnDrafts(user: StudioUser): boolean {
  return user.registration?.accountType === 'teacher' || Boolean(user.roles?.some(role => TEACHING_ROLES.has(role)));
}

export function studioConnection(env: StudioEnv): string {
  if (env.STUDIO_HYPERDRIVE?.connectionString) return env.STUDIO_HYPERDRIVE.connectionString;
  if (['development', 'test'].includes(env.APP_ENV ?? 'development') && env.STUDIO_DATABASE_URL) {
    try {
      const address = new URL(env.STUDIO_DATABASE_URL);
      if (['postgres:', 'postgresql:'].includes(address.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) && !address.search && !address.hash) return env.STUDIO_DATABASE_URL;
    } catch { /* Sanitized configuration message below. */ }
  }
  throw new ApiError('storage_unavailable', 'Studio storage is not configured. A dedicated database and accepted migrations are required.', 503);
}

function resourceFor(resources: WorkspaceResource[], name: string): WorkspaceResource {
  const resource = resources.find(item => item.id === name);
  if (!resource) throw new ApiError('not_found', 'This workspace resource was not found.', 404);
  if (!resource.available) throw new ApiError('integration_required', resource.unavailableReason ?? 'This canonical integration is not available.', 503);
  return resource;
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError('validation_failed', 'The workspace request is invalid.', 422);
  return result.data;
}
function changeKey(request: StudioRequest, bodyKey?: string): string {
  if (request.idempotencyKey && bodyKey && request.idempotencyKey !== bodyKey) throw new ApiError('idempotency_conflict', 'Use one stable change key.', 409);
  const result = z.uuid().safeParse(request.idempotencyKey ?? bodyKey);
  if (!result.success) throw new ApiError('idempotency_required', 'Use a stable UUID Idempotency-Key for this change.', 422);
  return result.data;
}
function capabilities(storage: WorkspaceCapabilities['storage'], user: StudioUser): WorkspaceCapabilities {
  return { storage, ownDrafts: storage === 'ready' && canWriteOwnDrafts(user), canonicalPublishing: false, certificateIssuance: false, financialTransactions: false, aiGeneration: false, note: storage === 'ready' ? 'Private preparation records are saved for your account only. Publishing, official credentials, delivery, financial transactions and AI generation require separate verified integrations.' : 'Persistent preparation needs the Studio feature enabled and an accepted dedicated database. Official publishing, credentials, money movement and AI generation are not enabled.' };
}

/** Product Workers call this through the central identity service. User identity
 * is server-resolved on every request; browser payloads cannot choose an owner. */
export async function handleStudioRequest(env: StudioEnv, appId: string, user: StudioUser, request: StudioRequest): Promise<StudioResponse> {
  const definition = definitionFor(appId);
  if (!definition) throw new ApiError('not_found', 'This TechlyUp app was not found.', 404);
  if (!user.id || user.id.length > 100 || !env.TECHLYUP_ERP_ORG_ID?.trim()) throw new ApiError('unauthorized', 'Sign in to a canonical TechlyUp account.', 401);
  if (request.body !== undefined && new TextEncoder().encode(JSON.stringify(request.body)).byteLength > 20000) throw new ApiError('request_too_large', 'The workspace request is too large.', 413);
  const address = new URL(request.path, 'https://workspace.internal');
  const path = address.pathname.replace(/\/$/, '') || '/';
  const method = request.method.toUpperCase();
  if (!['GET', 'POST', 'PATCH'].includes(method)) throw new ApiError('method_not_allowed', 'This workspace method is not supported.', 405);
  if (env.APP_PRODUCTS_ENABLED !== 'true') {
    if (path === '/' && method === 'GET') return { status: 200, body: { definition, capabilities: capabilities('disabled', user) } };
    throw new ApiError('feature_disabled', 'Persistent Studio workspaces are not enabled in this environment.', 503);
  }
  let connection: string;
  try { connection = studioConnection(env); }
  catch (error) {
    if (path === '/' && method === 'GET') return { status: 200, body: { definition, capabilities: capabilities('unavailable', user) } };
    throw error;
  }
  const actor: StudioActor = { orgId: env.TECHLYUP_ERP_ORG_ID, accountId: user.id, issuer: 'techlyup-learner' };
  const pool = createStudioDatabase(connection), repository = new StudioRepository(pool);
  try {
    if (path === '/' && method === 'GET') {
      try { await repository.ready(actor); return { status: 200, body: { definition, capabilities: capabilities('ready', user) } }; }
      catch { return { status: 200, body: { definition, capabilities: capabilities('unavailable', user) } }; }
    }
    if (method !== 'GET' && !canWriteOwnDrafts(user)) throw new ApiError('forbidden', 'A teaching workspace is required to save your own preparation drafts.', 403);
    if (path === '/overview' && method === 'GET') return { status: 200, body: await repository.overview(actor, definition) };
    if (path === '/records' && method === 'GET') {
      const name = address.searchParams.get('resource') ?? '';
      const resource = resourceFor(definition.resources, name), search = (address.searchParams.get('q') ?? '').trim();
      if (search.length > 100) throw new ApiError('invalid_filter', 'Keep the workspace search below 100 characters.', 422);
      return { status: 200, body: { records: await repository.list(actor, definition.id, resource.id, search), limit: 100 } };
    }
    if (path === '/records' && method === 'POST') {
      const input = parse(createSchema, request.body), resource = resourceFor(definition.resources, input.resource);
      const values = validateValues(resource, input.values), key = changeKey(request, input.idempotencyKey);
      return { status: 201, body: await repository.create(actor, definition.id, resource.id, values, key) };
    }
    const match = path.match(/^\/records\/([^/]+)(\/archive)?$/);
    if (match) {
      const idResult = z.uuid().safeParse(match[1]);
      if (!idResult.success) throw new ApiError('not_found', 'Your workspace record was not found.', 404);
      if (match[2] && method === 'POST') {
        const input = parse(archiveSchema, request.body), key = changeKey(request, input.idempotencyKey);
        return { status: 200, body: await repository.archive(actor, definition.id, idResult.data, input.version, key) };
      }
      if (!match[2] && method === 'PATCH') {
        const input = parse(updateSchema, request.body), key = changeKey(request, input.idempotencyKey);
        const existing = await repository.record(actor, definition.id, idResult.data);
        if (!existing) throw new ApiError('not_found', 'Your workspace record was not found.', 404);
        const resource = resourceFor(definition.resources, existing.resource), values = validateValues(resource, input.values);
        return { status: 200, body: await repository.update(actor, definition.id, idResult.data, input.version, values, key) };
      }
      throw new ApiError('method_not_allowed', 'This workspace method is not supported.', 405);
    }
    throw new ApiError('not_found', 'This workspace route was not found.', 404);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // No raw SQL error, draft values, request body or connection details escape.
    throw new ApiError('storage_unavailable', 'Workspace storage is unavailable. Reload before retrying a change.', 503);
  } finally { await pool.end().catch(() => undefined); }
}
