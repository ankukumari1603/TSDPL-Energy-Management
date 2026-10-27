import bcrypt from 'bcryptjs';
import { HttpError } from './service.js';
import { ROLE, isConfiguredRole } from './rolesConfig.js';

const BCRYPT_COST = 12;
const LOCATION_TYPES = ['Office', 'Stockyard', 'Guest House'];
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function validatePassword(pw) {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 12) return 'Password must be at least 12 characters.';
  if (Buffer.byteLength(pw) > 72) return 'Password must be at most 72 bytes.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain upper-case, lower-case and a digit.';
  return null;
}

const str = (v, label, { min = 1, max, pattern, patternMsg } = {}) => {
  if (typeof v !== 'string') throw new HttpError(422, `${label} is required.`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(422, `${label} must be ${min}-${max} characters.`);
  if (pattern && !pattern.test(s)) throw new HttpError(422, patternMsg || `${label} has invalid characters.`);
  return s;
};

export function createAdmin(db, service) {
  const { tx } = service;

  const roleRow = (name) => {
    const r = db.prepare('SELECT RoleID, RoleName FROM RolesMaster WHERE RoleName = ?').get(name);
    if (!r) throw new HttpError(422, 'Unknown role.');
    if (!isConfiguredRole(r.RoleName)) throw new HttpError(422, `Role "${r.RoleName}" has no configured permissions yet.`);
    return r;
  };

  function idList(v, label, table, col) {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x))) throw new HttpError(422, `${label} must be an array of integers.`);
    const ids = [...new Set(v)];
    for (const id of ids) if (!db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ?`).get(id)) throw new HttpError(422, `${label}: ${id} does not exist.`);
    return ids;
  }

  function shapeUser(u) {
    const loaded = service.loadUser(u.UserID);
    const role = db.prepare('SELECT r.RoleName FROM UserRoleMapping m JOIN RolesMaster r ON r.RoleID = m.RoleID WHERE m.UserID = ? ORDER BY r.RoleID LIMIT 1').get(u.UserID)?.RoleName ?? null;
    return {
      id: u.UserID,
      userName: u.UserName,
      email: u.Email,
      employeeCode: u.EmployeeCode,
      isActive: !!u.IsActive,
      role,
      plantIds: db.prepare('SELECT PlantID FROM UserPlantMapping WHERE UserID = ? ORDER BY PlantID').all(u.UserID).map((r) => r.PlantID),
      locationIds: db.prepare('SELECT LocationID FROM UserOfficeLocationMapping WHERE UserID = ? ORDER BY LocationID').all(u.UserID).map((r) => r.LocationID),
      energyEnabled: loaded ? loaded.energyEnabled : null,
    };
  }

  const getUser = (id) => {
    const u = db.prepare('SELECT UserID, UserName, Email, IsActive, EmployeeCode FROM Users WHERE UserID = ?').get(Number(id));
    if (!u) throw new HttpError(404, 'User not found.');
    return u;
  };

  const listUsers = () => db.prepare('SELECT UserID, UserName, Email, IsActive, EmployeeCode FROM Users ORDER BY UserID').all().map(shapeUser);

  function assertUnique(userName, email, employeeCode, exceptId = 0) {
    const dup = db
      .prepare('SELECT 1 FROM Users WHERE UserID <> ? AND (LOWER(UserName) = LOWER(?) OR LOWER(Email) = LOWER(?) OR LOWER(EmployeeCode) = LOWER(?))')
      .get(exceptId, userName, email, employeeCode);
    if (dup) throw new HttpError(409, 'User name, email or employee code is already in use.');
  }

  function setMappings(userId, actor, { plantIds, locationIds }) {
    const ts = now();
    if (plantIds) {
      db.prepare('DELETE FROM UserPlantMapping WHERE UserID = ?').run(userId);
      for (const p of plantIds) db.prepare('INSERT INTO UserPlantMapping (UserID, PlantID, CreatedOn, CreatedBy) VALUES (?,?,?,?)').run(userId, p, ts, String(actor.id));
    }
    if (locationIds) {
      db.prepare('DELETE FROM UserOfficeLocationMapping WHERE UserID = ?').run(userId);
      for (const l of locationIds) db.prepare('INSERT INTO UserOfficeLocationMapping (UserID, LocationID, CreatedOn, CreatedBy) VALUES (?,?,?,?)').run(userId, l, ts, String(actor.id));
    }
  }

  function createUser(actor, body = {}) {
    const userName = str(body.userName, 'User name', { min: 3, max: 50, pattern: /^[A-Za-z0-9._-]+$/, patternMsg: 'User name may contain letters, digits, dot, underscore and hyphen only.' });
    const email = str(body.email, 'Email', { min: 5, max: 100, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMsg: 'Email is not valid.' });
    const employeeCode = str(body.employeeCode, 'Employee code', { min: 1, max: 30, pattern: /^[A-Za-z0-9._-]+$/ });
    const pwErr = validatePassword(body.password);
    if (pwErr) throw new HttpError(422, pwErr);
    const role = roleRow(body.role);
    const plantIds = idList(body.plantIds ?? [], 'plantIds', 'PlantMaster', 'PlantID');
    const locationIds = idList(body.locationIds ?? [], 'locationIds', 'OfficeLocationMaster', 'LocationID');
    const hash = bcrypt.hashSync(body.password, BCRYPT_COST);
    return tx(() => {
      assertUnique(userName, email, employeeCode);
      const ts = now();
      const { lastInsertRowid } = db
        .prepare('INSERT INTO Users (UserName, Email, PasswordHash, IsActive, CreatedOn, CreatedBy, EmployeeCode) VALUES (?,?,?,?,?,?,?)')
        .run(userName, email, hash, 1, ts, String(actor.id), employeeCode);
      const id = Number(lastInsertRowid);
      db.prepare('INSERT INTO UserRoleMapping (UserID, RoleID, CreatedOn, CreatedBy) VALUES (?,?,?,?)').run(id, role.RoleID, ts, String(actor.id));
      setMappings(id, actor, { plantIds, locationIds });
      return shapeUser(getUser(id));
    });
  }

  const activeAdminCount = (exceptId) =>
    db
      .prepare(
        `SELECT COUNT(*) c FROM Users u JOIN UserRoleMapping m ON m.UserID = u.UserID JOIN RolesMaster r ON r.RoleID = m.RoleID
         WHERE u.IsActive = 1 AND r.RoleName = ? AND u.UserID <> ?`,
      )
      .get(ROLE.ADMIN, exceptId).c;

  function updateUser(actor, id, body = {}) {
    const u = getUser(id);
    const current = shapeUser(u);
    const next = {
      email: body.email === undefined ? current.email : str(body.email, 'Email', { min: 5, max: 100, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMsg: 'Email is not valid.' }),
      employeeCode: body.employeeCode === undefined ? current.employeeCode : str(body.employeeCode, 'Employee code', { min: 1, max: 30, pattern: /^[A-Za-z0-9._-]+$/ }),
      isActive: body.isActive === undefined ? current.isActive : body.isActive,
    };
    if (typeof next.isActive !== 'boolean') throw new HttpError(422, 'isActive must be true or false.');
    const role = body.role === undefined ? null : roleRow(body.role);
    const plantIds = idList(body.plantIds, 'plantIds', 'PlantMaster', 'PlantID');
    const locationIds = idList(body.locationIds, 'locationIds', 'OfficeLocationMaster', 'LocationID');
    const isSelf = u.UserID === actor.id;
    if (isSelf && (!next.isActive || (role && role.RoleName !== ROLE.ADMIN))) throw new HttpError(409, 'You cannot deactivate or demote your own account.');
    const losesAdmin = current.role === ROLE.ADMIN && current.isActive && (!next.isActive || (role && role.RoleName !== ROLE.ADMIN));
    if (losesAdmin && activeAdminCount(u.UserID) === 0) throw new HttpError(409, 'At least one active Admin must remain.');
    return tx(() => {
      assertUnique(u.UserName, next.email, next.employeeCode, u.UserID);
      db.prepare('UPDATE Users SET Email = ?, EmployeeCode = ?, IsActive = ? WHERE UserID = ?').run(next.email, next.employeeCode, next.isActive ? 1 : 0, u.UserID);
      if (role) {
        db.prepare('DELETE FROM UserRoleMapping WHERE UserID = ?').run(u.UserID);
        db.prepare('INSERT INTO UserRoleMapping (UserID, RoleID, CreatedOn, CreatedBy) VALUES (?,?,?,?)').run(u.UserID, role.RoleID, now(), String(actor.id));
      }
      setMappings(u.UserID, actor, { plantIds, locationIds });
      return shapeUser(getUser(u.UserID));
    });
  }

  function resetPassword(actor, id, password) {
    const u = getUser(id);
    const err = validatePassword(password);
    if (err) throw new HttpError(422, err);
    db.prepare('UPDATE Users SET PasswordHash = ? WHERE UserID = ?').run(bcrypt.hashSync(password, BCRYPT_COST), u.UserID);
    return { ok: true };
  }

  function listLocations() {
    const used = (table, col, id) => db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${col} = ?`).get(id).c;
    const mapped = (type, col, id) => db.prepare(`SELECT COUNT(*) c FROM EnergyExportCellMapping WHERE MappingType = ? AND ${col} = ? AND IsActive = 1`).get(type, id).c;
    return [
      ...db.prepare('SELECT * FROM PlantMaster ORDER BY PlantID').all().map((r) => ({
        kind: 'plant', id: r.PlantID, name: r.PlantName, isActive: !!r.IsActive,
        assignedUsers: used('UserPlantMapping', 'PlantID', r.PlantID), exportMappings: mapped('PLANT_CONSUMPTION', 'PlantID', r.PlantID),
      })),
      ...db.prepare('SELECT * FROM OfficeLocationMaster ORDER BY LocationID').all().map((r) => ({
        kind: 'office', id: r.LocationID, name: r.LocationName, type: r.LocationType, isActive: !!r.IsActive,
        assignedUsers: used('UserOfficeLocationMapping', 'LocationID', r.LocationID), exportMappings: mapped('OFFICE_CONSUMPTION', 'LocationID', r.LocationID),
      })),
    ];
  }

  function createLocation(actor, body = {}) {
    const name = str(body.name, 'Name', { min: 2, max: 100 }).toUpperCase();
    const ts = now();
    if (body.kind === 'plant') {
      if (db.prepare('SELECT 1 FROM PlantMaster WHERE UPPER(PlantName) = ?').get(name)) throw new HttpError(409, 'A plant with this name already exists.');
      const { lastInsertRowid } = db.prepare('INSERT INTO PlantMaster (PlantName, IsActive, CreatedOn, CreatedBy) VALUES (?,1,?,?)').run(name, ts, String(actor.id));
      return { kind: 'plant', id: Number(lastInsertRowid), name, note: 'No EnergyExportCellMapping rows exist for this plant; its data will not appear in the Excel report until mappings are provided.' };
    }
    if (body.kind === 'office') {
      if (!LOCATION_TYPES.includes(body.locationType)) throw new HttpError(422, `locationType must be one of ${LOCATION_TYPES.join(', ')}.`);
      if (db.prepare('SELECT 1 FROM OfficeLocationMaster WHERE UPPER(LocationName) = ?').get(name)) throw new HttpError(409, 'A location with this name already exists.');
      const { lastInsertRowid } = db.prepare('INSERT INTO OfficeLocationMaster (LocationName, IsActive, CreatedOn, CreatedBy, LocationType) VALUES (?,1,?,?,?)').run(name, ts, String(actor.id), body.locationType);
      return { kind: 'office', id: Number(lastInsertRowid), name, type: body.locationType, note: 'No EnergyExportCellMapping rows exist for this location, so it has no entry parameters until mappings are provided.' };
    }
    throw new HttpError(422, 'kind must be plant or office.');
  }

  function setLocationActive(kind, id, isActive) {
    if (typeof isActive !== 'boolean') throw new HttpError(422, 'isActive must be true or false.');
    const site = service.siteInfo(kind, id);
    const table = kind === 'plant' ? 'PlantMaster' : 'OfficeLocationMaster';
    const col = kind === 'plant' ? 'PlantID' : 'LocationID';
    db.prepare(`UPDATE ${table} SET IsActive = ? WHERE ${col} = ?`).run(isActive ? 1 : 0, site.id);
    return { kind, id: site.id, name: site.name, isActive };
  }

  const listRoles = () =>
    db.prepare('SELECT RoleID, RoleName FROM RolesMaster ORDER BY RoleID').all().map((r) => ({ id: r.RoleID, name: r.RoleName, configured: isConfiguredRole(r.RoleName) }));

  return { listUsers, createUser, updateUser, resetPassword, listLocations, createLocation, setLocationActive, listRoles, LOCATION_TYPES };
}
