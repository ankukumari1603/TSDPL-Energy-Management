import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load backend/.env (git-ignored) if present; variables already set in the environment win.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  root,
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'energy.sqlite'),
  seedWorkbook: process.env.SEED_WORKBOOK || path.join(root, 'seed', 'BRSR_database.xlsx'),
  templatePath:
    process.env.TEMPLATE_PATH || path.join(root, 'templates', 'TSDPL Energy Data Template.xlsx'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'data', 'uploads'),
  port: Number(process.env.PORT) || 4000,
  jwtExpiresIn: '8h',
};

// Template sheet names that differ from the names stored in EnergyExportCellMapping.
// Each alias must be confirmed by the business owner; every use is reported as a warning.
export const SHEET_ALIASES = { Pantanagar: 'Pantnagar' };

export function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET must be set (at least 32 characters).');
  }
  return s;
}
