import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import test from 'node:test';
import { account,fixture,signupInput } from './fixture';
import { fetch } from '../src/index';
import { hash } from '../src/auth/crypto';

test('disabled defaults and invalid environments never report readiness or issue sessions',async()=>{
  const disabled=await fetch(new Request('https://app.example.test/api/v1/health'),{});
  assert.deepEqual((await disabled.json() as any).data,{status:'disabled',enabled:false});
  const response=await fetch(new Request('https://app.example.test/api/v1/catalog'),{});
  assert.equal(response.status,503);
  for(const values of [{APP_ENABLED:'yes'},{APP_ENABLED:'true'},{APP_ENV:'production',APP_ALLOWED_ORIGINS:'http://app.example.test'}])assert.equal((await fetch(new Request('https://app.example.test/api/v1/health'),values)).status,503);
});

test('native signup/me/logout shares canonical account identity and stores only hashed secrets',async()=>{
  const f=fixture();try{
    const {body,response}=await account(f);const session=body.data;
    assert.match(session.accessToken,/^tlu_a_[a-f0-9]{64}$/);assert.match(session.refreshToken,/^tlu_r_[a-f0-9]{64}$/);
    assert.equal(session.user.emailVerified,false);assert.deepEqual(session.user.roles,['learner']);assert.deepEqual(session.user.permissions,[]);
    assert.equal(response.headers.get('set-cookie'),null);
    assert.match(response.headers.get('cache-control')??'',/no-store/);
    const stored=JSON.stringify({session:f.sqlite.prepare('SELECT * FROM app_sessions').get(),access:f.sqlite.prepare('SELECT * FROM app_access_tokens').get(),refresh:f.sqlite.prepare('SELECT * FROM app_refresh_tokens').get()});
    assert.equal(stored.includes(session.accessToken),false);assert.equal(stored.includes(session.refreshToken),false);assert.equal(stored.includes(signupInput.password),false);
    const me=await f.call('/me',{access:session.accessToken});assert.equal(me.response.status,200);assert.equal(me.body.data.id,session.user.id);
    const loggedOut=await f.call('/auth/logout',{body:{},access:session.accessToken});assert.equal(loggedOut.response.status,200);
    assert.equal((await f.call('/me',{access:session.accessToken})).response.status,401);
    assert.equal((await f.call('/auth/refresh',{body:{refreshToken:session.refreshToken}})).response.status,401);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM app_audit_events WHERE action='auth.logout'").get()?.n,1);
  }finally{f.close();}
});

