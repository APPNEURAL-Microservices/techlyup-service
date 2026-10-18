import { z } from 'zod';

export interface PlatformScope { tenantId: string; projectId: string; environmentId: string }
export interface PlatformClientOptions {
  origin: string; serviceCredential: string; scope: PlatformScope;
  publicFlagKeys: readonly string[]; configNamespace?: string; publicConfigKeys?: readonly string[];
  allowLocal?: boolean; transport?: typeof fetch;
  targetingKey?: string;
}
export class PlatformError extends Error {
  constructor(public readonly code: 'configuration_required'|'platform_unavailable'|'platform_authority_invalid'|'platform_response_invalid') { super(code); this.name='PlatformError'; }
}
const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const key=z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/).refine(value=>!value.includes('..'));
const principalSchema=z.object({principal:z.object({id:identifier,tenantId:identifier,kind:z.literal('SERVICE'),permissions:z.array(z.string()).max(256)})});
const evaluations=z.array(z.object({flagKey:key,value:z.boolean(),reason:z.string().max(80),revision:z.number().int().nonnegative(),snapshotRevision:z.number().int().positive()})).max(100);
const capabilities=z.object({immutableServerReceipts:z.boolean(),hashChainVerification:z.boolean(),legalHoldExport:z.boolean(),externalAnchoring:z.boolean(),clientEventIngestion:z.boolean()});
const configResult=z.object({namespace:z.string(),revision:z.string().max(128),configs:z.record(z.string(),z.unknown())});
const MAX_BYTES=64*1024;

/** Server-side client for existing edge-monolith contracts. There is no public
 * arbitrary-URL/path/tenant/target/proxy method and no credential provisioning. */
export class PlatformClient {
  private readonly settings:PlatformClientOptions;
  private readonly transport:typeof fetch;
  constructor(options:PlatformClientOptions){
    try{
      const url=new URL(options.origin),local=options.allowLocal===true&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
      if(url.origin!==options.origin||url.username||url.password||(!local&&options.origin!=='https://api.appneurox.com'))throw new Error();
      if(!options.serviceCredential||options.serviceCredential.length>8192||/\s/.test(options.serviceCredential))throw new Error();
      for(const value of Object.values(options.scope))identifier.parse(value);
      if(Object.keys(options.scope).sort().join(',')!=='environmentId,projectId,tenantId')throw new Error();
      if(options.publicFlagKeys.length>20||new Set(options.publicFlagKeys).size!==options.publicFlagKeys.length)throw new Error();
      options.publicFlagKeys.forEach(value=>key.parse(value));
      if(options.configNamespace&&!/^[a-z][a-z0-9-]{0,63}$/.test(options.configNamespace))throw new Error();
      if((options.publicConfigKeys?.length??0)>20)throw new Error();
      options.publicConfigKeys?.forEach(value=>key.parse(value));
      if(options.targetingKey)identifier.parse(options.targetingKey);
      this.settings={...options,scope:{...options.scope},publicFlagKeys:[...options.publicFlagKeys],publicConfigKeys:[...(options.publicConfigKeys??[])]};
      this.transport=options.transport??globalThis.fetch;
    }catch{throw new PlatformError('configuration_required');}
  }
  private async request(path:'/v1/authentication/me'|'/v1/featureflag/evaluate/batch'|'/v1/config/configurations/resolve'|'/v1/audit/capabilities',body?:unknown):Promise<unknown>{
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),3000);
    try{
      const request=new Request(this.settings.origin+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:abort.signal,headers:{Authorization:`Bearer ${this.settings.serviceCredential}`,Origin:this.settings.origin,'X-Tenant-ID':this.settings.scope.tenantId,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const response=await this.transport(request);
      if(!response.ok||!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')){await response.body?.cancel();throw new PlatformError('platform_unavailable');}
      if(Number(response.headers.get('content-length')??0)>MAX_BYTES){await response.body?.cancel();throw new PlatformError('platform_response_invalid');}
      const reader=response.body?.getReader();if(!reader)throw new PlatformError('platform_response_invalid');
      let bytes=0,raw='';const decoder=new TextDecoder('utf-8',{fatal:true});
      try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();throw new PlatformError('platform_response_invalid');}raw+=decoder.decode(next.value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}
      try{return JSON.parse(raw);}catch{throw new PlatformError('platform_response_invalid');}
    }catch(error){if(error instanceof PlatformError)throw error;throw new PlatformError('platform_unavailable');}
    finally{clearTimeout(timer);}
  }
  private async serviceAuthority(required:string){
    const parsed=principalSchema.safeParse(await this.request('/v1/authentication/me'));
    if(!parsed.success||parsed.data.principal.tenantId!==this.settings.scope.tenantId||!parsed.data.principal.permissions.includes(required)||parsed.data.principal.permissions.includes('platform.admin'))throw new PlatformError('platform_authority_invalid');
  }
  async evaluateBooleanFlags():Promise<{flags:Record<string,boolean>;snapshotRevision:number}>{
    if(!this.settings.publicFlagKeys.length)return {flags:{},snapshotRevision:0};
    await this.serviceAuthority('featureflag.evaluate');
    const scope=this.settings.scope;
    const parsed=evaluations.safeParse(await this.request('/v1/featureflag/evaluate/batch',{projectId:scope.projectId,environmentId:scope.environmentId,context:{targetingKey:this.settings.targetingKey??'public-app'},flags:this.settings.publicFlagKeys.map(flagKey=>({flagKey,fallbackValue:false}))}));
    if(!parsed.success||parsed.data.length!==this.settings.publicFlagKeys.length||new Set(parsed.data.map(item=>item.flagKey)).size!==parsed.data.length||parsed.data.some(item=>!this.settings.publicFlagKeys.includes(item.flagKey))||new Set(parsed.data.map(item=>item.snapshotRevision)).size!==1)throw new PlatformError('platform_response_invalid');
    return {flags:Object.fromEntries(parsed.data.map(item=>[item.flagKey,item.value])),snapshotRevision:parsed.data[0].snapshotRevision};
  }
  async resolveAllowlistedConfig():Promise<{configs:Record<string,string|number|boolean>;revision:string}>{
    if(!this.settings.configNamespace||!this.settings.publicConfigKeys?.length)throw new PlatformError('configuration_required');
    await this.serviceAuthority('config.read');
    const parsed=configResult.safeParse(await this.request('/v1/config/configurations/resolve',{namespace:this.settings.configNamespace,projectId:this.settings.scope.projectId,environmentId:this.settings.scope.environmentId,includeResolutionMetadata:false}));
    if(!parsed.success||parsed.data.namespace!==this.settings.configNamespace)throw new PlatformError('platform_response_invalid');
    const configs:Record<string,string|number|boolean>={};
    for(const name of this.settings.publicConfigKeys){const value=parsed.data.configs[name];if(value===undefined)continue;if(!['string','number','boolean'].includes(typeof value)||typeof value==='string'&&value.length>200||typeof value==='number'&&!Number.isFinite(value))throw new PlatformError('platform_response_invalid');configs[name]=value as string|number|boolean;}
    return {configs,revision:parsed.data.revision};
  }
  async readAuditCapabilities(){
    await this.serviceAuthority('audit.read');
    const parsed=capabilities.safeParse(await this.request('/v1/audit/capabilities'));
    if(!parsed.success)throw new PlatformError('platform_response_invalid');
    return parsed.data;
  }
}
