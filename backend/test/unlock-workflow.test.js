import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, startApp, fullEntries, forwardAndApprove, PLANT_PARAMS, OFFICE_PARAMS } from './helpers.js';

const FY = 'FY26-27';
const Q = 'Q1';
const path = `/api/energy/plant/7/${FY}/${Q}`;
const UNLOCK = '/api/energy/unlock-requests';

async function setup(t) {
  const db = await makeDb();
  const app = await startApp(db);
  t.after(app.close);
  const tokens = {};
  for (const n of ['entry', 'sup', 'admin']) tokens[n] = await app.login(n);
  const { call } = app;
  const dash = async () => (await call('GET', `/api/dashboard?fy=${FY}&period=${Q}&site=plant:7`, { token: tokens.admin })).data.summary.approved.total;
  const exported = async () => (await call('GET', `/api/reports/energy/preview?fy=${FY}&quarter=${Q}`, { token: tokens.admin })).data.cells.filter((c) => c.site !== 'conversion').length;
  const rows = () => db.prepare('SELECT ParameterID, ConsumptionValue, StatusID, ReviewedStatus, ReviewedBy, ReviewedOn FROM EnergyConsumption WHERE PlantID=7 AND FinancialYear=? AND QuarterCode=? ORDER BY ParameterID').all(FY, Q);
  const hist = async () => (await call('GET', `${path}/history`, { token: tokens.sup })).data.history;
  const submit = (v) => call('POST', `${path}/submit`, { token: tokens.entry, body: { entries: fullEntries(PLANT_PARAMS, v) } });
  const ask = (token, reason = 'Electricity figure needs correction') => call('POST', UNLOCK, { token, body: { kind: 'plant', id: 7, financialYear: FY, quarter: Q, reason } });
  const decide = (id, body) => call('POST', `${UNLOCK}/${id}/review`, { token: tokens.admin, body });
  const notes = async (n) => (await call('GET', '/api/notifications', { token: tokens[n] })).data.notifications;
  return { db, call, tokens, dash, exported, rows, hist, submit, ask, decide, notes };
}

test('approved record: unlock approved -> revise -> resubmit -> supervisor -> admin', async (t) => {
  const s = await setup(t);
  const { call, tokens } = s;

  assert.equal((await s.submit(10)).status, 200);
  assert.equal((await forwardAndApprove(call, tokens.sup, tokens.admin, path)).status, 200);
  const approvedTotal = await s.dash();
  assert.ok(approvedTotal > 0);
  assert.ok((await s.exported()) > 0);
  const approvedRows = s.rows();

  // 1. locked
  const rec = (await call('GET', path, { token: tokens.entry })).data;
  assert.equal(rec.statusName, 'Approved');
  assert.equal(rec.editable, false);
  assert.equal((await call('PUT', path, { token: tokens.entry, body: { entries: [{ parameterId: 1, value: 99 }] } })).status, 409);
  assert.equal((await s.submit(50)).status, 409);

  // 2. reason required
  assert.equal((await s.ask(tokens.entry, '   ')).status, 422);
  const req = await s.ask(tokens.entry);
  assert.equal(req.status, 201);
  assert.equal((await s.notes('admin'))[0].event, 'UnlockRequested');

  // 3/4. admin approves with a comment
  const ok = await s.decide(req.data.id, { decision: 'approve', reason: 'Go ahead and correct it' });
  assert.equal(ok.status, 200);
  assert.equal((await s.notes('entry'))[0].event, 'UnlockApproved');
  assert.equal((await s.notes('entry'))[0].reason, 'Go ahead and correct it');
  const reopened = (await call('GET', path, { token: tokens.entry })).data;
  assert.equal(reopened.statusName, 'Returned');
  assert.equal(reopened.editable, true);

  // previous approval is preserved in the audit trail (who/when and the approved values)
  const h1 = await s.hist();
  assert.deepEqual(h1.map((h) => h.action), ['Submitted', 'Approved', 'UnlockRequested', 'UnlockApproved']);
  const unlocked = h1.at(-1);
  assert.match(unlocked.comment, /Go ahead and correct it/);
  assert.match(unlocked.comment, /Previously approved by tsup/);
  assert.match(unlocked.comment, new RegExp(`${approvedRows[0].ConsumptionValue}`));
  assert.equal(h1.at(-2).comment, 'Electricity figure needs correction');

  // 9. revision in progress is not official data
  assert.equal(await s.dash(), 0);
  assert.equal(await s.exported(), 0);

  // 5. user edits and resubmits
  assert.equal((await s.submit(70)).status, 200);
  assert.equal(await s.dash(), 0);
  assert.equal(await s.exported(), 0);
  // 6. the Supervisor reviews and gives the final approval; no Admin step is required
  assert.equal((await call('POST', `${path}/review`, { token: tokens.sup, body: { decision: 'approve' } })).status, 200);
  const revisedTotal = await s.dash();
  assert.ok(revisedTotal > approvedTotal);
  assert.ok((await s.exported()) > 0);

  const h2 = await s.hist();
  assert.deepEqual(h2.map((h) => h.action), ['Submitted', 'Approved', 'UnlockRequested', 'UnlockApproved', 'Submitted', 'Approved']);
  assert.ok(h2.every((h) => h.by && h.at && h.role));
});

