import { z } from 'zod';
export const crmKinds = ['course', 'webinar', 'mentorship', 'career', 'general'] as const;
export const crmStages = ['new', 'contacted', 'qualified', 'won', 'lost'] as const;
export const crmChannels = ['email', 'whatsapp'] as const;
export const crmPurposes = ['service', 'marketing'] as const;
export type CrmKind = typeof crmKinds[number];
export type CrmStage = typeof crmStages[number];
export type CrmChannel = typeof crmChannels[number];
export type CrmPurpose = typeof crmPurposes[number];
const ref = z.string().trim().min(1).max(180).regex(/^[^\u0000-\u001f\u007f]+$/);
const operatorRef = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/, 'Use an operator-approved identifier.');
const short = z.string().trim().max(240);
// Internal legacy newsletter import records its absent notice version truthfully.
const policy = z.enum(['2026-09', '2026-10', 'legacy-newsletter-unversioned']);
export const crmConsentSchema = z.object({ service: z.boolean(), marketing: z.boolean(), whatsapp: z.boolean().default(false), policyVersion: policy }).strict();
export const crmCaptureSchema = z.object({
    name: z.string().trim().min(1).max(160).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: z.string().trim().min(7).max(32).regex(/^\+?[0-9() .-]+$/).optional(),
    kind: z.enum(crmKinds), interest: short.optional(), source: z.string().trim().min(1).max(120).optional(),
    attribution: z.object({ source: z.string().trim().max(120).optional(), medium: z.string().trim().max(120).optional(), campaign: z.string().trim().max(120).optional(), referrerOrigin: z.string().url().max(300).refine(value => { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password; }).optional() }).strict().optional(),
    consent: crmConsentSchema,
}).strict().refine(value => Boolean(value.email || value.phone), 'Provide an email address or phone number.');
export const crmPublicCaptureSchema = crmCaptureSchema.refine(value => value.consent.policyVersion === '2026-10' && value.consent.service, 'Accept the current contact notice to request follow-up.');
export type CrmCaptureInput = z.input<typeof crmCaptureSchema>;
export const crmLeadPatchSchema = z.object({ expectedVersion: z.number().int().positive(), stage: z.enum(crmStages).optional(), ownerAccountId: ref.nullable().optional(), interest: short.optional() }).strict().refine(value => value.stage !== undefined || value.ownerAccountId !== undefined || value.interest !== undefined, 'Choose a field to update.');
export type CrmLeadPatchInput = z.infer<typeof crmLeadPatchSchema>;
export const crmActivitySchema = z.object({ kind: z.enum(['note', 'call', 'email', 'meeting', 'follow_up']), note: z.string().trim().min(1).max(1000) }).strict();
export type CrmActivityInput = z.infer<typeof crmActivitySchema>;
export const crmTaskSchema = z.object({ taskId: ref.optional(), title: z.string().trim().min(2).max(200), dueAt: z.iso.datetime({ offset: true }), assignedAccountId: ref, status: z.enum(['open', 'done', 'cancelled']).default('open'), expectedVersion: z.number().int().positive().optional() }).strict().refine(value => !value.taskId || Boolean(value.expectedVersion), 'Use the current task version.');
export type CrmTaskInput = z.input<typeof crmTaskSchema>;
export const crmLeadFilterSchema = z.object({ q: z.string().trim().max(100).optional(), stage: z.enum(crmStages).optional(), kind: z.enum(crmKinds).optional(), ownerAccountId: ref.optional(), limit: z.coerce.number().int().min(1).max(100).default(25), cursor: ref.optional() }).strict();
export type CrmLeadFilter = z.input<typeof crmLeadFilterSchema>;
export const crmCampaignSchema = z.object({ id: ref.optional(), name: z.string().trim().min(3).max(120), channel: z.enum(crmChannels), purpose: z.enum(crmPurposes).default('marketing'), templateRef: operatorRef, integrationId: ref.nullable().default(null), kinds: z.array(z.enum(crmKinds)).max(5).default([]), stages: z.array(z.enum(crmStages)).max(5).default([]), minScore: z.number().int().min(0).max(100).default(0), enabled: z.boolean().default(false), expectedVersion: z.number().int().positive().optional() }).strict().refine(value => !value.id || Boolean(value.expectedVersion), 'Use the current campaign version.');
export type CrmCampaignInput = z.input<typeof crmCampaignSchema>;
export const crmRuleSchema = z.object({ id: ref.optional(), name: z.string().trim().min(3).max(120), type: z.enum(['score', 'automation']), trigger: z.enum(['capture', 'stage_changed', 'activity', 'no_show', 'post_event', 'task_due']), kind: z.enum(crmKinds).nullable().default(null), stage: z.enum(crmStages).nullable().default(null), points: z.number().int().min(-100).max(100).default(0), campaignId: ref.nullable().default(null), taskTitle: z.string().trim().max(200).nullable().default(null), enabled: z.boolean().default(false), expectedVersion: z.number().int().positive().optional() }).strict().refine(value => !value.id || Boolean(value.expectedVersion), 'Use the current rule version.');
export type CrmRuleInput = z.input<typeof crmRuleSchema>;
export const crmIntegrationSchema = z.object({ id: ref.optional(), name: z.string().trim().min(3).max(120), provider: z.enum(['native_notification', 'meta', 'linkedin', 'external']), channel: z.enum(crmChannels), sourceRef: operatorRef, enabled: z.boolean().default(false), expectedVersion: z.number().int().positive().optional() }).strict().refine(value => !value.id || Boolean(value.expectedVersion), 'Use the current integration version.');
export type CrmIntegrationInput = z.input<typeof crmIntegrationSchema>;
export interface CrmScoreReason {
    code: string;
    label: string;
    points: number;
}
export interface CrmLead {
    id: string;
    contactId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    accountId: string | null;
    kind: CrmKind;
    interest: string;
    source: string;
    stage: CrmStage;
    score: number;
    scoreReasons: CrmScoreReason[];
    ownerAccountId: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}
