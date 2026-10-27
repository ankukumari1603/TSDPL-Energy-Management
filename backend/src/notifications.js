import { can, canAccessSite, ROLE } from './permissions.js';

export const EVENT = {
  SUBMITTED: 'Submitted',
  FORWARDED: 'Forwarded',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RETURNED: 'Returned',
  UNLOCK_REQUESTED: 'UnlockRequested',
  UNLOCK_APPROVED: 'UnlockApproved',
  UNLOCK_REJECTED: 'UnlockRejected',
};

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const VERB = {
  [EVENT.SUBMITTED]: 'submitted',
  [EVENT.FORWARDED]: 'reviewed and forwarded for final approval',
  [EVENT.APPROVED]: 'approved',
  [EVENT.REJECTED]: 'rejected',
  [EVENT.RETURNED]: 'returned',
  [EVENT.UNLOCK_REQUESTED]: 'requested an unlock for',
  [EVENT.UNLOCK_APPROVED]: 'approved your unlock request for',
  [EVENT.UNLOCK_REJECTED]: 'rejected your unlock request for',
};

export function createNotifier(db, loadUser) {
  let seq = 0;
  const commentFor = db.prepare(
    `SELECT Comment FROM ApprovalHistory WHERE Action = ? AND ActorUserID = ? AND FinancialYear = ? AND QuarterCode = ?
       AND COALESCE(PlantID, 0) = ? AND COALESCE(LocationID, 0) = ? AND CreatedOn = ? ORDER BY HistoryID DESC LIMIT 1`,
  );
  const activeUsers = () =>
    db.prepare('SELECT UserID FROM Users WHERE IsActive = 1').all().map((r) => loadUser(r.UserID)).filter(Boolean);

  const siteUsers = (site) => activeUsers().filter((u) => can(u, 'energy:view') && canAccessSite(u, site));

  const recipientsFor = (event, site, { actor, submitterId, requesterId }) => {
    let list;
    if (event === EVENT.SUBMITTED) list = siteUsers(site).filter((u) => u.role === ROLE.SUPERVISOR);
    else if (event === EVENT.FORWARDED) list = siteUsers(site).filter((u) => u.role === ROLE.ADMIN);
    else if (event === EVENT.APPROVED || event === EVENT.REJECTED || event === EVENT.RETURNED) {
      list = siteUsers(site).filter((u) => can(u, 'energy:enter') || String(u.id) === String(submitterId));
    } else if (event === EVENT.UNLOCK_REQUESTED) list = activeUsers().filter((u) => can(u, 'energy:unlock-review'));
    else list = activeUsers().filter((u) => u.id === Number(requesterId));
    return list.filter((u) => u.id !== actor.id);
  };

  /** Inserts one notification per recipient. Call inside the caller's transaction. */
  function notify(event, site, fy, quarter, actor, ctx = {}) {
    const ts = ctx.ts ?? now();
    const entity = site.kind === 'plant' ? 'Plant' : 'Office';
    const ins = db.prepare(
      `INSERT INTO Notifications (RecipientUserID, ActorUserID, EventType, EntityType, PlantID, LocationID, FinancialYear, QuarterCode, EventOn, EventKey, UnlockRequestID)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const recipients = recipientsFor(event, site, { actor, ...ctx });
    for (const u of recipients) {
      const key = `${event}:${entity}:${site.id}:${fy}:${quarter}:${Date.now()}-${++seq}:${actor.id}:${u.id}`;
      ins.run(u.id, actor.id, event, entity, site.kind === 'plant' ? site.id : null, site.kind === 'office' ? site.id : null, fy, quarter, ts, key, ctx.unlockRequestId ?? null);
    }
    return recipients.length;
  }

  const visibleWhere = `n.RecipientUserID = ? AND n.ClearedOn IS NULL
    AND n.EventOn > COALESCE((SELECT ClearedThroughAt FROM UserNotificationState WHERE UserID = n.RecipientUserID), '')`;

  function list(userId, { limit = 50 } = {}) {
    const rows = db
      .prepare(
        `SELECT n.*, a.UserName AS ActorName, p.PlantName, l.LocationName
         FROM Notifications n
         LEFT JOIN Users a ON a.UserID = n.ActorUserID
         LEFT JOIN PlantMaster p ON p.PlantID = n.PlantID
         LEFT JOIN OfficeLocationMaster l ON l.LocationID = n.LocationID
         WHERE ${visibleWhere} ORDER BY n.EventOn DESC, n.NotificationID DESC LIMIT ?`,
      )
      .all(userId, limit);
    const unread = db.prepare(`SELECT COUNT(*) c FROM Notifications n WHERE ${visibleWhere} AND n.ReadOn IS NULL`).get(userId).c;
    return {
      unread,
      notifications: rows.map((n) => {
        const full = commentFor.get(n.EventType, n.ActorUserID, n.FinancialYear, n.QuarterCode, n.PlantID ?? 0, n.LocationID ?? 0, n.EventOn)?.Comment || null;
        // Unlock approvals append an audit snapshot after the admin's note; notifications show the note only.
        const comment = n.EventType === 'UnlockApproved' && full?.startsWith('Previously ') ? null : n.EventType === 'UnlockApproved' ? full?.split('\n')[0] || null : full;
        const where = `${n.PlantName ?? n.LocationName ?? 'a location'}${n.FinancialYear ? ` (${n.FinancialYear}${n.QuarterCode ? ` ${n.QuarterCode}` : ''})` : ''}`;
        return {
          id: n.NotificationID,
          event: n.EventType,
          decision: n.EventType,
          reason: comment,
          message: `${n.ActorName ?? 'Someone'} ${VERB[n.EventType] ?? n.EventType} ${where}${comment ? `. Reason: ${comment}` : ''}`,
          site: { kind: n.PlantID ? 'plant' : 'office', id: n.PlantID ?? n.LocationID },
          financialYear: n.FinancialYear,
          quarter: n.QuarterCode || null,
          unlockRequestId: n.UnlockRequestID,
          eventOn: n.EventOn,
          read: !!n.ReadOn,
        };
      }),
    };
  }

  const markRead = (userId, id) =>
    db.prepare('UPDATE Notifications SET ReadOn = ? WHERE NotificationID = ? AND RecipientUserID = ? AND ReadOn IS NULL').run(now(), id, userId).changes;

  const markAllRead = (userId) =>
    db.prepare('UPDATE Notifications SET ReadOn = ? WHERE RecipientUserID = ? AND ReadOn IS NULL AND ClearedOn IS NULL').run(now(), userId).changes;

  function clearAll(userId) {
    const ts = now();
    const max = db.prepare('SELECT MAX(EventOn) m FROM Notifications WHERE RecipientUserID = ? AND ClearedOn IS NULL').get(userId).m;
    const changes = db.prepare('UPDATE Notifications SET ClearedOn = ?, ReadOn = COALESCE(ReadOn, ?) WHERE RecipientUserID = ? AND ClearedOn IS NULL').run(ts, ts, userId).changes;
    if (max) {
      db.prepare(
        `INSERT INTO UserNotificationState (UserID, LastSeenAt, ClearedThroughAt) VALUES (?,?,?)
         ON CONFLICT(UserID) DO UPDATE SET LastSeenAt = excluded.LastSeenAt, ClearedThroughAt = excluded.ClearedThroughAt`,
      ).run(userId, ts, max);
    }
    return changes;
  }

  return { notify, list, markRead, markAllRead, clearAll };
}
