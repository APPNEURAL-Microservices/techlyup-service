export const PRODUCT_IDS = ['courses', 'mentorship', 'certificates', 'learners', 'earnings', 'promotion', 'insights', 'assistant'] as const;
export type ProductId = typeof PRODUCT_IDS[number];
export type WorkspaceValue = string | number | boolean;
export interface WorkspaceField {
  name: string; label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'datetime-local' | 'url' | 'select' | 'checkbox';
  required?: boolean; options?: { value: string; label: string }[];
  help?: string; min?: number; max?: number;
}
export interface WorkspaceResource {
  id: string; label: string; singularLabel: string; description: string;
  fields: WorkspaceField[]; available: boolean; unavailableReason?: string;
}
export interface WorkspacePage {
  id: string; label: string; title: string; description: string;
  kind: 'records' | 'overview' | 'report'; resource?: string;
}
export interface WorkspaceDefinition {
  id: ProductId; title: string; summary: string; defaultPage: string;
  pages: WorkspacePage[]; resources: WorkspaceResource[];
}
export interface WorkspaceRecord {
  id: string; appId: ProductId; resource: string;
  values: Record<string, WorkspaceValue>; status: 'draft' | 'archived';
  version: number; createdAt: string; updatedAt: string;
}
export interface WorkspaceCapabilities {
  storage: 'ready' | 'disabled' | 'unavailable'; ownDrafts: boolean;
  canonicalPublishing: false; certificateIssuance: false;
  financialTransactions: false; aiGeneration: false; note: string;
}
export interface StudioUser {
  id: string; name: string; roles?: string[]; permissions?: string[];
  registration?: { accountType?: string };
}
export interface StudioEnv {
  APP_ENV?: string; APP_PRODUCTS_ENABLED?: string; TECHLYUP_ERP_ORG_ID?: string;
  /** Direct connections are accepted only for loopback development/test databases. */
  STUDIO_DATABASE_URL?: string;
  /** A dedicated Studio Hyperdrive binding; never falls back to learning storage. */
  STUDIO_HYPERDRIVE?: { connectionString: string };
}
export interface StudioActor { orgId: string; accountId: string; issuer: 'techlyup-learner' }
export interface StudioRequest { method: string; path: string; body?: unknown; idempotencyKey?: string }
export interface StudioResponse { status: number; body: unknown }
export interface WorkspaceOverview {
  counts: { resource: string; label: string; count: number }[];
  recentActivity: { id: string; appId: ProductId; resource: string; action: string; createdAt: string }[];
  source: 'own_workspace_records';
}