test('approved record: unlock rejected -> record unchanged and locked', async (t) => {
  const s = await setup(t);
  const { call, tokens } = s;
  await s.submit(10);
  await forwardAndApprove(call, tokens.sup, tokens.admin, path);
  const before = JSON.stringify(s.rows());
  const total = await s.dash();

  const req = await s.ask(tokens.sup, 'Supervisor spotted an error');
  assert.equal(req.status, 201);
  assert.equal((await s.decide(req.data.id, { decision: 'reject' })).status, 422);
  assert.equal((await s.decide(req.data.id, { decision: 'reject', reason: 'Figures were verified' })).status, 200);

  assert.equal(JSON.stringify(s.rows()), before);
  const rec = (await call('GET', path, { token: tokens.entry })).data;
  assert.equal(rec.statusName, 'Approved');
  assert.equal(rec.editable, false);
  assert.equal(await s.dash(), total);

  const h = await s.hist();
  assert.deepEqual(h.map((x) => x.action), ['Submitted', 'Approved', 'UnlockRequested', 'UnlockRejected']);
  assert.equal(h.at(-1).comment, 'Figures were verified');
  const n = (await s.notes('sup'))[0];
  assert.equal(n.event, 'UnlockRejected');
});

test('unlock filters, visibility and permissions across users and record types', async (t) => {
  const db = await makeDb();
  const { call, login, close } = await startApp(db);
  t.after(close);
  const tk = {};
  for (const n of ['entry', 'entry2', 'sup', 'admin']) tk[n] = await login(n);
  const p = (kind, id, q) => `/api/energy/${kind}/${id}/${FY}/${q}`;
  const seed = async (kind, id, q, token, params) => {
    assert.equal((await call('POST', `${p(kind, id, q)}/submit`, { token, body: { entries: fullEntries(params, 10) } })).status, 200);
    assert.equal((await forwardAndApprove(call, tk.sup, tk.admin, p(kind, id, q))).status, 200);
  };
  const ask = (token, kind, id, q, reason = 'Needs correction') =>
    call('POST', UNLOCK, { token, body: { kind, id, financialYear: FY, quarter: q, reason } });

  await seed('plant', 7, 'Q1', tk.entry, PLANT_PARAMS);   // A: will be unlocked
  await seed('plant', 7, 'Q2', tk.entry, PLANT_PARAMS);   // B: unlock rejected
  await seed('plant', 1, 'Q1', tk.entry2, PLANT_PARAMS);  // C: stays pending
  await seed('office', 6, 'Q1', tk.entry, OFFICE_PARAMS); // D: office record, unlocked
  // E: submitted, awaiting supervisor -> also locked, so it can be unlocked
  await call('POST', `${p('plant', 7, 'Q3')}/submit`, { token: tk.entry, body: { entries: fullEntries(PLANT_PARAMS, 10) } });

  const A = (await ask(tk.entry, 'plant', 7, 'Q1')).data;
  const B = (await ask(tk.sup, 'plant', 7, 'Q2', 'Supervisor request')).data;
  const C = (await ask(tk.entry2, 'plant', 1, 'Q1')).data;
  const D = (await ask(tk.entry, 'office', 6, 'Q1')).data;
  const E = (await ask(tk.entry, 'plant', 7, 'Q3')).data;
  const mine = new Set([A.id, B.id, C.id, D.id, E.id]);

  const review = (id, token, body) => call('POST', `${UNLOCK}/${id}/review`, { token, body });
  // only the Admin may decide
  for (const who of ['entry', 'entry2', 'sup']) assert.equal((await review(C.id, tk[who], { decision: 'approve' })).status, 403);
  assert.equal((await review(C.id, null, { decision: 'approve' })).status, 401);

  const rowsBeforeB = JSON.stringify(db.prepare('SELECT * FROM EnergyConsumption WHERE PlantID=7 AND QuarterCode=? ORDER BY ParameterID').all('Q2'));
  assert.equal((await review(A.id, tk.admin, { decision: 'approve' })).status, 200);
  assert.equal((await review(D.id, tk.admin, { decision: 'approve', reason: 'ok' })).status, 200);
  assert.equal((await review(B.id, tk.admin, { decision: 'reject', reason: 'Verified' })).status, 200);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM EnergyConsumption WHERE PlantID=7 AND QuarterCode=? ORDER BY ParameterID').all('Q2')), rowsBeforeB);

  const list = async (token, status) =>
    (await call('GET', `${UNLOCK}${status ? `?status=${status}` : ''}`, { token })).data.requests.filter((r) => mine.has(r.id)).map((r) => `${r.id}:${r.status}:${r.recordStatus}`).sort();
  const tag = (r, st, rs) => `${r.id}:${st}:${rs}`;
  assert.deepEqual(await list(tk.admin, 'Approved'), [tag(A, 'Approved', 'Returned'), tag(D, 'Approved', 'Returned')].sort());
  assert.deepEqual(await list(tk.admin, 'Rejected'), [tag(B, 'Rejected', 'Approved')]);
  assert.deepEqual(await list(tk.admin, 'Pending').then((l) => l.filter((x) => x.startsWith(`${C.id}:`))), [tag(C, 'Pending', 'Approved')]);
  assert.equal((await list(tk.admin, 'Pending')).length, 2); // C and the submitted-record request E
  assert.equal((await list(tk.admin)).length, 5);

  // users only ever see their own requests
  assert.deepEqual(await list(tk.sup), [tag(B, 'Rejected', 'Approved')]);
  assert.deepEqual(await list(tk.entry2), [tag(C, 'Pending', 'Approved')]);
  assert.equal((await list(tk.entry)).length, 3);
  assert.deepEqual(await list(tk.entry, 'Rejected'), []);

  // approved unlocks reopen the records (plant and office); rejected/pending stay locked
  const status = async (kind, id, q) => (await call('GET', p(kind, id, q), { token: tk.admin })).data;
  assert.deepEqual([(await status('plant', 7, 'Q1')).statusName, (await status('plant', 7, 'Q1')).editable], ['Returned', true]);
  assert.deepEqual([(await status('office', 6, 'Q1')).statusName, (await status('office', 6, 'Q1')).editable], ['Returned', true]);
  assert.deepEqual([(await status('plant', 7, 'Q2')).statusName, (await status('plant', 7, 'Q2')).editable], ['Approved', false]);
  assert.deepEqual([(await status('plant', 1, 'Q1')).statusName, (await status('plant', 1, 'Q1')).editable], ['Approved', false]);

  // history keeps every request and decision for the rejected record
  const hist = (await call('GET', `${p('plant', 7, 'Q2')}/history`, { token: tk.sup })).data.history.map((h) => h.action);
  assert.deepEqual(hist, ['Submitted', 'Approved', 'UnlockRequested', 'UnlockRejected']);

  // office record: edit, resubmit and go through both review steps again
  assert.equal((await call('POST', `${p('office', 6, 'Q1')}/submit`, { token: tk.entry, body: { entries: fullEntries(OFFICE_PARAMS, 20) } })).status, 200);
  assert.equal((await forwardAndApprove(call, tk.sup, tk.admin, p('office', 6, 'Q1'))).status, 200);
  assert.equal((await status('office', 6, 'Q1')).statusName, 'Approved');
});

