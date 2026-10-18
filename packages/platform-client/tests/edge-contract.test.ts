import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PlatformClient,PlatformError } from '../src/index';

test('client consumes real local edge-monolith authentication/flags/config/audit contracts with tenant-scoped SERVICE authority',async()=>{
  // Shared source integration, not a copied route or mocked upstream response.
  // This test uses the neighboring existing monolith's disposable Miniflare
  // harness and actual D1 migrations. It performs zero remote requests.
  const harness=new URL('../../../../cloudflare/edge-monolith/test/runtime-harness.ts',import.meta.url);
  const {createRuntime}=await import(harness.href);
  const origin='https://api.appneurox.com',tenant='local-techlyup-platform';
  const script=`
    import {ModuleCoordinator} from './src/coordinator.ts';
    import {authenticate,dispatchIdentity} from './src/identity.ts';
    import {dispatchWorkspaces} from './src/workspaces.ts';
    import {dispatchFeatures} from './src/features.ts';
    import {dispatchConfig} from './src/config.ts';
    import {dispatchOperations} from './src/operations.ts';
    import {HttpError,reply} from './src/types.ts';
    export {ModuleCoordinator};
    export default {async fetch(request,env){try{
      const principal=await authenticate(request,env);
      if(!principal)return reply({error:{code:'UNAUTHORIZED'}},401);
      return await dispatchIdentity(request,env,principal)||await dispatchWorkspaces(request,env,principal)||await dispatchFeatures(request,env,principal)||await dispatchConfig(request,env,principal)||await dispatchOperations(request,env,principal)||reply({},404);
    }catch(error){return reply({error:{code:error instanceof HttpError?error.code:'INTERNAL'}},error instanceof HttpError?error.status:503);}}};`;
  const runtime=await createRuntime({script,consumers:false,bindings:{PUBLIC_ORIGIN:origin}});
  try{
    const now=new Date().toISOString();
    await runtime.db.batch([
      runtime.db.prepare("INSERT INTO edge_tenants(id,name,status,isolation_mode,namespace_id,created_at,updated_at) VALUES(?,?,'PROVISIONING','logical',?,?,?)").bind(tenant,'Synthetic local platform',tenant+'-namespace',now,now),
      runtime.db.prepare("INSERT INTO edge_tenant_namespaces(id,tenant_id,storage_backend,created_at) VALUES(?,?,'cloudflare-d1',?)").bind(tenant+'-namespace',tenant,now),
      runtime.db.prepare("UPDATE edge_tenants SET status='ACTIVE' WHERE id=?").bind(tenant),
    ]);
    async function credential(id:string,kind:string,permissions:string[]){
      const cid=randomUUID(),family=randomUUID(),secret=randomBytes(32).toString('base64url'),issued=new Date(),expires=new Date(issued.getTime()+900000).toISOString(),familyExpires=new Date(issued.getTime()+86400000).toISOString();
      await runtime.db.batch([
        runtime.db.prepare("INSERT INTO edge_identity_principals(id,tenant_id,kind,status,direct_permissions_json,created_at,updated_at) VALUES(?,?,?,'ACTIVE',?,?,?)").bind(id,tenant,kind,JSON.stringify(permissions),now,now),
        runtime.db.prepare('INSERT INTO edge_auth_families(id,principal_id,tenant_id,principal_kind,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(family,id,tenant,kind,issued.toISOString(),familyExpires),
        runtime.db.prepare("INSERT INTO edge_auth_credentials(id,principal_id,family_id,purpose,tenant_id,principal_kind,secret_sha256,permissions_json,audience,issued_at,expires_at) VALUES(?,?,?,'ACCESS',?,?,?,?,?,?,?)").bind(cid,id,family,tenant,kind,createHash('sha256').update(cid+'.'+secret).digest('hex'),JSON.stringify(permissions),'edge-monolith',issued.toISOString(),expires),
      ]);
      return `ec1.${cid}.${secret}`;
    }
    const owner=await credential('local-techlyup-owner','USER',['platform.admin']);
    const service=await credential('local-techlyup-service','SERVICE',['featureflag.evaluate','config.read','audit.read']);
    const transport:typeof fetch=async(input,init)=>{
      const request=input instanceof Request?input:new Request(input,init);
      return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),redirect:'error',...(request.body?{body:await request.arrayBuffer()}:{})});
    };
    async function call(path:string,body:unknown,revision?:number){
      const response=await transport(new Request(origin+path,{method:'POST',headers:{authorization:'Bearer '+owner,origin,'x-tenant-id':tenant,'content-type':'application/json','idempotency-key':randomUUID(),...(revision?{'if-match':`"${revision}"`}:{})},body:JSON.stringify(body)}));
      const result:any=await response.json();assert.ok(response.ok,`${path}: ${response.status} ${result.error?.code??''}`);return result;
    }
    let org=await call('/v1/organization/organizations',{displayName:'Synthetic platform organization',organizationTypeKey:'local-test-type',ownerSubjectId:'local-techlyup-owner'});
    org=await call(`/v1/organization/organizations/${org.id}/transition`,{status:'PENDING',reason:'Synthetic local acceptance'},org.revision);
    org=await call(`/v1/organization/organizations/${org.id}/transition`,{status:'ACTIVE',reason:'Synthetic local acceptance'},org.revision);
    let project=await call('/v1/project/projects',{organizationId:org.id,name:'Synthetic app project',slug:'local-techlyup-app',owner:{type:'ORGANIZATION',id:org.id}});
    project=await call(`/v1/project/projects/${project.id}/transition`,{status:'ACTIVE',reason:'Synthetic local acceptance'},project.revision);
    let environment=await call('/v1/environment/environments',{projectId:project.id,name:'Local development',slug:'local-development',type:'DEVELOPMENT'});
    environment=await call(`/v1/environment/environments/${environment.id}/transition`,{status:'INITIALIZING',reason:'Synthetic local acceptance'},environment.revision);
    environment=await call(`/v1/environment/environments/${environment.id}/transition`,{status:'ACTIVE',reason:'Synthetic local acceptance'},environment.revision);
    const flag=(await call('/v1/featureflag/flags',{projectId:project.id,key:'techlyup.app.analytics',name:'Synthetic public analytics flag',flagType:'BOOLEAN',defaultValue:true,status:'ACTIVE'})).data;
    await call(`/v1/featureflag/flags/${flag.id}/environments/${environment.id}`,{enabled:true},flag.revision);
    await call('/v1/config/namespaces',{name:'techlyup-app'});
    await call('/v1/config/configurations',{namespace:'techlyup-app',key:'app.display-name',value:'TechlyUp local acceptance',valueType:'STRING'});
    const scope={tenantId:tenant,projectId:project.id,environmentId:environment.id};
    const client=new PlatformClient({origin,serviceCredential:service,scope,publicFlagKeys:['techlyup.app.analytics','techlyup.app.missing'],configNamespace:'techlyup-app',publicConfigKeys:['app.display-name'],transport});
    const measured=await client.evaluateBooleanFlags();
    assert.equal(measured.flags['techlyup.app.analytics'],true);assert.equal(measured.flags['techlyup.app.missing'],false);assert.ok(measured.snapshotRevision>0);
    const configuration=await client.resolveAllowlistedConfig();assert.equal(configuration.configs['app.display-name'],'TechlyUp local acceptance');
    const audit=await client.readAuditCapabilities();assert.equal(audit.immutableServerReceipts,true);assert.equal(audit.clientEventIngestion,false);
    const otherTenant=new PlatformClient({origin,serviceCredential:service,scope:{...scope,tenantId:'another-tenant'},publicFlagKeys:['techlyup.app.analytics'],transport});
    await assert.rejects(otherTenant.evaluateBooleanFlags(),PlatformError);
    await runtime.db.prepare("UPDATE edge_identity_principals SET direct_permissions_json='[]' WHERE id='local-techlyup-service'").run();
    await assert.rejects(client.evaluateBooleanFlags(),PlatformError);
    await assert.rejects(client.readAuditCapabilities(),PlatformError);
  }finally{await runtime.dispose();}
});
