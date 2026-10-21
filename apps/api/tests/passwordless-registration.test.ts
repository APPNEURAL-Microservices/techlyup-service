import assert from 'node:assert/strict';
import test from 'node:test';
import { account,codeLogin,emailCode,fixture,signupInput } from './fixture';
import { consumeCode } from '../src/auth/otp';

const unissued={challengeId:`otp_${'0'.repeat(32)}`,code:'000000'};

test('email codes go only where they can be used, and the response never reveals whether an email is registered',async()=>{
  const f=fixture();try{
    const fresh=await f.call('/auth/otp',{body:{email:' New@Example.test ',purpose:'signup'}});
    assert.equal(fresh.response.status,202);assert.match(fresh.body.data.challengeId,/^otp_[0-9a-f]{32}$/);assert.equal(fresh.body.data.expiresIn,600);
    const sent=f.outbox.at(-1)!;assert.equal(sent.to,'new@example.test');assert.match(sent.text,/code is \d{6}/);
    const code=/code is (\d{6})/.exec(sent.text)![1]!;
    // Only hashes are stored: neither the code nor the address appears in the challenge table.
    const stored=JSON.stringify(f.sqlite.prepare('SELECT * FROM app_email_otp_challenges').all());
    assert.equal(stored.includes(code),false);assert.equal(stored.includes('new@example.test'),false);
    await account(f);
    const existing=await f.call('/auth/otp',{body:{email:signupInput.email,purpose:'signup'}});
    const unknown=await f.call('/auth/otp',{body:{email:'nobody@example.test',purpose:'login'}});
    for(const result of [existing,unknown]){assert.equal(result.response.status,202);assert.deepEqual(Object.keys(result.body.data).sort(),['challengeId','expiresIn']);}
    assert.match(f.outbox.at(-2)!.subject,/already have a TechlyUp account/);assert.doesNotMatch(f.outbox.at(-2)!.text,/\d{6}/);assert.match(f.outbox.at(-2)!.text,/https:\/\/app\.example\.test\/sign-in/);
    assert.match(f.outbox.at(-1)!.subject,/Sign in to TechlyUp/);assert.doesNotMatch(f.outbox.at(-1)!.text,/\d{6}/);
    // A notice without a code never verifies, whatever is guessed.
    assert.equal((await f.call('/auth/otp/login',{body:{email:'nobody@example.test',challengeId:unknown.body.data.challengeId,code:'123456'}})).response.status,401);
  }finally{f.close();}
});

test('a code works once, for its own email and purpose, within ten minutes and five attempts',async()=>{
  const f=fixture();try{
    await account(f);
    const login=await emailCode(f,signupInput.email,'login');
    const wrong=login.code==='111111'?'222222':'111111';
    const denied=await f.call('/auth/otp/login',{body:{email:signupInput.email,challengeId:login.challengeId,code:wrong}});
    assert.equal(denied.response.status,401);assert.equal(denied.body.error.code,'invalid_code');assert.ok(denied.body.error.fields.code);
    assert.equal((await f.call('/auth/otp/login',{body:{email:'other@example.test',...login}})).response.status,401);
    const ok=await f.call('/auth/otp/login',{body:{email:signupInput.email,...login}});assert.equal(ok.response.status,200);
    assert.equal((await f.call('/auth/otp/login',{body:{email:signupInput.email,...login}})).response.status,401);
    // A sign-up code cannot sign in, and five wrong guesses lock the challenge even for the right code.
    const forSignup=await emailCode(f,'later@example.test','signup');
    await assert.rejects(consumeCode(f.db,'login','later@example.test',forSignup.challengeId,forSignup.code),/not valid/);
    const locked=await emailCode(f,signupInput.email,'login');
    for(let attempt=0;attempt<5;attempt++)await assert.rejects(consumeCode(f.db,'login',signupInput.email,locked.challengeId,locked.code==='999999'?'888888':'999999'));
    await assert.rejects(consumeCode(f.db,'login',signupInput.email,locked.challengeId,locked.code),/not valid/);
    const expired=await emailCode(f,'expiry@example.test','signup');
    await assert.rejects(consumeCode(f.db,'signup','expiry@example.test',expired.challengeId,expired.code,new Date(Date.now()+601000)),/not valid/);
  }finally{f.close();}
});

test('missing or failing email delivery fails closed and spends nothing',async()=>{
  const f=fixture();try{
    const send=f.env.EMAIL!.send;
    f.env.EMAIL!.send=async()=>{throw Object.assign(new Error('synthetic'),{code:'E_RECIPIENT_SUPPRESSED'});};
    const rejected=await f.call('/auth/otp',{body:{email:'bounce@example.test',purpose:'signup'}});
    assert.equal(rejected.response.status,502);assert.equal(rejected.body.error.code,'email_failed');
    f.env.EMAIL!.send=async()=>({});
    assert.equal((await f.call('/auth/otp',{body:{email:'unsure@example.test',purpose:'signup'}})).body.error.code,'email_unconfirmed');
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM app_email_otp_challenges WHERE consumed_at IS NULL').get()?.n,0);
    f.env.EMAIL!.send=send;delete f.env.EMAIL_FROM;
    const unavailable=await f.call('/auth/otp',{body:{email:'later@example.test',purpose:'signup'}});
    assert.equal(unavailable.response.status,503);assert.equal(unavailable.body.error.code,'email_unavailable');
    assert.equal((await f.call('/health')).body.data.emailCodes,false);
  }finally{f.close();}
});