export interface CrmActivity {
    id: string;
    leadId: string;
    kind: string;
    note: string | null;
    actorAccountId: string | null;
    occurredAt: string;
}
export interface CrmTask {
    id: string;
    leadId: string;
    title: string;
    dueAt: string;
    assignedAccountId: string;
    status: 'open' | 'done' | 'cancelled';
    version: number;
    createdAt: string;
    updatedAt: string;
}
export interface CrmConsent {
    channel: CrmChannel;
    purpose: CrmPurpose;
    state: 'pending' | 'granted' | 'withdrawn';
    policyVersion: string;
    proofKind: string;
    verifiedAt: string | null;
    updatedAt: string;
}
export interface CrmLeadDetail {
    lead: CrmLead;
    activities: CrmActivity[];
    tasks: CrmTask[];
    consents: CrmConsent[];
}
export interface CrmStaff {
    accountId: string;
    name: string;
    email: string;
    roles: string[];
}
export interface CrmCampaign {
    id: string;
    name: string;
    channel: CrmChannel;
    purpose: CrmPurpose;
    templateRef: string;
    integrationId: string | null;
    kinds: CrmKind[];
    stages: CrmStage[];
    minScore: number;
    enabled: boolean;
    version: number;
    createdAt: string;
    updatedAt: string;
}
export interface CrmRule {
    id: string;
    name: string;
    type: 'score' | 'automation';
    trigger: 'capture' | 'stage_changed' | 'activity' | 'no_show' | 'post_event' | 'task_due';
    kind: CrmKind | null;
    stage: CrmStage | null;
    points: number;
    campaignId: string | null;
    taskTitle: string | null;
    enabled: boolean;
    version: number;
    createdAt: string;
    updatedAt: string;
}
export interface CrmIntegration {
    id: string;
    name: string;
    provider: 'native_notification' | 'meta' | 'linkedin' | 'external';
    channel: CrmChannel;
    sourceRef: string;
    enabled: boolean;
    version: number;
    createdAt: string;
    updatedAt: string;
}
export interface CrmJob {
    id: string;
    leadId: string;
    campaignId: string;
    campaignVersion: number;
    integrationId: string;
    templateRef: string;
    channel: CrmChannel;
    purpose: CrmPurpose;
    state: 'queued' | 'sending' | 'accepted' | 'delivered' | 'failed' | 'blocked' | 'suppressed' | 'uncertain';
    attempts: number;
    leaseId: string | null;
    providerMessageId: string | null;
    nativeIntentId: string | null;
    errorCode: string | null;
    scheduledAt: string;
    updatedAt: string;
}
export interface CrmCapabilities {
    enabled: boolean;
    canRead: boolean;
    canWrite: boolean;
    canAssign: boolean;
    canExport: boolean;
    canSend: boolean;
    manageAutomation: boolean;
    manageIntegrations: boolean;
    providers: {
        email: boolean;
        whatsapp: boolean;
        meta: boolean;
        linkedin: boolean;
        external: boolean;
    };
    dispatchEnabled: boolean;
    source: 'd1-acquisition';
}
export interface CrmSummary {
    total: number;
    byStage: {
        stage: CrmStage;
        count: number;
    }[];
    openTasks: number;
    queuedJobs: number;
}
export interface CrmLeadList {
    leads: CrmLead[];
    nextCursor: string | null;
}
export interface CrmCampaignPreview {
    campaignId: string;
    eligible: number;
    blocked: number;
    reasons: Record<string, number>;
    dispatchEnabled: false;
}
export interface CrmCampaignQueueResult {
    queued: number;
    blocked: number;
    dispatchEnabled: false;
}
export interface CrmStaffResponse {
    staff: CrmStaff[];
}
export interface CrmJobsResponse {
    jobs: CrmJob[];
}
export interface CrmCampaignsResponse {
    campaigns: CrmCampaign[];
}
export interface CrmRulesResponse {
    rules: CrmRule[];
}
export interface CrmIntegrationsResponse {
    integrations: CrmIntegration[];
}
