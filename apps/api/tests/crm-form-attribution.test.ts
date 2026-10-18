import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture';

test('public form labels retain first, latest and per-submission attribution without claiming provider provenance',async()=>{
 const f=fixture({fullCanonical:true,crm:true});f.env.APP_CRM_ENABLED='true';f.env.APP_CRM_CAPTURE_ENABLED='true';
 try{
  const input={email:'synthetic-form@example.test',kind:'general',interest:'Learning',consent:{service:true,marketing:false,whatsapp:false,policyVersion:'2026-10'}};
  const first=await f.call('/crm/capture',{body:{...input,source:'app:resource'},headers:{'idempotency-key':'resource-form-first'}});assert.equal(first.response.status,202);
  const second=await f.call('/crm/capture',{body:{...input,source:'app:organization'},headers:{'idempotency-key':'organization-form-next'}});assert.equal(second.response.status,202);assert.equal(second.body.data.reference,first.body.data.reference);
  const row=f.sqlite.prepare('SELECT source,first_attribution,last_attribution FROM crm_leads WHERE id=?').get(first.body.data.reference)!;
  assert.equal(row.source,'app:resource');assert.equal(JSON.parse(String(row.first_attribution)).source,'app:resource');assert.equal(JSON.parse(String(row.last_attribution)).source,'app:organization');
  const notes=f.sqlite.prepare("SELECT note FROM crm_activities WHERE kind='capture' ORDER BY occurred_at,id").all().map(row=>row.note);
  assert.equal(notes.some(note=>String(note).includes('app:resource')),true);assert.equal(notes.some(note=>String(note).includes('app:organization')),true);
  const spoof=await f.call('/crm/capture',{body:{...input,email:'another-form@example.test',source:'meta'},headers:{'idempotency-key':'spoofed-provider-form'}});assert.equal(spoof.response.status,202);
  assert.equal(f.sqlite.prepare('SELECT source FROM crm_leads WHERE id=?').get(spoof.body.data.reference)!.source,'app_capture');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_source_events').get()!.n,0);
 }finally{f.close();}
});
