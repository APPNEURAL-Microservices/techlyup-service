import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database, D1Statement, Env } from '../src/types';
import { fetch } from '../src/index';

export function fixture(options:{fullCanonical?:boolean;crm?:boolean}={}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL(options.fullCanonical?'./fixtures/website-schema-2026-10-16.sql':'./fixtures/canonical.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../../migrations/d1/0047_native_app_foundation.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../../migrations/d1/0054_account_registration_live_login.sql',import.meta.url),'utf8'));
  if(options.crm){
    if(!options.fullCanonical)sqlite.exec(readFileSync(new URL('./fixtures/canonical-crm.sql',import.meta.url),'utf8'));
    for(const file of ['0048_crm_acquisition.sql','0049_crm_canonical_sources.sql','0050_crm_visitors.sql','0051_crm_staff_alerts.sql'])sqlite.exec(readFileSync(new URL(`../../../migrations/d1/${file}`,import.meta.url),'utf8'));
  }
  let failAudit = false;
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
  const env:Env={APP_ENV:'test',APP_ENABLED:'true',APP_SIGNUP_ENABLED:'true',APP_ANALYTICS_ENABLED:'false',APP_ALLOWED_ORIGINS:'https://app.example.test',TECHLYUP_ERP_ORG_ID:'appneural',REGISTRATIONS_DB:db};
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
  return {sqlite,db,env,call,setFailAudit(value:boolean){failAudit=value;},close(){sqlite.close();}};
}
export const signupInput={firstName:'Synthetic',lastName:'Learner',email:'learner@example.test',password:'a strong synthetic password 123',phone:'98765 43210',accountType:'student',city:'Jaipur',consent:true,consentVersion:'2026-10'};
export async function account(f:ReturnType<typeof fixture>,client='ios',email=signupInput.email){
  const result=await f.call('/auth/signup',{body:{...signupInput,email},client,...(client==='web'?{origin:'https://app.example.test'}:{})});
  if(result.response.status!==201)throw new Error(`Fixture signup failed: ${JSON.stringify(result.body)}`);
  return result;
}
