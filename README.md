# TSDPL Energy Data Collection & Reporting

React (Vite) frontend + Node/Express backend for quarterly plant and office energy data: entry, draft/submit, review, conversion to GJ, and Excel export into a copy of the original template.

## Run

```powershell
cd backend
npm install
npm run seed            # builds backend/data/energy.sqlite from seed/BRSR_database.xlsx
$env:JWT_SECRET = "<random string, 32+ chars>"   # optional if backend/.env defines JWT_SECRET (auto-loaded; real env vars win)
npm start               # http://127.0.0.1:4000

cd ../frontend
npm install
npm run dev             # http://localhost:5173 (proxies /api)
```

Log in with an existing user from the `Users` table (bcrypt hashes are used as supplied; no passwords are stored in this repo), or create development-only accounts:

```powershell
cd backend
node src/devAccounts.js          # creates devadmin / devsupervisor / devuser (refuses NODE_ENV=production)
node src/devAccounts.js --reset  # issues new random passwords
node src/inspectDb.js            # read-only overview: tables, row counts, foreign keys, users (no hashes)
```

Passwords are random, stored only as bcrypt hashes in the DB, and written to the git-ignored `backend/data/dev-credentials.json`. Re-seeding (`npm run seed -- --force`) wipes the dev accounts; run the script again afterwards.

## Tests

`cd backend; npm test` (validation, conversion, permissions/workflow, unlock requests, notifications, Excel export, Consol report) and `cd frontend; npm test`.

The Consol test evaluates the exported workbook's formulas with a small test-only evaluator (`backend/test/evalWorkbook.js`: SUM, + - * /, %, cross-sheet references, shared formulas; it throws on anything else). It is not Excel; open the exported file in Excel for a final visual check.

## Unlock requests and notifications

- A User or Supervisor with access to a site may request an unlock of a locked (Submitted/Approved) record, giving a reason (max 500 chars). One pending request per site/period.
- Only Admins review (cannot review their own request; rejecting needs a reason). Approval sets the record to *Returned* (editable) and clears review fields. Admins cannot request unlocks themselves.
- Non-admins see only their own requests. Rows with legacy `RequestType` values other than `EnergyPlant`/`EnergyOffice` are ignored.
- Notifications (table `Notifications`, per-user clear state in `UserNotificationState`): Submitted → reviewers with site access; Approved/Rejected → data-entry users with site access and the submitter; UnlockRequested → Admins; UnlockApproved/Rejected → the requester. The actor is never notified of their own action. The UI polls every 30 s.
- API: `POST/GET /api/energy/unlock-requests`, `POST /api/energy/unlock-requests/:id/review`, `GET /api/notifications`, `POST /api/notifications/:id/read`, `/read-all`, `/clear`.

## Database

The supplied workbook is the schema source. `src/db.js` builds a **SQLite development mirror** with the same table and column names and foreign keys (no columns added). The production SQL Server database is not touched; all SQL lives in `src/service.js` / `src/app.js` and would need a T-SQL port to run against it.

Tables used: PlantMaster, OfficeLocationMaster, ParameterMaster, StatusMaster, RolesMaster, ModuleMaster, Users, UserRoleMapping, UserPlantMapping, UserOfficeLocationMapping, UserModuleAccess, EnergyConsumption, OfficeEnergyConsumption, EnergyConversionFactor, EnergyExportCellMapping.

## Roles

| Role | Enter data | Review: approve / reject / return | Dashboard | Export | Sites |
|---|---|---|---|---|---|
| User | yes | no | **no** (API returns 403) | no | mapped |
| Supervisor | no | yes (not own submission) | yes | yes | mapped |
| Admin | yes | yes, as an exception (not own submission) | yes | yes | all |

Conversion factors are read-only for every role (`GET /api/conversion-factors` is the only route).

Energy module access follows `UserModuleAccess`, falling back to `ModuleMaster.DefaultEnabled`.

Permissions live in `backend/src/rolesConfig.js`. `RolesMaster` contains only Admin, Supervisor and User. `PENDING_FOURTH_ROLE` is a **disabled placeholder**; no fourth role is implemented until the company confirms it, and a role that is not configured has no permissions and cannot be assigned to users.

## Review, return and audit trail

