import test from 'node:test';
import assert from 'node:assert/strict';
import {fetch} from '../src/index';
import type {Env} from '../src/types';

function setup(enabled=true){
  const forwarded:Request[]=[],assets:string[]=[];
  const env:Env={APP_ENV:'production',APP_ENABLED:'true',APP_PRODUCTS_ENABLED:enabled?'true':'false',APP_ALLOWED_ORIGINS:'https://app.techlyup.com',TECHLYUP_ERP_ORG_ID:'appneural',
    ASSETS:{async fetch(request){assets.push(new URL(request.url).pathname);return new Response('<html>central page</html>',{headers:{'Content-Type':'text/html'}});}},
    STUDIO_COURSES:{async fetch(request){forwarded.push(request);const headers=new Headers({'Content-Type':'application/json'});
      headers.append('Set-Cookie','__Host-tu_courses_session=new; Path=/; HttpOnly; Secure; SameSite=Lax');
      headers.append('Set-Cookie','__Host-tlu_app_refresh=replaced; Path=/; HttpOnly; Secure');
      headers.append('Set-Cookie','__Host-tu_earnings_session=replaced; Path=/; HttpOnly; Secure');
      return new Response('{"app":"courses"}',{status:201,headers});}}};
  return {env,forwarded,assets};
}
const cookies='__Host-tlu_app_refresh=central-secret; __Host-tu_courses_session=courses-token; __Host-tu_earnings_session=earnings-token; __Host-tu_courses_login=pending; theme=light';

test('the central origin forwards /studio/<app> to that app Worker with only its own cookies',async()=>{
  const f=setup();
  const response=await fetch(new Request('https://app.techlyup.com/studio/courses/api/workspace/records?resource=courses',{method:'POST',headers:{Cookie:cookies,Authorization:'Bearer tlu_a_secret',Origin:'https://app.techlyup.com','Content-Type':'application/json'},body:'{"resource":"courses"}'}),f.env);
  assert.equal(response.status,201);assert.equal(f.assets.length,0);
  const [request]=f.forwarded;
  assert.equal(request.url,'https://app.techlyup.com/studio/courses/api/workspace/records?resource=courses');
  assert.equal(request.method,'POST');assert.equal(await request.text(),'{"resource":"courses"}');assert.equal(request.headers.get('Origin'),'https://app.techlyup.com');
  assert.equal(request.headers.get('Cookie'),'__Host-tu_courses_session=courses-token; __Host-tu_courses_login=pending');
  assert.equal(request.headers.get('Authorization'),null);
  assert.deepEqual(response.headers.getSetCookie(),['__Host-tu_courses_session=new; Path=/; HttpOnly; Secure; SameSite=Lax'],'An app cannot replace central or other app cookies.');
  await fetch(new Request('https://app.techlyup.com/studio/courses'),f.env);
  assert.equal(new URL(f.forwarded[1].url).pathname,'/studio/courses');assert.equal(f.forwarded[1].headers.get('Cookie'),null);
});
test('unreleased, unbound or unknown apps keep the central page',async()=>{
  for(const [f,path] of [[setup(false),'/studio/courses/'],[setup(),'/studio/earnings/'],[setup(),'/studio/unknown/'],[setup(),'/studio/coursesx'],[setup(),'/studio'],[setup(),'/courses']] as const){
    const response=await fetch(new Request('https://app.techlyup.com'+path,{headers:{Cookie:cookies}}),f.env);
    assert.equal(await response.text(),'<html>central page</html>');assert.equal(f.forwarded.length,0);assert.deepEqual(f.assets,[path]);
  }
  const off=setup();off.env.APP_ENABLED='false';
  await fetch(new Request('https://app.techlyup.com/studio/courses/'),off.env);assert.equal(off.forwarded.length,0);
});
test('production requires HTTPS before forwarding and an unavailable app fails closed',async()=>{
  const f=setup();
  assert.equal((await fetch(new Request('http://app.techlyup.com/studio/courses/'),f.env)).status,403);assert.equal(f.forwarded.length,0);
  f.env.STUDIO_COURSES={async fetch(){throw new Error('binding unavailable');}};
  const failed=await fetch(new Request('https://app.techlyup.com/studio/courses/'),f.env);
  assert.equal(failed.status,503);assert.equal(failed.headers.get('Cache-Control'),'no-store');
});
