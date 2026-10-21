import { Pool, type PoolClient } from 'pg';
import { ApiError } from '../types';
import type { ProductId, StudioActor, WorkspaceDefinition, WorkspaceOverview, WorkspaceRecord, WorkspaceValue } from './contracts';

type RecordRow = { id: string; app_id: ProductId; resource: string; values: Record<string, WorkspaceValue>; status: 'draft' | 'archived'; version: number; created_at: Date; updated_at: Date };
const recordFrom = (row: RecordRow): WorkspaceRecord => ({ id: row.id, appId: row.app_id, resource: row.resource, values: row.values, status: row.status, version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const ownerParams = (actor: StudioActor) => [actor.orgId, actor.issuer, actor.accountId];
const ownerWhere = 'org_id=$1 AND issuer=$2 AND account_id=$3';
const fields = 'id,app_id,resource,values,status,version,created_at,updated_at';

export interface StudioDatabase { connect(): Promise<PoolClient> }
export function createStudioDatabase(connectionString: string): Pool {
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, statement_timeout: 5000, application_name: 'techlyup-studio' });
  pool.on('error', () => { /* Never log connection strings, SQL values or private draft contents. */ });
  return pool;
}

export class StudioRepository {
  constructor(private readonly database: StudioDatabase) {}

  private async transaction<T>(actor: StudioActor, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
      if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls) throw new ApiError('unsafe_storage_role', 'Studio storage must use a role that cannot bypass row permissions.', 503);
      await client.query("SELECT set_config('app.studio_org',$1,true),set_config('app.studio_issuer',$2,true),set_config('app.studio_account',$3,true)", ownerParams(actor));
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async ready(actor: StudioActor): Promise<void> {
    return this.transaction(actor, async client => {
      const result = await client.query<{ total: number; secured: number }>(`SELECT count(*)::int total,count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='studio_workspace' AND c.relname IN ('account_refs','records','idempotency_operations','audit_events') AND c.relkind='r'`);
      if (result.rows[0]?.total !== 4 || result.rows[0]?.secured !== 4) throw new ApiError('storage_unavailable', 'The Studio workspace schema is not ready.', 503);
      await client.query('SELECT id FROM studio_workspace.records LIMIT 0');
    });
  }

  async list(actor: StudioActor, appId: ProductId, resource: string, search = ''): Promise<WorkspaceRecord[]> {
    return this.transaction(actor, async client => {
      const result = await client.query<RecordRow>(`SELECT ${fields} FROM studio_workspace.records WHERE ${ownerWhere} AND app_id=$4 AND resource=$5 AND status='draft' AND ($6='' OR position(lower($6) in lower(values->>'title'))>0) ORDER BY updated_at DESC,id LIMIT 100`, [...ownerParams(actor), appId, resource, search]);
      return result.rows.map(recordFrom);
    });
  }

  async overview(actor: StudioActor, definition: WorkspaceDefinition): Promise<WorkspaceOverview> {
    return this.transaction(actor, async client => {
      // Insights is the only app that summarizes this person's other workspaces.
      // These are private preparation counts, never attendance/revenue outcomes.
      const product = definition.id === 'insights' ? null : definition.id;
      const counts = await client.query<{ app_id: ProductId; resource: string; count: number }>(`SELECT app_id,resource,count(*)::int count FROM studio_workspace.records WHERE ${ownerWhere} AND status='draft' AND ($4::text IS NULL OR app_id=$4) GROUP BY app_id,resource ORDER BY app_id,resource`, [...ownerParams(actor), product]);
      const activity = await client.query<{ id: string; app_id: ProductId; resource: string; action: string; created_at: Date }>(`SELECT id,app_id,resource,action,created_at FROM studio_workspace.audit_events WHERE ${ownerWhere} AND ($4::text IS NULL OR app_id=$4) ORDER BY created_at DESC,id LIMIT 20`, [...ownerParams(actor), product]);
      const outputCounts = definition.id === 'insights' ? counts.rows.map(row => ({ resource: `${row.app_id}/${row.resource}`, label: `${row.app_id} · ${row.resource}`, count: row.count })) : definition.resources.filter(resource => resource.available).map(resource => ({ resource: resource.id, label: resource.label, count: counts.rows.find(row => row.resource === resource.id)?.count ?? 0 }));
      return { counts: outputCounts, recentActivity: activity.rows.map(row => ({ id: row.id, appId: row.app_id, resource: row.resource, action: row.action, createdAt: row.created_at.toISOString() })), source: 'own_workspace_records' };
    });
  }

