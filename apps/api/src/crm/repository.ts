import { crmCaptureSchema, crmLeadPatchSchema, crmActivitySchema, crmTaskSchema, crmLeadFilterSchema, crmCampaignSchema, crmRuleSchema, crmIntegrationSchema, crmStages, type CrmLead, type CrmCaptureInput, type CrmLeadPatchInput, type CrmActivityInput, type CrmTaskInput, type CrmLeadFilter, type CrmActivity, type CrmTask, type CrmConsent, type CrmStaff, type CrmCampaign, type CrmCampaignInput, type CrmRule, type CrmRuleInput, type CrmIntegration, type CrmIntegrationInput, type CrmJob, type CrmChannel, type CrmPurpose, type CrmScoreReason, type CrmCampaignPreview, } from '@techlyup/contracts';
import { ApiError, type D1Database, type D1Statement } from '../types';
import { hash } from '../auth/crypto';
export interface CrmActor {
    orgId: string;
    accountId: string | null;
    requestId: string;
    ownerOnly?: boolean;
}
export interface CrmCaptureOptions {
    accountId?: string;
    sourceEvent?: {
        source: string;
        externalId: string;
    };
    processingProof?: {sourceRef:string;externalId:string;policyVersion:'2026-10';occurredAt:string};
    verifiedSource?: {
        kind: 'newsletter';
        reference: string;
        verifiedAt: string;
    };
}
type Row = Record<string, any>;
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
// Canonical website src/lib/live/crm/hashes.ts uses a runtime NUL separator.
export const canonicalCrmContactHash = (channel: CrmChannel, value: string) => hash(`${channel}\0${channel === 'email' ? value.trim().toLowerCase() : value.trim()}`);
const managerRoles=['owner','admin','manager','operations','academic_admin','coordinator'];
const currentManager=(orgColumn:string,accountColumn:string)=>`EXISTS(SELECT 1 FROM live_core_staff_links ms JOIN learner_accounts ma ON ma.id=ms.learner_account_id WHERE ms.org_id=${orgColumn} AND ma.id=${accountColumn} AND ms.revoked_at IS NULL AND ms.expires_at>? AND lower(ms.actor_email)=lower(ma.email) AND (ms.actor_role IN('owner','admin','manager') OR EXISTS(SELECT 1 FROM webinar_erp_roles mr WHERE mr.org_id=ms.org_id AND mr.actor_id=ms.actor_id AND mr.functional_role IN('operations','academic_admin','coordinator'))))`;
const missing = () => new ApiError('crm_not_found', 'CRM record not found.', 404);
const conflict = () => new ApiError('crm_conflict', 'The record changed. Reload before trying again.', 409);
const leadSelect = `SELECT l.id,l.contact_id contactId,c.name,c.email,c.phone,l.account_id accountId,l.kind,l.interest,l.source,l.stage,l.score,l.score_reasons scoreReasons,l.owner_account_id ownerAccountId,l.version,l.created_at createdAt,l.updated_at updatedAt FROM crm_leads l JOIN crm_contacts c ON c.org_id=l.org_id AND c.id=l.contact_id`;
const taskSelect = `SELECT t.id,t.lead_id leadId,t.title,t.due_at dueAt,t.assigned_account_id assignedAccountId,t.status,t.version,t.created_at createdAt,t.updated_at updatedAt FROM crm_tasks t JOIN crm_leads l ON l.org_id=t.org_id AND l.id=t.lead_id`;
const jobSelect = `SELECT j.id,j.lead_id leadId,j.campaign_id campaignId,j.campaign_version campaignVersion,j.integration_id integrationId,j.template_ref templateRef,j.channel,j.purpose,j.state,j.attempts,j.lease_id leaseId,j.provider_message_id providerMessageId,j.native_intent_id nativeIntentId,j.error_code errorCode,j.scheduled_at scheduledAt,j.updated_at updatedAt FROM crm_jobs j JOIN crm_leads l ON l.org_id=j.org_id AND l.id=j.lead_id`;
const lead = (row: Row): CrmLead => ({ ...row, scoreReasons: JSON.parse(row.scoreReasons) }) as CrmLead;
const campaign = (row: Row): CrmCampaign => ({ ...row, enabled: Boolean(row.enabled), kinds: JSON.parse(row.kinds), stages: JSON.parse(row.stages) }) as CrmCampaign;
const entity = (row: Row) => ({ ...row, enabled: Boolean(row.enabled) });
const scope = (actor: CrmActor, alias = 'l') => actor.ownerOnly ? { sql: ` AND ${alias}.owner_account_id=?`, values: [actor.accountId] } : { sql: '', values: [] };
/** Canonical identities remain outside this additive acquisition domain. All
 * mutations use a D1 atomic batch including the command receipt and audit. */
