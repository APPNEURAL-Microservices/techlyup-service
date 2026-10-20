import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {fixture,account} from './fixture';
import {SupportService} from '../src/credits/service';
import {readCapture,processSupportFunding,checkout,verifyPurchase,purchaseStatus,createPurchase} from '../src/credits/payments';
import type {SupportEnv,SupportProps,RpcResult} from '../src/credits/types';
import {hash} from '../src/auth/crypto';

const props:SupportProps={clientId:'techlyup-live',product:'techlyup',tenantId:'appneural'};
const live={liveSubject:'live-user-fixture',sessionBinding:'a'.repeat(64)};
function unwrap<T>(value:RpcResult<T>):T{assert.equal(value.ok,true,value.ok?'':value.error.code);if(!value.ok)throw new Error('Fixture action failed');return value.data;}
function setup(){const f=fixture();f.sqlite.exec(readFileSync(new URL('../../../migrations/d1/0052_support_credits.sql',import.meta.url),'utf8'));const env:SupportEnv=Object.assign(f.env,{APP_SUPPORT_CREDITS_ENABLED:'true',SUPPORT_EXPECTED_CLIENT_ID:'techlyup-live',SUPPORT_LEARNER_ISSUER:'techlyup-learners',SUPPORT_PUBLIC_ORIGIN:'https://app.example.test'});return {...f,env,service:new SupportService(env,props)};}
async function pkce(){const verifier=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),pkceChallenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');return {verifier,pkceChallenge};}
async function link(f:ReturnType<typeof setup>){
 const session=(await account(f)).body.data,p=await pkce(),begun=unwrap(await f.service.beginLink({...live,pkceChallenge:p.pkceChallenge}));
 const authorized=await f.call('/support/link/authorize',{access:session.accessToken,body:{challengeId:begun.challengeId,confirm:true}});assert.equal(authorized.response.status,200);
 unwrap(await f.service.consumeLink({...live,challengeId:begun.challengeId,code:authorized.body.data.code,verifier:p.verifier}));return {session,p,begun,code:authorized.body.data.code as string};
}
function paymentConfig(f:ReturnType<typeof setup>){Object.assign(f.env,{APP_SUPPORT_TEST_PAYMENTS_ENABLED:'true',SUPPORT_RAZORPAY_MODE:'test',SUPPORT_RAZORPAY_KEY_ID:'rzp_test_synthetic',SUPPORT_RAZORPAY_KEY_SECRET:'synthetic-key-secret',SUPPORT_RAZORPAY_WEBHOOK_SECRET:'synthetic-webhook-secret'});}
function provider(){
 const orders=new Map<string,any>(),payments=new Map<string,any>(),state={posts:0,losePost:false,allMethods:[] as string[]};
 const fetcher:typeof fetch=async (raw,init)=>{const u=new URL(String(raw)),method=init?.method??'GET';assert.equal(u.origin,'https://api.razorpay.com');state.allMethods.push(method);
  if(u.pathname==='/v1/orders'&&method==='POST'){state.posts++;const body=JSON.parse(String(init?.body)),order={...body,id:'order_Fixture'+state.posts,status:'created',amount_paid:0};orders.set(order.id,order);if(state.losePost)throw new Error('Synthetic response loss');return Response.json(order);}
  if(u.pathname==='/v1/orders')return Response.json({items:[...orders.values()].filter(v=>v.receipt===u.searchParams.get('receipt'))});
  if(u.pathname.endsWith('/payments')&&u.pathname.includes('/orders/'))return Response.json({items:[...payments.values()].filter(v=>v.order_id===u.pathname.split('/')[3])});
  if(u.pathname.startsWith('/v1/payments/'))return Response.json(payments.get(u.pathname.split('/').at(-1)!));
  if(u.pathname.startsWith('/v1/orders/'))return Response.json(orders.get(u.pathname.split('/').at(-1)!));
  throw Error('Unexpected provider path');
 };
 return {fetcher,state,orders,payments};
}
function ledger(f:ReturnType<typeof setup>){const granted=new Map<string,number>(),state={calls:0,invalidReply:false};Object.assign(f.env,{SUPPORT_LEDGER_TENANT_ID:'tenant',SUPPORT_LEDGER_SERVICE_CREDENTIAL:'synthetic-service-credential',SUPPORT_LEDGER:{fetch:async(request:Request)=>{
  state.calls++;const url=new URL(request.url),body=JSON.parse(await request.text());assert.equal(url.origin,'https://api.appneurox.com');assert.equal(url.pathname,'/v1/support-credits/funding');assert.deepEqual(Object.keys(body),['receiptId']);
  const r=await readCapture(f.env,body.receiptId);assert.equal(Boolean(r?.captured),true);if(!r)return new Response(null,{status:409});
  if(state.invalidReply)return Response.json({receiptId:'foreign',mode:'test',fundedCredits:'100',reversedCredits:'0'});
  granted.set(r.id,r.creditUnits-Math.ceil(r.refundedPaise/100));return Response.json({receiptId:r.id,mode:'test',fundedCredits:String(r.creditUnits),reversedCredits:String(Math.ceil(r.refundedPaise/100))});
 }}});return {granted,state};}

