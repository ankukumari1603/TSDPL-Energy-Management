import fs from 'node:fs';
import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

if (!fs.existsSync(config.dbPath)) {
  console.error('Database not found. Run "npm run seed" first.');
  process.exit(1);
}
const app = createApp(openDb(config.dbPath));
app.listen(config.port, '127.0.0.1', () => console.log(`API listening on http://127.0.0.1:${config.port}`));