export class CrmRepository {
    constructor(private db: D1Database) { }
    private stmt(sql: string, ...values: unknown[]) { return this.db.prepare(sql).bind(...values); }
    private guard() { return this.stmt('INSERT INTO crm_command_guards(id,satisfied) VALUES(?,changes()) ON CONFLICT(id) DO UPDATE SET satisfied=excluded.satisfied', 'atomic-cas'); }
    private staffGuard(actor: CrmActor, accountId: string) { return this.stmt(`INSERT INTO crm_command_guards(id,satisfied) SELECT 'atomic-staff',CASE WHEN EXISTS(SELECT 1 FROM live_core_staff_links s JOIN learner_accounts a ON a.id=s.learner_account_id WHERE s.org_id=? AND a.id=? AND s.revoked_at IS NULL AND s.expires_at>? AND lower(s.actor_email)=lower(a.email) AND (s.actor_role IN('owner','admin','manager') OR EXISTS(SELECT 1 FROM webinar_erp_roles r WHERE r.org_id=s.org_id AND r.actor_id=s.actor_id AND r.functional_role IN('operations','academic_admin','coordinator','sales','crm','assistant')))) THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET satisfied=excluded.satisfied`, actor.orgId, accountId, now()); }
    private audit(actor: CrmActor, action: string, resourceId: string | null, metadata: unknown = {}) { return this.stmt('INSERT INTO crm_audit_events(org_id,id,actor_account_id,request_id,action,resource_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)', actor.orgId, id(), actor.accountId, actor.requestId, action, resourceId, JSON.stringify(metadata), now()); }
    private async command<T>(actor: CrmActor, key: string, operation: string, input: unknown, build: () => Promise<{
        statements: D1Statement[];
        result: T;
    }>): Promise<T> {
        if (!/^[A-Za-z0-9._:-]{8,180}$/.test(key))
            throw new ApiError('idempotency_required', 'Use a stable request key.', 422);
        const digest = await hash(stable({ operation, input })), actorKey = actor.accountId ?? 'public';
        const receipt = () => this.stmt('SELECT operation,request_sha256,result_json FROM crm_commands WHERE org_id=? AND actor_key=? AND command_key=?', actor.orgId, actorKey, key).first<Row>();
        const replay = (row: Row) => { if (row.request_sha256 !== digest || row.operation !== operation)
            throw new ApiError('crm_idempotency_conflict', 'This request key was already used for another change.', 409); return JSON.parse(row.result_json) as T; };
        const previous = await receipt();
        if (previous)
            return replay(previous);
        const work = await build(), at = now();
        try {
            await this.db.batch([
                this.stmt('INSERT INTO crm_commands(org_id,actor_key,command_key,operation,request_sha256,result_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)', actor.orgId, actorKey, key, operation, digest, JSON.stringify(work.result), at, new Date(Date.now() + 7 * 86400000).toISOString()),
                ...work.statements, this.audit(actor, operation, typeof work.result==='object'&&work.result!==null&&'id' in work.result&&typeof work.result.id==='string'?work.result.id:null,{commandHash:await hash(key)}),
            ]);
            return work.result;
        }
        catch (error) {
            const committed = await receipt();
            if (committed)
                return replay(committed);
            if (error instanceof ApiError)
                throw error;
            if (error instanceof Error && /CHECK constraint failed: satisfied(?:=1)?|UNIQUE constraint failed|FOREIGN KEY constraint failed/i.test(error.message))
                throw conflict();
            throw new ApiError('crm_storage_unavailable', 'CRM storage is temporarily unavailable.', 503);
        }
    }
    private async getLead(actor: CrmActor, leadId: string) { const s = scope(actor); const row = await this.stmt(`${leadSelect} WHERE l.org_id=? AND l.id=?${s.sql}`, actor.orgId, leadId, ...s.values).first<Row>(); if (!row)
        throw missing(); return lead(row); }
    async listLeads(actor: CrmActor, raw: CrmLeadFilter = {}) {
        const filter = crmLeadFilterSchema.parse(raw), s = scope(actor), where = ['l.org_id=?'], values: unknown[] = [actor.orgId];
        if (s.sql) {
            where.push('l.owner_account_id=?');
            values.push(actor.accountId);
        }
        for (const [field, column] of [['stage', 'stage'], ['kind', 'kind'], ['ownerAccountId', 'owner_account_id']] as const)
            if (filter[field]) {
                where.push(`l.${column}=?`);
                values.push(filter[field]);
            }
        if (filter.q) {
            where.push("(c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR l.interest LIKE ? ESCAPE '\\')");
            const q = `%${filter.q.replace(/[\\%_]/g, '\\$&')}%`;
            values.push(q, q, q, q);
        }
        if (filter.cursor) {
            try {
                const [at, key] = JSON.parse(atob(filter.cursor));
                if (typeof at !== 'string' || typeof key !== 'string')
                    throw Error();
                where.push('(l.updated_at<? OR (l.updated_at=? AND l.id<?))');
                values.push(at, at, key);
            }
            catch {
                throw new ApiError('crm_invalid_cursor', 'Use the next page cursor.', 422);
            }
        }
        const rows = await this.stmt(`${leadSelect} WHERE ${where.join(' AND ')} ORDER BY l.updated_at DESC,l.id DESC LIMIT ?`, ...values, filter.limit + 1).all<Row>();
        const more = rows.results.length > filter.limit, leads = rows.results.slice(0, filter.limit).map(lead), last = leads.at(-1);
        return { leads, nextCursor: more && last ? btoa(JSON.stringify([last.updatedAt, last.id])) : null };
    }
    async detail(actor: CrmActor, leadId: string) {
        const found = await this.getLead(actor, leadId);
        const [activities, tasks, consents] = await Promise.all([
            this.stmt('SELECT id,lead_id leadId,kind,note,actor_account_id actorAccountId,occurred_at occurredAt FROM crm_activities WHERE org_id=? AND lead_id=? ORDER BY occurred_at DESC,id DESC LIMIT 100', actor.orgId, leadId).all<CrmActivity>(),
            this.stmt(`${taskSelect} WHERE t.org_id=? AND t.lead_id=? ORDER BY t.due_at LIMIT 100`, actor.orgId, leadId).all<CrmTask>(),
            this.stmt('SELECT channel,purpose,state,policy_version policyVersion,proof_kind proofKind,verified_at verifiedAt,updated_at updatedAt FROM crm_contact_permissions WHERE org_id=? AND contact_id=?', actor.orgId, found.contactId).all<CrmConsent>(),
        ]);
        return { lead: found, activities: activities.results, tasks: tasks.results, consents: consents.results };
    }
    async capture(actor: CrmActor, raw: CrmCaptureInput, key: string, options: CrmCaptureOptions = {}) {
        const input = crmCaptureSchema.parse(raw), request = { input, options };
        if(options.processingProof){const proof=options.processingProof;if(proof.policyVersion!=='2026-10'||!input.consent.service||input.consent.policyVersion!==proof.policyVersion||!/^[A-Za-z0-9_.:-]{1,160}$/.test(proof.sourceRef)||!/^[A-Za-z0-9._:-]{1,180}$/.test(proof.externalId)||!Number.isFinite(Date.parse(proof.occurredAt))||Date.parse(proof.occurredAt)>Date.now()+300000||(options.sourceEvent&&options.sourceEvent.externalId!==proof.externalId))throw new ApiError('crm_processing_proof_invalid','A current approved source processing receipt is required.',422);}
        if (options.sourceEvent) {
            const old = await this.stmt('SELECT lead_id,payload_sha256 FROM crm_source_events WHERE org_id=? AND source=? AND external_id=?', actor.orgId, options.sourceEvent.source, options.sourceEvent.externalId).first<Row>();
            if (old) {
                if (old.payload_sha256 !== await hash(stable(request)))
                    throw conflict();
                return this.getLead({ ...actor, ownerOnly: false }, old.lead_id);
            }
        }
        const result = await this.command(actor, key, 'capture', request, async () => {
            const at = now(), canonicalAccount = options.accountId ? await this.stmt('SELECT id,email,email_verified FROM learner_accounts WHERE id=?', options.accountId).first<Row>() : null, contact = input.email ? await this.stmt('SELECT * FROM crm_contacts WHERE org_id=? AND email=?', actor.orgId, input.email).first<Row>() : null;
            const contactId = contact?.id ?? id(), interest = input.interest ?? '', source = input.source ?? 'app_capture';
            const old = await this.stmt(`${leadSelect} WHERE l.org_id=? AND l.contact_id=? AND l.kind=? AND l.interest=?`, actor.orgId, contactId, input.kind, interest).first<Row>();
            // A restricted salesperson must never capture an existing record into their
            // scope or receive another owner's contact from an email dedupe.
            if (actor.ownerOnly && old && old.ownerAccountId !== actor.accountId)
                throw missing();
            const leadId = old?.id ?? id(), owner = old?.ownerAccountId ?? (actor.ownerOnly ? actor.accountId : null);
            const statements: D1Statement[] = [];
            if (owner)
                statements.push(this.staffGuard(actor, owner));
            if (!contact)
                statements.push(this.stmt('INSERT INTO crm_contacts(org_id,id,name,email,phone,created_at) VALUES(?,?,?,?,?,?)', actor.orgId, contactId, input.name ?? null, input.email ?? null, input.phone ?? null, at));
            if (options.accountId) {
                const acct = await this.stmt('SELECT id,email,email_verified FROM learner_accounts WHERE id=?', options.accountId).first<Row>();
                if (!acct)
                    throw missing();
                if (!input.email || acct.email.toLowerCase() !== input.email)
                    throw new ApiError('crm_account_contact_mismatch', 'Use the canonical account contact for an explicit account link.', 422);
                statements.push(this.stmt('INSERT INTO crm_contact_accounts(org_id,contact_id,account_id,linked_by,linked_at) VALUES(?,?,?,?,?) ON CONFLICT(org_id,account_id) DO UPDATE SET linked_at=excluded.linked_at WHERE crm_contact_accounts.contact_id=excluded.contact_id', actor.orgId, contactId, options.accountId, 'canonical_proof', at), this.guard());
            }
            const reasons: CrmScoreReason[] = [{ code: 'declared_interest', label: 'Explicit interest provided', points: interest ? 10 : 0 }, { code: `kind_${input.kind}`, label: 'Requested learning category', points: input.kind === 'general' ? 0 : 10 }];
            const score = reasons.reduce((n, r) => n + r.points, 0), attribution = JSON.stringify(input.attribution ?? {});
            if (old) {
                const scoped = scope(actor);
                statements.push(this.stmt(`UPDATE crm_leads AS l SET last_attribution=?,updated_at=?,version=version+1,account_id=COALESCE(account_id,?) WHERE org_id=? AND id=?${scoped.sql}`, attribution, at, options.accountId ?? null, actor.orgId, leadId, ...scoped.values), this.guard());
            }
            else
                statements.push(this.stmt('INSERT INTO crm_leads(org_id,id,contact_id,account_id,kind,interest,source,score,score_reasons,owner_account_id,first_attribution,last_attribution,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', actor.orgId, leadId, contactId, options.accountId ?? null, input.kind, interest, source, score, JSON.stringify(reasons), owner, attribution, attribution, at, at));
            if (input.phone && contact?.phone && input.phone !== contact.phone)
                statements.push(this.stmt('INSERT OR IGNORE INTO crm_contact_conflicts VALUES(?,?,?,?,?,?)', actor.orgId, id(), contactId, 'phone_conflict', await hash(input.phone), at));
            if (input.phone) {
                const shared = await this.stmt('SELECT id FROM crm_contacts WHERE org_id=? AND phone=? AND id<>? LIMIT 1', actor.orgId, input.phone, contactId).first();
                if (shared)
                    statements.push(this.stmt('INSERT OR IGNORE INTO crm_contact_conflicts VALUES(?,?,?,?,?,?)', actor.orgId, id(), contactId, 'shared_phone', await hash(input.phone), at));
            }
            for (const [channel, purpose, requested, value] of [
                ['email', 'service', input.consent.service, input.email], ['email', 'marketing', input.consent.marketing, input.email],
                ['whatsapp', 'service', input.consent.service, input.phone], ['whatsapp', 'marketing', input.consent.whatsapp, input.phone],
            ] as const) {
                if (!value)
                    continue;
                const digest = await hash(value), accountProof = Boolean(canonicalAccount?.email_verified && canonicalAccount.email.toLowerCase() === input.email), newsletterProof = Boolean(options.verifiedSource?.kind === 'newsletter' && purpose === 'marketing' && input.consent.policyVersion === '2026-10'), verified = Boolean(requested && channel === 'email' && (accountProof || newsletterProof)), proof = verified ? (accountProof ? 'canonical_account' : 'canonical_newsletter') : (options.processingProof&&purpose==='service'&&requested?'approved_source_form':'declared'), verifiedAt = verified ? (accountProof ? at : options.verifiedSource!.verifiedAt) : null;
                statements.push(this.stmt('INSERT INTO crm_consent_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', actor.orgId, id(), contactId, channel, purpose, verified ? 'verified' : 'declared', Number(requested), input.consent.policyVersion, proof, options.processingProof&&purpose==='service'?JSON.stringify(options.processingProof):(options.verifiedSource?.reference ?? actor.requestId), digest, verifiedAt, at));
                // Withdrawal is monotonic for intake. Absence of opt-in is not opt-out and
                // cannot revoke another person's existing verified contact permission.
                statements.push(this.stmt(`INSERT INTO crm_contact_permissions(org_id,contact_id,channel,purpose,state,policy_version,proof_kind,proof_reference,contact_hash,verified_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(org_id,contact_id,channel,purpose) DO UPDATE SET state=excluded.state,policy_version=excluded.policy_version,proof_kind=excluded.proof_kind,proof_reference=excluded.proof_reference,contact_hash=excluded.contact_hash,verified_at=excluded.verified_at,revision=crm_contact_permissions.revision+1,updated_at=excluded.updated_at WHERE crm_contact_permissions.state='pending' AND excluded.state='granted'`, actor.orgId, contactId, channel, purpose, verified ? 'granted' : 'pending', input.consent.policyVersion, proof, options.processingProof&&purpose==='service'?JSON.stringify(options.processingProof):(options.verifiedSource?.reference ?? actor.requestId), digest, verifiedAt, at));
            }
            const captureNote=/^(app:[a-z]+|website:[a-z_]+|app_capture|meta|linkedin|external)$/.test(source)?`Enquiry received through ${source}.`:'Enquiry received.';
            statements.push(this.stmt('INSERT INTO crm_activities VALUES(?,?,?,?,?,?,?,?)', actor.orgId, id(), leadId, 'capture', captureNote, actor.accountId, `capture:${key}`, at), this.stmt('INSERT INTO crm_outbox(org_id,id,lead_id,event_type,created_at,updated_at) VALUES(?,?,?,?,?,?)', actor.orgId, id(), leadId, 'capture', at, at));
            if (options.sourceEvent)
                statements.push(this.stmt('INSERT INTO crm_source_events VALUES(?,?,?,?,?,?)', actor.orgId, options.sourceEvent.source, options.sourceEvent.externalId, leadId, await hash(stable(request)), at));
            return { statements, result: { id: leadId } };
        });
        return this.getLead(actor, result.id);
    }
    async listStaff(actor: CrmActor): Promise<CrmStaff[]> {
        const rows = await this.stmt(`SELECT a.id accountId,a.name,a.email,s.actor_id actorId,s.actor_role actorRole FROM live_core_staff_links s JOIN learner_accounts a ON a.id=s.learner_account_id WHERE s.org_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND lower(s.actor_email)=lower(a.email)`, actor.orgId, now()).all<Row>();
        const out: CrmStaff[] = [];
        for (const row of rows.results) {
            const functional = await this.stmt('SELECT functional_role role FROM webinar_erp_roles WHERE org_id=? AND actor_id=?', actor.orgId, row.actorId).all<{
                role: string;
            }>();
            const roles = [row.actorRole, ...functional.results.map(r => r.role)];
            if (roles.some(r => ['owner', 'admin', 'manager', 'operations', 'academic_admin', 'coordinator', 'sales', 'crm', 'assistant'].includes(r)))
                out.push({ accountId: row.accountId, name: row.name, email: row.email, roles });
        }
        return out;
    }
    private async staff(actor: CrmActor, accountId: string) {
        const member=(await this.listStaff(actor)).find(s=>s.accountId===accountId);
        if(!member)throw new ApiError('crm_assignment_invalid','Assign a current CRM team member.',422);
        return member;
    }
    private taskScopeGuard(actor:CrmActor,record:CrmLead,assignee:string){
        const scoped=scope(actor);
        return this.stmt(`INSERT INTO crm_command_guards(id,satisfied) SELECT 'atomic-task-scope',CASE WHEN EXISTS(SELECT 1 FROM crm_leads l WHERE l.org_id=? AND l.id=? AND l.version=? AND l.owner_account_id IS ? AND (l.owner_account_id=? OR ${currentManager('l.org_id','?')})${scoped.sql}) THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET satisfied=excluded.satisfied`,actor.orgId,record.id,record.version,record.ownerAccountId,assignee,assignee,now(),...scoped.values);
    }

