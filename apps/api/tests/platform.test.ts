import assert from 'node:assert/strict';
import test from 'node:test';
import { account,fixture } from './fixture';
import { config } from '../src/config';

test('shared platform defaults off and diagnostics require canonical admin rather than service authority',async()=>{
  const f=fixture();try{
    const flags=await f.call('/featureflags');assert.equal(flags.response.status,200);assert.equal(flags.body.data.source,'disabled');assert.ok(Object.values(flags.body.data.flags).every(value=>value===false));
    assert.equal((await f.call('/platform/capabilities')).response.status,401);
    const session=(await account(f)).body.data;
    assert.equal((await f.call('/platform/capabilities',{access:session.accessToken})).response.status,403);
    const now=new Date().toISOString();
    f.sqlite.prepare('INSERT INTO live_core_staff_links(learner_account_id,org_id,actor_id,actor_role,actor_email,actor_name,expires_at,linked_by_actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(session.user.id,'appneural','platform-reader','admin',session.user.email,'Synthetic admin','2099-01-01','operator',now,now);
    const disabled=await f.call('/platform/capabilities',{access:session.accessToken});assert.equal(disabled.response.status,200);assert.equal(disabled.body.data.configured,false);
    f.env.APP_PLATFORM_ENABLED='true';
    assert.equal((await f.call('/featureflags')).response.status,503);
    assert.equal((await f.call('/platform/capabilities',{access:session.accessToken})).response.status,503);
  }finally{f.close();}
});

test('shared bridge enablement requires explicit server-side scope and credential configuration',()=>{
  assert.throws(()=>config({APP_PLATFORM_ENABLED:'true'}));
  assert.throws(()=>config({APP_ENABLED:'true',APP_PLATFORM_ENABLED:'true'}));
});
