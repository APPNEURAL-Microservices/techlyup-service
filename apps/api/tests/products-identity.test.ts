import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {account,fixture} from './fixture';
import {authenticate} from '../src/auth/service';
import {hash} from '../src/auth/crypto';
import {ApiError} from '../src/types';
import {authorizeProductLogin,beginProductLogin,consumeProductLogin,endProductSession,handleProductsHttp,productConfiguration,productLoginRequest,productRequest,productSession,type ProductBindingProps} from '../src/products/identity';

const props:ProductBindingProps={clientId:'techlyup-courses',product:'techlyup',tenantId:'appneural'};
const verifier='v'.repeat(43);
async function setup(){
  const f=fixture();f.sqlite.exec(readFileSync(new URL('../../../migrations/d1/0057_products_login.sql',import.meta.url),'utf8'));f.env.APP_PRODUCTS_ENABLED='true';
  const signup=await account(f,'ios','teacher@example.test',{accountType:'teacher',teacherRole:'instructor'});
  const identity=await authenticate(f.db,'appneural','Bearer '+signup.body.data.accessToken);
  return {...f,identity};
}
async function challenge(f:Awaited<ReturnType<typeof setup>>,returnPath='/curriculum'){
  const pkceChallenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  const begun=await beginProductLogin(f.env,props,{pkceChallenge,returnPath});
  const approved=await authorizeProductLogin(f.env,f.identity,begun.challengeId),url=new URL(approved.redirectUrl);
  return {begun,approved,input:{challengeId:begun.challengeId,code:url.searchParams.get('code')!,verifier}};
}
const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;

