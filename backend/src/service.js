import { STATUS, ROLE, can, canAccessSite, isEditable, overallStatus, reviewStage } from './permissions.js';
import { validateEntries, validateFinancialYear, validateQuarter, QUARTERS } from './validation.js';
import { convertLines } from './conversion.js';
import { createNotifier, EVENT } from './notifications.js';
import { ensureApprovalHistory, ensureFaridabadMapping } from './migrations.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const SITE_TABLES = {
  plant: { table: 'EnergyConsumption', idCol: 'PlantID', pk: 'EnergyConsumptionID', master: 'PlantMaster', nameCol: 'PlantName', mappingType: 'PLANT_CONSUMPTION' },
  office: { table: 'OfficeEnergyConsumption', idCol: 'LocationID', pk: 'OfficeEnergyConsumptionID', master: 'OfficeLocationMaster', nameCol: 'LocationName', mappingType: 'OFFICE_CONSUMPTION' },
};

export function createService(db) {
  ensureApprovalHistory(db);
  ensureFaridabadMapping(db);
  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const parameters = () => db.prepare('SELECT * FROM ParameterMaster ORDER BY ParameterID').all();
  const factors = () => db.prepare('SELECT * FROM EnergyConversionFactor').all();

  function loadUser(userId) {
    const u = db.prepare('SELECT UserID, UserName, Email, IsActive FROM Users WHERE UserID = ?').get(userId);
    if (!u || !u.IsActive) return null;
    const role = db
      .prepare('SELECT r.RoleName FROM UserRoleMapping m JOIN RolesMaster r ON r.RoleID = m.RoleID WHERE m.UserID = ? ORDER BY r.RoleID LIMIT 1')
      .get(userId)?.RoleName;
    if (!role) return null;
    const override = db
      .prepare("SELECT a.IsEnabled FROM UserModuleAccess a JOIN ModuleMaster m ON m.ModuleID = a.ModuleID WHERE a.UserID = ? AND m.ModuleKey = 'energy'")
      .get(userId);
    const def = db.prepare("SELECT DefaultEnabled FROM ModuleMaster WHERE ModuleKey = 'energy' AND IsActive = 1").get();
    return {
      id: u.UserID,
      name: u.UserName,
      email: u.Email,
      role,
      plantIds: db.prepare('SELECT PlantID FROM UserPlantMapping WHERE UserID = ?').all(userId).map((r) => r.PlantID),
      locationIds: db.prepare('SELECT LocationID FROM UserOfficeLocationMapping WHERE UserID = ?').all(userId).map((r) => r.LocationID),
      energyEnabled: override ? !!override.IsEnabled : !!def?.DefaultEnabled,
    };
  }

  const notifier = createNotifier(db, (id) => loadUser(id));

  /** Appends an audit row and returns its timestamp, which notifications reuse to find the comment. */
  function recordHistory(site, fy, q, action, actor, { from = null, to = null, comment = null, unlockRequestId = null } = {}) {
    const ts = now();
    db.prepare(
      `INSERT INTO ApprovalHistory (RecordType, PlantID, LocationID, FinancialYear, QuarterCode, Action, FromStatusID, ToStatusID, ActorUserID, ActorRole, Comment, UnlockRequestID, CreatedOn)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(site.kind === 'plant' ? 'Plant' : 'Office', site.kind === 'plant' ? site.id : null, site.kind === 'office' ? site.id : null, fy, q, action, from, to, actor.id, actor.role, comment || null, unlockRequestId, ts);
    return ts;
  }

  function history(user, kind, id, fy, q) {
    const site = siteInfo(kind, id);
    checkScope(user, site, fy, q);
    return db
      .prepare(
        `SELECT h.*, u.UserName AS ActorName, s1.StatusName AS FromStatus, s2.StatusName AS ToStatus
         FROM ApprovalHistory h
         JOIN Users u ON u.UserID = h.ActorUserID
         LEFT JOIN StatusMaster s1 ON s1.StatusID = h.FromStatusID
         LEFT JOIN StatusMaster s2 ON s2.StatusID = h.ToStatusID
         WHERE h.RecordType = ? AND COALESCE(h.PlantID, 0) = ? AND COALESCE(h.LocationID, 0) = ? AND h.FinancialYear = ? AND h.QuarterCode = ?
         ORDER BY h.HistoryID`,
      )
      .all(site.kind === 'plant' ? 'Plant' : 'Office', site.kind === 'plant' ? site.id : 0, site.kind === 'office' ? site.id : 0, fy, q)
      .map((h) => ({
        id: h.HistoryID,
        action: h.Action,
        by: h.ActorName,
        role: h.ActorRole,
        comment: h.Comment,
        fromStatus: h.FromStatus,
        toStatus: h.ToStatus,
        at: h.CreatedOn,
        unlockRequestId: h.UnlockRequestID,
      }));
  }

  function siteInfo(kind, id) {
    const t = SITE_TABLES[kind];
    if (!t) throw new HttpError(400, 'Unknown site type.');
    const row = db.prepare(`SELECT * FROM ${t.master} WHERE ${t.idCol} = ?`).get(Number(id));
    if (!row) throw new HttpError(404, 'Location not found.');
    return { kind, id: Number(id), name: row[t.nameCol], active: !!row.IsActive, ...(kind === 'office' ? { type: row.LocationType } : {}) };
  }

  function allowedParameterIds(site) {
    if (site.kind === 'plant') return parameters().map((p) => p.ParameterID);
    return db
      .prepare('SELECT DISTINCT ParameterID FROM EnergyExportCellMapping WHERE MappingType = ? AND LocationID = ? AND IsActive = 1 ORDER BY ParameterID')
      .all(SITE_TABLES.office.mappingType, site.id)
      .map((r) => r.ParameterID);
  }

  function listSites(user) {
    const plants = db.prepare('SELECT * FROM PlantMaster WHERE IsActive = 1 ORDER BY PlantID').all()
      .map((r) => ({ kind: 'plant', id: r.PlantID, name: r.PlantName }));
    const offices = db.prepare('SELECT * FROM OfficeLocationMaster WHERE IsActive = 1 ORDER BY LocationID').all()
      .map((r) => ({ kind: 'office', id: r.LocationID, name: r.LocationName, type: r.LocationType }));
    return [...plants, ...offices].filter((s) => canAccessSite(user, s));
  }

  function rowsFor(site, fy, q) {
    const t = SITE_TABLES[site.kind];
    return db
      .prepare(`SELECT * FROM ${t.table} WHERE ${t.idCol} = ? AND FinancialYear = ? AND QuarterCode = ? ORDER BY ParameterID`)
      .all(site.id, fy, q);
  }

  function checkScope(user, site, fy, q) {
    const e = validateFinancialYear(fy) || validateQuarter(q);
    if (e) throw new HttpError(400, e);
    if (!canAccessSite(user, site)) throw new HttpError(403, 'You do not have access to this location.');
  }

  function getRecord(user, kind, id, fy, q) {
    const site = siteInfo(kind, id);
    checkScope(user, site, fy, q);
    const rows = rowsFor(site, fy, q);
    const allowed = allowedParameterIds(site);
    const byParam = new Map(rows.map((r) => [r.ParameterID, r]));
    const params = parameters().filter((p) => allowed.includes(p.ParameterID));
    const status = overallStatus(rows);
    const conv = convertLines(
      rows.filter((r) => allowed.includes(r.ParameterID)).map((r) => ({ ParameterID: r.ParameterID, ConsumptionValue: r.ConsumptionValue })),
      parameters(),
      factors(),
    );
    const gjById = new Map(conv.lines.map((l) => [l.ParameterID, l.gj]));
    const first = rows[0];
    return {
      site,
      financialYear: fy,
      quarter: q,
      status,
      statusName: status ? db.prepare('SELECT StatusName FROM StatusMaster WHERE StatusID = ?').get(status)?.StatusName : 'Not started',
      editable: isEditable(rows),
      stage: reviewStage(rows),
      stageName: { AwaitingSupervisor: 'Awaiting supervisor review', AwaitingAdmin: 'Previously escalated to admin; a supervisor or admin may decide' }[reviewStage(rows)] ?? null,
      rejectionReason: rows.find((r) => r.RejectionReason)?.RejectionReason ?? null,
      submittedBy: first?.SubmittedBy ?? null,
      submittedOn: first?.SubmittedOn ?? null,
      reviewedBy: first?.ReviewedBy ?? null,
      reviewedOn: first?.ReviewedOn ?? null,
      entries: params.map((p) => ({
        parameterId: p.ParameterID,
        sourceOfEnergy: p.SourceOfEnergy,
        parameterName: p.ParameterName,
        unit: p.Unit,
        value: byParam.get(p.ParameterID)?.ConsumptionValue ?? null,
        gj: gjById.get(p.ParameterID) ?? null,
      })),
      conversion: { totals: conv.totals, missing: conv.missing, complete: conv.complete },
      pendingUnlock: pendingUnlockFor(site, fy, q),
    };
  }

  function writeEntries(user, site, fy, q, clean, existing) {
    const t = SITE_TABLES[site.kind];
    const ts = now();
    const uid = String(user.id);
    const byParam = new Map(existing.map((r) => [r.ParameterID, r]));
    for (const e of clean) {
      if (byParam.has(e.parameterId)) {
        db.prepare(`UPDATE ${t.table} SET ConsumptionValue = ?, ModifiedOn = ?, ModifiedBy = ? WHERE ${t.pk} = ?`)
          .run(e.value, ts, uid, byParam.get(e.parameterId)[t.pk]);
      } else {
        db.prepare(`INSERT INTO ${t.table} (${t.idCol}, ParameterID, FinancialYear, QuarterCode, ConsumptionValue, StatusID, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(site.id, e.parameterId, fy, q, e.value, STATUS.DRAFT, ts, uid, ts, uid);
      }
    }
    return ts;
  }

  function save(user, kind, id, fy, q, entries, { submit }) {
    const site = siteInfo(kind, id);
    checkScope(user, site, fy, q);
    if (!site.active) throw new HttpError(409, 'Location is inactive.');
    const t = SITE_TABLES[site.kind];
    return tx(() => {
      const existing = rowsFor(site, fy, q);
      if (!isEditable(existing)) throw new HttpError(409, 'This record is submitted or approved and cannot be edited.');
      const { errors, clean } = validateEntries(entries, allowedParameterIds(site), { submit, units: Object.fromEntries(parameters().map((p) => [p.ParameterID, p.Unit])) });
      if (errors.length) throw new HttpError(422, 'Validation failed.', errors);
      const ts = writeEntries(user, site, fy, q, clean, existing);
      const keep = new Set(clean.map((c) => c.parameterId));
      // A blank value in a draft removes any previously saved row for that parameter.
      for (const r of existing) {
        if (!keep.has(r.ParameterID) && entries.some((e) => Number(e.parameterId) === r.ParameterID)) {
          db.prepare(`DELETE FROM ${t.table} WHERE ${t.pk} = ?`).run(r[t.pk]);
        }
      }
      if (submit) {
        db.prepare(
          `UPDATE ${t.table} SET StatusID = ?, SubmittedOn = ?, SubmittedBy = ?, ModifiedOn = ?, ModifiedBy = ?, ReviewedOn = NULL, ReviewedStatus = NULL, ReviewedBy = NULL, RejectionReason = NULL WHERE ${t.idCol} = ? AND FinancialYear = ? AND QuarterCode = ?`,
        ).run(STATUS.SUBMITTED, ts, String(user.id), ts, String(user.id), site.id, fy, q);
        const hts = recordHistory(site, fy, q, 'Submitted', user, { from: overallStatus(existing), to: STATUS.SUBMITTED });
        notifier.notify(EVENT.SUBMITTED, site, fy, q, user, { submitterId: user.id, ts: hts });
      } else {
        db.prepare(
          `UPDATE ${t.table} SET StatusID = ?, ReviewedStatus = NULL, ReviewedOn = NULL, ReviewedBy = NULL WHERE ${t.idCol} = ? AND FinancialYear = ? AND QuarterCode = ?`,
        ).run(STATUS.DRAFT, site.id, fy, q);
      }
      return getRecord(user, kind, id, fy, q);
    });
  }

  function review(user, kind, id, fy, q, { decision, reason }) {
    const site = siteInfo(kind, id);
    checkScope(user, site, fy, q);
    const t = SITE_TABLES[site.kind];
    if (!['return', 'approve', 'reject'].includes(decision)) throw new HttpError(400, 'decision must be approve, reject or return.');
    // Supervisors and Admins may approve, reject or return a submitted record; no Admin step is required.
    if (!can(user, 'energy:review')) throw new HttpError(403, 'You do not have permission to review records.');
    const trimmed = (reason ?? '').trim();
    if ((decision === 'return' || decision === 'reject') && !trimmed) throw new HttpError(422, decision === 'return' ? 'A comment is required when returning a record.' : 'A rejection reason is required.');
    if (trimmed.length > 500) throw new HttpError(422, 'Comment must be 500 characters or fewer.');
    return tx(() => {
      const rows = rowsFor(site, fy, q);
      // Records escalated before this rule ("AwaitingAdmin") remain reviewable like any submitted record.
      const stage = reviewStage(rows);
      if (!stage) throw new HttpError(409, 'Only a submitted record can be reviewed.');
      if (rows.some((r) => r.SubmittedBy === String(user.id))) {
        throw new HttpError(403, 'You cannot review a record you submitted.');
      }
      const outcome = {
        approve: [STATUS.APPROVED, 'Approved', 'Approved', EVENT.APPROVED],
        reject: [STATUS.REJECTED, 'Rejected', 'Rejected', EVENT.REJECTED],
        return: [STATUS.RETURNED, 'Returned', 'Returned', EVENT.RETURNED],
      }[decision];
      const ts = now();
      db.prepare(
        `UPDATE ${t.table} SET StatusID = ?, ReviewedStatus = ?, ReviewedOn = ?, ReviewedBy = ?, ModifiedOn = ?, ModifiedBy = ?, RejectionReason = ? WHERE ${t.idCol} = ? AND FinancialYear = ? AND QuarterCode = ?`,
      ).run(outcome[0], outcome[1], ts, String(user.id), ts, String(user.id), decision === 'approve' ? null : trimmed, site.id, fy, q);
      const hts = recordHistory(site, fy, q, outcome[2], user, { from: STATUS.SUBMITTED, to: outcome[0], comment: trimmed });
      notifier.notify(outcome[3], site, fy, q, user, { submitterId: rows[0].SubmittedBy, ts: hts });
      return getRecord(user, kind, id, fy, q);
    });
  }

  /** One line per (site, FY, quarter) the user can see, for the review queue and dashboards. */
  function listRecords(user, fy, q) {
    const e = validateFinancialYear(fy) || validateQuarter(q);
    if (e) throw new HttpError(400, e);
    return listSites(user).map((s) => {
      const rows = rowsFor(s, fy, q);
      const status = overallStatus(rows);
      return {
        site: s,
        status,
        statusName: status ? db.prepare('SELECT StatusName FROM StatusMaster WHERE StatusID = ?').get(status).StatusName : 'Not started',
        parameterCount: rows.length,
        stage: reviewStage(rows),
        submittedBy: rows[0]?.SubmittedBy ?? null,
      };
    });
  }

  /** Submitted records waiting for a Supervisor or Admin decision in any quarter of the year. */
  function listPending(user, fy) {
    const e = validateFinancialYear(fy);
    if (e) throw new HttpError(400, e);
    if (!can(user, 'energy:review')) return [];
    return listSites(user).flatMap((s) =>
      QUARTERS.flatMap((q) => {
        const rows = rowsFor(s, fy, q);
        const stage = reviewStage(rows);
        if (!stage) return [];
        return [{ site: s, financialYear: fy, quarter: q, stage, submittedBy: rows[0].SubmittedBy ?? null, submittedOn: rows[0].SubmittedOn ?? null }];
      }),
    );
  }

  function conversionFactors() {
    return factors().map((f) => ({
      parameterId: f.ParameterID,
      factor: f.ConversionFactor,
      uom: f.ConversionUOM,
      source: f.SourceName,
      category: f.EnergyCategory,
    }));
  }

  const REQUEST_TYPE = { plant: 'EnergyPlant', office: 'EnergyOffice' };

  function pendingUnlockFor(site, fy, q) {
    const t = SITE_TABLES[site.kind];
    const r = db
      .prepare(
        `SELECT UnlockRequestID, RequestedByUserID, Reason, CreatedOn FROM UnlockRequests
         WHERE RequestType = ? AND ${t.idCol} = ? AND FinancialYear = ? AND QuarterCode = ? AND Status = 'Pending'`,
      )
      .get(REQUEST_TYPE[site.kind], site.id, fy, q);
    return r ? { id: r.UnlockRequestID, requestedBy: r.RequestedByUserID, reason: r.Reason, createdOn: r.CreatedOn } : null;
  }

  const unlockSelect = `SELECT u.*, r.UserName AS RequesterName, v.UserName AS ReviewerName, p.PlantName, l.LocationName
    FROM UnlockRequests u
    LEFT JOIN Users r ON r.UserID = u.RequestedByUserID
    LEFT JOIN Users v ON v.UserID = u.ReviewedByUserID
    LEFT JOIN PlantMaster p ON p.PlantID = u.PlantID
    LEFT JOIN OfficeLocationMaster l ON l.LocationID = u.LocationID`;

  /** Live status of the record an unlock request refers to (distinct from the request's own status). */
  function recordStatusName(site, fy, q) {
    const status = overallStatus(rowsFor(site, fy, q));
    return status ? db.prepare('SELECT StatusName FROM StatusMaster WHERE StatusID = ?').get(status)?.StatusName ?? null : 'Not started';
  }

  const shapeUnlock = (u) => {
    const site = u.PlantID ? { kind: 'plant', id: u.PlantID, name: u.PlantName } : { kind: 'office', id: u.LocationID, name: u.LocationName };
    return {
    id: u.UnlockRequestID,
    site,
    recordStatus: recordStatusName(site, u.FinancialYear, u.QuarterCode),
    financialYear: u.FinancialYear,
    quarter: u.QuarterCode,
    reason: u.Reason,
    status: u.Status,
    requestedBy: u.RequesterName,
    requesterRole: u.RequesterRole,
    createdOn: u.CreatedOn,
    reviewedBy: u.ReviewerName ?? null,
    reviewedOn: u.ReviewedOn,
    rejectionReason: u.RejectionReason,
    };
  };

  function requestUnlock(user, kind, id, fy, q, reason) {
    const site = siteInfo(kind, id);
    checkScope(user, site, fy, q);
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text) throw new HttpError(422, 'A reason is required.');
    if (text.length > 500) throw new HttpError(422, 'Reason must be 500 characters or fewer.');
    const t = SITE_TABLES[site.kind];
    return tx(() => {
      const rows = rowsFor(site, fy, q);
      if (rows.length === 0 || isEditable(rows)) throw new HttpError(409, 'This record is not locked; it can be edited directly.');
      if (pendingUnlockFor(site, fy, q)) throw new HttpError(409, 'An unlock request is already pending for this record.');
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO UnlockRequests (RequestType, RequestedByUserID, RequesterRole, ${t.idCol}, FinancialYear, QuarterCode, Reason, Status, CreatedOn)
           VALUES (?,?,?,?,?,?,?,'Pending',?)`,
        )
        .run(REQUEST_TYPE[site.kind], user.id, user.role, site.id, fy, q, text, now());
      const unlockRequestId = Number(lastInsertRowid);
      const hts = recordHistory(site, fy, q, 'UnlockRequested', user, { from: overallStatus(rows), to: overallStatus(rows), comment: text, unlockRequestId });
      notifier.notify(EVENT.UNLOCK_REQUESTED, site, fy, q, user, { unlockRequestId, ts: hts });
      return shapeUnlock(db.prepare(`${unlockSelect} WHERE u.UnlockRequestID = ?`).get(unlockRequestId));
    });
  }

  /** Admins see every energy request; others only their own. */
  function listUnlockRequests(user, { status } = {}) {
    const where = ["u.RequestType IN ('EnergyPlant','EnergyOffice')"];
    const args = [];
    if (user.role !== ROLE.ADMIN) {
      where.push('u.RequestedByUserID = ?');
      args.push(user.id);
    }
    if (status) {
      if (!['Pending', 'Approved', 'Rejected'].includes(status)) throw new HttpError(400, 'Unknown status filter.');
      where.push('u.Status = ?');
      args.push(status);
    }
    return db.prepare(`${unlockSelect} WHERE ${where.join(' AND ')} ORDER BY u.CreatedOn DESC, u.UnlockRequestID DESC`).all(...args).map(shapeUnlock);
  }

  /** Unlocking overwrites the review fields, so the prior decision and values are kept in the audit comment. */
  function previousApprovalNote(rows) {
    const first = rows[0];
    const reviewer = first.ReviewedBy ? db.prepare('SELECT UserName FROM Users WHERE UserID = ?').get(Number(first.ReviewedBy))?.UserName ?? `user ${first.ReviewedBy}` : 'unknown';
    const names = new Map(parameters().map((p) => [p.ParameterID, p.ParameterName]));
    const values = rows.map((r) => `${names.get(r.ParameterID) ?? `Parameter ${r.ParameterID}`}=${r.ConsumptionValue}`).join('; ');
    return `Previously ${first.ReviewedStatus === 'Approved' ? 'approved' : 'decided'} by ${reviewer}${first.ReviewedOn ? ` on ${first.ReviewedOn} UTC` : ''}. Values before revision: ${values}`;
  }

  function reviewUnlock(user, requestId, { decision, reason }) {
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'decision must be approve or reject.');
    const trimmed = (reason ?? '').trim();
    if (decision === 'reject' && !trimmed) throw new HttpError(422, 'A rejection reason is required.');
    if (trimmed.length > 500) throw new HttpError(422, 'Rejection reason must be 500 characters or fewer.');
    return tx(() => {
      const req = db.prepare(`${unlockSelect} WHERE u.UnlockRequestID = ? AND u.RequestType IN ('EnergyPlant','EnergyOffice')`).get(Number(requestId));
      if (!req) throw new HttpError(404, 'Unlock request not found.');
      if (req.Status !== 'Pending') throw new HttpError(409, 'This request has already been reviewed.');
      if (req.RequestedByUserID === user.id) throw new HttpError(403, 'You cannot review your own request.');
      const site = siteInfo(req.PlantID ? 'plant' : 'office', req.PlantID ?? req.LocationID);
      const t = SITE_TABLES[site.kind];
      const approve = decision === 'approve';
      const before = overallStatus(rowsFor(site, req.FinancialYear, req.QuarterCode));
      let snapshot = null;
      if (approve) {
        const rows = rowsFor(site, req.FinancialYear, req.QuarterCode);
        if (rows.length === 0 || isEditable(rows)) throw new HttpError(409, 'The record is no longer locked.');
        snapshot = previousApprovalNote(rows);
        db.prepare(
          `UPDATE ${t.table} SET StatusID = ?, ReviewedStatus = NULL, ReviewedOn = NULL, ReviewedBy = NULL, RejectionReason = NULL, ModifiedOn = ?, ModifiedBy = ?
           WHERE ${t.idCol} = ? AND FinancialYear = ? AND QuarterCode = ?`,
        ).run(STATUS.RETURNED, now(), String(user.id), site.id, req.FinancialYear, req.QuarterCode);
      }
      db.prepare('UPDATE UnlockRequests SET Status = ?, ReviewedOn = ?, ReviewedByUserID = ?, RejectionReason = ? WHERE UnlockRequestID = ?')
        .run(approve ? 'Approved' : 'Rejected', now(), user.id, approve ? null : trimmed, req.UnlockRequestID);
      const hts = recordHistory(site, req.FinancialYear, req.QuarterCode, approve ? 'UnlockApproved' : 'UnlockRejected', user, {
        from: before,
        to: approve ? STATUS.RETURNED : before,
        comment: approve ? [trimmed, snapshot].filter(Boolean).join('\n') : trimmed,
        unlockRequestId: req.UnlockRequestID,
      });
      notifier.notify(approve ? EVENT.UNLOCK_APPROVED : EVENT.UNLOCK_REJECTED, site, req.FinancialYear, req.QuarterCode, user, {
        unlockRequestId: req.UnlockRequestID,
        requesterId: req.RequestedByUserID,
        ts: hts,
      });
      return shapeUnlock(db.prepare(`${unlockSelect} WHERE u.UnlockRequestID = ?`).get(req.UnlockRequestID));
    });
  }

  return { loadUser, listSites, getRecord, save, review, listRecords, listPending, conversionFactors, siteInfo, rowsFor, parameters, factors, tx, ROLE, requestUnlock, listUnlockRequests, reviewUnlock, notifier, history, checkScope };
}
