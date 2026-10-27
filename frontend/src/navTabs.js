/** Navigation tabs as [key, label]; Unlock requests sits directly beside Approvals/Review. Users get no Dashboard. */
export function navTabs({ role }) {
  const isAdmin = role === 'Admin';
  const reviewer = isAdmin || role === 'Supervisor';
  return [
    ...(reviewer ? [['dashboard', 'Dashboard']] : []),
    ['entry', 'Data entry'],
    ...(reviewer ? [['review', isAdmin ? 'Approvals' : 'Review']] : []),
    ['unlock', isAdmin ? 'Unlock requests' : 'My unlock requests'],
    ...(reviewer ? [['report', 'Excel report']] : []),
    ['factors', 'Conversion factors'],
    ...(isAdmin ? [['admin', 'Admin']] : []),
    ['password', 'Change password'],
  ];
}
