import {z} from 'zod';
import {ApiError} from '../types';
import {database} from '../config';
import {hash} from '../auth/crypto';
import {SUPPORT_CREDIT_POLICY,SUPPORT_CREDIT_CATALOG,SUPPORT_CREDIT_POLICY_VERSION,validateSupportCredits,questionBidIncrease} from './policy';
import {beginLink,consumeLink,unlink,linkedAccount,caller,liveContext} from './link';
import {SupportLedgerClient} from './ledger-client';
import {createPurchase,checkout,purchaseStatus,verifyPurchase,readCapture} from './payments';
import {ingestWebinarCrmEvent} from '../crm/webinar-ingestion';
import type {LiveContext,RpcResult,SupportEnv,SupportProps} from './types';
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/),context=z.object({liveSubject:id,sessionBinding:z.string().regex(/^[a-f0-9]{64}$/)});
/** Pure service core, also exercised with isolated SQLite. Only the named Worker
 * entrypoint can supply deployment-authenticated caller properties in production. */
export class SupportService {
 constructor(private env:SupportEnv,private props:SupportProps){}
 private async execute<T>(work:()=>Promise<T>|T):Promise<RpcResult<T>>{try{caller(this.env,this.props);return {ok:true,data:await work()};}catch(e){return {ok:false,error:e instanceof ApiError?{code:e.code,message:e.message}:e instanceof z.ZodError?{code:'support_invalid_request',message:'Check the support request and try again.'}:{code:'support_unavailable',message:'Support status could not be confirmed. Recheck the same action before trying another.'}};}}
 private async account(raw:LiveContext){const linked=await linkedAccount(this.env,this.props,raw);if(!linked)throw new ApiError('support_account_link_required','Connect your canonical TechlyUp account before using credits.',409);return linked.account_id;}
 private async boundAccount(raw:LiveContext&{requestId:string},operation:string,body:unknown){
  const accountId=await this.account(raw),db=database(this.env),digest=await hash(JSON.stringify(body));
  await db.prepare('INSERT OR IGNORE INTO app_support_source_commands(client_id,live_subject,request_key,operation,request_hash,account_id,created_at) VALUES(?,?,?,?,?,?,?)').bind(this.props.clientId,raw.liveSubject,raw.requestId,operation,digest,accountId,new Date().toISOString()).run();
  const binding=await db.prepare('SELECT operation,request_hash,account_id FROM app_support_source_commands WHERE client_id=? AND live_subject=? AND request_key=?').bind(this.props.clientId,raw.liveSubject,raw.requestId).first<{operation:string;request_hash:string;account_id:string}>();
  if(!binding||binding.account_id!==accountId||binding.operation!==operation||binding.request_hash!==digest)throw new ApiError('support_original_principal_conflict','This action belongs to an earlier account connection or different request. Recheck its original outcome before starting another.',409);
  return accountId;
 }
 catalog(){return this.execute(()=>({policyVersion:SUPPORT_CREDIT_POLICY_VERSION,asset:SUPPORT_CREDIT_POLICY.asset,mode:'TEST' as const,packs:SUPPORT_CREDIT_CATALOG.map(p=>({...p})),support:SUPPORT_CREDIT_POLICY.support,questionBid:SUPPORT_CREDIT_POLICY.questionBid,mentorBasisPoints:9000,platformBasisPoints:1000,purchasedCreditsExpire:false as const,actualPayoutOrSettlement:false}));}
 beginLink(input:LiveContext&{pkceChallenge:string}){return this.execute(()=>beginLink(this.env,this.props,input));}
 consumeLink(input:LiveContext&{challengeId:string;code:string;verifier:string}){return this.execute(()=>consumeLink(this.env,this.props,input));}
 unlink(input:LiveContext){return this.execute(()=>unlink(this.env,this.props,input));}
 wallet(input:LiveContext){return this.execute(async()=>{const linked=await linkedAccount(this.env,this.props,input);return linked?new SupportLedgerClient(this.env).wallet(linked.account_id):{linked:false as const};});}
 createPurchase(raw:LiveContext&{requestId:string;packId:string}){return this.execute(async()=>{const input=context.extend({requestId:z.uuid(),packId:id}).strict().parse(raw);return createPurchase(this.env,await this.boundAccount(input,'purchase',[input.packId]),input.requestId,input.packId);});}
 checkout(raw:LiveContext&{purchaseId:string}){return this.execute(async()=>{const input=context.extend({purchaseId:z.uuid()}).strict().parse(raw);return checkout(this.env,await this.account(input),input.purchaseId);});}
 purchaseStatus(raw:LiveContext&{purchaseId:string}){return this.execute(async()=>{const input=context.extend({purchaseId:z.uuid()}).strict().parse(raw);return purchaseStatus(this.env,await this.account(input),input.purchaseId);});}
 verifyPurchase(raw:LiveContext&{purchaseId:string;razorpay_order_id:string;razorpay_payment_id:string;razorpay_signature:string}){return this.execute(async()=>{const input=context.extend({purchaseId:z.uuid(),razorpay_order_id:z.string().regex(/^order_[A-Za-z0-9]+$/),razorpay_payment_id:z.string().regex(/^pay_[A-Za-z0-9]+$/),razorpay_signature:z.string().regex(/^[a-f0-9]{64}$/i)}).strict().parse(raw);return verifyPurchase(this.env,await this.account(input),input.purchaseId,input);});}
 giveSupport(raw:LiveContext&{requestId:string;sessionId:string;mentorSubject:string;credits:number}){return this.execute(async()=>{const input=context.extend({requestId:z.uuid(),sessionId:id,mentorSubject:id,credits:z.number().int().min(1).max(1000)}).strict().parse(raw);validateSupportCredits(input.credits);return new SupportLedgerClient(this.env).support(await this.boundAccount(input,'support',[input.sessionId,input.mentorSubject,input.credits]),input);});}
 reserveQuestion(raw:LiveContext&{requestId:string;sessionId:string;questionId:string;mentorSubject:string;desiredCredits:number}){return this.execute(async()=>{const input=context.extend({requestId:z.uuid(),sessionId:id,questionId:id,mentorSubject:id,desiredCredits:z.number().int().min(1).max(500)}).strict().parse(raw);questionBidIncrease(0,input.desiredCredits);return new SupportLedgerClient(this.env).reserve(await this.boundAccount(input,'reserve',[input.sessionId,input.questionId,input.mentorSubject,input.desiredCredits]),input);});}
 settleQuestion(raw:{requestId:string;sessionId:string;questionId:string;command:'ANSWERED'|'RELEASED';managerSubject:string}){return this.execute(async()=>{const input=z.object({requestId:z.uuid(),sessionId:id,questionId:id,command:z.enum(['ANSWERED','RELEASED']),managerSubject:id}).strict().parse(raw);return new SupportLedgerClient(this.env).settle(input);});}
 questionStatus(raw:{sessionId:string;questionId:string}){return this.execute(async()=>{const input=z.object({sessionId:id,questionId:id}).strict().parse(raw);return new SupportLedgerClient(this.env).questionStatus(input);});}
 ingestWebinarEvent(raw:LiveContext&Record<string,unknown>){return this.execute(async()=>{const input=liveContext(raw),accountId=await this.account(input);const {liveSubject:_,sessionBinding:__,...event}=raw;void _;void __;return ingestWebinarCrmEvent(this.env,{orgId:this.env.TECHLYUP_ERP_ORG_ID!,accountId,liveSubject:input.liveSubject},event);});}
}
/** Private funding owner has a different deployment capability. It cannot place
 * an order, link an account, or execute a credit command. */
export async function fundingReceipt(env:SupportEnv,props:SupportProps,idValue:string){
 if(props?.clientId!=='edge-monolith'||props?.product!=='techlyup'||props?.tenantId!==env.TECHLYUP_ERP_ORG_ID)throw new ApiError('support_funding_caller_denied','Funding receipt access is not authorized.',403);
 z.uuid().parse(idValue);return readCapture(env,idValue);
}
