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
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const signupSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name.').max(100), lastName: z.string().trim().min(1, 'Enter your last name.').max(100),
  email, password: z.string().min(12, 'Use at least 12 characters.').max(128),
  consent: z.literal(true), consentVersion: z.literal('2026-10'),
}).strict();
export const profileSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name.').max(100), lastName: z.string().trim().min(1, 'Enter your last name.').max(100),
  audienceIds: z.array(z.string().refine(id => profileTaxonomy.audiences.some(item => item.id === id), 'Choose a listed audience.')).max(3).transform(ids => [...new Set(ids)]),
  goalIds: z.array(z.string().refine(id => profileTaxonomy.goals.some(item => item.id === id), 'Choose a listed goal.')).max(5).transform(ids => [...new Set(ids)]),
  interestIds: z.array(z.string().refine(id => profileTaxonomy.interests.some(item => item.id === id), 'Choose a listed interest.')).max(8).transform(ids => [...new Set(ids)]),
}).strict();
export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;

export const analyticsSchema = z.object({
  event: z.enum(['screen_view', 'catalog_filter', 'learning_open', 'auth_complete', 'profile_saved']),
  screen: z.enum(['home', 'learn', 'webinars', 'mentors', 'career', 'profile', 'admin', 'sign-in', 'sign-up']),
  itemKind: z.enum(['course', 'webinar', 'mentorship', 'career']).optional(),
}).strict();
export type AnalyticsEvent = z.infer<typeof analyticsSchema>;
export * from './crm';
