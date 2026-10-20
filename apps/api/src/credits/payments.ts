import {createOrder,reconcile,verifyPayment,webhook,provider,hash,type Invoice,type CoreConfig,type ProviderCall} from '@appneurox/razorpay-invoice-core';
import {ApiError,type D1Database} from '../types';
import {database} from '../config';
import {SUPPORT_CREDIT_CATALOG,SUPPORT_CREDIT_POLICY_VERSION} from './policy';
import {supportEnabled} from './link';
import {SupportLedgerClient} from './ledger-client';
import type {Checkout,FundingReceipt,Purchase,SupportEnv} from './types';
interface Intent {id:string;account_id:string;pack_id:string;credit_units:number;price_paise:number;mode:'test';policy_version:string}
const at=()=>new Date().toISOString();
/** The extracted invoice engine keeps its established SQL contract. This private
 * adapter gives it dedicated product tables without introducing another balance. */
function invoiceDB(db:D1Database){return {prepare(sql:string){return db.prepare(sql.replace(/\binvoices\b/g,'app_support_payment_invoices').replace(/\bpayment_webhooks\b/g,'app_support_payment_webhooks'));}};}
function config(env:SupportEnv,write=false):CoreConfig{
 supportEnabled(env);
 if(env.SUPPORT_RAZORPAY_MODE!=='test'||!/^rzp_test_[A-Za-z0-9]+$/.test(env.SUPPORT_RAZORPAY_KEY_ID??'')||!env.SUPPORT_RAZORPAY_KEY_SECRET||!env.SUPPORT_RAZORPAY_WEBHOOK_SECRET||(write&&env.APP_SUPPORT_TEST_PAYMENTS_ENABLED!=='true'))throw new ApiError('support_test_payment_not_configured','Test credit checkout is not enabled and verified in this environment.',503);
 return {mode:'test',keyId:env.SUPPORT_RAZORPAY_KEY_ID!,secret:env.SUPPORT_RAZORPAY_KEY_SECRET,webhookSecret:env.SUPPORT_RAZORPAY_WEBHOOK_SECRET,ready:true,available:env.APP_SUPPORT_TEST_PAYMENTS_ENABLED==='true'};
}
function transport(c:CoreConfig,fetcher:typeof fetch){return provider(c,async (url,init)=>{try{return await fetcher(url,init);}catch{throw new Error('payment_transport_unavailable');}});}
async function owned(env:SupportEnv,accountId:string,id:string){const db=supportEnabled(env),intent=await db.prepare('SELECT * FROM app_support_purchases WHERE id=? AND account_id=?').bind(id,accountId).first<Intent>();if(!intent)throw new ApiError('support_purchase_not_found','This credit purchase could not be found.',404);const invoice=await db.prepare('SELECT * FROM app_support_payment_invoices WHERE id=?').bind(id).first<Invoice>();if(!invoice||invoice.mode!=='test'||invoice.amount!==intent.price_paise||invoice.currency!=='INR')throw new ApiError('support_purchase_invalid','This credit purchase needs a staff review.',409);return {intent,invoice};}
function purchase(intent:Intent,invoice:Invoice):Purchase{return {id:intent.id,state:invoice.status==='creating'?'REVIEW_REQUIRED':invoice.status.toUpperCase(),packId:intent.pack_id,credits:intent.credit_units,amountPaise:intent.price_paise,currency:'INR',mode:'TEST'};}
async function purchaseResult(env:SupportEnv,intent:Intent,invoice:Invoice){const result=purchase(intent,invoice);if(invoice.status==='paid'){const funding=await database(env).prepare('SELECT o.state,o.delivered_refunded_paise FROM app_support_capture_receipts r JOIN app_support_funding_outbox o ON o.receipt_id=r.id WHERE r.intent_id=?').bind(intent.id).first<{state:string;delivered_refunded_paise:number}>();result.state=funding?.state==='COMPLETED'&&funding.delivered_refunded_paise===invoice.amount_refunded?'CREDITS_READY':'CAPTURED_CREDITS_PENDING';}return result;}
export async function createPurchase(env:SupportEnv,accountId:string,requestId:string,packId:string){
 const db=supportEnabled(env),pack=SUPPORT_CREDIT_CATALOG.find(v=>v.id===packId);if(!pack)throw new ApiError('support_pack_invalid','Choose a listed credit pack.',422);
 const previous=await db.prepare('SELECT id,pack_id FROM app_support_purchases WHERE account_id=? AND request_key=?').bind(accountId,requestId).first<{id:string;pack_id:string}>();if(previous){if(previous.pack_id!==packId)throw new ApiError('idempotency_conflict','This request already selected a different credit pack.',409);const old=await owned(env,accountId,previous.id);return purchaseResult(env,old.intent,old.invoice);}
 if(await db.prepare("SELECT p.id FROM app_support_purchases p JOIN app_support_payment_invoices i ON i.id=p.id WHERE p.account_id=? AND i.status='creating' LIMIT 1").bind(accountId).first())throw new ApiError('support_payment_outcome_unknown','Reconcile your unconfirmed Test order before starting another purchase.',409);
 const id=crypto.randomUUID(),now=Date.now();
 try{await db.batch([
  db.prepare("INSERT INTO app_support_guards(id,satisfied) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM app_support_purchases p JOIN app_support_payment_invoices i ON i.id=p.id WHERE p.account_id=? AND i.status='creating') THEN 1 ELSE 0 END").bind(crypto.randomUUID(),accountId),
  db.prepare("INSERT INTO app_support_purchases(id,account_id,request_key,pack_id,policy_version,credit_units,price_paise,mode,created_at) VALUES(?,?,?,?,?,?,?,'test',?)").bind(id,accountId,requestId,pack.id,SUPPORT_CREDIT_POLICY_VERSION,pack.creditUnits,pack.pricePaise,at()),
  db.prepare("INSERT INTO app_support_payment_invoices(id,site,reference_hash,reference_label,title,customer_name,email,email_hash,amount,currency,mode,expires_at,created_at,updated_at) VALUES(?,'techlyup',?,'Support credit purchase',?,'Canonical learner','',?,?,'INR','test',?,?,?)").bind(id,await hash(id),`${pack.creditUnits} support credits (TEST)`,await hash(accountId),pack.pricePaise,now+86400000,now,now),
  db.prepare("INSERT INTO app_support_audit_events(id,account_id,action,source_ref,created_at) VALUES(?,?,'PURCHASE_INTENT_CREATED',?,?)").bind(crypto.randomUUID(),accountId,id,at()),
 ]);}catch{const old=await db.prepare('SELECT id,pack_id FROM app_support_purchases WHERE account_id=? AND request_key=?').bind(accountId,requestId).first<{id:string;pack_id:string}>();if(old?.pack_id===packId){const value=await owned(env,accountId,old.id);return purchaseResult(env,value.intent,value.invoice);}throw new ApiError('support_purchase_conflict','The credit purchase changed. Recheck the existing request.',409);}
 const value=await owned(env,accountId,id);return purchaseResult(env,value.intent,value.invoice);
}
async function reconcileMissingOrder(env:SupportEnv,row:Invoice,call:ProviderCall){
 if(row.status!=='creating'||row.provider_order_id)return row;
 const list=await call(`/orders?receipt=${encodeURIComponent(row.id)}&count=10`),matches=Array.isArray(list?.items)?list.items.filter((v:any)=>/^order_[A-Za-z0-9]+$/.test(v.id??'')&&v.receipt===row.id&&v.amount===row.amount&&v.currency===row.currency&&v.notes?.invoice_id===row.id&&v.notes?.website==='techlyup'):[];
 if(matches.length===1){await database(env).prepare("UPDATE app_support_payment_invoices SET provider_order_id=?,status='pending',updated_at=? WHERE id=? AND status='creating' AND provider_order_id IS NULL").bind(matches[0].id,Date.now(),row.id).run();return (await database(env).prepare('SELECT * FROM app_support_payment_invoices WHERE id=?').bind(row.id).first<Invoice>())!;}
 return row; // An empty or ambiguous list is not permission to repeat POST.
}
export async function checkout(env:SupportEnv,accountId:string,id:string,fetcher:typeof fetch=fetch):Promise<Checkout>{
 const {invoice}=await owned(env,accountId,id),c=config(env,true),call=transport(c,fetcher);
 let row=await reconcileMissingOrder(env,invoice,call);
 if(row.status==='creating'&&!row.provider_order_id)throw new ApiError('support_payment_outcome_unknown','The previous Test order is unconfirmed. Check payment status; it will not be created again automatically.',409);
 if(['paid','partially_refunded','refunded'].includes(row.status))throw new ApiError('support_purchase_already_paid','This purchase is already paid or refunded. Check its credit status.',409);
 try{row=await createOrder(invoiceDB(database(env)),c,call,row);}catch{throw new ApiError('support_payment_outcome_unknown','The Test order is being checked. Keep this purchase and use Check status before trying again.',503);}
 if(!row.provider_order_id||!/^order_[A-Za-z0-9]+$/.test(row.provider_order_id))throw new ApiError('support_payment_outcome_unknown','The Test order is not confirmed.',409);
 return {orderId:row.provider_order_id,keyId:c.keyId,amountPaise:row.amount,currency:'INR',mode:'TEST'};
}
async function persistCapture(env:SupportEnv,row:Invoice){
 if(!['paid','partially_refunded','refunded'].includes(row.status)||!row.payment_id||!row.provider_order_id)return;
 const db=database(env),intent=await db.prepare('SELECT * FROM app_support_purchases WHERE id=?').bind(row.id).first<Intent>();if(!intent||intent.price_paise!==row.amount||row.mode!=='test')throw new ApiError('support_capture_invalid','Captured payment does not match its immutable credit intent.',409);
 const existing=await db.prepare('SELECT id,provider_order_id,provider_payment_id FROM app_support_capture_receipts WHERE intent_id=?').bind(row.id).first<{id:string;provider_order_id:string;provider_payment_id:string}>();if(existing&&(existing.provider_order_id!==row.provider_order_id||existing.provider_payment_id!==row.payment_id))throw new ApiError('support_capture_conflict','This payment requires a staff review.',409);
 const receiptId=existing?.id??crypto.randomUUID();
 await db.batch([
  db.prepare('INSERT OR IGNORE INTO app_support_capture_receipts(id,intent_id,account_id,provider_order_id,provider_payment_id,captured_at) VALUES(?,?,?,?,?,?)').bind(receiptId,row.id,intent.account_id,row.provider_order_id,row.payment_id,at()),
  db.prepare("INSERT INTO app_support_funding_outbox(receipt_id,desired_refunded_paise,updated_at) SELECT id,?,? FROM app_support_capture_receipts WHERE intent_id=? ON CONFLICT(receipt_id) DO UPDATE SET desired_refunded_paise=MAX(desired_refunded_paise,excluded.desired_refunded_paise),revision=revision+CASE WHEN excluded.desired_refunded_paise>desired_refunded_paise THEN 1 ELSE 0 END,attempts=CASE WHEN excluded.desired_refunded_paise>desired_refunded_paise THEN 0 ELSE attempts END,state=CASE WHEN excluded.desired_refunded_paise>desired_refunded_paise THEN 'PENDING' ELSE state END,updated_at=excluded.updated_at").bind(row.amount_refunded,at(),row.id),
 ]);
}
export async function readCapture(env:SupportEnv,receiptId:string):Promise<FundingReceipt|null>{
 const db=supportEnabled(env),row=await db.prepare('SELECT r.*,p.pack_id,p.credit_units,p.price_paise,p.mode,i.amount_refunded,i.status FROM app_support_capture_receipts r JOIN app_support_purchases p ON p.id=r.intent_id AND p.account_id=r.account_id JOIN app_support_payment_invoices i ON i.id=p.id AND i.provider_order_id=r.provider_order_id AND i.payment_id=r.provider_payment_id WHERE r.id=?').bind(receiptId).first<{id:string;intent_id:string;account_id:string;provider_order_id:string;provider_payment_id:string;captured_at:string;pack_id:string;credit_units:number;price_paise:number;mode:string;amount_refunded:number;status:string}>();
 if(!row||row.mode!=='test'||!['paid','partially_refunded','refunded'].includes(row.status))return null;
 return {id:row.id,intentId:row.intent_id,mode:'test',issuer:env.SUPPORT_LEARNER_ISSUER!,subject:row.account_id,packId:row.pack_id,creditUnits:row.credit_units,pricePaise:row.price_paise,currency:'INR',providerOrderId:row.provider_order_id,providerPaymentId:row.provider_payment_id,captured:true,capturedAt:row.captured_at,refundedPaise:row.amount_refunded};
}
export async function processSupportFunding(env:SupportEnv,onlyAccount?:string){
 if(env.APP_ENABLED!=='true'||env.APP_SUPPORT_CREDITS_ENABLED!=='true')return {checked:0,completed:0};
 const db=database(env),items=await db.prepare(`SELECT o.* FROM app_support_funding_outbox o JOIN app_support_capture_receipts r ON r.id=o.receipt_id WHERE o.attempts<10 AND (? IS NULL OR r.account_id=?) AND (o.state='PENDING' OR (o.state='PROCESSING' AND o.updated_at<?)) ORDER BY o.updated_at,o.receipt_id LIMIT 5`).bind(onlyAccount??null,onlyAccount??null,new Date(Date.now()-120000).toISOString()).all<{receipt_id:string;revision:number;desired_refunded_paise:number}>();
 let completed=0;
 for(const item of items.results){
  const claimed=await db.prepare("UPDATE app_support_funding_outbox SET state='PROCESSING',attempts=attempts+1,updated_at=? WHERE receipt_id=? AND revision=? AND (state='PENDING' OR (state='PROCESSING' AND updated_at<?))").bind(at(),item.receipt_id,item.revision,new Date(Date.now()-120000).toISOString()).run();if(claimed.meta.changes!==1)continue;
  try{await new SupportLedgerClient(env).funding(item.receipt_id,item.desired_refunded_paise);await db.prepare("UPDATE app_support_funding_outbox SET state='COMPLETED',delivered_refunded_paise=?,updated_at=? WHERE receipt_id=? AND revision=?").bind(item.desired_refunded_paise,at(),item.receipt_id,item.revision).run();completed++;}
  catch{await db.prepare("UPDATE app_support_funding_outbox SET state=CASE WHEN attempts>=10 THEN 'REVIEW_REQUIRED' ELSE 'PENDING' END,updated_at=? WHERE receipt_id=? AND revision=?").bind(at(),item.receipt_id,item.revision).run();}
 }
 return {checked:items.results.length,completed};
}
export async function purchaseStatus(env:SupportEnv,accountId:string,id:string,fetcher:typeof fetch=fetch){
 let {intent,invoice}=await owned(env,accountId,id);
 if(invoice.provider_order_id||invoice.status==='creating'){
  const c=config(env),call=transport(c,fetcher);invoice=await reconcileMissingOrder(env,invoice,call);invoice=await reconcile(invoiceDB(database(env)),c,call,invoice);
  await persistCapture(env,invoice);await processSupportFunding(env,accountId);
 }
 return purchaseResult(env,intent,invoice);
}
export async function verifyPurchase(env:SupportEnv,accountId:string,id:string,input:{razorpay_order_id:string;razorpay_payment_id:string;razorpay_signature:string},fetcher:typeof fetch=fetch){
 const {intent,invoice}=await owned(env,accountId,id),c=config(env),call=transport(c,fetcher);
 let row:Invoice;try{row=await verifyPayment(invoiceDB(database(env)),c,call,invoice,input);}catch{throw new ApiError('support_payment_not_verified','The Test payment signature and provider capture could not both be verified. Check this purchase again.',409);}
 await persistCapture(env,row);await processSupportFunding(env,accountId);return purchaseResult(env,intent,row);
}
export async function supportWebhook(env:SupportEnv,raw:string,signature:string,eventId:string,fetcher:typeof fetch=fetch){
 const c=config(env),db=database(env);try{await webhook(invoiceDB(db),c,transport(c,fetcher),raw,signature,eventId);}catch{throw new ApiError('support_webhook_invalid','Payment event verification failed.',400);}
 // The core has already verified raw-body HMAC and performed provider readback.
 const pending=await db.prepare("SELECT i.* FROM app_support_payment_invoices i LEFT JOIN app_support_capture_receipts r ON r.intent_id=i.id LEFT JOIN app_support_funding_outbox o ON o.receipt_id=r.id WHERE i.status IN ('paid','partially_refunded','refunded') AND (r.id IS NULL OR o.desired_refunded_paise<i.amount_refunded) ORDER BY i.updated_at LIMIT 5").all<Invoice>();
 for(const row of pending.results)await persistCapture(env,row);
 await processSupportFunding(env);return {received:true};
}
