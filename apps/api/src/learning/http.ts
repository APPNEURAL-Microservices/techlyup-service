import { z } from 'zod';
import { courseLessons,currentPublicCatalog } from '@techlyup/contracts';
import { createDatabase,LearningError,LearningRepository,type DatabaseActor } from '@appneurox/learning-postgres';
import { ApiError,type Env } from '../types';
import { database,learningConnection,type config } from '../config';
import { jsonBody,success } from '../http';
import { rateLimit,type Identity } from '../auth/service';

const COURSE='course-ai-useful-answers';
const enrollmentSchema=z.object({kind:z.literal('course'),id:z.literal(COURSE)}).strict();
const progressSchema=z.object({lessonRef:z.string().refine(id=>courseLessons.some(lesson=>lesson.id===id),'Choose a published lesson.'),status:z.enum(['started','completed']),expectedVersion:z.number().int().min(0).max(2147483646)}).strict();
type Repository=Pick<LearningRepository,'enroll'|'listEnrollments'|'saveProgress'|'listProgress'>;
type Work=<T>(env:Env,run:(repo:Repository)=>Promise<T>)=>Promise<T>;
const withRepository:Work=async(env,run)=>{
  const pool=createDatabase(learningConnection(env));
  // Never log pool errors/DSNs; every request owns and closes its pool.
  pool.on('error',()=>{});
  try{return await run(new LearningRepository(pool));}
  finally{await pool.end().catch(()=>undefined);}
};
function idempotency(request:Request){
  const value=request.headers.get('idempotency-key');
  if(!z.uuid().safeParse(value).success)throw new ApiError('idempotency_required','Use a stable UUID Idempotency-Key for this change.',422);
  return value!;
}
function assertFreeCourse(){
  const course=currentPublicCatalog().items.find(item=>item.id===COURSE);
  if(!course||course.kind!=='course'||course.status!=='available'||course.priceLabel!=='Free')throw new ApiError('course_unavailable','This free practice course is unavailable.',409);
}
const learningMessage:Record<string,string>={enrollment_not_found:'This enrollment was not found.',enrollment_inactive:'This enrollment is no longer active.',version_conflict:'Your progress changed. Refresh before saving again.',progress_regression:'A completed practice step cannot be reset.',idempotency_conflict:'This request key belongs to a different change.'};

export async function handleLearning(request:Request,env:Env,identity:Identity,requestId:string,settings:ReturnType<typeof config>,work:Work=withRepository){
  if(!settings.learning)throw new ApiError('feature_disabled','Learning sync is not enabled in this environment.',503);
  assertFreeCourse();
  const path=new URL(request.url).pathname.replace(/\/$/,''),actor:DatabaseActor={orgId:env.TECHLYUP_ERP_ORG_ID!,accountId:identity.user.id,issuer:'techlyup-learner',requestId};
  await rateLimit(database(env),'learning',identity.user.id,120);
  try{
    if(path==='/api/v1/learning/enrollments'){
      if(request.method==='GET')return success({enrollments:await work(env,repo=>repo.listEnrollments(actor)),tracking:'self-reported'},requestId);
      if(request.method==='POST'){
        const item=enrollmentSchema.parse(await jsonBody(request)),key=idempotency(request);
        return success(await work(env,repo=>repo.enroll(actor,item,key)),requestId,201);
      }
      throw new ApiError('method_not_allowed','This API method is not supported.',405);
    }
    const match=path.match(/^\/api\/v1\/learning\/enrollments\/([^/]+)\/progress$/);
    if(!match)throw new ApiError('not_found','Learning API route not found.',404);
    const enrollmentId=z.uuid().parse(match[1]);
    const input=request.method==='PUT'?progressSchema.parse(await jsonBody(request)):null;
    const key=request.method==='PUT'?idempotency(request):null;
    if(!['GET','PUT'].includes(request.method))throw new ApiError('method_not_allowed','This API method is not supported.',405);
    return await work(env,async repo=>{
      const owner=(await repo.listEnrollments(actor)).find(item=>item.id===enrollmentId);
      if(!owner||owner.kind!=='course'||owner.itemRef!==COURSE)throw new ApiError('enrollment_not_found','This enrollment was not found.',404);
      if(owner.status!=='active')throw new ApiError('enrollment_inactive','This enrollment is no longer active.',409);
      if(request.method==='GET')return success({progress:await repo.listProgress(actor,enrollmentId),tracking:'self-reported'},requestId);
      return success(await repo.saveProgress(actor,{enrollmentId,...input!},key!),requestId);
    });
  }catch(error){
    if(error instanceof LearningError)throw new ApiError(error.code,learningMessage[error.code]??'Learning sync could not complete this change.',error.status);
    throw error;
  }
}
