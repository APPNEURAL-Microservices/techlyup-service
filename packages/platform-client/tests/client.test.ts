import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformClient,PlatformError,type PlatformClientOptions } from '../src/index';

const options:PlatformClientOptions={origin:'https://api.appneurox.com',serviceCredential:'synthetic-service-credential',scope:{tenantId:'tenant-one',projectId:'project-one',environmentId:'environment-one'},publicFlagKeys:['app.public'],configNamespace:'public-app',publicConfigKeys:['app.title']};
const principal=(kind='SERVICE',tenant='tenant-one',permissions=['featureflag.evaluate','config.read','audit.read'])=>({principal:{id:'service-one',kind,tenantId:tenant,permissions}});
function transport(result:unknown,identity:unknown=principal(),capture?:(request:Request)=>void):typeof fetch{return async input=>{const request=input as Request;capture?.(request);return Response.json(new URL(request.url).pathname==='/v1/authentication/me'?identity:result);};}

test('bounded fixed-contract client pins origin/tenant and strips all unapproved flags/config metadata',async()=>{
  const requests:Request[]=[];
  const client=new PlatformClient({...options,transport:transport([{flagKey:'app.public',value:true,reason:'DEFAULT',revision:1,snapshotRevision:2,privateMetadata:'discard'}],principal(),request=>requests.push(request))});
  assert.deepEqual(await client.evaluateBooleanFlags(),{flags:{'app.public':true},snapshotRevision:2});
  for(const request of requests){assert.equal(request.headers.get('authorization'),'Bearer synthetic-service-credential');assert.equal(request.headers.get('origin'),options.origin);assert.equal(request.headers.get('x-tenant-id'),'tenant-one');assert.equal(request.redirect,'error');assert.equal(new URL(request.url).origin,options.origin);}
  const config=new PlatformClient({...options,transport:transport({namespace:'public-app',revision:'a'.repeat(64),configs:{'app.title':'Safe title','private.password':'must never leave client'}})});
  assert.deepEqual(await config.resolveAllowlistedConfig(),{configs:{'app.title':'Safe title'},revision:'a'.repeat(64)});
});

test('wrong realm, tenant, user token, platform admin and missing permission are rejected before business calls',async()=>{
  for(const identity of [principal('USER'),principal('SERVICE','other-tenant'),principal('SERVICE','tenant-one',[]),principal('SERVICE','tenant-one',['platform.admin','featureflag.evaluate'])]){
    let calls=0;
    const client=new PlatformClient({...options,transport:transport([],identity,()=>calls++)});
    await assert.rejects(client.evaluateBooleanFlags(),PlatformError);assert.equal(calls,1);
  }
});

test('response validation rejects truthy strings, unknown/duplicate keys, missing entries and inconsistent revisions',async()=>{
  const good={flagKey:'app.public',value:true,reason:'DEFAULT',revision:1,snapshotRevision:2};
  for(const response of [[{...good,value:'true'}],[{...good,flagKey:'private.flag'}],[good,good],[],[{...good,snapshotRevision:0}]]){
    const client=new PlatformClient({...options,transport:transport(response)});
    await assert.rejects(client.evaluateBooleanFlags(),PlatformError);
  }
  const oversized=new PlatformClient({...options,transport:async()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}})});
  await assert.rejects(oversized.evaluateBooleanFlags(),PlatformError);
  const failed=new PlatformClient({...options,transport:async()=>{throw new Error('synthetic-secret-must-not-leak');}});
  await assert.rejects(failed.evaluateBooleanFlags(),error=>error instanceof PlatformError&&!error.message.includes('synthetic-secret'));
});

test('origin, credentials, scope and key validation prevent arbitrary destinations or proxy expansion',()=>{
  for(const change of [{origin:'https://evil.example.test'},{origin:'https://api.appneurox.com/secret'},{origin:'http://127.0.0.1:8789'},{origin:'https://user:password@api.appneurox.com'},{serviceCredential:'invalid whitespace'},{publicFlagKeys:['../private']},{scope:{...options.scope,tenantId:'tenant/escape'}}])assert.throws(()=>new PlatformClient({...options,...change}),PlatformError);
  assert.doesNotThrow(()=>new PlatformClient({...options,origin:'http://127.0.0.1:8789',allowLocal:true}));
});
