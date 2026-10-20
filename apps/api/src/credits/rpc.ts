/// <reference types="@cloudflare/workers-types" />
import {WorkerEntrypoint} from 'cloudflare:workers';
import {SupportService,fundingReceipt} from './service';
import type {LiveContext,SupportEnv,SupportProps} from './types';
/** No public fetch method. Caller scope comes only from operator-managed binding props. */
export class TechlyUpSupport extends WorkerEntrypoint<SupportEnv,SupportProps>{
 #service(){return new SupportService(this.env,this.ctx.props);}
 catalog(){return this.#service().catalog();}
 beginLink(input:LiveContext&{pkceChallenge:string}){return this.#service().beginLink(input);}
 consumeLink(input:LiveContext&{challengeId:string;code:string;verifier:string}){return this.#service().consumeLink(input);}
 unlink(input:LiveContext){return this.#service().unlink(input);}
 wallet(input:LiveContext){return this.#service().wallet(input);}
 createPurchase(input:LiveContext&{requestId:string;packId:string}){return this.#service().createPurchase(input);}
 checkout(input:LiveContext&{purchaseId:string}){return this.#service().checkout(input);}
 purchaseStatus(input:LiveContext&{purchaseId:string}){return this.#service().purchaseStatus(input);}
 verifyPurchase(input:LiveContext&{purchaseId:string;razorpay_order_id:string;razorpay_payment_id:string;razorpay_signature:string}){return this.#service().verifyPurchase(input);}
 giveSupport(input:LiveContext&{requestId:string;sessionId:string;mentorSubject:string;credits:number}){return this.#service().giveSupport(input);}
 reserveQuestion(input:LiveContext&{requestId:string;sessionId:string;questionId:string;mentorSubject:string;desiredCredits:number}){return this.#service().reserveQuestion(input);}
 settleQuestion(input:{requestId:string;sessionId:string;questionId:string;command:'ANSWERED'|'RELEASED';managerSubject:string}){return this.#service().settleQuestion(input);}
 questionStatus(input:{sessionId:string;questionId:string}){return this.#service().questionStatus(input);}
 ingestWebinarEvent(input:LiveContext&Record<string,unknown>){return this.#service().ingestWebinarEvent(input);}
}
export class TechlyUpFunding extends WorkerEntrypoint<SupportEnv,SupportProps>{
 readCapture(id:string){return fundingReceipt(this.env,this.ctx.props,id);}
}
