import assert from 'node:assert/strict';
import test from 'node:test';
import { account,codeLogin,emailCode,fixture,signupInput } from './fixture';
import { beginLiveLogin,consumeLiveLogin,type LiveLoginEnv,type LiveLoginProps } from '../src/live/login';

/** Schema-valid but never issued: requests that fail validation or referral checks never reach the code. */
const unissued={challengeId:`otp_${'0'.repeat(32)}`,code:'000000'};
const props:LiveLoginProps={clientId:'techlyup-live',product:'techlyup',tenantId:'appneural'};
function setup(){
  const f=fixture();
  const env:LiveLoginEnv=Object.assign(f.env,{APP_LIVE_LOGIN_ENABLED:'true',LIVE_LOGIN_CLIENT_ID:'techlyup-live',LIVE_LOGIN_APP_ORIGIN:'https://app.example.test',LIVE_LOGIN_CALLBACK_URL:'https://live.example.test/api/auth/techlyup/callback'});
  return {...f,env};
}
async function pkce(){const verifier=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),pkceChallenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');return {verifier,pkceChallenge};}

test('signup stores normalized self-declared registration details and an own referral code, without granting roles',async()=>{
  const f=fixture();try{
    const session=(await account(f)).body.data;
    assert.equal(session.user.registration.phone,'+919876543210');assert.equal(session.user.registration.accountType,'student');assert.equal(session.user.registration.city,'Jaipur');
    assert.match(session.user.registration.referralCode,/^TU[2-9A-HJKMNP-Z]{6}$/);
    const teacher=(await account(f,'ios','teacher@example.test',{phone:'+91 70000-12345',accountType:'teacher',teacherRole:'mentor'})).body.data;
    assert.equal(teacher.user.registration.accountType,'teacher');assert.equal(teacher.user.registration.teacherRole,'mentor');assert.deepEqual(teacher.user.roles,session.user.roles);assert.deepEqual(teacher.user.permissions,[]);
    const me=await f.call('/me',{access:teacher.accessToken});assert.deepEqual(me.body.data.registration,teacher.user.registration);
    const stored=f.sqlite.prepare('SELECT phone,account_type,city,referred_by_account_id FROM app_account_registrations WHERE account_id=?').get(teacher.user.id);
    assert.deepEqual({...stored},{phone:'+917000012345',account_type:'teacher',city:'Jaipur',referred_by_account_id:null});
  }finally{f.close();}
});

test('referral codes link the referrer only when they exist; required registration fields fail with field messages',async()=>{
  const f=fixture();try{
    const referrer=(await account(f)).body.data.user;
    const referred=await account(f,'ios','friend@example.test',{referralCode:` ${referrer.registration.referralCode.toLowerCase()} `});
    assert.equal(referred.response.status,201);
    assert.equal(f.sqlite.prepare('SELECT referred_by_account_id r FROM app_account_registrations WHERE account_id=?').get(referred.body.data.user.id)?.r,referrer.id);
    const empty=await account(f,'ios','empty@example.test',{referralCode:''});assert.equal(empty.response.status,201);
    // A rejected referral does not spend the email code: the same code works once the field is fixed.
    const issued=await emailCode(f,'unknown@example.test');
    const unknown=await f.call('/auth/signup',{body:{...signupInput,email:'unknown@example.test',referralCode:'TU222222',...issued}});
    assert.equal(unknown.response.status,422);assert.match(unknown.body.error.fields.referralCode,/not valid/);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM learner_accounts WHERE email='unknown@example.test'").get()?.n,0);
    assert.equal((await f.call('/auth/signup',{body:{...signupInput,email:'unknown@example.test',...issued}})).response.status,201);
    const {phone:_p,accountType:_a,city:_c,...missing}=signupInput;
    const invalid=await f.call('/auth/signup',{body:{...missing,email:'missing@example.test',...unissued}});
    assert.equal(invalid.response.status,422);assert.deepEqual(Object.keys(invalid.body.error.fields).sort(),['accountType','city','phone']);
    for(const body of [{...signupInput,email:'a@example.test',phone:'12345',...unissued},{...signupInput,email:'b@example.test',accountType:'admin',...unissued},{...signupInput,email:'c@example.test',city:'<script>',...unissued}])
      assert.equal((await f.call('/auth/signup',{body})).response.status,422);
  }finally{f.close();}
});

