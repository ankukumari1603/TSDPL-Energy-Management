import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, startApp, fullEntries, legacyEscalate, PLANT_PARAMS } from './helpers.js';

const FY = 'FY26-27';
const UNLOCK = '/api/energy/unlock-requests';
const p = (q) => `/api/energy/plant/7/${FY}/${q}`;

async function setup(t) {
  const db = await makeDb();
  const app = await startApp(db);
  t.after(app.close);
  const tk = {};
  for (const n of ['entry', 'sup', 'admin', 'admin2']) tk[n] = await app.login(n);
  const { call } = app;
  const submit = (q, v = 10) => call('POST', `${p(q)}/submit`, { token: tk.entry, body: { entries: fullEntries(PLANT_PARAMS, v) } });
  const decide = (who, q, decision, reason) => call('POST', `${p(q)}/review`, { token: tk[who], body: { decision, reason } });
  const approvedTotal = async (q) => (await call('GET', `/api/dashboard?fy=${FY}&period=${q}&site=plant:7`, { token: tk.sup })).data.summary.approved.total;
  const events = async (who) => (await call('GET', '/api/notifications', { token: tk[who] })).data.notifications.map((n) => n.event);
  const hist = async (q) => (await call('GET', `${p(q)}/history`, { token: tk.admin })).data.history;
  return { db, call, tk, submit, decide, approvedTotal, events, hist };
}

test('normal flow: Supervisor approval alone makes the record Approved and counts in dashboard totals', async (t) => {
  const s = await setup(t);
  assert.equal((await s.submit('Q1')).status, 200);
  assert.equal(await s.approvedTotal('Q1'), 0, 'submitted data is not official yet');

  const r = await s.decide('sup', 'Q1', 'approve');
  assert.equal(r.status, 200);
  assert.equal(r.data.statusName, 'Approved');
  assert.equal(r.data.stage, null, 'nothing is left waiting for the Admin');
  assert.ok((await s.approvedTotal('Q1')) > 0, 'approved by the Supervisor only');

  // Admin gets no task and no notification from a normal approval
  const pending = (await s.call('GET', `/api/energy/pending-review?fy=${FY}`, { token: s.tk.admin })).data.pending;
  assert.ok(!pending.some((x) => x.site.id === 7 && x.quarter === 'Q1'));
  assert.ok(!(await s.events('admin')).includes('Submitted'));
  assert.ok(!(await s.events('admin')).includes('Forwarded'));
  assert.ok((await s.events('entry')).includes('Approved'));

  const h = await s.hist('Q1');
  assert.deepEqual(h.map((x) => [x.action, x.role]), [['Submitted', 'User'], ['Approved', 'Supervisor']]);
  assert.ok(h.every((x) => x.by && x.at));
});

test('Supervisor reject and return need a reason, notify the submitter, keep totals at zero', async (t) => {
  const s = await setup(t);
  await s.submit('Q1');
  assert.equal((await s.decide('sup', 'Q1', 'return')).status, 422);
  assert.equal((await s.decide('sup', 'Q1', 'reject')).status, 422);

  let r = await s.decide('sup', 'Q1', 'return', 'Please attach the invoice values');
  assert.equal(r.data.statusName, 'Returned');
  assert.equal(r.data.editable, true);
  assert.equal(await s.approvedTotal('Q1'), 0);
  assert.ok((await s.events('entry')).includes('Returned'));

  // the user corrects and resubmits (same record, no duplicate rows), then the Supervisor rejects
  const before = s.db.prepare('SELECT COUNT(*) c FROM EnergyConsumption WHERE PlantID=7 AND FinancialYear=? AND QuarterCode=?').get(FY, 'Q1').c;
  assert.equal((await s.submit('Q1', 12)).status, 200);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM EnergyConsumption WHERE PlantID=7 AND FinancialYear=? AND QuarterCode=?').get(FY, 'Q1').c, before);
  r = await s.decide('sup', 'Q1', 'reject', 'Figures do not match meter readings');
  assert.equal(r.data.statusName, 'Rejected');
  assert.equal(r.data.rejectionReason, 'Figures do not match meter readings');
  assert.equal(await s.approvedTotal('Q1'), 0);
  assert.ok((await s.events('entry')).includes('Rejected'));
  assert.deepEqual((await s.hist('Q1')).map((x) => x.action), ['Submitted', 'Returned', 'Submitted', 'Rejected']);
});

test('Admin is optional: can approve or reject as an exception without any Supervisor action', async (t) => {
  const s = await setup(t);
  await s.submit('Q1');
  await s.submit('Q2');
  // admin2 did not submit, so the self-review rule does not apply
  assert.equal((await s.decide('admin2', 'Q1', 'approve')).data.statusName, 'Approved');
  assert.ok((await s.approvedTotal('Q1')) > 0);
  assert.equal((await s.decide('admin2', 'Q2', 'reject')).status, 422);
  assert.equal((await s.decide('admin2', 'Q2', 'reject', 'Exception: supervisor unavailable')).data.statusName, 'Rejected');
  assert.equal(await s.approvedTotal('Q2'), 0);
  const h = await s.hist('Q1');
  assert.equal(h.at(-1).role, 'Admin');
  // after a Supervisor already approved, the Admin cannot decide again
  await s.submit('Q3');
  await s.decide('sup', 'Q3', 'approve');
  assert.equal((await s.decide('admin2', 'Q3', 'reject', 'late')).status, 409);
});

