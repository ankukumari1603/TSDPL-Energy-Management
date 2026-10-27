import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './service.js';

/**
 * Additive migration approved by the project owner: one new metadata table. Files live on disk outside the web root;
 * rows are soft-deleted (IsDeleted) so evidence is never physically removed.
 */
export function ensureDocumentsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS SupportingDocuments (
      DocumentID INTEGER PRIMARY KEY AUTOINCREMENT,
      RecordType TEXT NOT NULL CHECK (RecordType IN ('Plant','Office')),
      PlantID INTEGER REFERENCES PlantMaster(PlantID),
      LocationID INTEGER REFERENCES OfficeLocationMaster(LocationID),
      FinancialYear TEXT NOT NULL,
      QuarterCode TEXT NOT NULL,
      OriginalName TEXT NOT NULL,
      StoredName TEXT NOT NULL UNIQUE,
      ContentType TEXT NOT NULL,
      SizeBytes INTEGER NOT NULL,
      UploadedByUserID INTEGER NOT NULL REFERENCES Users(UserID),
      UploadedOn TEXT NOT NULL,
      IsDeleted INTEGER NOT NULL DEFAULT 0,
      DeletedByUserID INTEGER REFERENCES Users(UserID),
      DeletedOn TEXT,
      CHECK ((PlantID IS NULL) <> (LocationID IS NULL))
    );
    CREATE INDEX IF NOT EXISTS IX_SupportingDocuments_Record ON SupportingDocuments (RecordType, PlantID, LocationID, FinancialYear, QuarterCode);
  `);
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_RECORD = 10;

export const ALLOWED_TYPES = {
  '.pdf': { type: 'application/pdf', check: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  '.png': { type: 'image/png', check: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { type: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.jpeg': { type: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.xlsx': {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    check: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  },
  '.csv': { type: 'text/csv', check: (b) => !b.includes(0) },
};

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Validates a client-supplied file name and returns a safe display name. */
export function cleanFileName(name) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f"<>|:*?]/g, '_').trim();
  return base.slice(0, 150);
}

export function validateFile(file) {
  if (!file || !file.buffer) return 'A file is required.';
  const name = cleanFileName(file.originalname);
  if (!name) return 'The file name is invalid.';
  const ext = path.extname(name).toLowerCase();
  const rule = ALLOWED_TYPES[ext];
  if (!rule) return 'Unsupported file type. Allowed: PDF, PNG, JPG, XLSX, CSV.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_FILE_BYTES) return 'File is larger than 10 MB.';
  if (!rule.check(file.buffer)) return 'File content does not match its extension.';
  return null;
}

export function createDocuments(db, service, uploadDir) {
  ensureDocumentsTable(db);
  fs.mkdirSync(uploadDir, { recursive: true });

  const locate = (kind, id, fy, q, user) => {
    const site = service.siteInfo(kind, id);
    service.checkScope(user, site, fy, q);
    return site;
  };
  const siteWhere = (site) => ({
    type: site.kind === 'plant' ? 'Plant' : 'Office',
    plant: site.kind === 'plant' ? site.id : 0,
    loc: site.kind === 'office' ? site.id : 0,
  });
  const shape = (d) => ({
    id: d.DocumentID,
    name: d.OriginalName,
    contentType: d.ContentType,
    size: d.SizeBytes,
    uploadedBy: d.UploaderName,
    uploadedOn: d.UploadedOn,
  });

  function list(user, kind, id, fy, q) {
    const site = locate(kind, id, fy, q, user);
    const w = siteWhere(site);
    return db
      .prepare(
        `SELECT d.*, u.UserName AS UploaderName FROM SupportingDocuments d JOIN Users u ON u.UserID = d.UploadedByUserID
         WHERE d.IsDeleted = 0 AND d.RecordType = ? AND COALESCE(d.PlantID,0) = ? AND COALESCE(d.LocationID,0) = ? AND d.FinancialYear = ? AND d.QuarterCode = ?
         ORDER BY d.DocumentID`,
      )
      .all(w.type, w.plant, w.loc, fy, q)
      .map(shape);
  }

  function assertEditable(user, site, fy, q) {
    if (!site.active) throw new HttpError(409, 'Location is inactive.');
    const rec = service.getRecord(user, site.kind, site.id, fy, q);
    if (!rec.editable) throw new HttpError(409, 'Documents can only be changed while the record is a draft, returned or rejected.');
  }

  function add(user, kind, id, fy, q, file) {
    const site = locate(kind, id, fy, q, user);
    assertEditable(user, site, fy, q);
    const err = validateFile(file);
    if (err) throw new HttpError(422, err);
    const w = siteWhere(site);
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM SupportingDocuments WHERE IsDeleted = 0 AND RecordType = ? AND COALESCE(PlantID,0) = ? AND COALESCE(LocationID,0) = ? AND FinancialYear = ? AND QuarterCode = ?`,
      )
      .get(w.type, w.plant, w.loc, fy, q).n;
    if (count >= MAX_FILES_PER_RECORD) throw new HttpError(409, `At most ${MAX_FILES_PER_RECORD} documents can be attached to a record.`);
    const name = cleanFileName(file.originalname);
    const ext = path.extname(name).toLowerCase();
    const stored = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(uploadDir, stored), file.buffer, { flag: 'wx' });
    try {
      db.prepare(
        `INSERT INTO SupportingDocuments (RecordType, PlantID, LocationID, FinancialYear, QuarterCode, OriginalName, StoredName, ContentType, SizeBytes, UploadedByUserID, UploadedOn)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(w.type, kind === 'plant' ? site.id : null, kind === 'office' ? site.id : null, fy, q, name, stored, ALLOWED_TYPES[ext].type, file.size, user.id, now());
    } catch (e) {
      fs.rmSync(path.join(uploadDir, stored), { force: true });
      throw e;
    }
    return list(user, kind, id, fy, q);
  }

  function findOwn(user, kind, id, fy, q, docId) {
    const site = locate(kind, id, fy, q, user);
    const w = siteWhere(site);
    const d = db
      .prepare(
        `SELECT * FROM SupportingDocuments WHERE DocumentID = ? AND IsDeleted = 0 AND RecordType = ? AND COALESCE(PlantID,0) = ? AND COALESCE(LocationID,0) = ? AND FinancialYear = ? AND QuarterCode = ?`,
      )
      .get(Number(docId), w.type, w.plant, w.loc, fy, q);
    if (!d) throw new HttpError(404, 'Document not found.');
    return { site, doc: d };
  }

  function file(user, kind, id, fy, q, docId) {
    const { doc } = findOwn(user, kind, id, fy, q, docId);
    const p = path.join(uploadDir, doc.StoredName);
    if (!fs.existsSync(p)) throw new HttpError(404, 'Document file is missing.');
    return { path: p, name: doc.OriginalName, contentType: doc.ContentType };
  }

  function remove(user, kind, id, fy, q, docId) {
    const { site, doc } = findOwn(user, kind, id, fy, q, docId);
    assertEditable(user, site, fy, q);
    db.prepare('UPDATE SupportingDocuments SET IsDeleted = 1, DeletedByUserID = ?, DeletedOn = ? WHERE DocumentID = ?').run(user.id, now(), doc.DocumentID);
    return list(user, kind, id, fy, q);
  }

  return { list, add, file, remove };
}
