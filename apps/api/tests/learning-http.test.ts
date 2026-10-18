import assert from 'node:assert/strict';
import test from 'node:test';
import { courseLessons } from '@techlyup/contracts';
import type { DatabaseActor,Enrollment,LessonProgress } from '@appneurox/learning-postgres';
import { fixture,account } from './fixture';
import { authenticate } from '../src/auth/service';
import { handleLearning } from '../src/learning/http';
import { config } from '../src/config';
import { ApiError } from '../src/types';

test('learning route scopes identity, free course, lesson IDs and stable request keys before repository mutations',async()=>{
  const f=fixture();try{
    const session=(await account(f)).body.data;
    f.env.APP_LEARNING_ENABLED='true';f.env.APP_POSTGRES={connectionString:'postgresql://synthetic-hyperdrive-binding/test'};
    const identity=await authenticate(f.db,'appneural',`Bearer ${session.accessToken}`),settings=config(f.env),enrollmentId=crypto.randomUUID();
    const enrollments:Enrollment[]=[{id:enrollmentId,kind:'course',itemRef:'course-ai-useful-answers',status:'active',createdAt:new Date().toISOString()}];
    const saved:LessonProgress={enrollmentId,lessonRef:courseLessons[0].id,status:'completed',version:1,updatedAt:new Date().toISOString()};
    let mutations=0;const actors:DatabaseActor[]=[];
    const repo={
      async listEnrollments(actor:DatabaseActor){actors.push(actor);return enrollments;},
      async enroll(actor:DatabaseActor,_input:unknown,key:string){actors.push(actor);mutations++;assert.match(key,/^[0-9a-f-]{36}$/);return enrollments[0];},
      async listProgress(actor:DatabaseActor){actors.push(actor);return [saved];},
      async saveProgress(actor:DatabaseActor,input:unknown,key:string){actors.push(actor);mutations++;assert.match(key,/^[0-9a-f-]{36}$/);return saved;},
    };
    const work=async<T>(_env:unknown,run:(value:typeof repo)=>Promise<T>)=>run(repo);
    const send=(path:string,method='GET',body?:unknown,key?:string)=>handleLearning(new Request(`https://app.example.test/api/v1/learning${path}`,{method,headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})}),f.env,identity,'server-request-id',settings,work);
    assert.equal((await send('/enrollments')).status,200);
    const item={kind:'course',id:'course-ai-useful-answers'};
    await assert.rejects(send('/enrollments','POST',item),(error:unknown)=>error instanceof ApiError&&error.code==='idempotency_required');
    await assert.rejects(send('/enrollments','POST',{kind:'course',id:'paid-course'},crypto.randomUUID()));
    await assert.rejects(send('/enrollments','POST',{...item,accountId:'another-account'},crypto.randomUUID()));
    assert.equal(mutations,0);
    assert.equal((await send('/enrollments','POST',item,crypto.randomUUID())).status,201);
    const progress={lessonRef:courseLessons[0].id,status:'completed',expectedVersion:0};
    await assert.rejects(send(`/enrollments/${enrollmentId}/progress`,'PUT',{...progress,lessonRef:'unpublished-or-paid'},crypto.randomUUID()));
    await assert.rejects(send(`/enrollments/${crypto.randomUUID()}/progress`,'PUT',progress,crypto.randomUUID()),(error:unknown)=>error instanceof ApiError&&error.code==='enrollment_not_found');
    assert.equal(mutations,1);
    assert.equal((await send(`/enrollments/${enrollmentId}/progress`,'PUT',progress,crypto.randomUUID())).status,200);
    const read=await send(`/enrollments/${enrollmentId}/progress`);assert.equal(read.status,200);assert.equal((await read.json() as any).data.tracking,'self-reported');
    assert.ok(actors.every(actor=>actor.accountId===session.user.id&&actor.orgId==='appneural'&&actor.requestId==='server-request-id'));
    enrollments[0].status='withdrawn';
    await assert.rejects(send(`/enrollments/${enrollmentId}/progress`,'PUT',progress,crypto.randomUUID()),(error:unknown)=>error instanceof ApiError&&error.code==='enrollment_inactive');
  }finally{f.close();}
});

test('learning feature and database configuration fail closed outside isolated local mode',()=>{
  for(const env of [
    {APP_ENABLED:'false',APP_LEARNING_ENABLED:'true'},
    {APP_ENV:'production',APP_ENABLED:'true',APP_LEARNING_ENABLED:'true',APP_LOCAL_POSTGRES:'true',APP_LOCAL_DATABASE_URL:'postgresql://local@localhost/database'},
    {APP_ENV:'test',APP_ENABLED:'true',APP_LEARNING_ENABLED:'true',APP_LOCAL_POSTGRES:'true',APP_LOCAL_DATABASE_URL:'postgresql://private@external.example.test/database'},
  ])assert.throws(()=>config(env),ApiError);
});
