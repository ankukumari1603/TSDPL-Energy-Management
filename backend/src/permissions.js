import { ROLE, roleHasPermission } from './rolesConfig.js';

export { ROLE };

export const STATUS = { DRAFT: 1, SUBMITTED: 2, APPROVED: 3, REJECTED: 4, RETURNED: 5 };
/** A Submitted record the supervisor has forwarded keeps StatusID Submitted and ReviewedStatus 'Forwarded'. */
export const FORWARDED = 'Forwarded';

/** Review stage of a submitted record: awaiting the supervisor, awaiting the admin, or null when not in review. */
export function reviewStage(rows) {
  if (rows.length === 0 || rows.some((r) => r.StatusID !== STATUS.SUBMITTED || r.ReviewedStatus === 'Rejected')) return null;
  return rows.every((r) => r.ReviewedStatus === FORWARDED) ? 'AwaitingAdmin' : rows.every((r) => !r.ReviewedStatus) ? 'AwaitingSupervisor' : null;
}

/** Energy and dashboard permissions also need the energy module to be enabled for the user. */
export function can(user, permission) {
  if (!user || !roleHasPermission(user.role, permission)) return false;
  return permission.startsWith('admin:') || user.energyEnabled !== false;
}

/** Admins see every site; other roles only their mapped sites. */
export function canAccessSite(user, site) {
  if (!user) return false;
  if (user.role === ROLE.ADMIN) return true;
  return site.kind === 'plant' ? user.plantIds.includes(site.id) : user.locationIds.includes(site.id);
}

const isLegacyRejected = (r) => r.ReviewedStatus === 'Rejected';

/** Rows may be edited while absent, Draft, Rejected or Returned (incl. legacy rows rejected via ReviewedStatus). */
export function isEditable(rows) {
  return rows.every(
    (r) => isLegacyRejected(r) || [STATUS.DRAFT, STATUS.REJECTED, STATUS.RETURNED].includes(r.StatusID),
  );
}

/** Overall status id of a (site, FY, quarter) set of rows; null when there are no rows. */
export function overallStatus(rows) {
  if (rows.length === 0) return null;
  if (rows.some(isLegacyRejected)) return STATUS.REJECTED;
  return Math.min(...rows.map((r) => r.StatusID));
}