test('product SSO keeps fixed destinations, validates deployment caller and denies browser-selected callbacks',async()=>{
  const f=await setup();try{
    const c=await challenge(f),metadata=await productLoginRequest(f.env,f.identity,c.begun.challengeId);
    assert.equal(c.begun.authorizeUrl,'https://app.example.test/products/sign-in?challengeId='+c.begun.challengeId);
    assert.equal(new URL(c.approved.redirectUrl).origin,'https://app.example.test');
    assert.equal(new URL(c.approved.redirectUrl).pathname,'/studio/courses/api/auth/callback');assert.equal(metadata.appName,'Courses');assert.equal(metadata.returnPath,'/curriculum');
    assert.equal(metadata.appOrigin,'https://app.example.test/studio/courses');
    for(const wrong of [undefined,{...props,clientId:'unapproved'},{...props,tenantId:'another-tenant'},{...props,product:'foreign'}])await assert.rejects(beginProductLogin(f.env,wrong as ProductBindingProps,{pkceChallenge:'a'.repeat(43)}),code('product_caller_denied'));
    for(const path of ['//attacker.example','/%2fattacker.example','/\\attacker.example','https://attacker.example','/api/auth/techlyup/callback','/%0aevil'])await assert.rejects(beginProductLogin(f.env,props,{pkceChallenge:'a'.repeat(43),returnPath:path}),code('product_return_invalid'));
    await assert.rejects(beginProductLogin(f.env,props,{pkceChallenge:'a'.repeat(43),callback:'https://attacker.example'} as any));
  }finally{f.close();}
});
test('PKCE redemption is one-use and app-bound, opaque sessions are stored only as hashes',async()=>{
  const f=await setup();try{
    const c=await challenge(f);
    await assert.rejects(consumeProductLogin(f.env,{...props,clientId:'techlyup-earnings'},c.input),code('product_login_code_invalid'));
    await assert.rejects(consumeProductLogin(f.env,props,{...c.input,verifier:'x'.repeat(43)}),code('product_login_code_invalid'));
    const outcomes=await Promise.allSettled([consumeProductLogin(f.env,props,c.input),consumeProductLogin(f.env,props,c.input)]);
    assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);
    const result=outcomes.find(value=>value.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof consumeProductLogin>>>;
    const saved=f.sqlite.prepare('SELECT token_hash,app_id FROM app_product_sessions').get() as any;
    assert.equal(saved.app_id,'courses');assert.equal(saved.token_hash,await hash(result.value.sessionToken));assert.notEqual(saved.token_hash,result.value.sessionToken);
    assert.equal(result.value.user.id,f.identity.user.id);assert.equal(result.value.returnPath,'/curriculum');
    assert.deepEqual(Object.keys(result.value.user).sort(),['email','emailVerified','id','name','permissions','registration','roles']);
    assert.deepEqual(Object.keys(result.value.user.registration!).sort(),['accountType','teacherRole']);
    await assert.rejects(productSession(f.env,{...props,clientId:'techlyup-earnings'},{sessionToken:result.value.sessionToken}),code('product_session_invalid'));
    await assert.rejects(consumeProductLogin(f.env,props,c.input),code('product_login_code_invalid'));
  }finally{f.close();}
});
test('five wrong codes close a challenge and expired challenges cannot be approved',async()=>{
  const f=await setup();try{
    const c=await challenge(f);
    for(let n=0;n<5;n++)await assert.rejects(consumeProductLogin(f.env,props,{...c.input,code:'0'.repeat(64)}),code('product_login_code_invalid'));
    await assert.rejects(consumeProductLogin(f.env,props,c.input),code('product_login_code_invalid'));
    const next=await challenge(f);f.sqlite.prepare("UPDATE app_product_login_challenges SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(next.begun.challengeId);
    await assert.rejects(authorizeProductLogin(f.env,f.identity,next.begun.challengeId),code('product_login_code_invalid'));
  }finally{f.close();}
});
test('product sessions recheck current canonical grants and parent revocation or password changes',async()=>{
  const f=await setup();try{
    const c=await challenge(f),session=await consumeProductLogin(f.env,props,c.input),input={sessionToken:session.sessionToken},now=new Date().toISOString();
    assert.deepEqual((await productSession(f.env,props,input)).user.permissions,[]);
    f.sqlite.prepare('INSERT INTO live_core_staff_links(learner_account_id,org_id,actor_id,actor_role,actor_email,actor_name,expires_at,linked_by_actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(f.identity.user.id,'appneural','fixture-teacher','member','teacher@example.test','Fixture Teacher','2099-01-01T00:00:00.000Z','fixture-owner',now,now);
    f.sqlite.prepare('INSERT INTO webinar_erp_roles(org_id,actor_id,functional_role,created_at) VALUES(?,?,?,?)').run('appneural','fixture-teacher','teacher',now);
    assert.ok((await productSession(f.env,props,input)).user.permissions.includes('create'));
    f.sqlite.prepare('DELETE FROM webinar_erp_roles WHERE actor_id=?').run('fixture-teacher');
    assert.ok(!(await productSession(f.env,props,input)).user.permissions.includes('create'));
    f.sqlite.prepare('UPDATE app_sessions SET revoked_at=? WHERE id=?').run(now,f.identity.sessionId);
    await assert.rejects(productSession(f.env,props,input),code('product_session_invalid'));
    f.sqlite.prepare('UPDATE app_sessions SET revoked_at=NULL WHERE id=?').run(f.identity.sessionId);
    f.sqlite.prepare("UPDATE learner_accounts SET password_hash='changed-canonical-password' WHERE id=?").run(f.identity.user.id);
    await assert.rejects(productSession(f.env,props,input),code('product_session_invalid'));
  }finally{f.close();}
});
test('audit failure atomically rolls redemption back and logout is idempotent',async()=>{
  const f=await setup();try{
    const c=await challenge(f);f.setFailAudit(true);
    await assert.rejects(consumeProductLogin(f.env,props,c.input));
    assert.equal((f.sqlite.prepare('SELECT count(*) n FROM app_product_sessions').get() as any).n,0);
    assert.equal((f.sqlite.prepare('SELECT consumed_at FROM app_product_login_challenges WHERE id=?').get(c.begun.challengeId) as any).consumed_at,null);
    f.setFailAudit(false);const session=await consumeProductLogin(f.env,props,c.input),input={sessionToken:session.sessionToken};
    assert.deepEqual(await endProductSession(f.env,props,input),{signedOut:true});assert.deepEqual(await endProductSession(f.env,props,input),{signedOut:true});
    await assert.rejects(productSession(f.env,props,input),code('product_session_invalid'));
  }finally{f.close();}
});
test('every app is served below the central origin and production cannot use loopback or another central origin',async()=>{
  const f=await setup();try{
    f.env.APP_ALLOWED_ORIGINS='http://127.0.0.1:8788';
    assert.equal(productConfiguration(f.env).destinations.courses,'http://127.0.0.1:8788/studio/courses');
    assert.equal(productConfiguration(f.env).destinations.assistant,'http://127.0.0.1:8788/studio/assistant');
    f.env.APP_ENV='production';assert.throws(()=>productConfiguration(f.env),code('products_unavailable'));
    f.env.APP_ALLOWED_ORIGINS='https://attacker.example';assert.throws(()=>productConfiguration(f.env),code('products_unavailable'));
    f.env.APP_ALLOWED_ORIGINS='https://app.techlyup.com';assert.equal(productConfiguration(f.env).destinations.courses,'https://app.techlyup.com/studio/courses');
    f.env.APP_PRODUCTS_ENABLED='false';assert.throws(()=>productConfiguration(f.env),code('products_unavailable'));
  }finally{f.close();}
});
test('approval requires an authenticated canonical session and bounded app requests reject invalid data',async()=>{
  const f=await setup();try{
    const c=await challenge(f);
    assert.equal((await f.call('/products/sign-in/request?challengeId='+c.begun.challengeId)).response.status,401);
    const metadata=await f.call('/products/sign-in/request?challengeId='+c.begun.challengeId,{access:(await account(f,'ios','second@example.test')).body.data.accessToken});
    assert.equal(metadata.response.status,409,'another account cannot adopt an approved request');
    const session=await consumeProductLogin(f.env,props,c.input);
    await assert.rejects(productRequest(f.env,props,{sessionToken:session.sessionToken,method:'POST',path:'/records',body:{text:'x'.repeat(16001)}}),code('body_too_large'));
    await assert.rejects(productRequest(f.env,props,{sessionToken:session.sessionToken,method:'GET',path:'https://attacker.example'}),code('product_request_invalid'));
  }finally{f.close();}
});
test('central Home overview chooses the authenticated account and fails closed when disabled',async()=>{
  const f=await setup();try{
    const second=await account(f,'ios','overview-second@example.test');
    const current=f.sqlite.prepare('SELECT token_hash FROM app_access_tokens WHERE session_id=?').get(f.identity.sessionId) as any;
    assert.ok(current);
    const capture: string[]=[];
    const domain:Parameters<typeof handleProductsHttp>[4]=async(env,appId,user,request)=>{
      assert.equal(appId,'insights');assert.equal(request.method,'GET');assert.equal(request.path,'/overview');assert.equal(env.TECHLYUP_ERP_ORG_ID,'appneural');
      capture.push(user.id);return {status:200,body:{counts:[],recentActivity:[],source:'own_workspace_records'}};
    };
    const noAuth=new Request('https://app.example.test/api/v1/products/overview');
    await assert.rejects(handleProductsHttp(noAuth,f.env,'test','local',domain),code('unauthorized'));
    const request=new Request('https://app.example.test/api/v1/products/overview?accountId='+f.identity.user.id,{headers:{authorization:'Bearer '+second.body.data.accessToken}});
    const result=await handleProductsHttp(request,f.env,'test','local',domain);
    assert.equal(result!.status,200);assert.deepEqual(capture,[second.body.data.user.id]);
    f.env.APP_PRODUCTS_ENABLED='false';
    await assert.rejects(handleProductsHttp(request,f.env,'test','local',domain),code('products_unavailable'));
    assert.equal(capture.length,1);
  }finally{f.close();}
});
