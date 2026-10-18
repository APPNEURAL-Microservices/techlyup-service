import { z } from 'zod';
import type { ClientPlatform } from '@techlyup/contracts';
import { ApiError } from './types';
import type { config } from './config';

export const BODY_LIMIT = 16_000;
export function clientPlatform(request: Request): ClientPlatform {
  const client = request.headers.get('x-techlyup-client') ?? 'web';
  if (!['web', 'ios', 'android'].includes(client)) throw new ApiError('invalid_client', 'Choose a supported app client.', 400);
  return client as ClientPlatform;
}
export function checkOrigin(request: Request, settings: ReturnType<typeof config>) {
  if (settings.mode === 'production' && new URL(request.url).protocol !== 'https:') throw new ApiError('https_required','Use the secure TechlyUp app address.',403);
  const origin = request.headers.get('origin');
  if (origin && !settings.origins.includes(origin)) throw new ApiError('origin_denied', 'This app origin is not authorized.', 403);
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method)) {
    if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError('origin_denied', 'This app origin is not authorized.', 403);
    if (clientPlatform(request) === 'web' && (!origin || (settings.mode === 'production' && origin !== new URL(request.url).origin))) throw new ApiError('origin_denied', 'Web requests must come from this app.', 403);
  }
}
export async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError('invalid_content_type', 'Send a JSON request.', 415);
  if (Number(request.headers.get('content-length') ?? 0) > BODY_LIMIT) throw new ApiError('body_too_large', 'Request is too large.', 413);
  const reader = request.body?.getReader();
  let size = 0, raw = ''; const decoder = new TextDecoder();
  if (reader) while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > BODY_LIMIT) { await reader.cancel(); throw new ApiError('body_too_large', 'Request is too large.', 413); }
    raw += decoder.decode(part.value, { stream: true });
  }
  raw += decoder.decode();
  try { return JSON.parse(raw); } catch { throw new ApiError('invalid_json', 'Send valid JSON.', 400); }
}
export function success(data: unknown, requestId: string, status = 200) { return Response.json({ data, meta: { requestId, apiVersion: 'v1' } }, { status }); }
export function failure(error: unknown, requestId: string) {
  if (error instanceof z.ZodError) return Response.json({ error: { code: 'validation_failed', message: 'Check the supplied details.', fields: Object.fromEntries(error.issues.map(issue => [issue.path.join('.'), issue.message])) }, meta: { requestId, apiVersion: 'v1' } }, { status: 422 });
  const known = error instanceof ApiError ? error : new ApiError('service_unavailable', 'App services are temporarily unavailable.', 503);
  return Response.json({ error: { code: known.code, message: known.message, ...(known.fields ? { fields: known.fields } : {}) }, meta: { requestId, apiVersion: 'v1' } }, { status: known.status, headers: known.status === 429 ? { 'Retry-After': '60' } : {} });
}
export function secureResponse(response: Response, request: Request, origins: string[]) {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Vary', 'Origin, Authorization, Cookie');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if(new URL(request.url).protocol==='https:')response.headers.set('Strict-Transport-Security','max-age=31536000');
  const origin = request.headers.get('origin');
  if (origin && origins.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return response;
}
