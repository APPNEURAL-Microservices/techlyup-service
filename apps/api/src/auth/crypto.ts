import { scrypt, timingSafeEqual } from 'node:crypto';

// Canonical compatibility: techlyup-next/src/lib/learner/crypto.ts, audited 2026-10-16.
// Do not lower the work factor or silently create a second password format.
const WORK = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 } as const;
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export async function hash(value: string) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
export function opaque(kind: 'a' | 'r') { return `tlu_${kind}_${hex(crypto.getRandomValues(new Uint8Array(32)))}`; }
export function validToken(value: string, kind: 'a' | 'r') { return new RegExp(`^tlu_${kind}_[a-f0-9]{64}$`).test(value); }
function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, WORK, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(24));
  return `scrypt$${WORK.N}$${WORK.r}$${WORK.p}$${hex(salt)}$${hex(await derive(password, salt))}`;
}
export const DUMMY_HASH = `scrypt$${WORK.N}$${WORK.r}$${WORK.p}$${'00'.repeat(24)}$${'00'.repeat(32)}`;
export async function verifyPassword(password: string, stored: string) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== String(WORK.N) || parts[2] !== String(WORK.r) || parts[3] !== String(WORK.p) || !/^[a-f0-9]{48}$/.test(parts[4]) || !/^[a-f0-9]{64}$/.test(parts[5])) return false;
  return timingSafeEqual(await derive(password, Uint8Array.from(Buffer.from(parts[4], 'hex'))), Buffer.from(parts[5], 'hex'));
}
