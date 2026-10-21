import type { Env } from './types';

export interface TransactionalEmail { to: string; subject: string; text: string }
export type EmailDelivery = 'accepted' | 'rejected' | 'uncertain';

const validAddress = (value: string | undefined): value is string => Boolean(value && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value));

/** Cloudflare Email Sending is the only sender, as on TechlyUp LIVE. Missing or invalid configuration fails closed. */
export function emailConfigured(env: Env) {
  return typeof env.EMAIL?.send === 'function' && validAddress(env.EMAIL_FROM);
}

/** Never logs or returns message content; callers decide what a failed delivery means. */
export async function sendEmail(env: Env, message: TransactionalEmail): Promise<EmailDelivery> {
  if (!emailConfigured(env) || !validAddress(message.to) || /[\r\n]/.test(message.subject)) return 'rejected';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      env.EMAIL!.send({ from: { email: env.EMAIL_FROM!, name: 'TechlyUp' }, to: message.to, subject: message.subject, text: message.text }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('email_timeout')), 20000); }),
    ]);
    return typeof result?.messageId === 'string' && result.messageId ? 'accepted' : 'uncertain';
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return /^E_(VALIDATION_ERROR|FIELD_MISSING|SENDER_NOT_VERIFIED|RECIPIENT_NOT_ALLOWED|RECIPIENT_SUPPRESSED|SENDER_DOMAIN_NOT_AVAILABLE|DELIVERY_FAILED|RATE_LIMIT_EXCEEDED|DAILY_LIMIT_EXCEEDED)/.test(code) ? 'rejected' : 'uncertain';
  } finally { if (timer) clearTimeout(timer); }
}
