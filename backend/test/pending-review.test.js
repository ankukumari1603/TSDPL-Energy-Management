import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, startApp, fullEntries, legacyEscalate, PLANT_PARAMS } from './helpers.js';

const FY = 'FY26-27';
const p = (id, q) => `/api/energy/plant/${id}/${FY}/${q}`;
const PENDING = `/api/energy/pending-review?fy=${FY}`;

test('pending-review lists submitted records across quarters, scoped by role and location', async (t) => {
  const db = await makeDb();
  const { call, login, close } = await startApp(db);
  t.after(close);
  const tk = {};
  for (const n of ['entry', 'entry2', 'sup', 'admin']) tk[n] = await login(n);

  // Submission in Q2 while the reviewer's quarter selector would be on Q1
  assert.equal((await call('POST', `${p(7, 'Q2')}/submit`, { token: tk.entry, body: { entries: fullEntries(PLANT_PARAMS, 10) } })).status, 200);
  assert.equal((await call('POST', `${p(1, 'Q4')}/submit`, { token: tk.entry2, body: { entries: fullEntries(PLANT_PARAMS, 10) } })).status, 200);

  // the quarter-scoped list is Not started for Q1, but the pending list finds both submissions
  const q1 = (await call('GET', `/api/energy/records?fy=${FY}&quarter=Q1`, { token: tk.sup })).data.records;
  assert.equal(q1.find((r) => r.site.id === 7 && r.site.kind === 'plant').statusName, 'Not started');
  const sup = (await call('GET', PENDING, { token: tk.sup })).data.pending;
  assert.deepEqual(sup.map((x) => `${x.site.id}:${x.quarter}:${x.stage}`).sort(), ['1:Q4:AwaitingSupervisor', '7:Q2:AwaitingSupervisor']);
  assert.ok(sup.every((x) => x.submittedOn && x.submittedBy));

  // Supervisor and Admin (exception role) both see every submitted record waiting for a decision
  const adminKeys = (await call('GET', PENDING, { token: tk.admin })).data.pending.map((x) => `${x.site.id}:${x.quarter}`);
  assert.ok(adminKeys.includes('7:Q2') && adminKeys.includes('1:Q4'));
  legacyEscalate(db, 'EnergyConsumption', 'PlantID', 7, FY, 'Q2');
  assert.deepEqual((await call('GET', PENDING, { token: tk.sup })).data.pending.map((x) => `${x.site.id}:${x.stage}`).sort(), ['1:AwaitingSupervisor', '7:AwaitingAdmin']);
  // a decided record leaves the list
  assert.equal((await call('POST', `${p(7, 'Q2')}/review`, { token: tk.sup, body: { decision: 'approve' } })).status, 200);
  const after = (await call('GET', PENDING, { token: tk.admin })).data.pending.map((x) => `${x.site.id}:${x.quarter}`);
  assert.ok(!after.includes('7:Q2') && after.includes('1:Q4'));

  // location scope and authorization: a supervisor only sees mapped locations
  const db2 = db.prepare('SELECT COUNT(*) c FROM UserPlantMapping WHERE UserID = 102 AND PlantID = 2').get().c;
  assert.equal(db2, 0);
  assert.equal((await call('GET', PENDING, { token: tk.entry })).status, 403);
  assert.equal((await call('GET', PENDING)).status, 401);
  assert.equal((await call('GET', '/api/energy/pending-review?fy=bad', { token: tk.sup })).status, 400);
});
