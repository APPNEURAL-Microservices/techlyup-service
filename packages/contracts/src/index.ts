import { z } from 'zod';
import { profileTaxonomy } from './taxonomy';
export { profileTaxonomy } from './taxonomy';
export { publicCatalog } from './catalog';
export { courseLessons, courseKit } from './lessons';
import { publicCatalog } from './catalog';
/** Scheduled snapshot entries expire; dates never imply live registration capacity. */
export function currentPublicCatalog(now = new Date()): Catalog {
  return { ...publicCatalog, items: publicCatalog.items.filter(item => item.kind !== 'webinar' || !item.startsAt || Date.parse(item.startsAt) >= now.getTime()) };
}

export const API_VERSION = 'v1' as const;
export type ClientPlatform = 'web' | 'ios' | 'android';
export interface ApiMeta { requestId: string; apiVersion: 'v1' }
export type ApiResponse<T> = { data: T; meta: ApiMeta } | { error: { code: string; message: string; fields?: Record<string, string> }; meta: ApiMeta };
export interface UserProfile {
  id: string; email: string; name: string; emailVerified: boolean;
  firstName?: string; middleName?: string; lastName?: string;
  audienceIds: string[]; goalIds: string[]; interestIds: string[];
  roles: string[]; permissions: string[];
  /** Present for accounts created with the app registration form. */
  registration?: AccountRegistration;
}
export interface AuthSession { user: UserProfile; accessToken: string; expiresIn: number; refreshToken?: string }
export type LearningKind = 'course' | 'webinar' | 'mentorship' | 'career';
export interface LearningItem {
  id: string; kind: LearningKind; title: string; description: string; category: string;
  level: 'Beginner' | 'Intermediate' | 'All levels';
  status: 'available' | 'scheduled' | 'request' | 'planned';
  duration?: string; startsAt?: string; priceLabel: string;
  websiteUrl: string; imageUrl?: string;
}
export interface Catalog { items: LearningItem[]; source: 'website-snapshot'; updatedAt: string }
export interface AdminOverview { accounts: number; nativeSessions: number; auditEvents: number }
export interface Enrollment { id: string; kind: LearningKind; itemRef: string; status: 'active' | 'completed' | 'withdrawn'; createdAt: string }
export interface LessonProgress { enrollmentId: string; lessonRef: string; status: 'started' | 'completed'; version: number; updatedAt: string }

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
/** Canonical password sign-in, kept for existing accounts. The app signs in with email codes instead. */
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const otpPurposes = ['signup', 'login'] as const;
export const OTP_SECONDS = 600;
export const otpRequestSchema = z.object({ email, purpose: z.enum(otpPurposes) }).strict();
export interface OtpChallenge { challengeId: string; expiresIn: number }
/** TechlyUp ID + permanent passcode for signing in on TechlyUp LIVE. `passcode` is present only in the response that creates it. */
export interface LivePasscode { loginId: string; createdAt: string; lastUsedAt?: string; passcode?: string }
const otpChallengeId = z.string('Request a new code.').regex(/^otp_[0-9a-f]{32}$/, 'Request a new code.');
const otpCode = z.string('Enter the 6-digit code from your email.').trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your email.');
export const otpLoginSchema = z.object({ email, challengeId: otpChallengeId, code: otpCode }).strict();
export const accountTypes = ['student', 'teacher'] as const;
export type AccountType = typeof accountTypes[number];
/** Self-declared teaching experience: mentor 15+ years in industry, instructor 5+ years, academic for school/college teaching. Never a role grant. */
export const teacherRoles = ['mentor', 'instructor', 'academic'] as const;
export type TeacherRole = typeof teacherRoles[number];
export const preferredLanguages = ['en', 'hi', 'hi-en'] as const;
export type PreferredLanguage = typeof preferredLanguages[number];
export const ageGroups = ['adult', 'minor'] as const;
export type AgeGroup = typeof ageGroups[number];
/** Bumped when registration started collecting language, institution, interests, age group, guardian and updates choices. */
export const ACCOUNT_CONSENT_VERSION = '2026-10-21' as const;
/** Self-declared registration details. accountType and teacherRole describe the person; they never grant a role or permission. */
export interface AccountRegistration {
  accountType: AccountType; teacherRole?: TeacherRole; phone: string; city: string; referralCode: string;
  preferredLanguage?: PreferredLanguage; institution?: string; ageGroup?: AgeGroup;
}
/** Indian mobile numbers, stored as +91XXXXXXXXXX. Accepts spaces, dashes and a +91, 91 or 0 prefix. */
export const indianMobileSchema = z.string('Enter your mobile number.').trim().max(20, 'Enter a valid 10-digit mobile number.')
  .transform(value => value.replace(/[\s()-]/g, '').replace(/^(?:\+91|0091|91|0)(?=[6-9]\d{9}$)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.'))
  .transform(value => `+91${value}`);
export const referralCodeSchema = z.string().trim().toUpperCase().regex(/^TU[0-9A-Z]{6}$/, 'Enter a valid referral code, like TU7K4M2Q.');
const blankAsUndefined = (value: unknown) => typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalText = (max: number, message: string) => z.preprocess(blankAsUndefined, z.string(message).trim().min(2, message).max(max, message).optional());
const interestIds = z.array(z.string().refine(id => profileTaxonomy.interests.some(item => item.id === id), 'Choose a listed interest.')).max(8, 'Choose up to 8 interests.').transform(ids => [...new Set(ids)]);
/** Passwordless: the email code proves the address before the account exists. */
export const signupSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name.').max(100), lastName: z.string().trim().min(1, 'Enter your last name.').max(100),
  email, phone: indianMobileSchema,
  accountType: z.enum(accountTypes, 'Choose whether you are a learner or a teacher.'),
  teacherRole: z.enum(teacherRoles, 'Choose how you teach.').optional(),
  city: z.string('Enter your city.').trim().min(2, 'Enter your city.').max(80, 'Use a shorter city name.').regex(/^\p{L}[\p{L}\p{M} .'-]*$/u, 'Enter a valid city name.'),
  institution: optionalText(120, 'Use 2 to 120 characters.'),
  preferredLanguage: z.enum(preferredLanguages, 'Choose a preferred language.'),
  interestIds,
  referralCode: z.preprocess(blankAsUndefined, referralCodeSchema.optional()),
  ageGroup: z.enum(ageGroups, 'Tell us whether you are 18 or older.'),
  guardianName: optionalText(100, 'Enter your parent or guardian’s full name.'),
  guardianEmail: z.preprocess(blankAsUndefined, email.optional()),
  guardianConsent: z.literal(true).optional(),
  updatesConsent: z.boolean(),
  consent: z.literal(true), consentVersion: z.literal(ACCOUNT_CONSENT_VERSION),
  challengeId: otpChallengeId, code: otpCode,
}).strict().superRefine((input, context) => {
  const issue = (field: string, message: string) => context.addIssue({ code: 'custom', path: [field], message });
  if (input.accountType === 'teacher' && !input.teacherRole) issue('teacherRole', 'Choose how you teach.');
  if (input.accountType !== 'teacher' && input.teacherRole) issue('teacherRole', 'Only teachers choose a teaching role.');
  if (input.ageGroup === 'minor') {
    if (input.accountType === 'teacher') issue('ageGroup', 'Teachers need to be 18 or older.');
    if (!input.guardianName) issue('guardianName', 'Enter your parent or guardian’s full name.');
    if (!input.guardianEmail) issue('guardianEmail', 'Enter your parent or guardian’s email.');
    else if (input.guardianEmail === input.email) issue('guardianEmail', 'Use your parent or guardian’s own email address.');
    if (input.guardianConsent !== true) issue('guardianConsent', 'Your parent or guardian needs to agree before you join.');
  } else if (input.guardianName || input.guardianEmail || input.guardianConsent) issue('ageGroup', 'Guardian details are only for learners under 18.');
});
export const profileSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name.').max(100), lastName: z.string().trim().min(1, 'Enter your last name.').max(100),
  audienceIds: z.array(z.string().refine(id => profileTaxonomy.audiences.some(item => item.id === id), 'Choose a listed audience.')).max(3).transform(ids => [...new Set(ids)]),
  goalIds: z.array(z.string().refine(id => profileTaxonomy.goals.some(item => item.id === id), 'Choose a listed goal.')).max(5).transform(ids => [...new Set(ids)]),
  interestIds: z.array(z.string().refine(id => profileTaxonomy.interests.some(item => item.id === id), 'Choose a listed interest.')).max(8).transform(ids => [...new Set(ids)]),
}).strict();
export type LoginInput = z.infer<typeof loginSchema>;
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;
export type OtpLoginInput = z.infer<typeof otpLoginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;

export const analyticsSchema = z.object({
  event: z.enum(['screen_view', 'catalog_filter', 'learning_open', 'auth_complete', 'profile_saved']),
  screen: z.enum(['home', 'learn', 'webinars', 'mentors', 'career', 'profile', 'admin', 'sign-in', 'sign-up']),
  itemKind: z.enum(['course', 'webinar', 'mentorship', 'career']).optional(),
}).strict();
export type AnalyticsEvent = z.infer<typeof analyticsSchema>;
export * from './crm';
