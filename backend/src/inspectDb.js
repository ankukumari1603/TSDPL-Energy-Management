import { config } from './config.js';
import { openDb } from './db.js';

// Read-only overview of the local SQLite database. Never prints password hashes.
const db = openDb(config.dbPath);
console.log('Database:', config.dbPath);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
for (const { name } of tables) {
  const n = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c;
  const fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all().map((f) => `${f.from}->${f.table}.${f.to}`);
  console.log(`${name.padEnd(26)} rows=${String(n).padEnd(4)} FKs: ${fks.join(', ') || '-'}`);
}
console.log('foreign_key_check violations:', db.prepare('PRAGMA foreign_key_check').all().length);
console.log('\nUsers (no hashes):');
console.table(
  db.prepare(`SELECT u.UserID, u.UserName, u.Email, u.IsActive, u.EmployeeCode, r.RoleName AS Role,
      (SELECT group_concat(PlantID) FROM UserPlantMapping WHERE UserID = u.UserID) AS Plants,
      (SELECT group_concat(LocationID) FROM UserOfficeLocationMapping WHERE UserID = u.UserID) AS Locations
    FROM Users u LEFT JOIN UserRoleMapping m ON m.UserID = u.UserID LEFT JOIN RolesMaster r ON r.RoleID = m.RoleID ORDER BY u.UserID`).all(),
);