test('passwordless accounts start verified, cannot use password sign-in and only accept their own email',async()=>{
  const f=fixture();try{
    const session=(await account(f)).body.data;
    assert.equal(session.user.emailVerified,true);
    for(const password of ['',' ','a strong synthetic password 123'])assert.notEqual((await f.call('/auth/login',{body:{email:signupInput.email,password}})).response.status,200);
    assert.equal((await codeLogin(f)).body.data.user.id,session.user.id);
    // A code issued for one address cannot create an account for another.
    const issued=await emailCode(f,'owner@example.test');
    assert.equal((await f.call('/auth/signup',{body:{...signupInput,email:'intruder@example.test',...issued}})).response.status,401);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM learner_accounts WHERE email='intruder@example.test'").get()?.n,0);
    assert.equal((await f.call('/auth/signup',{body:{...signupInput,password:'old style password 123',...unissued}})).response.status,422);
  }finally{f.close();}
});

test('onboarding details and consent history are stored; teacher roles are descriptive and grant nothing',async()=>{
  const f=fixture();try{
    const mentor=(await account(f,'ios','mentor@example.test',{accountType:'teacher',teacherRole:'mentor',preferredLanguage:'hi-en',institution:'  Synthetic Institute ',interestIds:['ai-technology','ai-technology'],updatesConsent:true})).body.data;
    assert.deepEqual(mentor.user.registration,{accountType:'teacher',teacherRole:'mentor',phone:'+919876543210',city:'Jaipur',referralCode:mentor.user.registration.referralCode,preferredLanguage:'hi-en',institution:'Synthetic Institute',ageGroup:'adult'});
    assert.deepEqual(mentor.user.interestIds,['ai-technology']);assert.deepEqual(mentor.user.roles,['learner']);assert.deepEqual(mentor.user.permissions,[]);
    assert.deepEqual((await f.call('/me',{access:mentor.accessToken})).body.data.registration,mentor.user.registration);
    const consents=f.sqlite.prepare('SELECT purpose,version,granted FROM app_consent_records WHERE account_id=? ORDER BY purpose').all(mentor.user.id).map(row=>({...row}));
    assert.deepEqual(consents,[{purpose:'account_terms',version:'2026-10-21',granted:1},{purpose:'webinar_updates',version:'2026-10-21',granted:1}]);
    for(const [extra,field] of [[{accountType:'teacher'},'teacherRole'],[{teacherRole:'instructor'},'teacherRole'],[{teacherRole:'admin',accountType:'teacher'},'teacherRole'],[{interestIds:['not-listed']},'interestIds'],[{preferredLanguage:'fr'},'preferredLanguage']] as const){
      const result=await f.call('/auth/signup',{body:{...signupInput,email:'invalid@example.test',...extra,...unissued}});
      assert.equal(result.response.status,422);assert.ok(Object.keys(result.body.error.fields).some(key=>key.split('.')[0]===field),field);
    }
  }finally{f.close();}
});

test('learners under 18 need a guardian’s name, own email and agreement, which stay private',async()=>{
  const f=fixture();try{
    const minor={ageGroup:'minor',guardianName:'Synthetic Guardian',guardianEmail:'guardian@example.test',guardianConsent:true};
    for(const [extra,field] of [[{ageGroup:'minor'},'guardianName'],[{...minor,guardianEmail:signupInput.email},'guardianEmail'],[{...minor,guardianConsent:undefined},'guardianConsent'],[{...minor,accountType:'teacher',teacherRole:'academic'},'ageGroup'],[{guardianName:'Someone'},'ageGroup']] as const){
      const result=await f.call('/auth/signup',{body:{...signupInput,...extra,...unissued}});
      assert.equal(result.response.status,422);assert.ok(result.body.error.fields[field],field);
    }
    const learner=(await account(f,'ios',signupInput.email,minor)).body.data;
    assert.equal(learner.user.registration.ageGroup,'minor');
    assert.equal(JSON.stringify((await f.call('/me',{access:learner.accessToken})).body.data).includes('guardian'),false);
    const stored=f.sqlite.prepare('SELECT guardian_name,guardian_email,guardian_consent_at IS NOT NULL agreed FROM app_account_onboarding WHERE account_id=?').get(learner.user.id);
    assert.deepEqual({...stored},{guardian_name:'Synthetic Guardian',guardian_email:'guardian@example.test',agreed:1});
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM app_consent_records WHERE account_id=? AND purpose='guardian' AND granted=1").get(learner.user.id)?.n,1);
  }finally{f.close();}
});

test('code requests are limited per email',async()=>{
  const f=fixture();try{
    for(let request=0;request<3;request++)assert.equal((await f.call('/auth/otp',{body:{email:'busy@example.test',purpose:'signup'}})).response.status,202);
    const limited=await f.call('/auth/otp',{body:{email:'busy@example.test',purpose:'signup'}});
    assert.equal(limited.response.status,429);assert.equal(f.outbox.length,3);
  }finally{f.close();}
});
