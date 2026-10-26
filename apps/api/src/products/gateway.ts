import type { Env } from '../types';
import { productIds, type ProductId } from './identity';

export type StudioAppBinding = `STUDIO_${Uppercase<ProductId>}`;
export const studioAppBinding = (appId: ProductId) => `STUDIO_${appId.toUpperCase()}` as StudioAppBinding;
const appPath = /^\/studio\/([a-z]+)(?:\/|$)/;

/** app.techlyup.com/studio/<app>/* is served by that app's own Worker through a service binding.
 * Before release, or without its binding, this returns null and the central app's own page answers. */
export async function routeStudioApp(request: Request, env: Env): Promise<Response | null> {
  const appId = productIds.find(id => id === appPath.exec(new URL(request.url).pathname)?.[1]);
  if (!appId || env.APP_ENABLED !== 'true' || env.APP_PRODUCTS_ENABLED !== 'true') return null;
  const app = env[studioAppBinding(appId)];
  if (!app) return null;
  // Each app receives only its own session cookies: never the central refresh cookie,
  // bearer credentials or another app's session. It cannot set any other cookie either.
  const own = new RegExp(`^(?:__Host-)?tu_${appId}_(?:session|login)=`);
  const headers = new Headers(request.headers);
  const cookies = (request.headers.get('Cookie') ?? '').split(';').map(value => value.trim()).filter(value => own.test(value));
  headers.delete('Authorization'); headers.delete('Cookie');
  if (cookies.length) headers.set('Cookie', cookies.join('; '));
  let response: Response;
  try { response = await app.fetch(new Request(request, { headers })); }
  catch { return new Response('This TechlyUp app is temporarily unavailable. Please try again.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } }); }
  const out = new Headers(response.headers);
  out.delete('Set-Cookie');
  for (const value of response.headers.getSetCookie()) if (own.test(value)) out.append('Set-Cookie', value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}
