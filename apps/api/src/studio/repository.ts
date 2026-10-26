import { ApiError, type D1Database, type D1Statement } from '../types';
import type { ProductId, StudioActor, WorkspaceDefinition, WorkspaceOverview, WorkspaceRecord, WorkspaceValue } from './contracts';

type RecordRow = { id: string; app_id: ProductId; resource: string; field_values: string; status: 'draft' | 'archived'; version: number; created_at: string; updated_at: string };
type Mutation = { record: WorkspaceRecord; replay?: boolean };
const recordFrom = (row: RecordRow): WorkspaceRecord => ({ id: row.id, appId: row.app_id, resource: row.resource, values: JSON.parse(row.field_values) as Record<string, WorkspaceValue>, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });
const owner = (actor: StudioActor) => [actor.orgId, actor.issuer, actor.accountId] as const;
// D1 has no row-level security: every statement binds the owner as ?1-?3 and filters or writes it.
export const ownerWhere = 'org_id=?1 AND issuer=?2 AND account_id=?3';
const fields = 'id,app_id,resource,field_values,status,version,created_at,updated_at';
const clock = () => new Date().toISOString();

export class StudioRepository {
  constructor(private readonly db: D1Database) {}

  async ready(): Promise<void> {
    const row = await this.db.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('studio_account_refs','studio_records','studio_idempotency_operations','studio_audit_events')").first<{ total: number }>();
    if (row?.total !== 4) throw new ApiError('storage_unavailable', 'The Studio workspace schema is not ready.', 503);
  }

  async list(actor: StudioActor, appId: ProductId, resource: string, search = ''): Promise<WorkspaceRecord[]> {
    const result = await this.db.prepare(`SELECT ${fields} FROM studio_records WHERE ${ownerWhere} AND app_id=?4 AND resource=?5 AND status='draft' AND (?6='' OR instr(lower(coalesce(json_extract(field_values,'$.title'),'')),lower(?6))>0) ORDER BY updated_at DESC,id LIMIT 100`).bind(...owner(actor), appId, resource, search).all<RecordRow>();
    return result.results.map(recordFrom);
  }

  async overview(actor: StudioActor, definition: WorkspaceDefinition): Promise<WorkspaceOverview> {
    // Insights is the only app that summarizes this person's other workspaces.
    // These are private preparation counts, never attendance/revenue outcomes.
    const product = definition.id === 'insights' ? null : definition.id;
    const counts = (await this.db.prepare(`SELECT app_id,resource,count(*) AS count FROM studio_records WHERE ${ownerWhere} AND status='draft' AND (?4 IS NULL OR app_id=?4) GROUP BY app_id,resource ORDER BY app_id,resource`).bind(...owner(actor), product).all<{ app_id: ProductId; resource: string; count: number }>()).results;
    const activity = (await this.db.prepare(`SELECT id,app_id,resource,action,created_at FROM studio_audit_events WHERE ${ownerWhere} AND (?4 IS NULL OR app_id=?4) ORDER BY created_at DESC,id LIMIT 20`).bind(...owner(actor), product).all<{ id: string; app_id: ProductId; resource: string; action: string; created_at: string }>()).results;
    const outputCounts = definition.id === 'insights' ? counts.map(row => ({ resource: `${row.app_id}/${row.resource}`, label: `${row.app_id} · ${row.resource}`, count: row.count })) : definition.resources.filter(resource => resource.available).map(resource => ({ resource: resource.id, label: resource.label, count: counts.find(row => row.resource === resource.id)?.count ?? 0 }));
    return { counts: outputCounts, recentActivity: activity.map(row => ({ id: row.id, appId: row.app_id, resource: row.resource, action: row.action, createdAt: row.created_at })), source: 'own_workspace_records' };
  }

  async record(actor: StudioActor, appId: ProductId, id: string): Promise<WorkspaceRecord | undefined> {
    const row = await this.db.prepare(`SELECT ${fields} FROM studio_records WHERE ${ownerWhere} AND app_id=?4 AND id=?5`).bind(...owner(actor), appId, id).first<RecordRow>();
    return row ? recordFrom(row) : undefined;
  }

  async create(actor: StudioActor, appId: ProductId, resource: string, values: Record<string, WorkspaceValue>, key: string): Promise<Mutation> {
    const fingerprint = await this.fingerprint(appId, resource, { operation: 'create', values });
    const replay = await this.prior(actor, key, fingerprint);
    if (replay) return replay;
    const at = clock(), writeId = crypto.randomUUID();
    const record: WorkspaceRecord = { id: crypto.randomUUID(), appId, resource, values, status: 'draft', version: 1, createdAt: at, updatedAt: at };
    const write = this.db.prepare(`INSERT INTO studio_records(id,org_id,issuer,account_id,app_id,resource,field_values,status,version,write_id,created_at,updated_at) VALUES(?4,?1,?2,?3,?5,?6,?7,'draft',1,?8,?9,?9)`).bind(...owner(actor), record.id, appId, resource, JSON.stringify(values), writeId, at);
    const result = await this.commit(actor, key, fingerprint, record, writeId, 'draft.created', write);
    if (!result) throw new ApiError('storage_unavailable', 'Workspace storage is unavailable. Reload before retrying a change.', 503);
    return result;
  }

