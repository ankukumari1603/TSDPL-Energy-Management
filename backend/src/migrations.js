/**
 * Additive migration approved by the project owner: one new table, no existing table or column is altered.
 * ApprovalHistory is an append-only audit trail of workflow decisions (UPDATE/DELETE are blocked by triggers).
 */
export const HISTORY_ACTIONS = ['Submitted', 'Forwarded', 'Approved', 'Rejected', 'Returned', 'UnlockRequested', 'UnlockApproved', 'UnlockRejected'];

const columns = `
      HistoryID INTEGER PRIMARY KEY AUTOINCREMENT,
      RecordType TEXT NOT NULL CHECK (RecordType IN ('Plant','Office')),
      PlantID INTEGER REFERENCES PlantMaster(PlantID),
      LocationID INTEGER REFERENCES OfficeLocationMaster(LocationID),
      FinancialYear TEXT NOT NULL,
      QuarterCode TEXT NOT NULL,
      Action TEXT NOT NULL CHECK (Action IN (${HISTORY_ACTIONS.map((a) => `'${a}'`).join(',')})),
      FromStatusID INTEGER REFERENCES StatusMaster(StatusID),
      ToStatusID INTEGER REFERENCES StatusMaster(StatusID),
      ActorUserID INTEGER NOT NULL REFERENCES Users(UserID),
      ActorRole TEXT NOT NULL,
      Comment TEXT,
      UnlockRequestID INTEGER,
      CreatedOn TEXT NOT NULL,
      CHECK ((PlantID IS NULL) <> (LocationID IS NULL))`;

/** Older databases have a CHECK without 'Forwarded'; rebuild the table once, copying every row unchanged. */
function upgradeApprovalHistory(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ApprovalHistory'").get();
  if (!row || row.sql.includes("'Forwarded'")) return;
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE ApprovalHistory_new (${columns});
      INSERT INTO ApprovalHistory_new SELECT HistoryID, RecordType, PlantID, LocationID, FinancialYear, QuarterCode, Action, FromStatusID, ToStatusID, ActorUserID, ActorRole, Comment, UnlockRequestID, CreatedOn FROM ApprovalHistory;
      DROP TABLE ApprovalHistory;
      ALTER TABLE ApprovalHistory_new RENAME TO ApprovalHistory;`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Faridabad is the only plant with no EnergyExportCellMapping rows. Its template sheet "Faridabad" has the same
 * B7:D16 parameter layout as Kalinganagar, Chennai, Pantnagar and Sanand, input column E, and the Consol sheet reads
 * Faridabad!E7:E16 (cells I49:I58). Rows are copied from the Kalinganagar mapping, and only when Faridabad has none.
 */
export function ensureFaridabadMapping(db) {
  const farid = db.prepare("SELECT PlantID FROM PlantMaster WHERE UPPER(PlantName) = 'FARIDABAD'").get();
  const ref = db.prepare("SELECT PlantID FROM PlantMaster WHERE UPPER(PlantName) = 'KALINGANAGAR'").get();
  if (!farid || !ref) return;
  const has = db.prepare("SELECT COUNT(*) c FROM EnergyExportCellMapping WHERE MappingType = 'PLANT_CONSUMPTION' AND PlantID = ?");
  if (has.get(farid.PlantID).c > 0 || has.get(ref.PlantID).c !== 10) return;
  db.prepare(`INSERT INTO EnergyExportCellMapping (MappingType, PlantID, LocationID, ParameterID, WorksheetName, CellColumn, CellRow, IsActive, CreatedOn, CreatedBy)
    SELECT MappingType, ?, NULL, ParameterID, 'Faridabad', CellColumn, CellRow, 1, datetime('now'), 'SYSTEM'
    FROM EnergyExportCellMapping WHERE MappingType = 'PLANT_CONSUMPTION' AND PlantID = ? AND IsActive = 1`).run(farid.PlantID, ref.PlantID);
}

export function ensureApprovalHistory(db) {
  upgradeApprovalHistory(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ApprovalHistory (${columns});
    CREATE INDEX IF NOT EXISTS IX_ApprovalHistory_Record ON ApprovalHistory (RecordType, PlantID, LocationID, FinancialYear, QuarterCode);
    CREATE TRIGGER IF NOT EXISTS TR_ApprovalHistory_NoUpdate BEFORE UPDATE ON ApprovalHistory
      BEGIN SELECT RAISE(ABORT, 'ApprovalHistory is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS TR_ApprovalHistory_NoDelete BEFORE DELETE ON ApprovalHistory
      BEGIN SELECT RAISE(ABORT, 'ApprovalHistory is append-only'); END;
  `);
}