test('"Escalate to Admin" no longer exists; User cannot review', async (t) => {
  const s = await setup(t);
  await s.submit('Q1');
  assert.equal((await s.decide('entry', 'Q1', 'approve')).status, 403);
  for (const who of ['sup', 'admin2']) {
    const r = await s.decide(who, 'Q1', 'forward', 'x');
    assert.equal(r.status, 400, `${who}: forward is rejected`);
  }
  const rec = (await s.call('GET', p('Q1'), { token: s.tk.sup })).data;
  assert.equal(rec.stage, 'AwaitingSupervisor', 'the failed call changed nothing');
  assert.equal((await s.hist('Q1')).length, 1);
});

test('records escalated before the change stay visible and reviewable by Supervisor and Admin', async (t) => {
  for (const [who, decision, reason, expected] of [
    ['sup', 'approve', undefined, 'Approved'],
    ['admin2', 'approve', undefined, 'Approved'],
    ['sup', 'reject', 'Wrong units', 'Rejected'],
    ['admin2', 'return', 'Please recheck', 'Returned'],
  ]) {
    const s = await setup(t);
    await s.submit('Q1');
    legacyEscalate(s.db, 'EnergyConsumption', 'PlantID', 7, FY, 'Q1');
    // still visible in the pending list for both roles, and not counted as approved
    for (const w of ['sup', 'admin2']) {
      const pending = (await s.call('GET', `/api/energy/pending-review?fy=${FY}`, { token: s.tk[w] })).data.pending;
      assert.equal(pending.find((x) => x.site.id === 7 && x.quarter === 'Q1')?.stage, 'AwaitingAdmin', w);
    }
    assert.equal(await s.approvedTotal('Q1'), 0);
    const r = await s.decide(who, 'Q1', decision, reason);
    assert.equal(r.status, 200, `${who} ${decision}`);
    assert.equal(r.data.statusName, expected);
    if (expected === 'Approved') assert.ok((await s.approvedTotal('Q1')) > 0);
  }
});

test('Supervisor-requested unlock: Admin approves -> user edits, resubmits -> Supervisor approves; history kept', async (t) => {
  const s = await setup(t);
  await s.submit('Q1', 10);
  await s.decide('sup', 'Q1', 'approve');
  const approved = await s.approvedTotal('Q1');
  assert.ok(approved > 0);

  const ask = (token, reason) => s.call('POST', UNLOCK, { token, body: { kind: 'plant', id: 7, financialYear: FY, quarter: 'Q1', reason } });
  assert.equal((await ask(s.tk.sup, '  ')).status, 422, 'reason required');
  const req = await ask(s.tk.sup, 'Meter reading corrected by site');
  assert.equal(req.status, 201);
  assert.ok((await s.events('admin')).includes('UnlockRequested'));
  // only the Admin decides unlocks
  assert.equal((await s.call('POST', `${UNLOCK}/${req.data.id}/review`, { token: s.tk.sup, body: { decision: 'approve' } })).status, 403);
  assert.equal((await s.call('POST', `${UNLOCK}/${req.data.id}/review`, { token: s.tk.entry, body: { decision: 'approve' } })).status, 403);

  assert.equal((await s.call('POST', `${UNLOCK}/${req.data.id}/review`, { token: s.tk.admin, body: { decision: 'approve', reason: 'OK' } })).status, 200);
  assert.ok((await s.events('sup')).includes('UnlockApproved'), 'requester notified');
  const rec = (await s.call('GET', p('Q1'), { token: s.tk.entry })).data;
  assert.equal(rec.editable, true);
  assert.equal(await s.approvedTotal('Q1'), 0, 'unapproved revision is not official data');

  assert.equal((await s.submit('Q1', 30)).status, 200);
  assert.equal(await s.approvedTotal('Q1'), 0);
  assert.equal((await s.decide('sup', 'Q1', 'approve')).status, 200);
  const revised = await s.approvedTotal('Q1');
  assert.ok(revised > approved);

  const actions = (await s.hist('Q1')).map((x) => x.action);
  assert.deepEqual(actions, ['Submitted', 'Approved', 'UnlockRequested', 'UnlockApproved', 'Submitted', 'Approved']);
});

test('Supervisor-requested unlock rejected: record stays Approved, locked, unchanged, totals unchanged', async (t) => {
  const s = await setup(t);
  await s.submit('Q1', 10);
  await s.decide('sup', 'Q1', 'approve');
  const total = await s.approvedTotal('Q1');
  const snapshot = () => JSON.stringify(s.db.prepare('SELECT ParameterID,ConsumptionValue,StatusID,ReviewedStatus,ReviewedBy FROM EnergyConsumption WHERE PlantID=7 AND FinancialYear=? AND QuarterCode=? ORDER BY ParameterID').all(FY, 'Q1'));
  const before = snapshot();

  const req = await s.call('POST', UNLOCK, { token: s.tk.sup, body: { kind: 'plant', id: 7, financialYear: FY, quarter: 'Q1', reason: 'Want to revise' } });
  const review = (body) => s.call('POST', `${UNLOCK}/${req.data.id}/review`, { token: s.tk.admin, body });
  assert.equal((await review({ decision: 'reject' })).status, 422, 'rejection needs a reason');
  assert.equal((await review({ decision: 'reject', reason: 'Not justified' })).status, 200);

  assert.equal(snapshot(), before, 'energy rows untouched');
  const rec = (await s.call('GET', p('Q1'), { token: s.tk.entry })).data;
  assert.equal(rec.statusName, 'Approved');
  assert.equal(rec.editable, false);
  assert.equal((await s.call('PUT', p('Q1'), { token: s.tk.entry, body: { entries: [{ parameterId: 1, value: 99 }] } })).status, 409);
  assert.equal(await s.approvedTotal('Q1'), total);
  assert.ok((await s.events('sup')).includes('UnlockRejected'), 'requester notified');
  assert.ok((await s.hist('Q1')).map((x) => x.action).includes('UnlockRejected'));
});
