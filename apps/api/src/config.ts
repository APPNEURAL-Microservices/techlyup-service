import { ApiError, type Env } from './types';
import { validateCrmProviders } from './crm/providers';

export function config(env: Env) {
  const mode = env.APP_ENV ?? 'development';
  if (!['development', 'test', 'staging', 'production'].includes(mode)) throw new ApiError('configuration_required', 'App configuration is unavailable.', 503);
  for (const key of ['APP_ENABLED', 'APP_PRODUCTS_ENABLED', 'APP_SIGNUP_ENABLED', 'APP_ANALYTICS_ENABLED', 'APP_LEARNING_ENABLED', 'APP_LOCAL_POSTGRES','APP_PLATFORM_ENABLED','APP_CRM_ENABLED','APP_CRM_CAPTURE_ENABLED','APP_CRM_WEBINAR_ENABLED','APP_CRM_SENDING_ENABLED','APP_CRM_INTEGRATIONS_ENABLED','CRM_ANALYTICS_EXPORT_ENABLED','CRM_META_APPROVED','CRM_LINKEDIN_APPROVED','CRM_EXTERNAL_APPROVED','CRM_NOTIFICATION_ALLOW_LOCAL','CRM_NOTIFICATION_AUTHORITY_APPROVED'] as const) {
    if (env[key] !== undefined && env[key] !== 'true' && env[key] !== 'false') throw new ApiError('configuration_required', 'App configuration is unavailable.', 503);
  }
  if (env.APP_ENABLED !== 'true' && [env.APP_PRODUCTS_ENABLED,env.APP_SIGNUP_ENABLED,env.APP_ANALYTICS_ENABLED,env.APP_LEARNING_ENABLED,env.APP_PLATFORM_ENABLED].includes('true')) throw new ApiError('configuration_required','App features require the app API to be enabled.',503);
  if (env.APP_CRM_ENABLED === 'true' && env.APP_ENABLED !== 'true') throw new ApiError('configuration_required','CRM requires the app API to be enabled.',503);
  if (env.APP_CRM_ENABLED !== 'true' && [env.APP_CRM_CAPTURE_ENABLED,env.APP_CRM_WEBINAR_ENABLED,env.APP_CRM_SENDING_ENABLED,env.APP_CRM_INTEGRATIONS_ENABLED].includes('true')) throw new ApiError('configuration_required','CRM capabilities require the CRM module to be enabled.',503);
  if (env.CRM_NOTIFICATION_ALLOW_LOCAL === 'true' && !['development','test'].includes(mode)) throw new ApiError('configuration_required','Local notification routing is development-only.',503);
  if (env.APP_CRM_SENDING_ENABLED === 'true') {
    validateCrmProviders(env);
    if(env.CRM_NOTIFICATION_AUTHORITY_APPROVED!=='true'||!env.CRM_DELIVERY_AUTH_SECRET||env.CRM_DELIVERY_AUTH_SECRET.length<32)throw new ApiError('configuration_required','CRM sending requires accepted downstream consent enforcement.',503);
  }
  if (env.CRM_ANALYTICS_EXPORT_ENABLED === 'true' && (env.APP_CRM_ENABLED !== 'true' || env.CRM_POSTHOG_REGION && !['us','eu'].includes(env.CRM_POSTHOG_REGION) || env.CRM_GA4_MEASUREMENT_ID && !/^G-[A-Z0-9]{4,24}$/.test(env.CRM_GA4_MEASUREMENT_ID))) throw new ApiError('configuration_required','CRM analytics configuration is unavailable.',503);
  if (env.APP_LOCAL_POSTGRES === 'true' && !['development','test'].includes(mode)) throw new ApiError('configuration_required','Direct learning database connections are local only.',503);
  if (env.APP_LEARNING_ENABLED === 'true') learningConnection(env);
  if(env.APP_PLATFORM_ENABLED==='true'&&(!env.PLATFORM_SERVICE_CREDENTIAL||!env.PLATFORM_TENANT_ID||!env.PLATFORM_PROJECT_ID||!env.PLATFORM_ENVIRONMENT_ID))throw new ApiError('configuration_required','Shared platform configuration is unavailable.',503);
  const origins = (env.APP_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new ApiError('configuration_required', 'App configuration is unavailable.', 503); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' && !(mode !== 'production' && loopback && url.protocol === 'http:'))) throw new ApiError('configuration_required', 'App configuration is unavailable.', 503);
  }
  if (env.APP_ENABLED === 'true' && (!env.REGISTRATIONS_DB || !env.TECHLYUP_ERP_ORG_ID?.trim() || !origins.length)) throw new ApiError('configuration_required', 'App configuration is unavailable.', 503);
  return { mode, origins, enabled: env.APP_ENABLED === 'true', signup: env.APP_SIGNUP_ENABLED === 'true', analytics: env.APP_ANALYTICS_ENABLED === 'true', learning: env.APP_LEARNING_ENABLED === 'true',platform:env.APP_PLATFORM_ENABLED==='true',crm:env.APP_CRM_ENABLED==='true',crmCapture:env.APP_CRM_CAPTURE_ENABLED==='true',crmSending:env.APP_CRM_SENDING_ENABLED==='true',crmIntegrations:env.APP_CRM_INTEGRATIONS_ENABLED==='true' };
}
export function learningConnection(env:Env) {
  if(env.APP_POSTGRES?.connectionString)return env.APP_POSTGRES.connectionString;
  if(env.APP_LOCAL_POSTGRES==='true'&&['development','test'].includes(env.APP_ENV??'development')&&env.APP_LOCAL_DATABASE_URL){
    try {
      const url=new URL(env.APP_LOCAL_DATABASE_URL);
      if(['postgres:','postgresql:'].includes(url.protocol)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))return env.APP_LOCAL_DATABASE_URL;
    }catch{/* Return only the sanitized configuration error below. */}
  }
  throw new ApiError('configuration_required','Learning storage is not configured.',503);
}
export function database(env: Env) {
  if (!env.REGISTRATIONS_DB) throw new ApiError('storage_unavailable', 'App storage is temporarily unavailable.', 503);
  return env.REGISTRATIONS_DB;
}