Workflow: **User submits → Supervisor approves, rejects or returns.** Admin approval is *not* a required step; the Admin can approve, reject or return a submission as an exception (for example when a Supervisor is unavailable).

- Supervisor or Admin (`decision: approve | reject | return`): reject and return need a comment (max 500 chars). The old `forward` ("Escalate to Admin") decision was removed and now returns 400.
- Nobody can review a record they submitted. Returned and Rejected records are editable; saving a draft resets them to Draft.
- Legacy: records escalated before the removal keep `Submitted` + `ReviewedStatus = 'Forwarded'` (API `stage: AwaitingAdmin`). They stay visible in the review queue and can be approved, rejected or returned by a Supervisor or an Admin. Their `Forwarded` history rows and notifications are kept. `StatusMaster` is unchanged.
- Only Approved records count in dashboard totals and Excel exports.
- Notifications: Submitted → Supervisors with site access; Approved/Rejected/Returned → data-entry users with site access and the submitter.
- The only added table is the append-only `ApprovalHistory` (created on startup by `src/migrations.js`; update/delete are blocked by triggers). It records submissions, forwards, decisions, comments and unlock actions with actor, role, from/to status and timestamp. Older databases are upgraded once on startup (rows are copied unchanged) to allow the `Forwarded` action. View it via `GET /api/energy/:kind/:id/:fy/:quarter/history` or "Workflow history" in the entry form.

## Change password

Any signed-in user can use the **Change password** tab (`POST /api/me/password` with `currentPassword`, `newPassword`, `confirmPassword`). The current password is verified first; the new one must follow the policy (12+ chars, upper, lower, digit), differ from the current one, and is stored as a bcrypt (cost 12) hash only. Existing sessions stay valid until their token expires, because there is no token-version column and the schema is unchanged.

## Supporting documents

Users (and Admins entering data) can attach evidence to a site/quarter record while it is a Draft, Returned or Rejected. Allowed: PDF, PNG, JPG, XLSX, CSV; max 10 MB per file; max 10 files per record. Type is checked by extension **and** file signature; files are stored under `backend/data/uploads` (override with `UPLOAD_DIR`) with random names, and served only through authenticated, site-scoped routes as downloads (`nosniff`). Removal is a soft delete (the file stays on disk). Uploads are optional; they are not yet required for submission. Metadata table `SupportingDocuments` is created on startup (additive, owner-approved).

API: `GET|POST /api/energy/:kind/:id/:fy/:quarter/documents`, `GET|DELETE .../documents/:docId` (multipart field `file`).

## Dashboard

`GET /api/dashboard?fy=FY26-27&period=ALL|Q1..Q4&site=plant:7` (own locations only). Energy totals and renewable share use **approved** records only; the share is `null` when the total is 0, and missing conversion factors are listed rather than defaulted.

## Admin (Admin role only)

`/api/admin/users`, `/api/admin/users/:id`, `/api/admin/users/:id/reset-password`, `/api/admin/locations`, `/api/admin/locations/:kind/:id`, `/api/admin/roles`. Passwords need 12+ characters (upper, lower, digit) and are hashed with bcrypt; hashes are never returned. You cannot deactivate yourself or remove the last active Admin. New locations have no export mappings until the company provides them.

## Known gaps in the supplied data (not invented around)

- Faridabad (PlantID 10) has no `EnergyExportCellMapping` rows: its data is not exported and the report warns.
- Mapping uses sheet name `Pantanagar`; the template sheet is `Pantnagar`. A flagged alias is configured in `src/config.js` (`SHEET_ALIASES`) and needs business confirmation.
- "Any Other Fuel" has a single factor of 1 GJ/kg for both renewable and non-renewable fuel; used as supplied, flagged in the report.
- Template headers say "Q1 FY27" / "FY 2025-26"; the export does not edit header text.
- Exported formulas are recalculated by Excel on open (`fullCalcOnLoad`); cached values inside the file are stale until then.
- Template gap: on the Consol sheet, cells O53, O55–O57 are constants, and the Offices sheet's LPG total (Q11) is not referenced anywhere, so office LPG never reaches Consol. The template is left unchanged; confirm with the business owner.
- UnlockRequests foreign keys to Water/Waste/AnnualReport/HealthSafety tables are not created (those tables are not in the energy mirror).
