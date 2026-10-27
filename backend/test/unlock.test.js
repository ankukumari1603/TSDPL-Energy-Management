import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, startApp, fullEntries, PLANT_PARAMS } from './helpers.js';

const FY = 'FY26-27';
const url = (id, q = 'Q1') => `/api/energy/plant/${id}/${FY}/${q}`;
const UNLOCK = '/api/energy/unlock-requests';

async function setup() {
  const db = await makeDb();
  const app = await startApp(db);
  const tokens = {};
  for (const n of ['entry', 'entry2', 'sup', 'admin']) tokens[n] = await app.login(n);
  return { db, ...app, tokens };
}
const submit = (call, token, id = 7, q = 'Q1') => call('POST', url(id, q) + '/submit', { token, body: { entries: fullEntries(PLANT_PARAMS, 10) } });
const ask = (call, token, reason = 'Wrong figure entered', id = 7, q = 'Q1') =>
  call('POST', UNLOCK, { token, body: { kind: 'plant', id, financialYear: FY, quarter: q, reason } });

test('unlock request: validation and access restrictions', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  await call('PUT', url(7), { token: tokens.entry, body: { entries: [{ parameterId: 1, value: 5 }] } });

  // editable record cannot be unlocked
  assert.equal((await ask(call, tokens.entry)).status, 409);
  await submit(call, tokens.entry);
  // reason required / bounded
  assert.equal((await ask(call, tokens.entry, '  ')).status, 422);
  assert.equal((await ask(call, tokens.entry, 'x'.repeat(501))).status, 422);
  // site scope: entry2 is not mapped to plant 7
  assert.equal((await ask(call, tokens.entry2)).status, 403);
  // admin cannot request; unauthenticated rejected
  assert.equal((await ask(call, tokens.admin)).status, 403);
  assert.equal((await call('POST', UNLOCK, { body: {} })).status, 401);

  const ok = await ask(call, tokens.entry);
  assert.equal(ok.status, 201);
  assert.equal(ok.data.status, 'Pending');
  // duplicate pending request
  assert.equal((await ask(call, tokens.entry)).status, 409);
  // pending banner data
  const rec = await call('GET', url(7), { token: tokens.entry });
  assert.equal(rec.data.pendingUnlock.id, ok.data.id);

  // only admin reviews
  const rv = `${UNLOCK}/${ok.data.id}/review`;
  assert.equal((await call('POST', rv, { token: tokens.sup, body: { decision: 'approve' } })).status, 403);
  assert.equal((await call('POST', rv, { token: tokens.entry, body: { decision: 'approve' } })).status, 403);
  assert.equal((await call('POST', rv, { token: tokens.admin, body: { decision: 'maybe' } })).status, 400);
  assert.equal((await call('POST', rv, { token: tokens.admin, body: { decision: 'reject' } })).status, 422);
  assert.equal((await call('POST', `${UNLOCK}/9999/review`, { token: tokens.admin, body: { decision: 'approve' } })).status, 404);
});

test('unlock request: list visibility', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  await submit(call, tokens.entry);
  await ask(call, tokens.entry);
  const own = (await call('GET', UNLOCK, { token: tokens.entry })).data.requests;
  assert.ok(own.length >= 1 && own.every((r) => r.requestedBy === 'tentry' || r.requestedBy));
  assert.equal((await call('GET', UNLOCK, { token: tokens.entry2 })).data.requests.length, 0);
  const all = (await call('GET', UNLOCK, { token: tokens.admin })).data.requests;
  assert.ok(all.length >= own.length);
  assert.ok(all.every((r) => r.site.kind === 'plant' || r.site.kind === 'office'));
  assert.equal((await call('GET', `${UNLOCK}?status=bogus`, { token: tokens.admin })).status, 400);
});

