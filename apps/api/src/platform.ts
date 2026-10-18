import { PlatformClient } from '@appneurox/platform-client';
import { ApiError,type Env } from './types';
import type { config } from './config';
import { success } from './http';

export const PUBLIC_PLATFORM_FLAGS=['techlyup.app.learning-sync','techlyup.app.analytics'] as const;
export function platformClient(env:Env){
  return new PlatformClient({origin:env.PLATFORM_API_ORIGIN??'https://api.appneurox.com',serviceCredential:env.PLATFORM_SERVICE_CREDENTIAL??'',scope:{tenantId:env.PLATFORM_TENANT_ID??'',projectId:env.PLATFORM_PROJECT_ID??'',environmentId:env.PLATFORM_ENVIRONMENT_ID??''},publicFlagKeys:PUBLIC_PLATFORM_FLAGS,targetingKey:'techlyup-app-public',configNamespace:'techlyup-app',publicConfigKeys:['app.display-name'],allowLocal:['development','test'].includes(env.APP_ENV??'development')});
}
export async function publicPlatformFlags(env:Env,requestId:string,settings:ReturnType<typeof config>){
  if(!settings.platform)return success({flags:Object.fromEntries(PUBLIC_PLATFORM_FLAGS.map(key=>[key,false])),source:'disabled',snapshotRevision:0},requestId);
  try{
    const result=await platformClient(env).evaluateBooleanFlags();
    // Remote targeting never enables an unconfigured local backend capability.
    result.flags['techlyup.app.learning-sync']&&=settings.learning;
    result.flags['techlyup.app.analytics']&&=settings.analytics;
    return success({...result,source:'platform'},requestId);
  }catch{throw new ApiError('platform_unavailable','Shared feature flags are temporarily unavailable.',503);}
}
export async function platformCapabilities(env:Env,requestId:string,settings:ReturnType<typeof config>){
  if(!settings.platform)return success({enabled:false,configured:false,source:'disabled'},requestId);
  try{
    const client=platformClient(env);
    const [audit,flags,configuration]=await Promise.all([client.readAuditCapabilities(),client.evaluateBooleanFlags(),client.resolveAllowlistedConfig()]);
    return success({enabled:true,configured:true,source:'platform',features:{booleanFlags:true,snapshotRevision:flags.snapshotRevision,publicKeyCount:Object.keys(flags.flags).length},configuration:{resolved:true,revision:configuration.revision,publicKeyCount:Object.keys(configuration.configs).length},audit},requestId);
  }catch{throw new ApiError('platform_unavailable','Shared platform capabilities are temporarily unavailable.',503);}
}