test('canonical account link requires both normal learner sign-in and the original PKCE-bound live sign-in, never an email match',async()=>{
 const f=setup();try{
  assert.deepEqual(unwrap(await f.service.wallet(live)),{linked:false});
  const session=(await account(f)).body.data,p=await pkce(),begun=unwrap(await f.service.beginLink({...live,pkceChallenge:p.pkceChallenge}));
  assert.equal(new URL(begun.authorizeUrl).origin,'https://app.example.test');assert.equal(new URL(begun.authorizeUrl).pathname,'/support/link');
  assert.equal((await f.call('/support/link/authorize',{body:{challengeId:begun.challengeId,confirm:true}})).response.status,401);
  const result=await f.call('/support/link/authorize',{access:session.accessToken,body:{challengeId:begun.challengeId,confirm:true}});assert.equal(result.response.status,200);const code=result.body.data.code;
  assert.equal((await f.service.consumeLink({...live,sessionBinding:'b'.repeat(64),challengeId:begun.challengeId,code,verifier:p.verifier})).ok,false);
  assert.equal((await f.service.consumeLink({...live,challengeId:begun.challengeId,code,verifier:'z'.repeat(43)})).ok,false);
  const linked=unwrap(await f.service.consumeLink({...live,challengeId:begun.challengeId,code,verifier:p.verifier}));assert.equal(linked.linked,true);
  assert.equal(unwrap(await f.service.consumeLink({...live,challengeId:begun.challengeId,code,verifier:p.verifier})).linked,true);
  const stored=JSON.stringify(f.sqlite.prepare('SELECT * FROM app_support_link_challenges').all());assert.equal(stored.includes(code),false);assert.equal(stored.includes(p.verifier),false);
  assert.equal(f.sqlite.prepare('SELECT account_id FROM app_support_links').get()!.account_id,session.user.id);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM app_support_audit_events WHERE action='ACCOUNT_LINKED'").get()!.n,1);
  unwrap(await f.service.unlink(live));assert.deepEqual(unwrap(await f.service.wallet(live)),{linked:false});assert.equal((await f.service.consumeLink({...live,challengeId:begun.challengeId,code,verifier:p.verifier})).ok,false);
 }finally{f.close();}
});

