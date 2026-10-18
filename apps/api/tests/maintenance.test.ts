import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanup } from '../src/maintenance';
import { account,fixture } from './fixture';
import { fetch } from '../src/index';

test('readiness verifies all app tables and production requests require HTTPS',async()=>{
  const f=fixture();try{
    assert.equal((await f.call('/health')).response.status,200);
    f.sqlite.exec('DROP TABLE app_analytics_events');
    assert.equal((await f.call('/health')).response.status,503);
    f.env.APP_ENV='production';
    assert.equal((await fetch(new Request('http://app.example.test/api/v1/health'),f.env)).status,403);
    assert.equal((await fetch(new Request('http://app.example.test/'),f.env)).status,403);
    const secured=await fetch(new Request('https://app.example.test/api/v1/health'),f.env);
    assert.equal(secured.headers.get('strict-transport-security'),'max-age=31536000');
  }finally{f.close();}
});

test('cleanup is bounded and retains active sessions, refresh replay evidence and audit events',async()=>{
  const f=fixture();try{
    const session=(await account(f)).body.data;
    const insert=f.sqlite.prepare('INSERT INTO app_rate_limits(id,expires_at,count) VALUES(?,?,1)');
    for(let index=0;index<1100;index++)insert.run(index.toString(16).padStart(64,'0'),'2000-01-01');
    const before=f.sqlite.prepare('SELECT count(*) n FROM app_audit_events').get()?.n;
    await cleanup(f.env);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM app_rate_limits WHERE expires_at='2000-01-01'").get()?.n,100);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM app_audit_events').get()?.n,before);
    assert.equal((await f.call('/me',{access:session.accessToken})).response.status,200);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM app_refresh_tokens').get()?.n,1);
  }finally{f.close();}
});