test('canonical website-format password hashes log in without creating or replacing users',async()=>{
  const f=fixture();try{
    const salt=Buffer.alloc(24,3),password=scryptSync(signupInput.password,salt,32,{N:32768,r:8,p:3,maxmem:64*1024*1024});
    const stored=`scrypt$32768$8$3$${salt.toString('hex')}$${password.toString('hex')}`,id=`acct_${crypto.randomUUID()}`;
    f.sqlite.prepare('INSERT INTO learner_accounts(id,email,name,password_hash,consent_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,signupInput.email,'Canonical Learner',stored,'2026-10','2026-01-01','2026-01-01');
    f.sqlite.prepare('INSERT INTO learner_account_sessions(token_hash,account_id,expires_at,created_at) VALUES(?,?,?,?)').run('canonical-website-session-hash',id,'2099-01-01','2026-01-01');
    const result=await f.call('/auth/login',{body:{email:signupInput.email.toUpperCase(),password:signupInput.password}});
    assert.equal(result.response.status,200);assert.equal(result.body.data.user.id,id);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM learner_accounts').get()?.n,1);
    assert.equal(f.sqlite.prepare('SELECT token_hash FROM learner_account_sessions').get()?.token_hash,'canonical-website-session-hash');
  }finally{f.close();}
});

test('web refresh uses an HttpOnly host cookie, exact origin and no refresh secret in JSON',async()=>{
  const f=fixture();try{
    const created=await account(f,'web'),session=created.body.data,cookie=created.response.headers.get('set-cookie')!;
    assert.equal('refreshToken' in session,false);assert.match(cookie,/^__Host-tlu_app_refresh=/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);assert.doesNotMatch(cookie,/Domain=/);
    const pair=cookie.split(';')[0];
    assert.equal((await f.call('/auth/refresh',{client:'web',body:{},cookie:pair})).response.status,403);
    assert.equal((await f.call('/auth/refresh',{client:'web',body:{},cookie:pair,origin:'https://evil.example.test'})).response.status,403);
    const refreshed=await f.call('/auth/refresh',{client:'web',body:{},cookie:pair,origin:'https://app.example.test'});
    assert.equal(refreshed.response.status,200);assert.equal('refreshToken' in refreshed.body.data,false);
    assert.notEqual(refreshed.response.headers.get('set-cookie')?.split(';')[0],pair);
    assert.equal((await f.call('/me',{access:session.accessToken})).response.status,401);
    const logout=await f.call('/auth/logout',{client:'web',body:{},origin:'https://app.example.test',cookie:refreshed.response.headers.get('set-cookie')!.split(';')[0]});
    assert.equal(logout.response.status,200);assert.match(logout.response.headers.get('set-cookie')??'',/Max-Age=0/);
  }finally{f.close();}
});

test('refresh rotation rejects replay and revokes that family without revoking another device',async()=>{
  const f=fixture();try{
    const first=(await account(f)).body.data;
    const other=(await f.call('/auth/login',{client:'android',body:{email:signupInput.email,password:signupInput.password}})).body.data;
    const rotated=await f.call('/auth/refresh',{body:{refreshToken:first.refreshToken}});assert.equal(rotated.response.status,200);
    const replay=await f.call('/auth/refresh',{body:{refreshToken:first.refreshToken}});assert.equal(replay.response.status,401);assert.equal(replay.body.error.code,'refresh_replayed');
    assert.equal((await f.call('/me',{access:rotated.body.data.accessToken})).response.status,401);
    assert.equal((await f.call('/auth/refresh',{body:{refreshToken:rotated.body.data.refreshToken}})).response.status,401);
    assert.equal((await f.call('/me',{access:other.accessToken,client:'android'})).response.status,200);
  }finally{f.close();}
});

test('concurrent refresh cannot mint two surviving token branches',async()=>{
  const f=fixture();try{
    const session=(await account(f)).body.data;
    const results=await Promise.all([f.call('/auth/refresh',{body:{refreshToken:session.refreshToken}}),f.call('/auth/refresh',{body:{refreshToken:session.refreshToken}})]);
    assert.equal(results.filter(result=>result.response.status===200).length,1);
    assert.equal(results.filter(result=>result.response.status===401).length,1);
    const winner=results.find(result=>result.response.status===200)!;
    assert.equal((await f.call('/me',{access:winner.body.data.accessToken})).response.status,401);
  }finally{f.close();}
});

test('canonical password changes and session expiry revoke app credentials immediately',async()=>{
  const f=fixture();try{
    const session=(await account(f)).body.data;
    f.sqlite.prepare('UPDATE learner_accounts SET password_hash=? WHERE id=?').run('changed-canonical-password-hash',session.user.id);
    assert.equal((await f.call('/me',{access:session.accessToken})).response.status,401);
    assert.equal((await f.call('/auth/refresh',{body:{refreshToken:session.refreshToken}})).response.status,401);
    const second=(await account(f,'ios','second@example.test')).body.data;
    f.sqlite.exec("UPDATE app_access_tokens SET expires_at='2000-01-01'");
    assert.equal((await f.call('/me',{access:second.accessToken})).response.status,401);
    f.sqlite.exec("UPDATE app_sessions SET expires_at='2001-01-01',created_at='2000-01-01'");
    assert.equal((await f.call('/auth/refresh',{body:{refreshToken:second.refreshToken}})).response.status,401);
  }finally{f.close();}
});

test('current canonical staff links grant and revoke admin roles without re-login',async()=>{
  const f=fixture();try{
    const session=(await account(f)).body.data,id=session.user.id;
    assert.equal((await f.call('/admin/overview',{access:session.accessToken})).response.status,403);
    const now=new Date().toISOString(),future=new Date(Date.now()+3600000).toISOString();
    f.sqlite.prepare('INSERT INTO live_core_staff_links(learner_account_id,org_id,actor_id,actor_role,actor_email,actor_name,expires_at,linked_by_actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'appneural','trusted-actor','admin',signupInput.email,'Trusted admin',future,'reviewed-operator',now,now);
    assert.equal((await f.call('/admin/overview',{access:session.accessToken})).response.status,200);
    f.sqlite.prepare('UPDATE live_core_staff_links SET actor_role=?').run('member');
    f.sqlite.prepare('INSERT INTO webinar_erp_roles(org_id,actor_id,functional_role,created_at) VALUES(?,?,?,?)').run('appneural','trusted-actor','mentor',now);
    const mentor=await f.call('/me',{access:session.accessToken});assert.ok(mentor.body.data.permissions.includes('mentor'));assert.equal(mentor.body.data.permissions.includes('admin'),false);
    assert.equal((await f.call('/admin/overview',{access:session.accessToken})).response.status,403);
    f.sqlite.exec("UPDATE live_core_staff_links SET actor_email='different@example.test'");
    assert.deepEqual((await f.call('/me',{access:session.accessToken})).body.data.roles,['learner']);
    f.sqlite.prepare('UPDATE live_core_staff_links SET actor_email=?,expires_at=?').run(signupInput.email,'2000-01-01');
    assert.deepEqual((await f.call('/me',{access:session.accessToken})).body.data.roles,['learner']);
  }finally{f.close();}
});

test('profile writes validate taxonomy, reject identity/role injection and roll back on audit failure',async()=>{
  const f=fixture();try{
    const session=(await account(f)).body.data;
    const body={firstName:'Updated',lastName:'Learner',audienceIds:['professionals'],goalIds:['learn-a-new-skill'],interestIds:['programming']};
    for(const invalid of [{...body,id:'another-account'},{...body,roles:['admin']},{...body,email:'owner@example.test'},{...body,interestIds:['invented']}])assert.equal((await f.call('/profile',{method:'PATCH',body:invalid,access:session.accessToken})).response.status,422);
    const updated=await f.call('/profile',{method:'PATCH',body,access:session.accessToken});assert.equal(updated.response.status,200);assert.equal(updated.body.data.firstName,'Updated');
    f.setFailAudit(true);
    assert.equal((await f.call('/profile',{method:'PATCH',body:{...body,firstName:'Should roll back'},access:session.accessToken})).response.status,503);
    assert.equal(f.sqlite.prepare('SELECT first_name FROM learner_accounts WHERE id=?').get(session.user.id)?.first_name,'Updated');
    assert.equal(f.sqlite.prepare('SELECT email FROM learner_accounts WHERE id=?').get(session.user.id)?.email,signupInput.email);
  }finally{f.close();}
});

test('failed audit persistence rolls back signup and refresh token changes',async()=>{
  const f=fixture();try{
    f.setFailAudit(true);
    const denied=await f.call('/auth/signup',{body:signupInput});assert.equal(denied.response.status,503);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM learner_accounts').get()?.n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM app_sessions').get()?.n,0);
    f.setFailAudit(false);const session=(await account(f)).body.data;f.setFailAudit(true);
    const failed=await f.call('/auth/refresh',{body:{refreshToken:session.refreshToken}});assert.equal(failed.response.status,503);
    assert.equal(f.sqlite.prepare('SELECT consumed_at FROM app_refresh_tokens WHERE token_hash=?').get(await hash(session.refreshToken))?.consumed_at,null);
    assert.equal((await f.call('/me',{access:session.accessToken})).response.status,200);
  }finally{f.close();}
});

