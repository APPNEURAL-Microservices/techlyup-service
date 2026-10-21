import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { D1Database, D1Statement, Env } from '../src/types';
import { fetch } from '../src/index';

export function fixture(options:{fullCanonical?:boolean;crm?:boolean}={}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL(options.fullCanonical?'./fixtures/website-schema-2026-10-16.sql':'./fixtures/canonical.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../../migrations/d1/0047_native_app_foundation.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../../migrations/d1/0054_account_registration_live_login.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../../migrations/d1/0055_passwordless_registration.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../../migrations/d1/0056_live_passcodes.sql',import.meta.url),'utf8'));
  if(options.crm){
    if(!options.fullCanonical)sqlite.exec(readFileSync(new URL('./fixtures/canonical-crm.sql',import.meta.url),'utf8'));
    for(const file of ['0048_crm_acquisition.sql','0049_crm_canonical_sources.sql','0050_crm_visitors.sql','0051_crm_staff_alerts.sql'])sqlite.exec(readFileSync(new URL(`../../../migrations/d1/${file}`,import.meta.url),'utf8'));
  }
  let failAudit = false;
  // Synthetic Cloudflare Email Sending binding. Messages stay in memory and are never printed.
  const outbox:{to:string;subject:string;text:string}[]=[];
  class Statement implements D1Statement {
    constructor(readonly sql:string,readonly values:unknown[] = []){}
    bind(...values:unknown[]){return new Statement(this.sql,values);}
    execute() {
      if(failAudit && /INSERT INTO app_audit_events/.test(this.sql))throw new Error('synthetic private audit storage failure');
      const result=sqlite.prepare(this.sql).run(...this.values as (string|number|null)[]);
      return {meta:{changes:Number(result.changes)}};
    }
    async first<T>(){return (sqlite.prepare(this.sql).get(...this.values as (string|number|null)[])??null) as T|null;}
    async all<T>(){return {results:sqlite.prepare(this.sql).all(...this.values as (string|number|null)[]) as T[]};}
    async run(){return this.execute();}
  }
  const db:D1Database={prepare:sql=>new Statement(sql),async batch(statements){
    sqlite.exec('BEGIN IMMEDIATE');
    try {const result=statements.map(statement=>(statement as Statement).execute());sqlite.exec('COMMIT');return result;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
  const env:Env={APP_ENV:'test',APP_ENABLED:'true',APP_SIGNUP_ENABLED:'true',APP_ANALYTICS_ENABLED:'false',APP_ALLOWED_ORIGINS:'https://app.example.test',TECHLYUP_ERP_ORG_ID:'appneural',REGISTRATIONS_DB:db,
    EMAIL_FROM:'codes@example.test',EMAIL:{async send(message){outbox.push({to:message.to,subject:message.subject,text:message.text});return {messageId:`synthetic-${outbox.length}`};}}};
  async function call(path:string, options:{method?:string;body?:unknown;access?:string;client?:string;origin?:string|null;cookie?:string;headers?:Record<string,string>}={}){
    const method=options.method??(options.body!==undefined?'POST':'GET');
    const headers:Record<string,string>={'x-techlyup-client':options.client??'ios',...options.headers};
    if(options.origin!==undefined&&options.origin!==null)headers.origin=options.origin;
    if(options.access)headers.authorization=`Bearer ${options.access}`;
    if(options.cookie)headers.cookie=options.cookie;
    if(options.body!==undefined)headers['content-type']='application/json';
    const response=await fetch(new Request(`https://app.example.test/api/v1${path}`,{method,headers,...(options.body!==undefined?{body:JSON.stringify(options.body)}:{})}),env);
    return {response,body:await response.json() as any};
  }
  return {sqlite,db,env,call,outbox,setFailAudit(value:boolean){failAudit=value;},close(){sqlite.close();}};
}
export const signupInput={firstName:'Synthetic',lastName:'Learner',email:'learner@example.test',phone:'98765 43210',accountType:'student',city:'Jaipur',preferredLanguage:'en',interestIds:[],ageGroup:'adult',updatesConsent:false,consent:true,consentVersion:'2026-10-21'};
type Fixture=ReturnType<typeof fixture>;
/** For real-Worker tests that cannot read an outbox: an issued signup code as SQL for their disposable local D1. */
export function seededCode(email:string){
  const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
  const challengeId=`otp_${randomUUID().replaceAll('-','')}`,code='246810';
  return {challengeId,code,sql:`INSERT INTO app_email_otp_challenges(id,purpose,email_hash,code_hash,expires_at,created_at) VALUES('${challengeId}','signup','${sha(email.toLowerCase())}','${sha(`${challengeId}:${code}`)}','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`};
}
/** Requests an email code and reads it from the synthetic outbox. */
export async function emailCode(f:Fixture,email:string,purpose:'signup'|'login'='signup',client='ios'){
  const result=await f.call('/auth/otp',{body:{email,purpose},client,...(client==='web'?{origin:'https://app.example.test'}:{})});
  if(result.response.status!==202)throw new Error(`Fixture code request failed: ${JSON.stringify(result.body)}`);
  const code=/code is (\d{6})/.exec(f.outbox.at(-1)?.text??'')?.[1];
  return {challengeId:result.body.data.challengeId as string,code:code??''};
}
export async function account(f:Fixture,client='ios',email=signupInput.email,extra:Record<string,unknown>={}){
  const result=await f.call('/auth/signup',{body:{...signupInput,email,...extra,...await emailCode(f,email,'signup',client)},client,...(client==='web'?{origin:'https://app.example.test'}:{})});
  if(result.response.status!==201)throw new Error(`Fixture signup failed: ${JSON.stringify(result.body)}`);
  return result;
}
export async function codeLogin(f:Fixture,email=signupInput.email,client='ios'){
  return f.call('/auth/otp/login',{body:{email,...await emailCode(f,email,'login',client)},client,...(client==='web'?{origin:'https://app.example.test'}:{})});
}
