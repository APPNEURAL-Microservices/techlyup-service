import assert from 'node:assert/strict';
import test from 'node:test';
import { account,fixture,signupInput } from './fixture';
import { accountForVerifiedEmail,verifyLivePasscode } from '../src/live/passcode';
import type { LiveLoginEnv,LiveLoginProps } from '../src/live/login';

const props:LiveLoginProps={clientId:'techlyup-live',product:'techlyup',tenantId:'appneural'};
function setup(){
  const f=fixture();
  const env:LiveLoginEnv=Object.assign(f.env,{APP_LIVE_LOGIN_ENABLED:'true',LIVE_LOGIN_CLIENT_ID:'techlyup-live',LIVE_LOGIN_APP_ORIGIN:'https://app.example.test',LIVE_LOGIN_CALLBACK_URL:'https://live.example.test/api/auth/techlyup/callback'});
  return {...f,env};
}

test('a TechlyUp ID and permanent passcode are created in the app, shown once and stored only as a hash',async()=>{
  const f=setup();try{
    const session=(await account(f,'ios',signupInput.email,{accountType:'teacher',teacherRole:'mentor'})).body.data;
    assert.equal((await f.call('/live/passcode')).response.status,401);
    assert.equal((await f.call('/live/passcode',{access:session.accessToken})).body.data,null);
    const created=await f.call('/live/passcode',{access:session.accessToken,body:{}});
    assert.equal(created.response.status,201);assert.match(created.response.headers.get('cache-control')??'',/no-store/);
    const {loginId,passcode}=created.body.data;
    assert.match(loginId,/^TL[2-9A-HJKMNP-Z]{8}$/);assert.match(passcode,/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    const stored=JSON.stringify(f.sqlite.prepare('SELECT * FROM app_live_passcodes').all());
    assert.equal(stored.includes(passcode.replaceAll('-','')),false);assert.match(stored,/scrypt\$/);
    const status=(await f.call('/live/passcode',{access:session.accessToken})).body.data;
    assert.equal(status.loginId,loginId);assert.equal('passcode' in status,false);
    assert.equal((await f.call('/live/passcode',{access:session.accessToken,body:{passcode:'chosen'}})).response.status,422);
    // Any case, with or without dashes.
    const identity=await verifyLivePasscode(f.env,props,{loginId:loginId.toLowerCase(),passcode:passcode.toLowerCase().replaceAll('-',' ')});
    assert.deepEqual(identity,{accountId:session.user.id,email:signupInput.email,name:'Synthetic Learner',emailVerified:true,accountType:'teacher'});
    assert.ok((await f.call('/live/passcode',{access:session.accessToken})).body.data.lastUsedAt);
  }finally{f.close();}
});

test('a new passcode keeps the ID and replaces the old one at once',async()=>{
  const f=setup();try{
    const session=(await account(f)).body.data;
    const first=(await f.call('/live/passcode',{access:session.accessToken,body:{}})).body.data;
    const second=(await f.call('/live/passcode',{access:session.accessToken,body:{}})).body.data;
    assert.equal(second.loginId,first.loginId);assert.notEqual(second.passcode,first.passcode);
    await assert.rejects(verifyLivePasscode(f.env,props,{loginId:first.loginId,passcode:first.passcode}),/incorrect/);
    assert.equal((await verifyLivePasscode(f.env,props,{loginId:first.loginId,passcode:second.passcode})).accountId,session.user.id);
  }finally{f.close();}
});

test('only the bound LIVE caller can verify; wrong, unknown or malformed details fail and guessing is limited',async()=>{
  const f=setup();try{
    const session=(await account(f)).body.data,{loginId,passcode}=(await f.call('/live/passcode',{access:session.accessToken,body:{}})).body.data;
    await assert.rejects(verifyLivePasscode(f.env,{...props,clientId:'someone-else'},{loginId,passcode}),/not authorized/);
    await assert.rejects(verifyLivePasscode(f.env,undefined,{loginId,passcode}),/not authorized/);
    await assert.rejects(verifyLivePasscode(f.env,props,{loginId:'TL22222222',passcode}),/incorrect/);
    await assert.rejects(verifyLivePasscode(f.env,props,{loginId,passcode:'short'}));
    await assert.rejects(verifyLivePasscode(f.env,props,{loginId:'TU7K4M2Q',passcode}));
    for(let attempt=0;attempt<10;attempt++)await assert.rejects(verifyLivePasscode(f.env,props,{loginId,passcode:'2222-2222-2222'}),/incorrect/);
    await assert.rejects(verifyLivePasscode(f.env,props,{loginId,passcode}),/wait/);
  }finally{f.close();}
});

test('a mailbox LIVE has verified signs in to its TechlyUp account; LIVE never gets a new account from it',async()=>{
  const f=setup();try{
    const session=(await account(f)).body.data;
    assert.equal((await accountForVerifiedEmail(f.env,props,{email:` ${signupInput.email.toUpperCase()} `})).accountId,session.user.id);
    await assert.rejects(accountForVerifiedEmail(f.env,props,{email:'nobody@example.test'}),/No TechlyUp account/);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM learner_accounts WHERE email='nobody@example.test'").get()?.n,0);
    await assert.rejects(accountForVerifiedEmail(f.env,{...props,tenantId:'other'},{email:signupInput.email}),/not authorized/);
    for(const values of [{APP_LIVE_LOGIN_ENABLED:'false'},{LIVE_LOGIN_CLIENT_ID:undefined}])await assert.rejects(accountForVerifiedEmail({...f.env,...values},props,{email:signupInput.email}),/not available yet/);
  }finally{f.close();}
});