test('request body bounds, exact schemas, CORS allowlist and rate limits fail closed',async()=>{
  const f=fixture();try{
    for(const [body,status] of [[{...signupInput,role:'admin'},422],[{...signupInput,password:'short'},422],[{...signupInput,firstName:'x'.repeat(17000)},413]] as const){assert.equal((await f.call('/auth/signup',{body})).response.status,status);}
    const missingType=await fetch(new Request('https://app.example.test/api/v1/auth/login',{method:'POST',headers:{'x-techlyup-client':'ios'},body:'{}'}),f.env);assert.equal(missingType.status,415);
    const badOrigin=await f.call('/catalog',{origin:'https://evil.example.test'});assert.equal(badOrigin.response.status,403);assert.equal(badOrigin.response.headers.get('access-control-allow-origin'),null);
    const goodOrigin=await f.call('/catalog',{origin:'https://app.example.test'});assert.equal(goodOrigin.response.headers.get('access-control-allow-origin'),'https://app.example.test');
    const key=await hash(`signup-email:${signupInput.email}:${Math.floor(Date.now()/3600000)}`);
    f.sqlite.prepare('INSERT INTO app_rate_limits(id,expires_at,count) VALUES(?,?,?)').run(key,'2099-01-01',5);
    const limited=await f.call('/auth/signup',{body:signupInput});assert.equal(limited.response.status,429);assert.ok(limited.response.headers.get('retry-after'));
    f.sqlite.exec('DROP TABLE app_rate_limits');assert.equal((await f.call('/auth/signup',{body:{...signupInput,email:'other@example.test'}})).response.status,503);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM learner_accounts').get()?.n,0);
  }finally{f.close();}
});

test('analytics require authentication and flag, accept only bounded non-PII dimensions',async()=>{
  const f=fixture();try{
    const event={event:'screen_view',screen:'home'};
    assert.equal((await f.call('/events',{body:event})).response.status,401);
    const session=(await account(f)).body.data;
    assert.equal((await f.call('/events',{body:event,access:session.accessToken})).response.status,503);
    f.env.APP_ANALYTICS_ENABLED='true';
    assert.equal((await f.call('/events',{body:{...event,email:signupInput.email},access:session.accessToken})).response.status,422);
    assert.equal((await f.call('/events',{body:event,access:session.accessToken})).response.status,202);
    const stored=f.sqlite.prepare('SELECT * FROM app_analytics_events').get()!;assert.equal(stored.account_id,session.user.id);assert.equal('email' in stored,false);
  }finally{f.close();}
});
