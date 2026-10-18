import type { AuthSession } from '@techlyup/contracts';
import { REFRESH_SECONDS } from './service';
import { clientPlatform } from '../http';

function cookieName(request: Request) { return new URL(request.url).protocol === 'https:' ? '__Host-tlu_app_refresh' : 'tlu_app_refresh'; }
export function refreshCookie(request: Request) {
  const key = `${cookieName(request)}=`;
  return (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(key))?.slice(key.length) ?? '';
}
export function setRefreshCookie(response: Response, request: Request, token: string, clear = false) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  response.headers.append('Set-Cookie', `${cookieName(request)}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : REFRESH_SECONDS}${secure}`);
}
export function clientSession(session: AuthSession, request: Request) {
  if (clientPlatform(request) !== 'web') return session;
  const { refreshToken: _private, ...browserSession } = session;
  return browserSession;
}
