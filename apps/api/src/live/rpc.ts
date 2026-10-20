/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError } from '../types';
import type { RpcResult } from '../credits/types';
import { beginLiveLogin, consumeLiveLogin, type LiveLoginEnv, type LiveLoginProps } from './login';
export async function liveLoginResult<T>(work: () => Promise<T>): Promise<RpcResult<T>> {
  try { return { ok: true, data: await work() }; }
  catch (error) {
    return { ok: false, error: error instanceof ApiError ? { code: error.code, message: error.message }
      : error instanceof z.ZodError ? { code: 'live_login_invalid_request', message: 'This sign-in request is invalid. Start again from TechlyUp LIVE.' }
      : { code: 'live_login_unavailable', message: 'TechlyUp accounts are temporarily unavailable. Please try again.' } };
  }
}
/** No public fetch method. Caller scope comes only from operator-managed binding props. */
export class TechlyUpIdentity extends WorkerEntrypoint<LiveLoginEnv, LiveLoginProps> {
  beginLiveLogin(input: { pkceChallenge: string }) { return liveLoginResult(() => beginLiveLogin(this.env, this.ctx.props, input)); }
  consumeLiveLogin(input: { challengeId: string; code: string; verifier: string }) { return liveLoginResult(() => consumeLiveLogin(this.env, this.ctx.props, input)); }
}