    async updateLead(actor: CrmActor, leadId: string, raw: CrmLeadPatchInput, key: string) {
        const input = crmLeadPatchSchema.parse(raw);
        const result = await this.command(actor, key, 'lead_update', { leadId, input }, async () => {
            const old = await this.getLead(actor, leadId);
            if (input.ownerAccountId)
                await this.staff(actor, input.ownerAccountId);
            if (old.version !== input.expectedVersion)
                throw conflict();
            const at = now(), s = scope(actor);
            const ownershipChange=input.ownerAccountId!==undefined&&input.ownerAccountId!==old.ownerAccountId;
            const scopedTasks=`org_id=? AND lead_id=? AND status='open' AND NOT ${currentManager('crm_tasks.org_id','crm_tasks.assigned_account_id')}`;
            if(ownershipChange&&input.ownerAccountId===null&&await this.stmt(`SELECT 1 FROM crm_tasks WHERE ${scopedTasks} LIMIT 1`,actor.orgId,leadId,at).first())throw new ApiError('crm_open_tasks_need_owner','Close open tasks or assign them to a CRM manager before removing the lead owner.',422);
            const statements = [this.stmt(`UPDATE crm_leads AS l SET stage=?,owner_account_id=?,interest=?,version=version+1,updated_at=? WHERE org_id=? AND id=? AND version=?${s.sql}`, input.stage ?? old.stage, input.ownerAccountId === undefined ? old.ownerAccountId : input.ownerAccountId, input.interest ?? old.interest, at, actor.orgId, leadId, input.expectedVersion, ...s.values), this.guard()];
            if (input.ownerAccountId)
                statements.push(this.staffGuard(actor, input.ownerAccountId));
            if(ownershipChange){
                if(input.ownerAccountId){
                    statements.push(this.stmt(`UPDATE crm_tasks SET assigned_account_id=?,version=version+1,updated_at=? WHERE ${scopedTasks} AND assigned_account_id<>?`,input.ownerAccountId,at,actor.orgId,leadId,at,input.ownerAccountId));
                }else{
                    statements.push(this.stmt(`INSERT INTO crm_command_guards(id,satisfied) SELECT 'atomic-unassign-tasks',CASE WHEN EXISTS(SELECT 1 FROM crm_tasks WHERE ${scopedTasks}) THEN 0 ELSE 1 END ON CONFLICT(id) DO UPDATE SET satisfied=excluded.satisfied`,actor.orgId,leadId,at));
                }
            }
            if (input.stage && input.stage !== old.stage)
                statements.push(this.stmt('INSERT INTO crm_pipeline_history VALUES(?,?,?,?,?,?,?,?,?)', actor.orgId, id(), leadId, old.stage, input.stage, old.version, old.version + 1, actor.accountId, at), this.stmt('INSERT INTO crm_outbox(org_id,id,lead_id,event_type,created_at,updated_at) VALUES(?,?,?,?,?,?)', actor.orgId, id(), leadId, 'stage_changed', at, at));
            return { statements, result: { id: leadId } };
        });
        return this.getLead(actor, result.id);
    }
    async addActivity(actor: CrmActor, leadId: string, raw: CrmActivityInput, key: string) { const input = crmActivitySchema.parse(raw); return this.command(actor, key, 'activity_add', { leadId, input }, async () => { await this.getLead(actor, leadId); const result: CrmActivity = { id: id(), leadId, ...input, actorAccountId: actor.accountId, occurredAt: now() }, s = scope(actor); return { result, statements: [this.stmt(`INSERT INTO crm_activities SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crm_leads l WHERE l.org_id=? AND l.id=?${s.sql})`, actor.orgId, result.id, leadId, input.kind, input.note, actor.accountId, key, result.occurredAt, actor.orgId, leadId, ...s.values), this.guard(), this.stmt('INSERT INTO crm_outbox(org_id,id,lead_id,event_type,created_at,updated_at) VALUES(?,?,?,?,?,?)', actor.orgId, id(), leadId, 'activity', result.occurredAt, result.occurredAt)] }; }); }
    async getTask(actor: CrmActor, taskId: string) { const s = scope(actor); const row = await this.stmt(`${taskSelect} WHERE t.org_id=? AND t.id=?${s.sql}`, actor.orgId, taskId, ...s.values).first<CrmTask>(); if (!row)
        throw missing(); return row; }
    async listTasks(actor: CrmActor, filter: {
        status?: string;
        limit?: number;
    } = {}) { const s = scope(actor); return (await this.stmt(`${taskSelect} WHERE t.org_id=?${s.sql}${filter.status ? ' AND t.status=?' : ''} ORDER BY t.due_at,t.id LIMIT ?`, actor.orgId, ...s.values, ...(filter.status ? [filter.status] : []), Math.min(100, Math.max(1, filter.limit ?? 100))).all<CrmTask>()).results; }
    async saveTask(actor: CrmActor, leadId: string, raw: CrmTaskInput, key: string) {
        const input = crmTaskSchema.parse(raw);
        return this.command(actor, key, 'task_save', { leadId, input }, async () => {
            const record=await this.getLead(actor, leadId),assignee=await this.staff(actor,input.assignedAccountId);
            if(assignee.accountId!==record.ownerAccountId&&!assignee.roles.some(role=>managerRoles.includes(role)))throw new ApiError('crm_task_scope_invalid','Assign this task to the lead owner or a CRM manager who can open the lead.',422);
            const at = now(), old = input.taskId ? await this.getTask(actor, input.taskId) : null;
            if (old && old.leadId !== leadId)
                throw missing();
            const result: CrmTask = { id: input.taskId ?? id(), leadId, title: input.title, dueAt: input.dueAt, assignedAccountId: input.assignedAccountId, status: input.status, version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? at, updatedAt: at }, s = scope(actor);
            const statement = old ? this.stmt(`UPDATE crm_tasks SET title=?,due_at=?,assigned_account_id=?,status=?,version=version+1,updated_at=? WHERE org_id=? AND id=? AND version=? AND EXISTS(SELECT 1 FROM crm_leads l WHERE l.org_id=crm_tasks.org_id AND l.id=crm_tasks.lead_id${s.sql})`, input.title, input.dueAt, input.assignedAccountId, input.status, at, actor.orgId, result.id, input.expectedVersion, ...s.values) : this.stmt(`INSERT INTO crm_tasks(org_id,id,lead_id,title,assigned_account_id,due_at,status,version,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crm_leads l WHERE l.org_id=? AND l.id=?${s.sql})`, actor.orgId, result.id, leadId, input.title, input.assignedAccountId, input.dueAt, input.status, 1, at, at, actor.orgId, leadId, ...s.values);
            return { result, statements: [this.taskScopeGuard(actor,record,input.assignedAccountId),statement, this.guard(), this.staffGuard(actor, input.assignedAccountId)] };
        });
    }
    async summary(actor: CrmActor) { const s = scope(actor), rows = (await this.stmt(`SELECT l.stage,count(*) count FROM crm_leads l WHERE l.org_id=?${s.sql} GROUP BY l.stage`, actor.orgId, ...s.values).all<{
        stage: CrmLead['stage'];
        count: number;
    }>()).results; const open = await this.stmt(`SELECT count(*) count FROM crm_tasks t JOIN crm_leads l ON l.org_id=t.org_id AND l.id=t.lead_id WHERE t.org_id=? AND t.status='open'${s.sql}`, actor.orgId, ...s.values).first<{
        count: number;
    }>(), queued = await this.stmt(`SELECT count(*) count FROM crm_jobs j JOIN crm_leads l ON l.org_id=j.org_id AND l.id=j.lead_id WHERE j.org_id=? AND j.state='queued'${s.sql}`, actor.orgId, ...s.values).first<{
        count: number;
    }>(); return { total: rows.reduce((n, r) => n + r.count, 0), byStage: crmStages.map(stage => ({ stage, count: rows.find(r => r.stage === stage)?.count ?? 0 })), openTasks: open?.count ?? 0, queuedJobs: queued?.count ?? 0 }; }
    async auditExport(actor: CrmActor, count: number) { await this.db.batch([this.audit(actor, 'export', null, { count })]); }
    async exportLeads(actor: CrmActor, filter: CrmLeadFilter = {}) { const leads: CrmLead[] = []; let cursor: string | null = null; do {
        const page = await this.listLeads(actor, { ...filter, limit: 100, cursor: cursor ?? undefined });
        leads.push(...page.leads);
        cursor = page.nextCursor;
        if (cursor && leads.length >= 1000)
            throw new ApiError('crm_export_too_large', 'Narrow the export to at most 1,000 leads.', 422);
    } while (cursor); await this.auditExport(actor, leads.length); return { leads }; }
    private async rows(table: 'campaigns' | 'rules' | 'integrations', actor: CrmActor, entityId?: string) { const projection = table === 'campaigns' ? 'id,name,channel,purpose,template_ref templateRef,integration_id integrationId,kinds,stages,min_score minScore,enabled,version,created_at createdAt,updated_at updatedAt' : table === 'rules' ? 'id,name,type,trigger,kind,stage,points,campaign_id campaignId,task_title taskTitle,enabled,version,created_at createdAt,updated_at updatedAt' : 'id,name,provider,channel,source_ref sourceRef,enabled,version,created_at createdAt,updated_at updatedAt'; return (await this.stmt(`SELECT ${projection} FROM crm_${table} WHERE org_id=?${entityId ? ' AND id=?' : ''} ORDER BY updated_at DESC,id LIMIT 1000`, actor.orgId, ...(entityId ? [entityId] : [])).all<Row>()).results; }
    async listCampaigns(actor: CrmActor) { return (await this.rows('campaigns', actor)).map(campaign); }
    async getCampaign(actor: CrmActor, key: string) { const row = (await this.rows('campaigns', actor, key))[0]; if (!row)
        throw missing(); return campaign(row); }
    async listRules(actor: CrmActor) { return (await this.rows('rules', actor)).map(r => entity(r) as CrmRule); }
    async listIntegrations(actor: CrmActor) { return (await this.rows('integrations', actor)).map(r => entity(r) as CrmIntegration); }
    async getIntegration(actor: CrmActor, key: string) { const row = (await this.rows('integrations', actor, key))[0]; if (!row)
        throw missing(); return entity(row) as CrmIntegration; }
    private async saveEntity<T>(actor: CrmActor, key: string, table: 'campaigns' | 'rules' | 'integrations', input: Row, columns: Record<string, unknown>, map: (row: Row) => T) { return this.command(actor, key, `${table}_save`, input, async () => { const at = now(), old = input.id ? (await this.rows(table, actor, input.id))[0] : null; if (input.id && !old)
        throw missing(); if (old && old.version !== input.expectedVersion)
        throw conflict(); const entityId = input.id ?? id(), names = Object.keys(columns), values = Object.values(columns), statements = old ? [this.stmt(`UPDATE crm_${table} SET ${names.map(n => `${n}=?`).join(',')},version=version+1,updated_at=? WHERE org_id=? AND id=? AND version=?`, ...values, at, actor.orgId, entityId, input.expectedVersion), this.guard()] : [this.stmt(`INSERT INTO crm_${table}(org_id,id,${names.join(',')},version,created_at,updated_at) VALUES(${Array(names.length + 5).fill('?').join(',')})`, actor.orgId, entityId, ...values, 1, at, at)]; return { statements, result: map({ ...input, id: entityId, version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? at, updatedAt: at }) }; }); }
    async saveCampaign(actor: CrmActor, raw: CrmCampaignInput, key: string) { const i = crmCampaignSchema.parse(raw); if (i.integrationId) {
        const integration = await this.getIntegration(actor, i.integrationId);
        if (integration.provider !== 'native_notification' || integration.channel !== i.channel)
            throw new ApiError('crm_integration_invalid', 'Choose the approved delivery integration for this channel.', 422);
    } return this.saveEntity<CrmCampaign>(actor, key, 'campaigns', i, { name: i.name, channel: i.channel, purpose: i.purpose, template_ref: i.templateRef, integration_id: i.integrationId, kinds: JSON.stringify(i.kinds), stages: JSON.stringify(i.stages), min_score: i.minScore, enabled: Number(i.enabled) }, r => { const { expectedVersion, ...result } = r; return result as CrmCampaign; }); }
    async saveRule(actor: CrmActor, raw: CrmRuleInput, key: string) { const i = crmRuleSchema.parse(raw); if (i.campaignId)
        await this.getCampaign(actor, i.campaignId); return this.saveEntity<CrmRule>(actor, key, 'rules', i, { name: i.name, type: i.type, trigger: i.trigger, kind: i.kind, stage: i.stage, points: i.points, campaign_id: i.campaignId, task_title: i.taskTitle, enabled: Number(i.enabled) }, r => { const { expectedVersion, ...result } = r; return result as CrmRule; }); }
    async saveIntegration(actor: CrmActor, raw: CrmIntegrationInput, key: string) { const i = crmIntegrationSchema.parse(raw); return this.saveEntity<CrmIntegration>(actor, key, 'integrations', i, { name: i.name, provider: i.provider, channel: i.channel, source_ref: i.sourceRef, enabled: Number(i.enabled) }, r => { const { expectedVersion, ...result } = r; return result as CrmIntegration; }); }
    async eligibility(actor: CrmActor, leadId: string, channel: CrmChannel, purpose: CrmPurpose = 'marketing'): Promise<{
        eligible: boolean;
        reason: string;
        recipient?: string;
        contactHash?: string;
    }> {
        const found = await this.getLead(actor, leadId), recipient = channel === 'email' ? found.email : found.phone;
        if (!recipient)
            return { eligible: false, reason: 'missing_contact' };
        const digest = await hash(recipient), permission = await this.stmt('SELECT * FROM crm_contact_permissions WHERE org_id=? AND contact_id=? AND channel=? AND purpose=?', actor.orgId, found.contactId, channel, purpose).first<Row>();
        if (permission?.state !== 'granted' || permission.contact_hash !== digest || !permission.verified_at)
            return { eligible: false, reason: 'verified_permission_required' };
        // Every attempt re-reads canonical proof; local declaration/flags never suffice.
        let verified = false;
        if (channel === 'email' && permission.proof_kind === 'canonical_newsletter') {
            const newsletter = await this.stmt('SELECT status,verified_at FROM email_subscribers WHERE lower(email)=? LIMIT 1', recipient.toLowerCase()).first<Row>();
            verified = Boolean(newsletter?.status === 'active' && newsletter.verified_at);
        }
        else if (channel === 'email') {
            const account = await this.stmt('SELECT a.email,a.email_verified FROM learner_accounts a JOIN crm_contact_accounts c ON c.account_id=a.id WHERE c.org_id=? AND c.contact_id=? AND lower(a.email)=lower(?) LIMIT 1', actor.orgId, found.contactId,recipient).first<Row>();
            verified = Boolean(account?.email_verified && account.email.toLowerCase() === recipient.toLowerCase());
        }
        if (!verified)
            return { eligible: false, reason: 'canonical_contact_unverified' };
        const suppressed = await this.stmt('SELECT 1 FROM crm_suppressions WHERE org_id=? AND channel=? AND contact_hash=? AND purpose=?', actor.orgId, channel, digest, purpose).first();
        if (suppressed)
            return { eligible: false, reason: 'suppressed' };
        // Existing LIVE CRM and newsletter suppression remain authoritative. Missing
        // canonical tables are a deployment/preflight failure, never permission to send.
        const canonical = await this.stmt('SELECT 1 FROM live_communication_suppressions WHERE channel=? AND contact_hash=? AND purpose=?', channel, await canonicalCrmContactHash(channel, recipient), purpose).first();
        if (canonical)
            return { eligible: false, reason: 'canonical_suppressed' };
        if (channel === 'email' && await this.stmt('SELECT 1 FROM live_communication_account_suppressions s JOIN learner_accounts a ON a.id=s.account_id WHERE lower(a.email)=lower(?) AND s.purpose=?', recipient.trim(), purpose).first())
            return { eligible: false, reason: 'canonical_account_suppressed' };
        if (channel === 'email' && purpose === 'marketing') {
            const news = await this.stmt('SELECT status FROM email_subscribers WHERE lower(email)=? LIMIT 1', recipient.toLowerCase()).first<Row>();
            if (news && news.status !== 'active')
                return { eligible: false, reason: 'newsletter_withdrawn' };
        }
        return { eligible: true, reason: 'eligible', recipient, contactHash: await canonicalCrmContactHash(channel, recipient) };
    }
    private async audience(actor: CrmActor, c: CrmCampaign) {
        const scoped=scope(actor),ranked=leadSelect.replace('SELECT l.id,','SELECT row_number() OVER(PARTITION BY l.contact_id ORDER BY l.updated_at DESC,l.id DESC) audienceRank,l.id,');
        const rows=await this.stmt(`SELECT * FROM (${ranked} WHERE l.org_id=? AND l.score>=? AND (?='[]' OR l.kind IN(SELECT value FROM json_each(?))) AND (?='[]' OR l.stage IN(SELECT value FROM json_each(?)))${scoped.sql}) WHERE audienceRank=1 ORDER BY updatedAt DESC,id DESC LIMIT 101`,actor.orgId,c.minScore,JSON.stringify(c.kinds),JSON.stringify(c.kinds),JSON.stringify(c.stages),JSON.stringify(c.stages),...scoped.values).all<Row>();
        if(rows.results.length>100)throw new ApiError('crm_audience_too_large','Narrow this campaign to at most 100 contacts per reviewed batch.',422);
        return rows.results.map(row=>{const {audienceRank,...record}=row;return lead(record);});
    }
    async campaignPreview(actor: CrmActor, key: string): Promise<CrmCampaignPreview> { const c = await this.getCampaign(actor, key), reasons: Record<string, number> = {}; let eligible = 0, blocked = 0; for (const l of await this.audience(actor, c)) {
        const check = await this.eligibility(actor, l.id, c.channel, c.purpose);
        if (check.eligible)
            eligible++;
        else {
            blocked++;
            reasons[check.reason] = (reasons[check.reason] ?? 0) + 1;
        }
    } return { campaignId: key, eligible, blocked, reasons, dispatchEnabled: false }; }
    async enqueueCampaignPreview(actor: CrmActor, key: string) { return this.campaignPreview(actor, key); }
    async enqueueCampaign(actor: CrmActor, campaignId: string, key: string) { return this.command(actor, key, 'campaign_queue', { campaignId }, async () => { const c = await this.getCampaign(actor, campaignId); if (!c.enabled || !c.integrationId)
        throw new ApiError('crm_campaign_disabled', 'Enable a campaign with an approved integration first.', 409); const integration = await this.getIntegration(actor, c.integrationId); if (!integration.enabled || integration.provider !== 'native_notification' || integration.channel !== c.channel)
        throw new ApiError('crm_integration_disabled', 'The delivery integration is not enabled.', 409); let queued = 0, blocked = 0; const statements: D1Statement[] = [], at = now(); for (const l of await this.audience(actor, c)) {
        const check = await this.eligibility(actor, l.id, c.channel, c.purpose);
        if (!check.eligible) {
            blocked++;
            continue;
        }
        const existing = await this.stmt('SELECT 1 FROM crm_jobs WHERE org_id=? AND campaign_id=? AND campaign_version=? AND contact_id=? AND channel=? AND purpose=?', actor.orgId, c.id, c.version, l.contactId,c.channel,c.purpose).first();
        if (existing)
            continue;
        statements.push(this.stmt('INSERT INTO crm_jobs(org_id,id,lead_id,contact_id,campaign_id,campaign_version,integration_id,template_ref,channel,purpose,state,scheduled_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', actor.orgId, id(), l.id,l.contactId, c.id, c.version, c.integrationId, c.templateRef, c.channel, c.purpose, 'queued', at, at));
        queued++;
    } return { statements, result: { queued, blocked, dispatchEnabled: false as const } }; }); }
    async listJobs(actor: CrmActor) { const s = scope(actor); return (await this.stmt(`${jobSelect} WHERE j.org_id=?${s.sql} ORDER BY j.scheduled_at DESC,j.id LIMIT 100`, actor.orgId, ...s.values).all<CrmJob>()).results; }
    async getJob(actor: CrmActor, key: string) { const s = scope(actor); const row = await this.stmt(`${jobSelect} WHERE j.org_id=? AND j.id=?${s.sql}`, actor.orgId, key, ...s.values).first<CrmJob>(); if (!row)
        throw missing(); return row; }
    async claimJob(actor: CrmActor, key: string, leaseId: string, instant: string) { const job = await this.getJob(actor, key); if (job.state !== 'queued' || job.scheduledAt > instant)
        return null; const at = now(), scoped = scope(actor); try {
        await this.db.batch([this.stmt("UPDATE crm_jobs SET state='sending',attempts=attempts+1,lease_id=?,claimed_at=?,updated_at=? WHERE org_id=? AND id=? AND state='queued' AND scheduled_at<=? AND EXISTS(SELECT 1 FROM crm_leads l WHERE l.org_id=crm_jobs.org_id AND l.id=crm_jobs.lead_id" + scoped.sql + ")", leaseId, instant, at, actor.orgId, key, instant, ...scoped.values), this.guard(), this.stmt("INSERT INTO crm_job_attempts(org_id,id,job_id,attempt,lease_id,state,created_at) SELECT org_id,?,id,attempts,lease_id,'sending',? FROM crm_jobs WHERE org_id=? AND id=? AND lease_id=?", id(), at, actor.orgId, key, leaseId), this.audit(actor, 'job_claim', key)]);
    }
    catch {
        return null;
    } return this.getJob(actor, key); }
    async finishJob(actor: CrmActor, key: string, leaseId: string, outcome: {
        state: 'accepted' | 'failed' | 'blocked' | 'suppressed' | 'uncertain';
        providerMessageId?: string;
        nativeIntentId?: string;
        errorCode?: string;
    }) { const scoped = scope(actor); await this.db.batch([this.stmt("UPDATE crm_jobs SET state=?,provider_message_id=?,native_intent_id=?,error_code=?,updated_at=? WHERE org_id=? AND id=? AND state='sending' AND lease_id=? AND EXISTS(SELECT 1 FROM crm_leads l WHERE l.org_id=crm_jobs.org_id AND l.id=crm_jobs.lead_id" + scoped.sql + ")", outcome.state, outcome.providerMessageId ?? null, outcome.nativeIntentId ?? null, outcome.errorCode ?? null, now(), actor.orgId, key, leaseId, ...scoped.values), this.guard(), this.stmt('UPDATE crm_job_attempts SET state=?,error_code=?,provider_message_id=? WHERE org_id=? AND job_id=? AND lease_id=?', outcome.state, outcome.errorCode ?? null, outcome.providerMessageId ?? null, actor.orgId, key, leaseId), this.audit(actor, 'job_finish', key, { state: outcome.state })]); return this.getJob(actor, key); }
    async consumeWebhookNonce(actor: CrmActor, nonce: string, bodyHash = '') { const digest = await hash(nonce); try {
        await this.db.batch([this.stmt('INSERT INTO crm_webhook_nonces VALUES(?,?,?,?,?)', actor.orgId, digest, bodyHash, now(), new Date(Date.now() + 86400000).toISOString()), this.audit(actor, 'webhook_nonce', null)]);
        return true;
    }
    catch {
        if (await this.stmt('SELECT 1 FROM crm_webhook_nonces WHERE org_id=? AND nonce_sha256=?', actor.orgId, digest).first())
            throw new ApiError('crm_webhook_replay', 'This webhook request has already been consumed.', 409);
        throw new ApiError('crm_storage_unavailable', 'CRM storage is temporarily unavailable.', 503);
    } }
    async issuePreferenceToken(actor: CrmActor, leadId: string, channel: CrmChannel) { const l = await this.getLead(actor, leadId), token = Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, '0')).join(''); await this.db.batch([this.stmt('INSERT INTO crm_preference_tokens VALUES(?,?,?,?,?,?,?)', actor.orgId, await hash(token), l.contactId, channel, new Date(Date.now() + 90 * 86400000).toISOString(), null, now()), this.audit(actor, 'preference_token_issue', leadId)]); return token; }
    async withdrawPreferenceToken(actor: CrmActor, token: string) {
        const digest = await hash(token), receipt = await this.stmt('SELECT * FROM crm_preference_tokens WHERE org_id=? AND token_sha256=? AND expires_at>?', actor.orgId, digest, now()).first<Row>();
        if (!receipt)
            return { withdrawn: false };
        if (receipt.consumed_at)
            return { withdrawn: true };
        const contact = await this.stmt('SELECT email,phone FROM crm_contacts WHERE org_id=? AND id=?', actor.orgId, receipt.contact_id).first<Row>();
        const value = receipt.channel === 'email' ? contact?.email : contact?.phone;
        if (!value)
            return { withdrawn: false };
        const contactHash = await hash(value), at = now(), statements: D1Statement[] = [this.stmt('UPDATE crm_preference_tokens SET consumed_at=? WHERE org_id=? AND token_sha256=? AND consumed_at IS NULL', at, actor.orgId, digest), this.guard()];
        for (const purpose of ['service', 'marketing']) {
            const revision = id();
            statements.push(this.stmt("INSERT INTO crm_suppressions VALUES(?,?,?,?, 'unsubscribe',?,?) ON CONFLICT(org_id,channel,contact_hash,purpose) DO UPDATE SET reason=excluded.reason,revision=excluded.revision,created_at=excluded.created_at", actor.orgId, receipt.channel, contactHash, purpose, revision, at), this.stmt("INSERT INTO live_communication_suppressions(channel,contact_hash,purpose,reason,created_at,revision) VALUES(?,?,?,'unsubscribe',?,?) ON CONFLICT(channel,contact_hash,purpose) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at,revision=excluded.revision", receipt.channel, await canonicalCrmContactHash(receipt.channel, value), purpose, at, revision), this.stmt("UPDATE crm_contact_permissions SET state='withdrawn',revision=revision+1,updated_at=? WHERE org_id=? AND contact_id=? AND channel=? AND purpose=?", at, actor.orgId, receipt.contact_id, receipt.channel, purpose), this.stmt("INSERT INTO crm_consent_events VALUES(?,?,?,?,?,'withdrawn',0,'2026-10','opaque_preference',?,?,NULL,?)", actor.orgId, id(), receipt.contact_id, receipt.channel, purpose, digest, contactHash, at), this.stmt("INSERT INTO live_communication_account_suppressions(account_id,purpose,reason,created_at,revision) SELECT id,?,'unsubscribe',?,? FROM learner_accounts WHERE lower(email)=lower(?) AND ?='email' ON CONFLICT(account_id,purpose) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at,revision=excluded.revision", purpose, at, revision, value, receipt.channel));
        }
        statements.push(this.stmt("UPDATE crm_jobs SET state='suppressed',error_code='consent_withdrawn',updated_at=? WHERE org_id=? AND channel=? AND state='queued' AND lead_id IN(SELECT id FROM crm_leads WHERE org_id=? AND contact_id=?)", at, actor.orgId, receipt.channel, actor.orgId, receipt.contact_id), this.audit(actor, 'preference_withdraw', null));
        try {
            await this.db.batch(statements);
        }
        catch {
            const consumed = await this.stmt('SELECT consumed_at FROM crm_preference_tokens WHERE org_id=? AND token_sha256=?', actor.orgId, digest).first<Row>();
            if (!consumed?.consumed_at)
                throw conflict();
        }
        return { withdrawn: true };
    }
    async runRules(actor: CrmActor, leadId: string, trigger: CrmRule['trigger'], eventKey: string,options:{dueTask?:{id:string;version:number}}={}) {
        const initial = await this.getLead(actor, leadId), rules = (await this.listRules(actor)).filter(r => r.enabled && r.trigger === trigger && (!r.kind || r.kind === initial.kind) && (!r.stage || r.stage === initial.stage));
        let matched = 0;
        for (const r of rules) {
            await this.command(actor, `rule:${await hash(`${r.id}:${r.version}:${leadId}:${eventKey}`)}`, 'rule_run', { ruleId: r.id, version: r.version, leadId, eventKey, trigger }, async () => {
                const at = now(), l = await this.getLead(actor, leadId), statements: D1Statement[] = [];
                if(options.dueTask)statements.push(this.stmt(`INSERT INTO crm_command_guards(id,satisfied) SELECT 'atomic-due-task',CASE WHEN EXISTS(SELECT 1 FROM crm_tasks t JOIN crm_leads dl ON dl.org_id=t.org_id AND dl.id=t.lead_id JOIN live_core_staff_links ds ON ds.org_id=t.org_id AND ds.learner_account_id=t.assigned_account_id JOIN learner_accounts da ON da.id=ds.learner_account_id WHERE t.org_id=? AND t.id=? AND t.version=? AND t.lead_id=? AND t.status='open' AND t.origin='staff' AND t.due_at<=? AND ds.revoked_at IS NULL AND ds.expires_at>? AND lower(ds.actor_email)=lower(da.email) AND ((t.assigned_account_id=dl.owner_account_id AND EXISTS(SELECT 1 FROM webinar_erp_roles dr WHERE dr.org_id=t.org_id AND dr.actor_id=ds.actor_id AND dr.functional_role IN('sales','crm','assistant'))) OR ${currentManager('t.org_id','t.assigned_account_id')})) THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET satisfied=excluded.satisfied`,actor.orgId,options.dueTask.id,options.dueTask.version,leadId,at,at,at));
                let state = 'matched';
                if (r.type === 'score') {
                    const base = l.scoreReasons.filter(reason => reason.code !== `rule:${r.id}`), reasons = [...base, { code: `rule:${r.id}`, label: r.name, points: r.points }], score = Math.min(100, Math.max(0, reasons.reduce((n, item) => n + item.points, 0)));
                    statements.push(this.stmt('UPDATE crm_leads SET score=?,score_reasons=?,version=version+1,updated_at=? WHERE org_id=? AND id=? AND version=?', score, JSON.stringify(reasons), at, actor.orgId, leadId, l.version), this.guard());
                }
                if (r.taskTitle && l.ownerAccountId) {
                    await this.staff(actor, l.ownerAccountId);
                    // Check task scope before any score/version change in this atomic rule run.
                    statements.unshift(this.taskScopeGuard(actor,l,l.ownerAccountId));
                    statements.push(this.staffGuard(actor, l.ownerAccountId), this.stmt("INSERT INTO crm_tasks(org_id,id,lead_id,title,assigned_account_id,due_at,status,version,created_at,updated_at,origin) VALUES(?,?,?,?,?,?,'open',1,?,?,'automation')", actor.orgId, id(), leadId, r.taskTitle, l.ownerAccountId, at, at, at));
                }
                if (r.type === 'automation' && r.campaignId) {
                    const c = await this.getCampaign(actor, r.campaignId), integration = c.integrationId ? await this.getIntegration(actor, c.integrationId) : null;
                    const allowed = c.enabled && integration?.enabled && integration.provider === 'native_notification' && integration.channel === c.channel && (!c.kinds.length || c.kinds.includes(l.kind)) && (!c.stages.length || c.stages.includes(l.stage)) && l.score >= c.minScore;
                    const permission = allowed ? await this.eligibility(actor, leadId, c.channel, c.purpose) : { eligible: false };
                    if (allowed && permission.eligible) {
                        statements.push(this.stmt("INSERT INTO crm_jobs(org_id,id,lead_id,contact_id,campaign_id,campaign_version,integration_id,template_ref,channel,purpose,state,scheduled_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT(org_id,campaign_id,campaign_version,contact_id,channel,purpose) DO NOTHING", actor.orgId, id(), leadId,l.contactId, c.id, c.version, c.integrationId, c.templateRef, c.channel, c.purpose, at, at));
                        state = 'queued';
                    }
                    else
                        state = 'blocked';
                }
                statements.push(this.stmt('INSERT INTO crm_rule_runs VALUES(?,?,?,?,?,?,?)', actor.orgId, r.id, r.version, eventKey, leadId, state, at), this.stmt('INSERT INTO crm_activities VALUES(?,?,?,?,?,?,?,?)', actor.orgId, id(), leadId, 'automation', state === 'queued' ? 'Approved follow-up queued for current permission checks.' : state === 'blocked' ? 'Follow-up blocked by current permission or configuration.' : 'CRM automation evaluated.', actor.accountId, `rule:${r.id}:${r.version}:${eventKey}`, at));
                return { statements, result: { matched: true } };
            });
            matched++;
        }
        return { matched, dispatchEnabled: false as const };
    }
    /** Only transient receipts expire automatically. Contact deletion, consent
     * evidence and legal retention require a separate authorized privacy workflow. */
    async purgeExpiredTransientRecords(actor: CrmActor, instant = now()) {
        const statements = ['crm_commands', 'crm_webhook_nonces', 'crm_preference_tokens'].map(table => this.stmt(`DELETE FROM ${table} WHERE org_id=? AND rowid IN(SELECT rowid FROM ${table} WHERE org_id=? AND expires_at<? LIMIT 100)`, actor.orgId, actor.orgId, instant));
        const results = await this.db.batch([...statements, this.audit(actor, 'transient_retention', null)]);
        return { removed: results.slice(0, 3).reduce((n, result) => n + result.meta.changes, 0) };
    }
}
