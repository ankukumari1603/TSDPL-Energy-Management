import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

// Tables of the supplied BRSR database that the Energy module uses.
export const ENERGY_TABLES = [
  'RolesMaster',
  'StatusMaster',
  'ModuleMaster',
  'Users',
  'PlantMaster',
  'OfficeLocationMaster',
  'ParameterMaster',
  'UserRoleMapping',
  'UserPlantMapping',
  'UserOfficeLocationMapping',
  'UserModuleAccess',
  'EnergyConsumption',
  'OfficeEnergyConsumption',
  'EnergyConversionFactor',
  'EnergyExportCellMapping',
  'UnlockRequests',
  'Notifications',
  'UserNotificationState',
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

const sqliteType = (t) =>
  ({ bigint: 'INTEGER', int: 'INTEGER', bit: 'INTEGER', decimal: 'REAL' })[t] || 'TEXT';

function sheetRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1)));
  return rows;
}

function normalise(v, dataType, nullable = true) {
  if (v === null || v === undefined || v === '') {
    // An empty cell in a NOT NULL text column was an empty string in the source database.
    return !nullable && ['varchar', 'nvarchar'].includes(dataType) ? '' : null;
  }
  if (v && typeof v === 'object' && 'result' in v) v = v.result;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  if (dataType === 'bit') return v === true || String(v).toLowerCase() === 'true' || v === 1 ? 1 : 0;
  if (['int', 'bigint', 'decimal'].includes(dataType)) return Number(v);
  return String(v);
}

/** Creates tables and loads rows from the supplied workbook. DDL comes from its Schema and Foreign Keys sheets. */
export async function createFromWorkbook(db, workbookPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath);
  const schema = sheetRows(wb.getWorksheet('Schema')).slice(1);
  const fks = sheetRows(wb.getWorksheet('Foreign Keys')).slice(1);
  const columns = {};
  for (const [, table, , name, dataType, , , , nullable, pk] of schema) {
    if (!ENERGY_TABLES.includes(table)) continue;
    (columns[table] ||= []).push({ name, dataType, nullable: nullable === 'YES', pk: pk === 'YES' });
  }
  for (const t of ENERGY_TABLES) {
    const cols = columns[t];
    if (!cols) throw new Error(`Table ${t} not found in Schema sheet`);
    const pks = cols.filter((c) => c.pk);
    const defs = cols.map((c) => {
      let d = `"${c.name}" ${sqliteType(c.dataType)}`;
      if (pks.length === 1 && c.pk) d += ' PRIMARY KEY';
      else if (!c.nullable) d += ' NOT NULL';
      return d;
    });
    if (pks.length > 1) defs.push(`PRIMARY KEY (${pks.map((c) => `"${c.name}"`).join(',')})`);
    for (const [fk, , table, col, refTable, refCol] of fks) {
      if (table === t && ENERGY_TABLES.includes(refTable)) {
        defs.push(`CONSTRAINT "${fk}" FOREIGN KEY ("${col}") REFERENCES "${refTable}" ("${refCol}")`);
      }
    }
    db.exec(`CREATE TABLE "${t}" (${defs.join(', ')})`);
  }
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ENERGY_TABLES) {
    const ws = wb.getWorksheet(t);
    const cols = columns[t];
    const ins = db.prepare(
      `INSERT INTO "${t}" (${cols.map((c) => `"${c.name}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    );
    for (const r of sheetRows(ws).slice(1)) {
      if (r[0] === undefined || r[0] === null) continue;
      ins.run(...cols.map((c, i) => normalise(r[i], c.dataType, c.nullable)));
    }
  }
  const bad = db.prepare('PRAGMA foreign_key_check').all();
  db.exec('PRAGMA foreign_keys = ON');
  if (bad.length) throw new Error(`Foreign key violations after seed: ${JSON.stringify(bad)}`);
}