test('canonical session revocation blocks code consumption, wrong caller props are rejected and default flags never fake a wallet',async()=>{
 const f=setup();try{
  assert.equal((await new SupportService(f.env,{...props,clientId:'foreign'}).wallet(live)).ok,false);
  const session=(await account(f)).body.data,p=await pkce(),begun=unwrap(await f.service.beginLink({...live,pkceChallenge:p.pkceChallenge}));
  const approved=await f.call('/support/link/authorize',{access:session.accessToken,body:{challengeId:begun.challengeId,confirm:true}});
  await f.call('/auth/logout',{access:session.accessToken,body:{}});
  assert.equal((await f.service.consumeLink({...live,challengeId:begun.challengeId,code:approved.body.data.code,verifier:p.verifier})).ok,false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_support_links').get()!.n,0);
  f.env.APP_SUPPORT_CREDITS_ENABLED='false';assert.equal((await f.service.catalog()).ok,false);assert.equal((await f.call('/support/link/authorize',{access:session.accessToken,body:{challengeId:begun.challengeId,confirm:true}})).response.status,503);
 }finally{f.close();}
});

test('canonical authorization UI uses existing own-origin auth and exposes only a one-use code, with no third party or bearer handoff',async()=>{
 const f=setup();try{
  const p=await pkce(),begun=unwrap(await f.service.beginLink({...live,pkceChallenge:p.pkceChallenge}));
  const {fetch}=await import('../src/index');const page=await fetch(new Request(begun.authorizeUrl),f.env);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy')??'',/connect-src 'self'/);
  const html=await page.text();assert.match(html,/\/auth\/login/);assert.match(html,/\/auth\/refresh/);assert.match(html,/\/support\/link\/authorize/);assert.doesNotMatch(html,/localStorage|sessionStorage|https:\/\/.*\.js|postMessage/);
  const wrong=await fetch(new Request('https://other.example.test/support/link?challengeId='+begun.challengeId),f.env);assert.equal(wrong.status,403);
 }finally{f.close();}
});

test('server-priced Test purchase intents are immutable and idempotent, and live credentials cannot create a checkout',async()=>{
 const f=setup();try{
  const linked=await link(f),key=crypto.randomUUID(),p=unwrap(await f.service.createPurchase({...live,requestId:key,packId:'support-credits-100'}));
  assert.equal(p.amountPaise,10000);assert.equal(p.mode,'TEST');assert.equal(p.credits,100);
  assert.equal(unwrap(await f.service.createPurchase({...live,requestId:key,packId:'support-credits-100'})).id,p.id);
  assert.equal((await f.service.createPurchase({...live,requestId:key,packId:'support-credits-250'})).ok,false);
  await assert.rejects(checkout(f.env,linked.session.user.id,p.id),e=>(e as {code:string}).code==='support_test_payment_not_configured');
  paymentConfig(f);f.env.SUPPORT_RAZORPAY_MODE='live';await assert.rejects(checkout(f.env,linked.session.user.id,p.id),e=>(e as {code:string}).code==='support_test_payment_not_configured');
  assert.throws(()=>f.sqlite.prepare('UPDATE app_support_purchases SET credit_units=999').run(),/IMMUTABLE_SUPPORT_PURCHASE/);
 }finally{f.close();}
});

test('unknown Test order creation reconciles its exact immutable receipt by GET and never repeats provider POST',async()=>{
 const f=setup();try{
  const a=(await account(f)).body.data.user.id;paymentConfig(f);const p=await createPurchase(f.env,a,crypto.randomUUID(),'support-credits-100'),remote=provider();remote.state.losePost=true;
  await assert.rejects(checkout(f.env,a,p.id,remote.fetcher));assert.equal(remote.state.posts,1);assert.equal(f.sqlite.prepare('SELECT status FROM app_support_payment_invoices').get()!.status,'creating');
  await assert.rejects(createPurchase(f.env,a,crypto.randomUUID(),'support-credits-250'),e=>(e as {code:string}).code==='support_payment_outcome_unknown');
  const restored=await checkout(f.env,a,p.id,remote.fetcher);assert.equal(restored.orderId,[...remote.orders.keys()][0]);assert.equal(remote.state.posts,1);
  await checkout(f.env,a,p.id,remote.fetcher);assert.equal(remote.state.posts,1);
 }finally{f.close();}
});

test('capture requires valid HMAC plus exact provider payment and paid order; credits await a matching canonical ledger receipt',async()=>{
 const f=setup();try{
  const a=(await account(f)).body.data.user.id;paymentConfig(f);const p=await createPurchase(f.env,a,crypto.randomUUID(),'support-credits-100'),remote=provider(),led=ledger(f),order=await checkout(f.env,a,p.id,remote.fetcher),paymentId='pay_Fixture1';
  const payment={id:paymentId,order_id:order.orderId,amount:10000,currency:'INR',status:'authorized',amount_refunded:0};remote.payments.set(paymentId,payment);
  const input={razorpay_order_id:order.orderId,razorpay_payment_id:paymentId,razorpay_signature:createHmac('sha256',f.env.SUPPORT_RAZORPAY_KEY_SECRET!).update(order.orderId+'|'+paymentId).digest('hex')};
  await assert.rejects(verifyPurchase(f.env,a,p.id,{...input,razorpay_signature:'0'.repeat(64)},remote.fetcher));
  await verifyPurchase(f.env,a,p.id,input,remote.fetcher);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_support_capture_receipts').get()!.n,0);
  payment.status='captured';remote.orders.get(order.orderId).status='paid';remote.orders.get(order.orderId).amount_paid=10000;
  led.state.invalidReply=true;assert.equal((await verifyPurchase(f.env,a,p.id,input,remote.fetcher)).state,'CAPTURED_CREDITS_PENDING');assert.equal(f.sqlite.prepare('SELECT state FROM app_support_funding_outbox').get()!.state,'PENDING');
  led.state.invalidReply=false;await processSupportFunding(f.env);assert.equal(led.granted.size,1);assert.equal([...led.granted.values()][0],100);assert.equal(f.sqlite.prepare('SELECT state FROM app_support_funding_outbox').get()!.state,'COMPLETED');
  assert.equal((await verifyPurchase(f.env,a,p.id,input,remote.fetcher)).state,'CREDITS_READY');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_support_capture_receipts').get()!.n,1);assert.equal(led.granted.size,1);
  payment.status='refunded';payment.amount_refunded=10000;await purchaseStatus(f.env,a,p.id,remote.fetcher);assert.equal([...led.granted.values()][0],0);assert.equal(f.sqlite.prepare('SELECT amount_refunded FROM app_support_payment_invoices').get()!.amount_refunded,10000);
 }finally{f.close();}
});

test('a financial request stays pinned to its original canonical principal after unlink and relink',async()=>{
 const f=setup();try{
  await link(f);const purchaseKey=crypto.randomUUID(),supportKey=crypto.randomUUID();
  unwrap(await f.service.createPurchase({...live,requestId:purchaseKey,packId:'support-credits-100'}));let ledgerCalls=0;
  Object.assign(f.env,{SUPPORT_LEDGER_TENANT_ID:'tenant',SUPPORT_LEDGER_SERVICE_CREDENTIAL:'synthetic-service',SUPPORT_LEDGER:{fetch:async()=>{ledgerCalls++;return Response.json({receiptId:'support-fixture',mode:'test',credits:'25'});}}});
  const support={...live,requestId:supportKey,sessionId:'session-1',mentorSubject:'mentor-1',credits:25};unwrap(await f.service.giveSupport(support));
  unwrap(await f.service.unlink(live));
  const second=(await account(f,'ios','second@example.test')).body.data,p=await pkce(),begun=unwrap(await f.service.beginLink({...live,pkceChallenge:p.pkceChallenge}));
  const authorized=await f.call('/support/link/authorize',{access:second.accessToken,body:{challengeId:begun.challengeId,confirm:true}});assert.equal(authorized.response.status,200);
  unwrap(await f.service.consumeLink({...live,challengeId:begun.challengeId,code:authorized.body.data.code,verifier:p.verifier}));
  assert.equal((await f.service.giveSupport(support)).ok,false);assert.equal(ledgerCalls,1);
  assert.equal((await f.service.createPurchase({...live,requestId:purchaseKey,packId:'support-credits-100'})).ok,false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_support_purchases').get()!.n,1);
 }finally{f.close();}
});

test('a new verified refund revision gets its own bounded delivery budget without resetting an exhausted identical revision',async()=>{
 const f=setup();try{
  const a=(await account(f)).body.data.user.id;paymentConfig(f);const p=await createPurchase(f.env,a,crypto.randomUUID(),'support-credits-100'),remote=provider(),led=ledger(f),order=await checkout(f.env,a,p.id,remote.fetcher),paymentId='pay_RefundBudget';
  const payment={id:paymentId,order_id:order.orderId,amount:10000,currency:'INR',status:'captured',amount_refunded:0};remote.payments.set(paymentId,payment);Object.assign(remote.orders.get(order.orderId),{status:'paid',amount_paid:10000});
  const input={razorpay_order_id:order.orderId,razorpay_payment_id:paymentId,razorpay_signature:createHmac('sha256',f.env.SUPPORT_RAZORPAY_KEY_SECRET!).update(order.orderId+'|'+paymentId).digest('hex')};
  assert.equal((await verifyPurchase(f.env,a,p.id,input,remote.fetcher)).state,'CREDITS_READY');
  f.sqlite.prepare("UPDATE app_support_funding_outbox SET attempts=10").run();
  payment.amount_refunded=100;await purchaseStatus(f.env,a,p.id,remote.fetcher);
  assert.equal(led.state.calls,2);assert.equal([...led.granted.values()][0],99);
  let row=f.sqlite.prepare('SELECT state,attempts,desired_refunded_paise,delivered_refunded_paise FROM app_support_funding_outbox').get()!;
  assert.deepEqual({...row},{state:'COMPLETED',attempts:1,desired_refunded_paise:100,delivered_refunded_paise:100});
  led.state.invalidReply=true;payment.amount_refunded=200;await purchaseStatus(f.env,a,p.id,remote.fetcher);
  for(let i=1;i<10;i++)await processSupportFunding(f.env);
  row=f.sqlite.prepare('SELECT state,attempts FROM app_support_funding_outbox').get()!;assert.deepEqual({...row},{state:'REVIEW_REQUIRED',attempts:10});
  const exhaustedCalls=led.state.calls;await purchaseStatus(f.env,a,p.id,remote.fetcher);assert.equal(led.state.calls,exhaustedCalls);
  assert.equal(f.sqlite.prepare('SELECT state FROM app_support_funding_outbox').get()!.state,'REVIEW_REQUIRED');
  led.state.invalidReply=false;payment.amount_refunded=300;await purchaseStatus(f.env,a,p.id,remote.fetcher);assert.equal(led.state.calls,exhaustedCalls+1);assert.equal([...led.granted.values()][0],97);
 }finally{f.close();}
});

test('linked RPC commands use the canonical account subject, stable request keys and zero locally stored balance',async()=>{
 const f=setup();try{
  const linked=await link(f),calls:Array<{body:any;key:string|null;path:string}>=[];Object.assign(f.env,{SUPPORT_LEDGER_TENANT_ID:'tenant',SUPPORT_LEDGER_SERVICE_CREDENTIAL:'synthetic-service',SUPPORT_LEDGER:{fetch:async(r:Request)=>{const u=new URL(r.url),b=await r.json() as any;calls.push({body:b,key:r.headers.get('idempotency-key'),path:u.pathname});if(u.pathname.endsWith('/support'))return Response.json({receiptId:crypto.randomUUID(),mode:'test',credits:String(b.credits)});return Response.json({receiptId:'hold-receipt',state:'ACTIVE',questionId:b.questionId,sessionId:b.sessionId,credits:String(b.desiredCredits)});}}});
  const requestId=crypto.randomUUID();unwrap(await f.service.giveSupport({...live,requestId,sessionId:'session-1',mentorSubject:'mentor-1',credits:25}));
  unwrap(await f.service.reserveQuestion({...live,requestId:crypto.randomUUID(),sessionId:'session-1',questionId:'question-1',mentorSubject:'mentor-1',desiredCredits:10}));
  assert.equal(calls[0].body.subject,linked.session.user.id);assert.equal(calls[0].body.subject===live.liveSubject,false);assert.equal(calls[0].key,requestId);assert.equal(calls[1].body.desiredCredits,10);
  const tables=f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'app_support_%'").all().map(r=>String(r.name));assert.equal(tables.some(n=>/balance|wallet/.test(n)),false);
  assert.equal((await hash('unchanged')).length,64);
 }finally{f.close();}
});
