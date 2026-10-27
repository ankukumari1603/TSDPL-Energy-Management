import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, startApp, fullEntries, PLANT_PARAMS, OFFICE_PARAMS, PASSWORD, USERS } from './helpers.js';

const FY = 'FY26-27';
const url = (kind, id, q = 'Q1') => `/api/energy/${kind}/${id}/${FY}/${q}`;

async function setup() {
  const db = await makeDb();
  const app = await startApp(db);
  return { db, ...app };
}

test('authentication', async (t) => {
  const { call, close } = await setup();
  t.after(close);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', { token: 'garbage' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'tentry', password: 'wrong' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'nobody', password: PASSWORD } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: {} })).status, 400);
  const ok = await call('POST', '/api/auth/login', { body: { username: USERS.entry.name, password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'User');
  assert.equal(JSON.stringify(ok.data).includes('PasswordHash'), false);
});

test('permissions: site scope, roles and module access', async (t) => {
  const { call, login, close } = await setup();
  t.after(close);
  const entry = await login('entry');
  const entry2 = await login('entry2');
  const sup = await login('sup');
  const admin = await login('admin');
  const noenergy = await login('noenergy');

  const sites = (await call('GET', '/api/sites', { token: entry })).data.sites;
  assert.deepEqual(sites.map((s) => `${s.kind}:${s.id}`), ['plant:7', 'office:6']);
  assert.equal((await call('GET', '/api/sites', { token: admin })).data.sites.length, 22);

  // not mapped to plant 1
  assert.equal((await call('GET', url('plant', 1), { token: entry })).status, 403);
  assert.equal((await call('PUT', url('plant', 1), { token: entry, body: { entries: [] } })).status, 403);
  // supervisors cannot enter data, users cannot review or export
  assert.equal((await call('PUT', url('plant', 7), { token: sup, body: { entries: [] } })).status, 403);
  assert.equal((await call('POST', url('plant', 7) + '/review', { token: entry, body: { decision: 'approve' } })).status, 403);
  assert.equal((await call('GET', `/api/reports/energy/preview?fy=${FY}&quarter=Q1`, { token: entry })).status, 403);
  assert.equal((await call('GET', `/api/reports/energy/preview?fy=${FY}&quarter=Q1`, { token: sup })).status, 200);
  // module disabled for user
  assert.equal((await call('GET', '/api/sites', { token: noenergy })).status, 403);
  void entry2;
});

test('draft -> submit -> reject -> resubmit -> approve (plant)', async (t) => {
  const { call, login, db, close } = await setup();
  t.after(close);
  const entry = await login('entry');
  const sup = await login('sup');
  const admin = await login('admin');

  let r = await call('GET', url('plant', 7), { token: entry });
  assert.equal(r.status, 200);
  assert.equal(r.data.statusName, 'Not started');
  assert.equal(r.data.entries.length, 10);

  // partial draft with a blank value is allowed
  r = await call('PUT', url('plant', 7), { token: entry, body: { entries: [{ parameterId: 1, value: '100' }, { parameterId: 2, value: '' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.statusName, 'Draft');
  assert.equal(r.data.entries[0].value, 100);
  assert.equal(r.data.entries[0].gj, 0.36);

  // invalid values are rejected with details
  r = await call('PUT', url('plant', 7), { token: entry, body: { entries: [{ parameterId: 3, value: '-4' }] } });
  assert.equal(r.status, 422);
  assert.equal(r.data.details[0].parameterId, 3);

  // submit needs every parameter
  r = await call('POST', url('plant', 7) + '/submit', { token: entry, body: { entries: [{ parameterId: 1, value: 100 }] } });
  assert.equal(r.status, 422);
  assert.equal(r.data.details.length, 9);

  r = await call('POST', url('plant', 7) + '/submit', { token: entry, body: { entries: fullEntries(PLANT_PARAMS, 10) } });
  assert.equal(r.status, 200);
  assert.equal(r.data.statusName, 'Submitted');
  assert.equal(r.data.editable, false);
  const row = db.prepare("SELECT * FROM EnergyConsumption WHERE PlantID=7 AND QuarterCode='Q1' AND ParameterID=1").get();
  assert.equal(row.SubmittedBy, '100');
  assert.equal(row.StatusID, 2);

  // locked while submitted
  assert.equal((await call('PUT', url('plant', 7), { token: entry, body: { entries: [{ parameterId: 1, value: 1 }] } })).status, 409);

  // reject/return need a reason; a Supervisor decides directly, a User cannot review at all
  const rev = (token, body) => call('POST', url('plant', 7) + '/review', { token, body });
  assert.equal((await rev(sup, { decision: 'reject' })).status, 422, 'supervisor rejection needs a reason');
  assert.equal((await rev(sup, { decision: 'forward' })).status, 400, 'escalation no longer exists');
  r = await rev(sup, { decision: 'reject', reason: 'Solar units look wrong' });
  assert.equal(r.status, 200);
  assert.equal(r.data.statusName, 'Rejected');
  assert.equal(r.data.rejectionReason, 'Solar units look wrong');
  assert.equal(r.data.editable, true);

  r = await call('POST', url('plant', 7) + '/submit', { token: entry, body: { entries: fullEntries(PLANT_PARAMS, 20) } });
  assert.equal(r.data.statusName, 'Submitted');
  assert.equal(r.data.stage, 'AwaitingSupervisor');
  assert.equal(r.data.rejectionReason, null);

  // the Supervisor gives the final approval directly; no Admin step is needed
  r = await rev(sup, { decision: 'approve' });
  assert.equal(r.status, 200);
  assert.equal(r.data.statusName, 'Approved');
  assert.equal(r.data.reviewedBy, '102');
  // approved is final
  assert.equal((await rev(admin, { decision: 'approve' })).status, 409);
  assert.equal((await call('PUT', url('plant', 7), { token: entry, body: { entries: [{ parameterId: 1, value: 1 }] } })).status, 409);

  // audit trail records every step with actor and comment
  const hist = (await call('GET', url('plant', 7) + '/history', { token: admin })).data.history;
  assert.deepEqual(hist.map((h) => h.action), ['Submitted', 'Rejected', 'Submitted', 'Approved']);
  assert.equal(hist[1].comment, 'Solar units look wrong');
  assert.equal(hist[1].role, 'Supervisor');
  assert.equal(hist[3].role, 'Supervisor');
});

test('only approved records reach totals and exports; a Supervisor approval is enough', async (t) => {
  const { call, login, close } = await setup();
  t.after(close);
  const entry = await login('entry');
  const sup = await login('sup');
  const admin = await login('admin');
  const rev = (token, body) => call('POST', url('plant', 7) + '/review', { token, body });
  const approvedGj = async () => JSON.stringify((await call('GET', `/api/dashboard?fy=${FY}&period=ALL`, { token: admin })).data);
  await call('POST', url('plant', 7) + '/submit', { token: entry, body: { entries: fullEntries(PLANT_PARAMS, 10) } });
  assert.equal((await call('GET', `/api/reports/energy/export?fy=${FY}&quarter=Q1`, { token: sup })).status, 409, 'no approved data yet');
  const before = await approvedGj();
  assert.equal((await rev(sup, { decision: 'approve' })).status, 200);
  assert.notEqual(await approvedGj(), before);
  assert.equal((await call('GET', `/api/reports/energy/export?fy=${FY}&quarter=Q1`, { token: sup })).status, 200);
});

test('notifications: submit -> supervisors, decision -> submitter, admin not asked', async (t) => {
  const { call, login, close } = await setup();
  t.after(close);
  const entry = await login('entry');
  const sup = await login('sup');
  const admin = await login('admin');
  const rev = (token, body) => call('POST', url('plant', 7) + '/review', { token, body });
  const events = async (token) => (await call('GET', '/api/notifications', { token })).data.notifications.map((n) => n.event);
  await call('POST', url('plant', 7) + '/submit', { token: entry, body: { entries: fullEntries(PLANT_PARAMS, 10) } });
  assert.ok((await events(sup)).includes('Submitted'));
  assert.ok(!(await events(admin)).includes('Submitted'), 'admin is not asked to review a normal submission');
  await rev(sup, { decision: 'reject', reason: 'No' });
  assert.ok((await events(entry)).includes('Rejected'));
  assert.ok(!(await events(admin)).includes('Forwarded'));
});

test('office record uses only the mapped parameters; self-review is blocked', async (t) => {
  const { call, login, close } = await setup();
  t.after(close);
  const admin = await login('admin');
  const sup = await login('sup');
  let r = await call('GET', url('office', 6), { token: admin });
  assert.deepEqual(r.data.entries.map((e) => e.parameterId), OFFICE_PARAMS);
  // parameter 2 is not applicable to offices
  r = await call('PUT', url('office', 6), { token: admin, body: { entries: [{ parameterId: 2, value: 1 }] } });
  assert.equal(r.status, 422);
  r = await call('POST', url('office', 6) + '/submit', { token: admin, body: { entries: fullEntries(OFFICE_PARAMS, 1) } });
  assert.equal(r.status, 200);
  // the submitter (an admin) cannot decide on their own record
  assert.equal((await call('POST', url('office', 6) + '/review', { token: admin, body: { decision: 'approve' } })).status, 403);
  assert.equal((await call('POST', url('office', 6) + '/review', { token: sup, body: { decision: 'approve' } })).data.statusName, 'Approved');
});

test('input validation on the route', async (t) => {
  const { call, login, close } = await setup();
  t.after(close);
  const entry = await login('entry');
  assert.equal((await call('GET', '/api/energy/plant/7/FY26-28/Q1', { token: entry })).status, 400);
  assert.equal((await call('GET', '/api/energy/plant/7/FY26-27/Q9', { token: entry })).status, 400);
  assert.equal((await call('GET', '/api/energy/plant/999/FY26-27/Q1', { token: await login('admin') })).status, 404);
  assert.equal((await call('GET', '/api/energy/bogus/7/FY26-27/Q1', { token: entry })).status, 400);
});

test('existing legacy approved data is readable and converted', async (t) => {
  const { call, login, close } = await setup();
  t.after(close);
  const r = await call('GET', url('plant', 7, 'Q3'), { token: await login('entry') });
  assert.equal(r.data.statusName, 'Approved');
  assert.equal(r.data.entries[0].value, 111);
  assert.equal(r.data.entries[0].gj, 0.3996);
  assert.equal(r.data.entries[1].gj, 166.665);
  assert.equal(r.data.conversion.totals.Renewable, 167.0646);
});

test('legacy row rejected through ReviewedStatus is editable', async (t) => {
  const { call, login, close } = await setup();
  t.after(close);
  const r = await call('GET', url('office', 6, 'Q3'), { token: await login('entry') });
  assert.equal(r.data.statusName, 'Rejected');
  assert.equal(r.data.editable, true);
});