  async update(actor: StudioActor, appId: ProductId, id: string, version: number, values: Record<string, WorkspaceValue>, key: string): Promise<Mutation> {
    const fingerprint = await this.fingerprint(appId, 'record', { operation: 'update', id, version, values });
    const replay = await this.prior(actor, key, fingerprint);
    if (replay) return replay;
    const existing = await this.current(actor, appId, id, version, 'editing');
    const at = clock(), writeId = crypto.randomUUID(), record: WorkspaceRecord = { ...existing, values, version: version + 1, updatedAt: at };
    const write = this.db.prepare(`UPDATE studio_records SET field_values=?6,version=version+1,updated_at=?7,write_id=?8 WHERE ${ownerWhere} AND app_id=?4 AND id=?5 AND version=?9 AND status='draft'`).bind(...owner(actor), appId, id, JSON.stringify(values), at, writeId, version);
    return await this.commit(actor, key, fingerprint, record, writeId, 'draft.updated', write) ?? this.lost(actor, appId, id, version, 'editing');
  }

  async archive(actor: StudioActor, appId: ProductId, id: string, version: number, key: string): Promise<Mutation> {
    const fingerprint = await this.fingerprint(appId, 'record', { operation: 'archive', id, version });
    const replay = await this.prior(actor, key, fingerprint);
    if (replay) return replay;
    const existing = await this.current(actor, appId, id, version, 'archiving');
    const at = clock(), writeId = crypto.randomUUID(), record: WorkspaceRecord = { ...existing, status: 'archived', version: version + 1, updatedAt: at };
    const write = this.db.prepare(`UPDATE studio_records SET status='archived',version=version+1,updated_at=?6,write_id=?7 WHERE ${ownerWhere} AND app_id=?4 AND id=?5 AND version=?8 AND status='draft'`).bind(...owner(actor), appId, id, at, writeId, version);
    return await this.commit(actor, key, fingerprint, record, writeId, 'draft.archived', write) ?? this.lost(actor, appId, id, version, 'archiving');
  }

  private async fingerprint(appId: ProductId, resource: string, payload: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ appId, resource, payload })));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /** A repeated change key returns its stored response; different content under the same key is refused. */
  private async prior(actor: StudioActor, key: string, fingerprint: string): Promise<Mutation | undefined> {
    const row = await this.db.prepare(`SELECT fingerprint,response FROM studio_idempotency_operations WHERE ${ownerWhere} AND idempotency_key=?4`).bind(...owner(actor), key).first<{ fingerprint: string; response: string }>();
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new ApiError('idempotency_conflict', 'This change key belongs to different content.', 409);
    return { ...JSON.parse(row.response) as { record: WorkspaceRecord }, replay: true };
  }

  private async current(actor: StudioActor, appId: ProductId, id: string, version: number, verb: 'editing' | 'archiving'): Promise<WorkspaceRecord> {
    const existing = await this.record(actor, appId, id);
    if (!existing) throw new ApiError('not_found', 'Your workspace record was not found.', 404);
    if (existing.version !== version) throw new ApiError('version_conflict', `This draft changed. Reload before ${verb} again.`, 409);
    if (existing.status !== 'draft') throw new ApiError('record_archived', verb === 'editing' ? 'This draft has been archived.' : 'This draft has already been archived.', 409);
    return existing;
  }

  /** Another change won after this request read the draft; report the state that now applies. */
  private async lost(actor: StudioActor, appId: ProductId, id: string, version: number, verb: 'editing' | 'archiving'): Promise<never> {
    await this.current(actor, appId, id, version, verb);
    throw new ApiError('version_conflict', `This draft changed. Reload before ${verb} again.`, 409);
  }

  /** One atomic D1 batch writes the draft, its audit event and the change key's stored response.
   * The last two exist only if this exact write landed, identified by its write ID. A concurrent
   * request with the same key fails the whole batch on the key's primary key and replays instead.
   * Returns null when the guarded write changed nothing. */
  private async commit(actor: StudioActor, key: string, fingerprint: string, record: WorkspaceRecord, writeId: string, action: string, write: D1Statement): Promise<Mutation | null> {
    const landed = `EXISTS(SELECT 1 FROM studio_records WHERE ${ownerWhere} AND id=?4 AND write_id=?5)`;
    let results;
    try {
      results = await this.db.batch([
        this.db.prepare('INSERT INTO studio_account_refs(org_id,issuer,account_id,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING').bind(...owner(actor), record.updatedAt),
        write,
        this.db.prepare(`INSERT INTO studio_audit_events(id,org_id,issuer,account_id,app_id,resource,record_id,action,created_at) SELECT ?5,?1,?2,?3,?6,?7,?4,?8,?9 WHERE ${landed}`).bind(...owner(actor), record.id, writeId, record.appId, record.resource, action, record.updatedAt),
        this.db.prepare(`INSERT INTO studio_idempotency_operations(org_id,issuer,account_id,idempotency_key,fingerprint,response,created_at) SELECT ?1,?2,?3,?6,?7,?8,?9 WHERE ${landed}`).bind(...owner(actor), record.id, writeId, key, fingerprint, JSON.stringify({ record }), record.updatedAt),
      ]);
    } catch (error) {
      const replay = await this.prior(actor, key, fingerprint);
      if (replay) return replay;
      throw error;
    }
    return results[1]?.meta.changes === 1 ? { record } : null;
  }
}
