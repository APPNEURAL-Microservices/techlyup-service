/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { beginLiveLogin, consumeLiveLogin, type LiveLoginEnv, type LiveLoginProps } from './login';
/** No public fetch method. Caller scope comes only from operator-managed binding props. */
export class TechlyUpIdentity extends WorkerEntrypoint<LiveLoginEnv, LiveLoginProps> {
  beginLiveLogin(input: { pkceChallenge: string }) { return beginLiveLogin(this.env, this.ctx.props, input); }
  consumeLiveLogin(input: { challengeId: string; code: string; verifier: string }) { return consumeLiveLogin(this.env, this.ctx.props, input); }
}
