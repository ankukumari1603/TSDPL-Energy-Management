import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.js';
import { ensureApprovalHistory } from '../src/migrations.js';

test('ApprovalHistory upgrade keeps existing rows and allows Forwarded', async () => {
  const db = await makeDb();
  db.exec(`CREATE TABLE ApprovalHistory (
      HistoryID INTEGER PRIMARY KEY AUTOINCREMENT,
      RecordType TEXT NOT NULL CHECK (RecordType IN ('Plant','Office')),
      PlantID INTEGER, LocationID INTEGER,
      FinancialYear TEXT NOT NULL, QuarterCode TEXT NOT NULL,
      Action TEXT NOT NULL CHECK (Action IN ('Submitted','Approved','Rejected','Returned','UnlockRequested','UnlockApproved','UnlockRejected')),
      FromStatusID INTEGER, ToStatusID INTEGER, ActorUserID INTEGER NOT NULL, ActorRole TEXT NOT NULL,
      Comment TEXT, UnlockRequestID INTEGER, CreatedOn TEXT NOT NULL,
      CHECK ((PlantID IS NULL) <> (LocationID IS NULL)))`);
  db.prepare("INSERT INTO ApprovalHistory (RecordType, PlantID, FinancialYear, QuarterCode, Action, ActorUserID, ActorRole, Comment, CreatedOn) VALUES ('Plant',7,'FY26-27','Q1','Submitted',100,'User','old row','2026-01-01 00:00:00')").run();
  ensureApprovalHistory(db);
  ensureApprovalHistory(db); // idempotent
  const rows = db.prepare('SELECT Action, Comment FROM ApprovalHistory').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Comment, 'old row');
  db.prepare("INSERT INTO ApprovalHistory (RecordType, PlantID, FinancialYear, QuarterCode, Action, ActorUserID, ActorRole, CreatedOn) VALUES ('Plant',7,'FY26-27','Q1','Forwarded',102,'Supervisor','2026-01-02 00:00:00')").run();
  assert.throws(() => db.prepare('DELETE FROM ApprovalHistory').run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE ApprovalHistory SET Comment = 'x'").run(), /append-only/);
});
