/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError,type Env } from '../types';
import { beginProductLogin,consumeProductLogin,productSession,endProductSession,productRequest,type ProductBindingProps,type ProductRequestInput } from './identity';
export async function productResult<T>(work:()=>Promise<T>){
  try{return {ok:true as const,data:await work()};}
  catch(error){return {ok:false as const,error:error instanceof ApiError?{code:error.code,message:error.message,status:error.status}:error instanceof z.ZodError?{code:'product_request_invalid',message:'Check the supplied app details.',status:422}:{code:'products_unavailable',message:'TechlyUp apps are temporarily unavailable. Please try again.',status:503}};}
}
/** Only operator-managed service binding props select the app and canonical tenant. */
export class TechlyUpProducts extends WorkerEntrypoint<Env,ProductBindingProps>{
  beginProductLogin(input:{pkceChallenge:string;returnPath?:string}){return productResult(()=>beginProductLogin(this.env,this.ctx.props,input));}
  consumeProductLogin(input:{challengeId:string;code:string;verifier:string}){return productResult(()=>consumeProductLogin(this.env,this.ctx.props,input));}
  productSession(input:{sessionToken:string}){return productResult(()=>productSession(this.env,this.ctx.props,input));}
  endProductSession(input:{sessionToken:string}){return productResult(()=>endProductSession(this.env,this.ctx.props,input));}
  productRequest(input:ProductRequestInput){return productResult(()=>productRequest(this.env,this.ctx.props,input));}
}
