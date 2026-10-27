import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { openDb } from './db.js';

// Development-only: creates local accounts in the SQLite dev database. Existing users are never modified.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run with NODE_ENV=production.');
  process.exit(1);
}

const ACCOUNTS = [
  { UserName: 'devadmin', EmployeeCode: 'DEV-ADMIN', role: 'Admin', plants: [], locations: [] },
  { UserName: 'devsupervisor', EmployeeCode: 'DEV-SUP', role: 'Supervisor', plants: [1, 6, 7, 10], locations: [6, 7] },
  { UserName: 'devuser', EmployeeCode: 'DEV-USER', role: 'User', plants: [6, 7], locations: [6] },
];

const reset = process.argv.includes('--reset');
const db = openDb(config.dbPath);
const credFile = path.join(config.root, 'data', 'dev-credentials.json');
const creds = fs.existsSync(credFile) ? JSON.parse(fs.readFileSync(credFile, 'utf8')) : {};
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
const newPassword = () => crypto.randomBytes(15).toString('base64url');

for (const a of ACCOUNTS) {
  const existing = db.prepare('SELECT UserID FROM Users WHERE UserName = ?').get(a.UserName);
  if (existing && !reset) {
    console.log(`${a.UserName}: already exists (use --reset to issue a new password).`);
    continue;
  }
  const password = newPassword();
  const hash = bcrypt.hashSync(password, 12);
  if (existing) {
    db.prepare('UPDATE Users SET PasswordHash = ?, IsActive = 1 WHERE UserID = ?').run(hash, existing.UserID);
    console.log(`${a.UserName}: password reset.`);
  } else {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO Users (UserName, Email, PasswordHash, IsActive, CreatedOn, CreatedBy, EmployeeCode) VALUES (?,?,?,?,?,?,?)')
      .run(a.UserName, `${a.UserName}@dev.local`, hash, 1, stamp, 'dev-script', a.EmployeeCode);
    const id = Number(lastInsertRowid);
    const roleId = db.prepare('SELECT RoleID FROM RolesMaster WHERE RoleName = ?').get(a.role).RoleID;
    db.prepare('INSERT INTO UserRoleMapping (UserID, RoleID, CreatedOn, CreatedBy) VALUES (?,?,?,?)').run(id, roleId, stamp, 'dev-script');
    for (const p of a.plants) db.prepare('INSERT INTO UserPlantMapping (UserID, PlantID, CreatedOn, CreatedBy) VALUES (?,?,?,?)').run(id, p, stamp, 'dev-script');
    for (const l of a.locations) db.prepare('INSERT INTO UserOfficeLocationMapping (UserID, LocationID, CreatedOn, CreatedBy) VALUES (?,?,?,?)').run(id, l, stamp, 'dev-script');
    console.log(`${a.UserName}: created as ${a.role}.`);
  }
  creds[a.UserName] = password;
}
fs.mkdirSync(path.dirname(credFile), { recursive: true });
fs.writeFileSync(credFile, JSON.stringify(creds, null, 2));
console.log(`Passwords are stored (git-ignored) in ${credFile}`);
