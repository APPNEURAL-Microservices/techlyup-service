export interface D1Result<T = unknown> { results?: T[]; meta: { changes: number } }
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1Result>;
}
export interface D1Database { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<D1Result[]> }
import type { CrmEnv } from './crm/providers';
import type { StudioAppBinding } from './products/gateway';
/** Each separate Studio app Worker, reached through a service binding by the /studio/<app> gateway. */
type StudioApps = Partial<Record<StudioAppBinding, { fetch(request: Request): Promise<Response> }>>;
export interface Env extends CrmEnv, StudioApps {
  APP_PRODUCTS_ENABLED?: string; APP_PRODUCTS_APP_ORIGIN?: string;
  /** Dedicated D1 for private Studio drafts; never the canonical registrations store. */
  STUDIO_DB?: D1Database;
  APP_ENV?: string; APP_ENABLED?: string; APP_SIGNUP_ENABLED?: string;
  APP_ANALYTICS_ENABLED?: string; APP_LEARNING_ENABLED?: string;
  APP_PLATFORM_ENABLED?: string;
  APP_CRM_ENABLED?: string; APP_CRM_CAPTURE_ENABLED?: string;
  APP_CRM_SENDING_ENABLED?: string; APP_CRM_INTEGRATIONS_ENABLED?: string;
  APP_CRM_WEBINAR_ENABLED?: string;
  CRM_ANALYTICS_EXPORT_ENABLED?: string; CRM_POSTHOG_PROJECT_KEY?: string;
  CRM_POSTHOG_REGION?: string; CRM_GA4_MEASUREMENT_ID?: string; CRM_GA4_API_SECRET?: string;
  APP_ALLOWED_ORIGINS?: string; TECHLYUP_ERP_ORG_ID?: string;
  APP_POSTGRES?: { connectionString: string };
  APP_LOCAL_POSTGRES?: string; APP_LOCAL_DATABASE_URL?: string;
  PLATFORM_API_ORIGIN?: string; PLATFORM_SERVICE_CREDENTIAL?: string;
  PLATFORM_TENANT_ID?: string; PLATFORM_PROJECT_ID?: string; PLATFORM_ENVIRONMENT_ID?: string;
  REGISTRATIONS_DB?: D1Database; ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Cloudflare Email Sending binding for sign-in codes, with its verified sender address. */
  EMAIL?: { send(message: { from: { email: string; name: string }; to: string; subject: string; text: string }): Promise<{ messageId?: string } | undefined> };
  EMAIL_FROM?: string;
}
export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400, public fields?: Record<string, string>) { super(message); }
}
