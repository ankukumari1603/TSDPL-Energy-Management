import bcrypt from 'bcryptjs';
import { openDb, createFromWorkbook } from '../src/db.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
export const PASSWORD = 'Test-Pass-123!';

export const USERS = {
  entry: { id: 100, name: 'tentry', role: 3, plants: [7], offices: [6] },
  entry2: { id: 101, name: 'tentry2', role: 3, plants: [1], offices: [] },
  sup: { id: 102, name: 'tsup', role: 2, plants: [7, 1, 6, 10], offices: [6] },
  admin: { id: 103, name: 'tadmin', role: 1, plants: [], offices: [] },
  admin2: { id: 105, name: 'tadmin2', role: 1, plants: [], offices: [] },
  noenergy: { id: 104, name: 'tnoenergy', role: 3, plants: [7], offices: [] },
};

export async function makeDb() {
  const db = openDb(':memory:');
  await createFromWorkbook(db, config.seedWorkbook);
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['UserModuleAccess', 'UserPlantMapping', 'UserOfficeLocationMapping', 'UserRoleMapping', 'Users']) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
  const hash = bcrypt.hashSync(PASSWORD, 4);
  for (const u of Object.values(USERS)) {
    db.prepare('INSERT INTO Users (UserID,UserName,Email,PasswordHash,IsActive,CreatedOn,EmployeeCode) VALUES (?,?,?,?,1,?,?)')
      .run(u.id, u.name, `${u.name}@example.test`, hash, '2026-01-01 00:00:00', `E${u.id}`);
    db.prepare('INSERT INTO UserRoleMapping (UserRoleMappingID,UserID,RoleID,CreatedOn) VALUES (?,?,?,?)').run(u.id, u.id, u.role, '2026-01-01 00:00:00');
    u.plants.forEach((p, i) => db.prepare('INSERT INTO UserPlantMapping (MappingID,UserID,PlantID,CreatedOn) VALUES (?,?,?,?)').run(u.id * 10 + i, u.id, p, '2026-01-01 00:00:00'));
    u.offices.forEach((o, i) => db.prepare('INSERT INTO UserOfficeLocationMapping (MappingID,UserID,LocationID,CreatedOn) VALUES (?,?,?,?)').run(u.id * 10 + i, u.id, o, '2026-01-01 00:00:00'));
  }
  db.prepare('INSERT INTO UserModuleAccess (UserID,ModuleID,IsEnabled,UpdatedOn) VALUES (104,1,0,?)').run('2026-01-01 00:00:00');
  return db;
}

export async function startApp(db, opts) {
  const app = createApp(db, opts);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  const login = async (name) => (await call('POST', '/api/auth/login', { body: { username: USERS[name].name, password: PASSWORD } })).data.token;
  return { server, base, call, login, close: () => { server.closeAllConnections(); server.close(); } };
}

export const fullEntries = (ids, v = 1) => ids.map((parameterId, i) => ({ parameterId, value: v + i }));

/**
 * Normal approval: the Supervisor decides alone. (Name kept for existing tests; the Admin token is unused
 * because "forward" no longer exists.)
 */
export async function forwardAndApprove(call, supToken, _adminToken, path) {
  return call('POST', `${path}/review`, { token: supToken, body: { decision: 'approve' } });
}

/** Recreates a record escalated before the Escalate action was removed (rows stay Submitted, ReviewedStatus 'Forwarded'). */
export function legacyEscalate(db, table, idCol, id, fy, q) {
  db.prepare(`UPDATE ${table} SET ReviewedStatus = 'Forwarded', ReviewedBy = '102', ReviewedOn = '2026-01-02 00:00:00' WHERE ${idCol} = ? AND FinancialYear = ? AND QuarterCode = ? AND StatusID = 2`).run(id, fy, q);
}
export const PLANT_PARAMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const OFFICE_PARAMS = [1, 3, 4, 5, 6, 10];
