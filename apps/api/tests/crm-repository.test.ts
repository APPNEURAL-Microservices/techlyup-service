import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './fixture';
import { CrmRepository, canonicalCrmContactHash, type CrmActor } from '../src/crm/repository';
import { hash } from '../src/auth/crypto';
import { crmCaptureSchema, crmPublicCaptureSchema, crmRuleSchema } from '@techlyup/contracts';
const actor: CrmActor = { orgId: 'appneural', accountId: null, requestId: 'synthetic-crm-test' };
const input = { name: 'Synthetic Prospect', email: 'prospect@example.test', phone: '+919000000001', kind: 'course' as const, interest: 'TypeScript', source: 'test', consent: { service: true, marketing: true, whatsapp: false, policyVersion: '2026-10' as const } };
function setup() { const f = fixture(); f.sqlite.exec(readFileSync(new URL('./fixtures/canonical-crm.sql', import.meta.url), 'utf8')); if (!f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='crm_contacts'").get())
    f.sqlite.exec(readFileSync(new URL('../../../migrations/d1/0048_crm_acquisition.sql', import.meta.url), 'utf8')); return { ...f, repo: new CrmRepository(f.db) }; }
function staff(f: ReturnType<typeof setup>, account = 'staff-one', role = 'manager') {
    const at = new Date().toISOString();
    f.sqlite.prepare("INSERT INTO learner_accounts(id,email,name,password_hash,consent_version,created_at,updated_at,email_verified) VALUES(?,?,?,'synthetic-unused','2026-10',?,?,1)").run(account, `${account}@example.test`, account, at, at);
    f.sqlite.prepare("INSERT INTO live_core_staff_links VALUES(?,?,?,?,?,?,?,NULL,'synthetic',?,?)").run(account, actor.orgId, `erp-${account}`, role, `${account}@example.test`, account, '2099-01-01T00:00:00.000Z', at, at);
    return { ...actor, accountId: account };
}
async function verified(f: ReturnType<typeof setup>, key = 'newsletter-verified') {
    const at = new Date().toISOString();
    f.sqlite.prepare('INSERT INTO email_subscribers(email,name,status,unsubscribe_token,consent_at,verified_at,last_requested_at) VALUES(?,?,?,?,?,?,?)').run(input.email, input.name, 'active', 'synthetic-token', at, at, at);
    return f.repo.capture(actor, input, key, { verifiedSource: { kind: 'newsletter', reference: 'newsletter:synthetic-proof', verifiedAt: at } });
}
async function campaign(f: ReturnType<typeof setup>) { const integration = await f.repo.saveIntegration(actor, { name: 'Approved notification', provider: 'native_notification', channel: 'email', sourceRef: 'operator-approved', enabled: true }, 'integration-create'); return f.repo.saveCampaign(actor, { name: 'Explicit course follow-up', channel: 'email', templateRef: 'APPROVED_TYPE', integrationId: integration.id, enabled: true }, 'campaign-create'); }
test('strict capture rejects identity/verification claims and requires current public policy and separate WhatsApp opt-in', () => {
    assert.equal(crmCaptureSchema.safeParse({ ...input, accountId: 'someone' }).success, false);
    assert.equal(crmPublicCaptureSchema.safeParse({ ...input, consent: { ...input.consent, policyVersion: '2026-09' } }).success, false);
    assert.equal(crmCaptureSchema.parse({ ...input, consent: { service: true, marketing: true, policyVersion: '2026-10' } }).consent.whatsapp, false);
    assert.equal(crmRuleSchema.parse({ name: 'Post event follow-up', type: 'automation', trigger: 'post_event' }).trigger, 'post_event');
});
test('email dedupe, attribution, append-only declarations and idempotency preserve first contact', async () => {
    const f = setup();
    try {
        const one = await f.repo.capture(actor, input, 'capture-one');
        const again = await f.repo.capture(actor, input, 'capture-one');
        assert.equal(one.id, again.id);
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_consent_events').get()!.n, 4);
        const two = await f.repo.capture(actor, { ...input, name: 'Spoofed', phone: '+919999999999', attribution: { source: 'second' } }, 'capture-two');
        assert.equal(two.id, one.id);
        assert.equal(two.name, input.name);
        assert.equal(two.phone, input.phone);
        assert.equal(two.version, 2);
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contacts').get()!.n, 1);
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contact_conflicts').get()!.n, 1);
        assert.equal((await f.repo.eligibility(actor, one.id, 'email')).eligible, false);
        await assert.rejects(() => f.repo.capture(actor, { ...input, kind: 'career' }, 'capture-one'), { code: 'crm_idempotency_conflict' });
        assert.throws(() => f.sqlite.exec("UPDATE crm_consent_events SET requested=0"), /IMMUTABLE/);
        assert.throws(() => f.sqlite.exec('DELETE FROM crm_audit_events'), /IMMUTABLE/);
    }
    finally {
        f.close();
    }
});
test('phone never merges contacts; source event exact replay is once and mismatch fails', async () => {
    const f = setup();
    try {
        const one = await f.repo.capture(actor, { ...input, email: undefined }, 'phone-capture-one');
        const two = await f.repo.capture(actor, { ...input, email: undefined }, 'phone-capture-two');
        assert.notEqual(one.contactId, two.contactId);
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contact_conflicts').get()!.n, 1);
        const options = { sourceEvent: { source: 'canonical', externalId: 'stable-source-event' } };
        const a = await f.repo.capture(actor, input, 'source-key-one', options);
        const b = await f.repo.capture(actor, input, 'source-key-two', options);
        assert.equal(a.id, b.id);
        await assert.rejects(() => f.repo.capture(actor, { ...input, interest: 'Other' }, 'source-key-three', options), { status: 409 });
    }
    finally {
        f.close();
    }
});
test('capture cannot infer canonical identity or link an authenticated foreign contact', async () => {
    const f = setup();
    try {
        const admin = staff(f);
        const unlinked = await f.repo.capture(actor, { ...input, email: 'staff-one@example.test' }, 'no-email-identity');
        assert.equal(unlinked.accountId, null);
        await assert.rejects(() => f.repo.capture(admin, input, 'foreign-explicit-proof', { accountId: admin.accountId! }), { code: 'crm_account_contact_mismatch' });
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contact_accounts').get()!.n, 0);
    }
    finally {
        f.close();
    }
});
test('tenant scope, owner scope, current staff assignments and version CAS apply to reads and writes', async () => {
    const f = setup();
    try {
        const manager = staff(f), seller = staff(f, 'staff-two', 'member');
        f.sqlite.prepare("INSERT INTO webinar_erp_roles VALUES(?,?,'sales',?)").run(actor.orgId, 'erp-staff-two', new Date().toISOString());
        const found = await f.repo.capture(actor, input, 'cas-capture');
        const assigned = await f.repo.updateLead(manager, found.id, { expectedVersion: 1, ownerAccountId: seller.accountId }, 'assign-once');
        assert.equal(assigned.version, 2);
        const restricted = { ...seller, ownerOnly: true };
        assert.equal((await f.repo.detail(restricted, found.id)).lead.id, found.id);
        await assert.rejects(() => f.repo.detail({ ...restricted, orgId: 'other' }, found.id), { status: 404 });
        await assert.rejects(() => f.repo.updateLead(manager, found.id, { expectedVersion: 1, stage: 'won' }, 'stale-stage-key'), { status: 409 });
        await f.repo.updateLead(manager, found.id, { expectedVersion: 2, stage: 'qualified' }, 'qualify-stage-key');
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_pipeline_history').get()!.n, 1);
        const task = await f.repo.saveTask(manager, found.id, { title: 'Call prospect', dueAt: '2026-12-01T00:00:00.000Z', assignedAccountId: seller.accountId! }, 'task-create-key');
        assert.equal((await f.repo.listTasks(restricted)).length, 1);
        await assert.rejects(() => f.repo.saveTask(manager, found.id, { ...task, taskId: task.id, expectedVersion: 2 } as any, 'task-stale-key')); // strict DTO cannot enter write body
        await f.repo.saveTask(manager, found.id, { taskId: task.id, title: task.title, dueAt: task.dueAt, assignedAccountId: task.assignedAccountId, expectedVersion: 1, status: 'done' }, 'task-done-key');
        f.sqlite.prepare('UPDATE live_core_staff_links SET revoked_at=? WHERE learner_account_id=?').run(new Date().toISOString(), seller.accountId);
        await assert.rejects(() => f.repo.updateLead(manager, found.id, { expectedVersion: 3, ownerAccountId: seller.accountId }, 'assign-revoked-key'), { code: 'crm_assignment_invalid' });
    }
    finally {
        f.close();
    }
});
test('audit failure rolls back contact, event, command receipt and retry remains safe', async () => {
    const f = setup();
    try {
        f.sqlite.exec("CREATE TRIGGER synthetic_crm_audit_failure BEFORE INSERT ON crm_audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
        await assert.rejects(() => f.repo.capture(actor, input, 'atomic-capture-key'));
        for (const table of ['crm_contacts', 'crm_leads', 'crm_consent_events', 'crm_commands'])
            assert.equal(f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
        f.sqlite.exec('DROP TRIGGER synthetic_crm_audit_failure');
        await f.repo.capture(actor, input, 'atomic-capture-key');
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_leads').get()!.n, 1);
    }
    finally {
        f.close();
    }
});
test('verified newsletter permission is freshly checked against canonical unsubscribe and suppression', async () => {
    const f = setup();
    try {
        const l = await verified(f);
        assert.equal((await f.repo.eligibility(actor, l.id, 'email')).eligible, true);
        assert.equal((await f.repo.eligibility(actor, l.id, 'whatsapp')).eligible, false);
        f.sqlite.prepare("UPDATE email_subscribers SET status='unsubscribed'").run();
        assert.equal((await f.repo.eligibility(actor, l.id, 'email')).eligible, false);
        f.sqlite.prepare("UPDATE email_subscribers SET status='active'").run();
        f.sqlite.prepare('INSERT INTO live_communication_suppressions VALUES(?,?,?,?,?,?)').run('email', await canonicalCrmContactHash('email', input.email), 'marketing', 'complaint', new Date().toISOString(), 'synthetic-rev');
        assert.equal((await f.repo.eligibility(actor, l.id, 'email')).reason, 'canonical_suppressed');
    }
    finally {
        f.close();
    }
});
test('queue is idempotent, has immutable snapshot and job lease never retries an uncertain send', async () => {
    const f = setup();
    try {
        const l = await verified(f), c = await campaign(f);
        assert.equal((await f.repo.enqueueCampaignPreview(actor, c.id)).eligible, 1);
        assert.deepEqual(await f.repo.enqueueCampaign(actor, c.id, 'campaign-queue-key'), { queued: 1, blocked: 0, dispatchEnabled: false });
        assert.equal((await f.repo.enqueueCampaign(actor, c.id, 'campaign-queue-key')).queued, 1);
        assert.equal((await f.repo.enqueueCampaign(actor, c.id, 'campaign-other-key')).queued, 0);
        const job = (await f.repo.listJobs(actor))[0];
        assert.equal(job.templateRef, 'APPROVED_TYPE');
        const claimed = await f.repo.claimJob(actor, job.id, 'lease-one', new Date().toISOString());
        assert.equal(claimed?.attempts, 1);
        assert.equal(await f.repo.claimJob(actor, job.id, 'lease-two', new Date().toISOString()), null);
        await assert.rejects(() => f.repo.finishJob(actor, job.id, 'lease-two', { state: 'accepted' }));
        await f.repo.finishJob(actor, job.id, 'lease-one', { state: 'uncertain', errorCode: 'unknown' });
        assert.equal(await f.repo.claimJob(actor, job.id, 'lease-three', new Date().toISOString()), null);
        assert.equal((await f.repo.getJob(actor, job.id)).leadId, l.id);
    }
    finally {
        f.close();
    }
});
test('opaque preference withdrawal blocks all purposes, legacy delivery and future duplicate intake', async () => {
    const f = setup();
    try {
        const l = await verified(f), c = await campaign(f);
        await f.repo.enqueueCampaign(actor, c.id, 'withdraw-queue-key');
        const token = await f.repo.issuePreferenceToken(actor, l.id, 'email');
        assert.equal(f.sqlite.prepare('SELECT token_sha256 FROM crm_preference_tokens').get()!.token_sha256, await hash(token));
        assert.deepEqual(await f.repo.withdrawPreferenceToken(actor, 'unknown'), { withdrawn: false });
        assert.deepEqual(await f.repo.withdrawPreferenceToken(actor, token), { withdrawn: true });
        assert.deepEqual(await f.repo.withdrawPreferenceToken(actor, token), { withdrawn: true });
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM live_communication_suppressions').get()!.n, 2);
        assert.equal((await f.repo.listJobs(actor))[0].state, 'suppressed');
        await f.repo.capture(actor, input, 'capture-after-withdraw', { verifiedSource: { kind: 'newsletter', reference: 'newsletter:again', verifiedAt: new Date().toISOString() } });
        assert.equal((await f.repo.detail(actor, l.id)).consents.find(x => x.channel === 'email' && x.purpose === 'marketing')?.state, 'withdrawn');
        assert.equal((await f.repo.eligibility(actor, l.id, 'email')).eligible, false);
    }
    finally {
        f.close();
    }
});
test('rule runs persist explanations, task and in-app notification once for explicit source events', async () => {
    const f = setup();
    try {
        const manager = staff(f), l = await f.repo.capture(actor, input, 'rules-capture-key');
        const assigned = await f.repo.updateLead(manager, l.id, { expectedVersion: l.version, ownerAccountId: manager.accountId }, 'rules-owner-key');
        await f.repo.saveRule(manager, { name: 'Career category interest', type: 'score', trigger: 'capture', points: 25, enabled: true }, 'score-rule-create');
        await f.repo.saveRule(manager, { name: 'Post webinar follow-up', type: 'automation', trigger: 'post_event', taskTitle: 'Review follow-up', enabled: true }, 'automation-rule-create');
        await f.repo.runRules(manager, l.id, 'capture', 'canonical-event-one');
        await f.repo.runRules(manager, l.id, 'capture', 'canonical-event-one');
        assert.equal((await f.repo.detail(manager, l.id)).lead.score, assigned.score + 25);
        await f.repo.runRules(manager, l.id, 'post_event', 'canonical-event-two');
        await f.repo.runRules(manager, l.id, 'post_event', 'canonical-event-two');
        assert.equal((await f.repo.detail(manager, l.id)).tasks.length, 1);
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n, 2);
        assert.equal((await f.repo.listJobs(manager)).length, 0);
    }
    finally {
        f.close();
    }
});
test('webhook nonces are hashed and one-shot; exports are bounded, scoped and audited', async () => {
    const f = setup();
    try {
        await f.repo.consumeWebhookNonce(actor, 'synthetic-webhook-nonce');
        await assert.rejects(() => f.repo.consumeWebhookNonce(actor, 'synthetic-webhook-nonce'), { code: 'crm_webhook_replay' });
        assert.notEqual(f.sqlite.prepare('SELECT nonce_sha256 FROM crm_webhook_nonces').get()!.nonce_sha256, 'synthetic-webhook-nonce');
        await f.repo.capture(actor, input, 'export-capture-key');
        assert.equal((await f.repo.exportLeads({ ...actor, orgId: 'other' })).leads.length, 0);
        assert.equal((await f.repo.exportLeads(actor)).leads.length, 1);
        assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_audit_events WHERE action='export'").get()!.n, 2);
    }
    finally {
        f.close();
    }
});
test('canonical suppression digest matches the existing website function and unlinked account veto is negative-only', async () => {
    assert.equal(await canonicalCrmContactHash('email', '  Prospect@Example.Test  '), 'c528c358acd7eecc8261bcc76c2abc42176253566d19da40c6ccfee31c698d81');
    const f = setup();
    try {
        const account = staff(f, 'prospect');
        f.sqlite.prepare('UPDATE learner_accounts SET email=? WHERE id=?').run(input.email, account.accountId);
        const l = await verified(f);
        assert.equal(l.accountId, null);
        assert.equal((await f.repo.eligibility(actor, l.id, 'email')).contactHash, await canonicalCrmContactHash('email', input.email));
        f.sqlite.prepare('INSERT INTO live_communication_account_suppressions VALUES(?,?,?,?,?)').run(account.accountId, 'marketing', 'old opt-out', new Date().toISOString(), 'canonical-rev');
        assert.equal((await f.repo.eligibility(actor, l.id, 'email')).reason, 'canonical_account_suppressed');
        assert.equal((await f.repo.detail(actor, l.id)).lead.accountId, null);
    }
    finally {
        f.close();
    }
});
test('unversioned legacy newsletter proof does not invent broader marketing permission', async () => {
    const f = setup();
    try {
        const at = new Date().toISOString();
        f.sqlite.prepare('INSERT INTO email_subscribers(email,name,status,unsubscribe_token,consent_at,verified_at,last_requested_at) VALUES(?,?,?,?,?,?,?)').run(input.email, input.name, 'active', 'legacy-synthetic-token', at, at, at);
        const l = await f.repo.capture(actor, { ...input, consent: { service: false, marketing: false, whatsapp: false, policyVersion: 'legacy-newsletter-unversioned' } }, 'legacy-newsletter-capture', { verifiedSource: { kind: 'newsletter', reference: 'legacy:synthetic', verifiedAt: at } });
        assert.equal((await f.repo.eligibility(actor, l.id, 'email')).eligible, false);
        assert.ok((await f.repo.detail(actor, l.id)).consents.every(c => c.state === 'pending'));
        assert.equal(crmPublicCaptureSchema.safeParse({ ...input, consent: { ...input.consent, policyVersion: 'legacy-newsletter-unversioned' } }).success, false);
    }
    finally {
        f.close();
    }
});
test('ownership transfer and current staff revocation between read and atomic mutation fail closed', async () => {
    const f = setup();
    try {
        const manager = staff(f), l = await f.repo.capture(actor, input, 'race-capture-key');
        await f.repo.updateLead(manager, l.id, { expectedVersion: l.version, ownerAccountId: manager.accountId }, 'race-owner-key');
        let armed = true;
        const transferRepo = new CrmRepository({ ...f.db, async batch(statements) { if (armed) {
                armed = false;
                f.sqlite.prepare('UPDATE crm_leads SET owner_account_id=NULL WHERE org_id=? AND id=?').run(actor.orgId, l.id);
            } return f.db.batch(statements); } });
        await assert.rejects(() => transferRepo.addActivity({ ...manager, ownerOnly: true }, l.id, { kind: 'note', note: 'Must not persist after transfer' }, 'race-activity-key'), { status: 409 });
        assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_activities WHERE kind='note'").get()!.n, 0);
        let revoke = true;
        const revokeRepo = new CrmRepository({ ...f.db, async batch(statements) { if (revoke) {
                revoke = false;
                f.sqlite.prepare('UPDATE live_core_staff_links SET revoked_at=?').run(new Date().toISOString());
            } return f.db.batch(statements); } });
        await assert.rejects(() => revokeRepo.saveTask(manager, l.id, { title: 'Must roll back after revocation', dueAt: '2026-12-01T00:00:00.000Z', assignedAccountId: manager.accountId! }, 'race-task-key'), { status: 409 });
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_tasks').get()!.n, 0);
    }
    finally {
        f.close();
    }
});
test('multiple score rules preserve explanations and approved follow-ups queue only with fresh consent', async () => {
    const f = setup();
    try {
        const l = await verified(f), c = await campaign(f);
        for (const [name, points, key] of [['First explicit interest', 15, 'score-first-key'], ['Second explicit interest', 20, 'score-second-key']] as const)
            await f.repo.saveRule(actor, { name, type: 'score', trigger: 'capture', points, enabled: true }, key);
        await f.repo.runRules(actor, l.id, 'capture', 'scoring-event');
        assert.equal((await f.repo.detail(actor, l.id)).lead.score, l.score + 35);
        assert.equal((await f.repo.detail(actor, l.id)).lead.scoreReasons.filter(r => r.code.startsWith('rule:')).length, 2);
        await f.repo.saveRule(actor, { name: 'Approved post event follow-up', type: 'automation', trigger: 'post_event', campaignId: c.id, enabled: true }, 'followup-rule-key');
        await f.repo.runRules(actor, l.id, 'post_event', 'proven-attendance-event');
        assert.equal((await f.repo.listJobs(actor)).length, 1);
        await f.repo.runRules(actor, l.id, 'post_event', 'proven-attendance-event');
        assert.equal((await f.repo.listJobs(actor)).length, 1);
        const token = await f.repo.issuePreferenceToken(actor, l.id, 'email');
        await f.repo.withdrawPreferenceToken(actor, token);
        await f.repo.runRules(actor, l.id, 'post_event', 'second-proven-event');
        assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_rule_runs WHERE state='blocked'").get()!.n, 1);
        assert.equal((await f.repo.listJobs(actor))[0].state, 'suppressed');
    }
    finally {
        f.close();
    }
});
test('transient retention is tenant-scoped and retains append-only consent/audit evidence', async () => {
    const f = setup();
    try {
        const l = await f.repo.capture(actor, input, 'retention-capture-key');
        await f.repo.consumeWebhookNonce(actor, 'retention-test-nonce');
        await f.repo.issuePreferenceToken(actor, l.id, 'email');
        const removed = await f.repo.purgeExpiredTransientRecords({ ...actor, orgId: 'other' }, '2099-01-01T00:00:00.000Z');
        assert.equal(removed.removed, 0);
        assert.equal((await f.repo.purgeExpiredTransientRecords(actor, '2099-01-01T00:00:00.000Z')).removed, 3);
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_leads').get()!.n, 1);
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_consent_events').get()!.n, 4);
    }
    finally {
        f.close();
    }
});
test('reviewed campaign batches are bounded, filters apply before the limit, and job intentions are immutable', async () => {
    const f = setup();
    try {
        const l = await verified(f), c = await campaign(f);
        await f.repo.enqueueCampaign(actor, c.id, 'immutable-queue-key');
        assert.throws(() => f.sqlite.exec("UPDATE crm_jobs SET template_ref='UNAPPROVED'"), /IMMUTABLE/);
        const at = new Date().toISOString();
        const insert = f.sqlite.prepare("INSERT INTO crm_leads(org_id,id,contact_id,kind,interest,source,created_at,updated_at) VALUES(?,?,?,'career',?,'synthetic',?,?)");
        for (let n = 0; n < 101; n++){
            f.sqlite.prepare('INSERT INTO crm_contacts(org_id,id,email,created_at) VALUES(?,?,?,?)').run(actor.orgId,`bounded-contact-${n}`,`bounded-${n}@example.test`,at);
            insert.run(actor.orgId, `bounded-${n}`, `bounded-contact-${n}`, `Career ${n}`, at, at);
        }
        const filtered = await f.repo.saveCampaign(actor, { name: 'Only course category', channel: 'email', templateRef: 'APPROVED_TYPE', integrationId: c.integrationId, enabled: true, kinds: ['course'] }, 'filtered-campaign-key');
        assert.equal((await f.repo.campaignPreview(actor, filtered.id)).eligible, 1);
        await assert.rejects(() => f.repo.campaignPreview(actor, c.id), { code: 'crm_audience_too_large' });
        assert.equal((await f.repo.listLeads(actor, { q: '%' })).leads.length, 0);
    }
    finally {
        f.close();
    }
});
test('failed nonce audit is unavailable, consumes nothing and allows a safe later retry', async () => {
    const f = setup();
    try {
        f.sqlite.exec("CREATE TRIGGER synthetic_nonce_failure BEFORE INSERT ON crm_audit_events BEGIN SELECT RAISE(ABORT,'synthetic nonce audit failure'); END;");
        await assert.rejects(() => f.repo.consumeWebhookNonce(actor, 'audit-nonce-test'), { code: 'crm_storage_unavailable', status: 503 });
        assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_webhook_nonces').get()!.n, 0);
        f.sqlite.exec('DROP TRIGGER synthetic_nonce_failure');
        assert.equal(await f.repo.consumeWebhookNonce(actor, 'audit-nonce-test'), true);
        await assert.rejects(() => f.repo.consumeWebhookNonce(actor, 'audit-nonce-test'), { code: 'crm_webhook_replay' });
    }
    finally {
        f.close();
    }
});

test('public contact processing requires explicit current notice and approved relays retain purpose-specific evidence only', async()=>{
 assert.equal(crmPublicCaptureSchema.safeParse({...input,consent:{...input.consent,service:false}}).success,false);
 const f=setup();try{
  const processingProof={sourceRef:'approved-form',externalId:'signed-form-event',policyVersion:'2026-10' as const,occurredAt:new Date().toISOString()},sourceEvent={source:'external:approved-form',externalId:'signed-form-event'};
  const l=await f.repo.capture(actor,{...input,consent:{service:true,marketing:false,whatsapp:false,policyVersion:'2026-10'}},'approved-form-capture',{sourceEvent,processingProof});
  const evidence=f.sqlite.prepare("SELECT proof_kind,proof_reference,decision FROM crm_consent_events WHERE contact_id=? AND channel='email' AND purpose='service'").get(l.contactId)!;
  assert.equal(evidence.proof_kind,'approved_source_form');assert.deepEqual(JSON.parse(String(evidence.proof_reference)),processingProof);assert.equal(evidence.decision,'declared');
  assert.equal((await f.repo.eligibility(actor,l.id,'email','service')).eligible,false);assert.equal((await f.repo.eligibility(actor,l.id,'email','marketing')).eligible,false);
  await assert.rejects(()=>f.repo.capture(actor,input,'invalid-form-proof',{sourceEvent,processingProof:{...processingProof,externalId:'different-event'}}),{code:'crm_processing_proof_invalid'});
 }finally{f.close();}
});

test('tasks require a current lead owner or global CRM manager without granting contact access',async()=>{
 const f=setup();try{
  const manager=staff(f),owner=staff(f,'task-owner','member'),other=staff(f,'task-other','member');
  for(const member of [owner,other])f.sqlite.prepare("INSERT INTO webinar_erp_roles VALUES(?,?,'sales',?)").run(actor.orgId,`erp-${member.accountId}`,new Date().toISOString());
  const l=await f.repo.capture(actor,input,'task-scope-capture');const assigned=await f.repo.updateLead(manager,l.id,{expectedVersion:l.version,ownerAccountId:owner.accountId},'task-scope-owner');
  const taskInput={title:'Scope checked follow-up',dueAt:'2026-12-01T00:00:00.000Z',assignedAccountId:other.accountId!};
  await assert.rejects(()=>f.repo.saveTask(manager,l.id,taskInput,'task-inaccessible-target'),{code:'crm_task_scope_invalid',status:422});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_tasks').get()!.n,0);
  await assert.rejects(()=>f.repo.detail({...other,ownerOnly:true},l.id),{status:404});assert.equal((await f.repo.listTasks({...other,ownerOnly:true})).length,0);
  const owned=await f.repo.saveTask(manager,l.id,{...taskInput,assignedAccountId:owner.accountId!},'task-accessible-owner');const global=await f.repo.saveTask(manager,l.id,{...taskInput,assignedAccountId:manager.accountId!},'task-accessible-manager');
  const transferred=await f.repo.updateLead(manager,l.id,{expectedVersion:assigned.version,ownerAccountId:other.accountId},'task-owner-transfer');
  assert.equal((await f.repo.getTask(manager,owned.id)).assignedAccountId,other.accountId);assert.equal((await f.repo.getTask(manager,owned.id)).version,2);assert.equal((await f.repo.getTask(manager,global.id)).assignedAccountId,manager.accountId);assert.equal((await f.repo.getTask(manager,global.id)).version,1);
  await assert.rejects(()=>f.repo.getTask({...owner,ownerOnly:true},owned.id),{status:404});assert.equal((await f.repo.listTasks({...other,ownerOnly:true})).length,2);
  await assert.rejects(()=>f.repo.updateLead(manager,l.id,{expectedVersion:transferred.version,ownerAccountId:null},'task-unassign-blocked'),{code:'crm_open_tasks_need_owner',status:422});
  await f.repo.saveTask(manager,l.id,{taskId:owned.id,title:owned.title,dueAt:owned.dueAt,assignedAccountId:manager.accountId!,expectedVersion:2},'task-reassign-manager');
  const unassigned=await f.repo.updateLead(manager,l.id,{expectedVersion:transferred.version,ownerAccountId:null},'task-unassign-reviewed');assert.equal(unassigned.ownerAccountId,null);
 }finally{f.close();}
});

test('task permission snapshots and automatic owner transfers remain atomic across races and audit outages',async()=>{
 const f=setup();try{
  const manager=staff(f),owner=staff(f,'race-owner','member'),target=staff(f,'race-manager');f.sqlite.prepare("INSERT INTO webinar_erp_roles VALUES(?,?,'sales',?)").run(actor.orgId,`erp-${owner.accountId}`,new Date().toISOString());
  const l=await f.repo.capture(actor,input,'task-race-capture');const assigned=await f.repo.updateLead(manager,l.id,{expectedVersion:l.version,ownerAccountId:owner.accountId},'task-race-owner');
  const taskInput={title:'Current permission required',dueAt:'2026-12-01T00:00:00.000Z',assignedAccountId:target.accountId!};let downgrade=true;
  const downgraded=new CrmRepository({...f.db,async batch(statements){if(downgrade){downgrade=false;f.sqlite.prepare("UPDATE live_core_staff_links SET actor_role='member' WHERE learner_account_id=?").run(target.accountId);f.sqlite.prepare("INSERT INTO webinar_erp_roles VALUES(?,?,'sales',?)").run(actor.orgId,`erp-${target.accountId}`,new Date().toISOString());}return f.db.batch(statements);}});
  await assert.rejects(()=>downgraded.saveTask(manager,l.id,taskInput,'task-role-race'),{status:409});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_tasks').get()!.n,0);
  let transferred=true;const raced=new CrmRepository({...f.db,async batch(statements){if(transferred){transferred=false;f.sqlite.prepare('UPDATE crm_leads SET owner_account_id=NULL,version=version+1 WHERE id=?').run(l.id);}return f.db.batch(statements);}});
  await assert.rejects(()=>raced.saveTask(manager,l.id,{...taskInput,assignedAccountId:owner.accountId!},'task-owner-race'),{status:409});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_tasks').get()!.n,0);
  const restored=await f.repo.updateLead(manager,l.id,{expectedVersion:assigned.version+1,ownerAccountId:owner.accountId},'task-race-owner-restored');const owned=await f.repo.saveTask(manager,l.id,{...taskInput,assignedAccountId:owner.accountId!},'task-race-create');
  f.sqlite.exec("CREATE TRIGGER synthetic_task_transfer_audit_failure BEFORE INSERT ON crm_audit_events BEGIN SELECT RAISE(ABORT,'synthetic task audit outage'); END;");
  await assert.rejects(()=>f.repo.updateLead(manager,l.id,{expectedVersion:restored.version,ownerAccountId:target.accountId},'task-transfer-retry'),{code:'crm_storage_unavailable'});
  assert.equal((await f.repo.detail(manager,l.id)).lead.ownerAccountId,owner.accountId);assert.equal((await f.repo.getTask(manager,owned.id)).assignedAccountId,owner.accountId);assert.equal((await f.repo.getTask(manager,owned.id)).version,1);
  f.sqlite.exec('DROP TRIGGER synthetic_task_transfer_audit_failure');await f.repo.updateLead(manager,l.id,{expectedVersion:restored.version,ownerAccountId:target.accountId},'task-transfer-retry');assert.equal((await f.repo.getTask(manager,owned.id)).assignedAccountId,target.accountId);
 }finally{f.close();}
});

test('automated task creation also rejects a lead owner changed before its atomic write',async()=>{
 const f=setup();try{
  const manager=staff(f),l=await f.repo.capture(actor,input,'automatic-task-race-capture');await f.repo.updateLead(manager,l.id,{expectedVersion:l.version,ownerAccountId:manager.accountId},'automatic-task-race-owner');
  await f.repo.saveRule(manager,{name:'Create an owner follow-up',type:'automation',trigger:'task_due',taskTitle:'Review due follow-up',enabled:true},'automatic-task-race-rule');let armed=true;
  const raced=new CrmRepository({...f.db,async batch(statements){if(armed){armed=false;f.sqlite.prepare('UPDATE crm_leads SET owner_account_id=NULL,version=version+1 WHERE id=?').run(l.id);}return f.db.batch(statements);}});
  await assert.rejects(()=>raced.runRules(manager,l.id,'task_due','canonical-due-task-event'),{status:409});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_tasks').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,0);
 }finally{f.close();}
});

test('campaigns dedupe recipient contacts across lead intents, rule events and concurrent queue attempts',async()=>{
 const f=setup();try{
  const l=await verified(f),other=await f.repo.capture(actor,{...input,kind:'career',interest:'Separate explicit career intent'},'same-contact-other-intent'),c=await campaign(f);assert.equal(other.contactId,l.contactId);assert.notEqual(other.id,l.id);assert.equal((await f.repo.campaignPreview(actor,c.id)).eligible,1);
  const outcomes=await Promise.allSettled([f.repo.enqueueCampaign(actor,c.id,'contact-race-queue-one'),f.repo.enqueueCampaign(actor,c.id,'contact-race-queue-two')]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length>=1,true);for(const result of outcomes)if(result.status==='rejected')assert.equal(result.reason.status,409);
  assert.equal((await f.repo.listJobs(actor)).length,1);assert.equal((await f.repo.enqueueCampaign(actor,c.id,'contact-race-queue-later')).queued,0);
  await f.repo.saveRule(actor,{name:'One approved follow-up per contact',type:'automation',trigger:'post_event',campaignId:c.id,enabled:true},'one-contact-followup-rule');
  await f.repo.runRules(actor,l.id,'post_event','first-intent-event');await f.repo.runRules(actor,other.id,'post_event','second-intent-event');assert.equal((await f.repo.listJobs(actor)).length,1);
  const duplicate=f.sqlite.prepare('INSERT INTO crm_jobs(org_id,id,lead_id,contact_id,campaign_id,campaign_version,integration_id,template_ref,channel,purpose,state,scheduled_at,updated_at) SELECT org_id,?, ?,contact_id,campaign_id,campaign_version,integration_id,template_ref,channel,purpose,state,scheduled_at,updated_at FROM crm_jobs LIMIT 1');assert.throws(()=>duplicate.run(crypto.randomUUID(),other.id),/UNIQUE/);
 }finally{f.close();}
});
