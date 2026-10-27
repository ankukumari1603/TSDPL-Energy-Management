import fs from 'node:fs';
import { config } from './config.js';
import { openDb, createFromWorkbook } from './db.js';

if (fs.existsSync(config.dbPath)) {
  if (process.argv.includes('--force')) fs.rmSync(config.dbPath);
  else {
    console.error(`${config.dbPath} exists. Use --force to rebuild it from the workbook.`);
    process.exit(1);
  }
}
const db = openDb(config.dbPath);
await createFromWorkbook(db, config.seedWorkbook);
const n = db.prepare('SELECT COUNT(*) c FROM EnergyConsumption').get().c;
console.log(`Seeded ${config.dbPath} (${n} plant energy rows).`);
