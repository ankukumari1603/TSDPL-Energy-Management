export const ROLE = { ADMIN: 'Admin', SUPERVISOR: 'Supervisor', USER: 'User' };

const ALL = [ROLE.ADMIN, ROLE.SUPERVISOR, ROLE.USER];

/** Permission -> roles allowed. Roles are the RoleName values stored in RolesMaster. */
export const PERMISSIONS = {
  'energy:view': ALL,
  'energy:enter': [ROLE.ADMIN, ROLE.USER],
  // Supervisors review and decide (approve, reject, return). Admins may do the same as an exception.
  'energy:review': [ROLE.SUPERVISOR, ROLE.ADMIN],
  'energy:approve': [ROLE.SUPERVISOR, ROLE.ADMIN],
  'energy:export': [ROLE.ADMIN, ROLE.SUPERVISOR],
  'energy:unlock-request': [ROLE.USER, ROLE.SUPERVISOR],
  'energy:unlock-review': [ROLE.ADMIN],
  'dashboard:view': [ROLE.ADMIN, ROLE.SUPERVISOR],
  'admin:manage': [ROLE.ADMIN],
};

/**
 * RolesMaster defines only Admin, Supervisor and User. A fourth role has been mentioned but not
 * confirmed by the company, so nothing is implemented for it. Once confirmed, set `name` to the exact
 * RolesMaster.RoleName, list its permission keys from PERMISSIONS above, and set `enabled` to true.
 * Any RolesMaster role that is not configured has no permissions at all.
 */
export const PENDING_FOURTH_ROLE = { enabled: false, name: null, permissions: [] };

export function roleHasPermission(role, permission) {
  if (PERMISSIONS[permission]?.includes(role)) return true;
  return PENDING_FOURTH_ROLE.enabled && PENDING_FOURTH_ROLE.name === role && PENDING_FOURTH_ROLE.permissions.includes(permission);
}

export const isConfiguredRole = (role) =>
  Object.values(ROLE).includes(role) || (PENDING_FOURTH_ROLE.enabled && PENDING_FOURTH_ROLE.name === role);
