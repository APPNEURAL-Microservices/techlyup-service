import type { D1Database } from '../types';

// Derived from canonical techlyup-next/src/lib/webinar-erp/contract.ts:29–54.
// Read roles on every request; never accept a role from signup, a token or client.
const ALL = ['read','private','operate','create','review','publish','finance','admin','certify','content','global','assess','grade','support','support_manage','export','mentor','mentor_manage'];
// A canonical database that predates website 0041 has no staff-link table yet. Then nobody holds staff
// authority (least privilege); any other storage error still fails the request.
export const missingStaffLinks = (error: unknown) => error instanceof Error && /no such table: live_core_staff_links\b/.test(error.message);
export async function authority(db: D1Database, orgId: string, account: { id: string; email: string }, now: string) {
  const link = await db.prepare(`SELECT actor_id,actor_role,actor_email FROM live_core_staff_links
    WHERE learner_account_id=? AND org_id=? AND revoked_at IS NULL AND expires_at>?`)
    .bind(account.id, orgId, now).first<{ actor_id: string; actor_role: string; actor_email: string }>()
    .catch(error => { if (missingStaffLinks(error)) return null; throw error; });
  if (!link || link.actor_email.toLowerCase() !== account.email.toLowerCase()) return { roles: ['learner'], permissions: [] as string[] };
  const rows = await db.prepare('SELECT functional_role FROM webinar_erp_roles WHERE org_id=? AND actor_id=?').bind(orgId, link.actor_id).all<{ functional_role: string }>();
  const roles = rows.results.map(row => row.functional_role);
  if (['owner','admin'].includes(link.actor_role)) return { roles: [...new Set(['learner', link.actor_role, ...roles])], permissions: [...ALL] };
  const permissions = new Set<string>(['read']);
  for (const role of roles) {
    if (['operations','academic_admin','coordinator','finance','certificate','quality','content'].includes(role)) permissions.add('global');
    if (['operations','academic_admin','moderator','host','coordinator'].includes(role)) { permissions.add('private'); permissions.add('operate'); }
    if (role === 'support') permissions.add('support');
    if (role === 'mentor') permissions.add('mentor');
    if (['operations','academic_admin','coordinator'].includes(role)) for (const p of ['mentor','mentor_manage','support','support_manage']) permissions.add(p);
    if (['operations','academic_admin','finance','coordinator'].includes(role)) permissions.add('export');
    if (['trainer','teacher','mentor','co_trainer','academic_admin'].includes(role)) { permissions.add('assess'); permissions.add('grade'); }
    if (role === 'quality') permissions.add('grade');
    if (['sales','crm','assistant'].includes(role)) permissions.add('private');
    if (['trainer','teacher','mentor','co_trainer','content','academic_admin'].includes(role)) permissions.add('create');
    if (['academic_admin','quality'].includes(role)) permissions.add('review');
    if (['academic_admin','content'].includes(role)) permissions.add('content');
    if (role === 'academic_admin') permissions.add('publish');
    if (role === 'finance') permissions.add('finance');
    if (role === 'certificate') { permissions.add('certify'); permissions.add('private'); }
  }
  if (link.actor_role === 'manager') for (const p of ['private','operate','create','global','support','support_manage','export','mentor','mentor_manage']) permissions.add(p);
  return { roles: [...new Set(['learner', link.actor_role, ...roles])], permissions: [...permissions] };
}