  private async mutation(actor: StudioActor, appId: ProductId, resource: string, key: string, payload: unknown, apply: (client: PoolClient) => Promise<{ record: WorkspaceRecord }>): Promise<{ record: WorkspaceRecord; replay?: boolean }> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ appId, resource, payload })));
    const fingerprint = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    return this.transaction(actor, async client => {
      await client.query('INSERT INTO studio_workspace.account_refs(org_id,issuer,account_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', ownerParams(actor));
      const claim = await client.query(`INSERT INTO studio_workspace.idempotency_operations(org_id,issuer,account_id,idempotency_key,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING fingerprint`, [...ownerParams(actor), key, fingerprint]);
      if (claim.rowCount !== 1) {
        const prior = await client.query<{ fingerprint: string; response: { record: WorkspaceRecord } | null }>(`SELECT fingerprint,response FROM studio_workspace.idempotency_operations WHERE ${ownerWhere} AND idempotency_key=$4`, [...ownerParams(actor), key]);
        if (prior.rows[0]?.fingerprint !== fingerprint) throw new ApiError('idempotency_conflict', 'This change key belongs to different content.', 409);
        if (!prior.rows[0]?.response) throw new ApiError('request_in_progress', 'This change is still in progress. Reload before retrying.', 409);
        return { ...prior.rows[0].response, replay: true };
      }
      const response = await apply(client);
      await client.query(`UPDATE studio_workspace.idempotency_operations SET response=$5::jsonb WHERE ${ownerWhere} AND idempotency_key=$4`, [...ownerParams(actor), key, JSON.stringify(response)]);
      return response;
    });
  }

  private async audit(client: PoolClient, actor: StudioActor, record: WorkspaceRecord, action: string): Promise<void> {
    await client.query('INSERT INTO studio_workspace.audit_events(id,org_id,issuer,account_id,app_id,resource,record_id,action) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [crypto.randomUUID(), ...ownerParams(actor), record.appId, record.resource, record.id, action]);
  }

  async create(actor: StudioActor, appId: ProductId, resource: string, values: Record<string, WorkspaceValue>, key: string): Promise<{ record: WorkspaceRecord; replay?: boolean }> {
    return this.mutation(actor, appId, resource, key, { operation: 'create', values }, async client => {
      const result = await client.query<RecordRow>(`INSERT INTO studio_workspace.records(id,org_id,issuer,account_id,app_id,resource,values) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING ${fields}`, [crypto.randomUUID(), ...ownerParams(actor), appId, resource, JSON.stringify(values)]);
      const record = recordFrom(result.rows[0]);
      await this.audit(client, actor, record, 'draft.created');
      return { record };
    });
  }

  async update(actor: StudioActor, appId: ProductId, id: string, version: number, values: Record<string, WorkspaceValue>, key: string): Promise<{ record: WorkspaceRecord; replay?: boolean }> {
    return this.mutation(actor, appId, 'record', key, { operation: 'update', id, version, values }, async client => {
      const existing = await client.query<RecordRow>(`SELECT ${fields} FROM studio_workspace.records WHERE ${ownerWhere} AND app_id=$4 AND id=$5 FOR UPDATE`, [...ownerParams(actor), appId, id]);
      const row = existing.rows[0];
      if (!row) throw new ApiError('not_found', 'Your workspace record was not found.', 404);
      if (row.version !== version) throw new ApiError('version_conflict', 'This draft changed. Reload before editing again.', 409);
      if (row.status !== 'draft') throw new ApiError('record_archived', 'This draft has been archived.', 409);
      const result = await client.query<RecordRow>(`UPDATE studio_workspace.records SET values=$6::jsonb,version=version+1,updated_at=clock_timestamp() WHERE ${ownerWhere} AND app_id=$4 AND id=$5 RETURNING ${fields}`, [...ownerParams(actor), appId, id, JSON.stringify(values)]);
      const record = recordFrom(result.rows[0]);
      await this.audit(client, actor, record, 'draft.updated');
      return { record };
    });
  }

  async record(actor: StudioActor, appId: ProductId, id: string): Promise<WorkspaceRecord | undefined> {
    return this.transaction(actor, async client => {
      const result = await client.query<RecordRow>(`SELECT ${fields} FROM studio_workspace.records WHERE ${ownerWhere} AND app_id=$4 AND id=$5`, [...ownerParams(actor), appId, id]);
      return result.rows[0] ? recordFrom(result.rows[0]) : undefined;
    });
  }

  async archive(actor: StudioActor, appId: ProductId, id: string, version: number, key: string): Promise<{ record: WorkspaceRecord; replay?: boolean }> {
    return this.mutation(actor, appId, 'record', key, { operation: 'archive', id, version }, async client => {
      const existing = await client.query<RecordRow>(`SELECT ${fields} FROM studio_workspace.records WHERE ${ownerWhere} AND app_id=$4 AND id=$5 FOR UPDATE`, [...ownerParams(actor), appId, id]);
      const row = existing.rows[0];
      if (!row) throw new ApiError('not_found', 'Your workspace record was not found.', 404);
      if (row.version !== version) throw new ApiError('version_conflict', 'This draft changed. Reload before archiving again.', 409);
      if (row.status !== 'draft') throw new ApiError('record_archived', 'This draft has already been archived.', 409);
      const result = await client.query<RecordRow>(`UPDATE studio_workspace.records SET status='archived',version=version+1,updated_at=clock_timestamp() WHERE ${ownerWhere} AND app_id=$4 AND id=$5 RETURNING ${fields}`, [...ownerParams(actor), appId, id]);
      const record = recordFrom(result.rows[0]);
      await this.audit(client, actor, record, 'draft.archived');
      return { record };
    });
  }
}