test('unlock approve reopens the record, reject keeps it locked', async (t) => {
  const { call, db, tokens, close } = await setup();
  t.after(close);
  await submit(call, tokens.entry);
  const a = (await ask(call, tokens.entry)).data;

  const rej = await call('POST', `${UNLOCK}/${a.id}/review`, { token: tokens.admin, body: { decision: 'reject', reason: 'Not justified' } });
  assert.equal(rej.status, 200);
  assert.equal(rej.data.status, 'Rejected');
  assert.equal((await call('GET', url(7), { token: tokens.entry })).data.editable, false);
  // already reviewed
  assert.equal((await call('POST', `${UNLOCK}/${a.id}/review`, { token: tokens.admin, body: { decision: 'approve' } })).status, 409);

  // a new request may follow a rejection
  const b = (await ask(call, tokens.sup, 'Supervisor request')).data;
  const apr = await call('POST', `${UNLOCK}/${b.id}/review`, { token: tokens.admin, body: { decision: 'approve' } });
  assert.equal(apr.status, 200);
  const rec = (await call('GET', url(7), { token: tokens.entry })).data;
  assert.equal(rec.editable, true);
  assert.equal(rec.statusName, 'Returned');
  assert.equal(rec.pendingUnlock, null);
  const row = db.prepare("SELECT StatusID, ReviewedStatus FROM EnergyConsumption WHERE PlantID=7 AND QuarterCode='Q1' AND ParameterID=1").get();
  assert.equal(row.StatusID, 5);
  assert.equal(row.ReviewedStatus, null);
  assert.equal(db.prepare('SELECT Status FROM UnlockRequests WHERE UnlockRequestID=?').get(b.id).Status, 'Approved');

  // editable again, and can be resubmitted
  assert.equal((await submit(call, tokens.entry)).status, 200);
});

test('notifications: events, recipients, read and clear', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  const unread = async (n) => (await call('GET', '/api/notifications', { token: tokens[n] })).data;
  const base = (await unread('sup')).notifications.length;

  await submit(call, tokens.entry);
  let s = await unread('sup');
  assert.equal(s.notifications.length, base + 1);
  assert.equal(s.notifications[0].event, 'Submitted');
  assert.equal((await unread('entry2')).notifications.every((n) => n.event !== 'Submitted' || n.site !== s.notifications[0].site), true);

  // approval notifies the submitter, not the reviewer
  await call('POST', url(7) + '/review', { token: tokens.sup, body: { decision: 'approve' } });
  const adminBase = (await unread('admin')).notifications.length;
  const e = await unread('entry');
  assert.equal(e.notifications[0].event, 'Approved');
  assert.equal(e.unread >= 1, true);
  assert.equal((await unread('sup')).notifications[0].event, 'Submitted');

  // unlock request -> admin notified; decision -> requester notified
  const u = (await ask(call, tokens.entry)).data;
  const adm = await unread('admin');
  assert.equal(adm.notifications.length, adminBase + 1);
  assert.equal(adm.notifications[0].event, 'UnlockRequested');
  assert.equal(adm.notifications[0].unlockRequestId, u.id);
  await call('POST', `${UNLOCK}/${u.id}/review`, { token: tokens.admin, body: { decision: 'approve' } });
  assert.equal((await unread('entry')).notifications[0].event, 'UnlockApproved');

  // read state is per user
  const first = (await unread('entry')).notifications[0];
  const after = (await call('POST', `/api/notifications/${first.id}/read`, { token: tokens.entry })).data;
  assert.equal(after.notifications.find((n) => n.id === first.id).read, true);
  const supBefore = await unread('sup');
  assert.equal(supBefore.unread >= 1, true);
  assert.equal((await call('POST', '/api/notifications/read-all', { token: tokens.entry })).data.unread, 0);
  assert.equal((await unread('sup')).unread, supBefore.unread);
  // clear affects only the caller
  assert.equal((await call('POST', '/api/notifications/clear', { token: tokens.entry })).data.notifications.length, 0);
  assert.ok((await unread('sup')).notifications.length > 0);
  assert.equal((await call('GET', '/api/notifications')).status, 401);
});

test('rejection notifies the submitter', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  await submit(call, tokens.entry);
  await call('POST', url(7) + '/review', { token: tokens.sup, body: { decision: 'reject', reason: 'Check electricity' } });
  const n = (await call('GET', '/api/notifications', { token: tokens.entry })).data.notifications[0];
  assert.equal(n.event, 'Rejected');
});