test('TechlyUp LIVE sign-in needs binding props, an app session approval, the original PKCE verifier and a single use',async()=>{
  const f=setup();try{
    const session=(await account(f)).body.data,p=await pkce();
    await assert.rejects(beginLiveLogin(f.env,{...props,clientId:'someone-else'},{pkceChallenge:p.pkceChallenge}),/not authorized/);
    await assert.rejects(beginLiveLogin(f.env,undefined,{pkceChallenge:p.pkceChallenge}),/not authorized/);
    const begun=await beginLiveLogin(f.env,props,{pkceChallenge:p.pkceChallenge});
    assert.equal(begun.authorizeUrl,`https://app.example.test/live/sign-in?challengeId=${begun.challengeId}`);
    assert.equal((await f.call('/live/sign-in/authorize',{body:{challengeId:begun.challengeId}})).response.status,401);
    const approved=await f.call('/live/sign-in/authorize',{access:session.accessToken,body:{challengeId:begun.challengeId}});
    assert.equal(approved.response.status,200);
    const redirect=new URL(approved.body.data.redirectUrl);
    assert.equal(redirect.origin+redirect.pathname,'https://live.example.test/api/auth/techlyup/callback');
    assert.equal(redirect.searchParams.get('challengeId'),begun.challengeId);
    const code=redirect.searchParams.get('code')!;
    assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM app_live_login_challenges').all()).includes(code),false);
    const stolen=await pkce();
    await assert.rejects(consumeLiveLogin(f.env,props,{challengeId:begun.challengeId,code,verifier:stolen.verifier}),/invalid or expired/);
    const identity=await consumeLiveLogin(f.env,props,{challengeId:begun.challengeId,code,verifier:p.verifier});
    assert.deepEqual(identity,{accountId:session.user.id,email:signupInput.email,name:'Synthetic Learner',emailVerified:true,accountType:'student'});
    await assert.rejects(consumeLiveLogin(f.env,props,{challengeId:begun.challengeId,code,verifier:p.verifier}),/invalid or expired/);
    assert.equal((await f.call('/live/sign-in/authorize',{access:session.accessToken,body:{challengeId:begun.challengeId}})).response.status,409);
  }finally{f.close();}
});

test('a signed-out app session or a different account cannot complete another approval, and defaults stay off',async()=>{
  const f=setup();try{
    const first=(await account(f)).body.data,second=(await account(f,'ios','second@example.test')).body.data,p=await pkce();
    const begun=await beginLiveLogin(f.env,props,{pkceChallenge:p.pkceChallenge});
    const approved=await f.call('/live/sign-in/authorize',{access:first.accessToken,body:{challengeId:begun.challengeId}});
    assert.equal((await f.call('/live/sign-in/authorize',{access:second.accessToken,body:{challengeId:begun.challengeId}})).response.status,409);
    await f.call('/auth/logout',{body:{},access:first.accessToken});
    const code=new URL(approved.body.data.redirectUrl).searchParams.get('code')!;
    await assert.rejects(consumeLiveLogin(f.env,props,{challengeId:begun.challengeId,code,verifier:p.verifier}),/invalid or expired/);
    for(const values of [{APP_LIVE_LOGIN_ENABLED:'false'},{LIVE_LOGIN_CALLBACK_URL:'http://live.example.test/callback'},{LIVE_LOGIN_APP_ORIGIN:'https://elsewhere.example.test'},{LIVE_LOGIN_CALLBACK_URL:'https://live.example.test/callback?next=x'}]){
      const env={...f.env,...values};
      await assert.rejects(beginLiveLogin(env,props,{pkceChallenge:p.pkceChallenge}),/not available yet/);
    }
  }finally{f.close();}
});

test('a canonical database before website 0041 (no staff links) still serves signup and sign-in as learners only',async()=>{
  const f=fixture();try{
    f.sqlite.exec('DROP TABLE live_core_staff_links');
    const health=await f.call('/health');assert.equal(health.response.status,200);assert.equal(health.body.data.staffLinks,false);
    const session=(await account(f)).body.data;assert.deepEqual(session.user.roles,['learner']);assert.deepEqual(session.user.permissions,[]);
    assert.equal((await f.call('/me',{access:session.accessToken})).response.status,200);
    assert.equal((await codeLogin(f)).response.status,200);
    f.sqlite.exec('DROP TABLE app_account_registrations');
    assert.equal((await f.call('/health')).response.status,503);
  }finally{f.close();}
});
