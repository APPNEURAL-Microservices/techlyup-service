import type {Env} from '../types';
export interface FundingReceipt {id:string;intentId:string;mode:'test';issuer:string;subject:string;packId:string;creditUnits:number;pricePaise:number;currency:'INR';providerOrderId:string;providerPaymentId:string;captured:true;capturedAt:string;refundedPaise:number}
export interface SupportEnv extends Env {
 APP_SUPPORT_CREDITS_ENABLED?:string;APP_SUPPORT_TEST_PAYMENTS_ENABLED?:string;
 SUPPORT_EXPECTED_CLIENT_ID?:string;SUPPORT_LEARNER_ISSUER?:string;SUPPORT_PUBLIC_ORIGIN?:string;
 SUPPORT_LEDGER?:{fetch(request:Request):Promise<Response>};SUPPORT_LEDGER_SERVICE_CREDENTIAL?:string;
 SUPPORT_LEDGER_TENANT_ID?:string;SUPPORT_LEDGER_ORIGIN?:string;
 SUPPORT_RAZORPAY_MODE?:string;SUPPORT_RAZORPAY_KEY_ID?:string;SUPPORT_RAZORPAY_KEY_SECRET?:string;SUPPORT_RAZORPAY_WEBHOOK_SECRET?:string;
}
export interface SupportProps {clientId:string;product:'techlyup';tenantId:string}
export interface LiveContext {liveSubject:string;sessionBinding:string}
export type RpcResult<T>={ok:true;data:T}|{ok:false;error:{code:string;message:string}};
export interface Wallet {linked:true;asset:'TECHLYUP_SUPPORT_CREDIT';mode:'TEST';postedCredits:number;heldCredits:number;availableCredits:number;debtCredits:number;status:'ACTIVE'|'FROZEN';purchasedCreditsExpire:false}
export interface Purchase {id:string;state:string;packId:string;credits:number;amountPaise:number;currency:'INR';mode:'TEST'}
export interface Checkout {orderId:string;keyId:string;amountPaise:number;currency:'INR';mode:'TEST'}
export interface QuestionSettlement {status:'CAPTURED'|'RELEASED';credits:number;receiptId:string}
