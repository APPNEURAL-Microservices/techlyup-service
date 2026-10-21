import { OTP_SECONDS, type OtpChallenge, type OtpRequestInput } from '@techlyup/contracts';
import { ApiError, type D1Database, type Env } from '../types';
import { emailConfigured, sendEmail, type TransactionalEmail } from '../email';
import { hash, randomHex } from './crypto';

export const OTP_ATTEMPTS = 5;
export const invalidCode = () => new ApiError('invalid_code', 'This code is not valid any more. Check it or request a new one.', 401, { code: 'Check the code or request a new one.' });

/** Uniform six digits; values above the largest multiple of 10^6 are redrawn. */
function sixDigits() {
  const limit = 2 ** 32 - (2 ** 32 % 1_000_000);
  for (;;) { const [value] = crypto.getRandomValues(new Uint32Array(1)); if (value! < limit) return String(value! % 1_000_000).padStart(6, '0'); }
}
function message(email: string, purpose: OtpRequestInput['purpose'], code: string | null, appOrigin: string): TransactionalEmail {
  const ignore = 'If you did not ask for this, you can ignore this email.';
  if (code) return { to: email, subject: purpose === 'signup' ? 'Confirm your email for TechlyUp' : 'Your TechlyUp sign-in code',
    text: `Your TechlyUp code is ${code}\n\nIt expires in ${OTP_SECONDS / 60} minutes and works once. Never share it with anyone, including TechlyUp staff.\n\n${ignore}` };
  return purpose === 'signup'
    ? { to: email, subject: 'You already have a TechlyUp account', text: `Someone tried to create a TechlyUp account with this email, but one already exists.\n\nSign in with an email code instead: ${appOrigin}/sign-in\n\n${ignore}` }
    : { to: email, subject: 'Sign in to TechlyUp', text: `We could not find a TechlyUp account for this email.\n\nCreate one here: ${appOrigin}/sign-up\n\n${ignore}` };
}

/**
 * Sends a code only when it can be used: sign-up for a new email, sign-in for an existing account.
 * Otherwise the email explains what to do instead. Either way the response is the same, so it never reveals which emails are registered.
 */
export async function requestCode(env: Env, db: D1Database, input: OtpRequestInput, appOrigin: string, now = new Date()): Promise<OtpChallenge> {
  if (!emailConfigured(env)) throw new ApiError('email_unavailable', 'Email codes are not available right now. Please try again later.', 503);
  const exists = Boolean(await db.prepare('SELECT 1 AS found FROM learner_accounts WHERE email=?').bind(input.email).first());
  const usable = input.purpose === 'signup' ? !exists : exists, code = usable ? sixDigits() : null;
  const id = `otp_${randomHex(16)}`, instant = now.toISOString();
  await db.prepare('INSERT INTO app_email_otp_challenges(id,purpose,email_hash,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)')
    .bind(id, input.purpose, await hash(input.email), code ? await hash(`${id}:${code}`) : null, new Date(now.getTime() + OTP_SECONDS * 1000).toISOString(), instant).run();
  const delivery = await sendEmail(env, message(input.email, input.purpose, code, appOrigin));
  if (delivery !== 'accepted') {
    await db.prepare('UPDATE app_email_otp_challenges SET consumed_at=? WHERE id=?').bind(instant, id).run();
    throw delivery === 'uncertain'
      ? new ApiError('email_unconfirmed', 'We could not confirm the email was sent. Wait a minute, then request a new code.', 502)
      : new ApiError('email_failed', 'We could not send the email. Check the address or try again later.', 502);
  }
  return { challengeId: id, expiresIn: OTP_SECONDS };
}

/** Counts the attempt first, so a wrong guess is spent even if the request is retried; a correct code works exactly once. */
export async function consumeCode(db: D1Database, purpose: OtpRequestInput['purpose'], email: string, challengeId: string, code: string, now = new Date()) {
  const instant = now.toISOString();
  const row = await db.prepare('UPDATE app_email_otp_challenges SET attempts=attempts+1 WHERE id=? AND purpose=? AND consumed_at IS NULL AND expires_at>? AND attempts<? RETURNING email_hash,code_hash')
    .bind(challengeId, purpose, instant, OTP_ATTEMPTS).first<{ email_hash: string; code_hash: string | null }>();
  if (!row?.code_hash || row.email_hash !== await hash(email) || row.code_hash !== await hash(`${challengeId}:${code}`)) throw invalidCode();
  const used = await db.prepare('UPDATE app_email_otp_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL RETURNING id').bind(instant, challengeId).first();
  if (!used) throw invalidCode();
}
