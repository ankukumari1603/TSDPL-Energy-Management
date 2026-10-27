import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, startApp, fullEntries, PLANT_PARAMS } from './helpers.js';
import { loadEvaluator } from './evalWorkbook.js';
import { roleHasPermission, isConfiguredRole, PENDING_FOURTH_ROLE } from '../src/rolesConfig.js';

const FY = 'FY26-27';
const url = (id, q = 'Q1') => `/api/energy/plant/${id}/${FY}/${q}`;

async function setup() {
  const db = await makeDb();
  const app = await startApp(db);
  const tokens = {};
  for (const n of ['entry', 'entry2', 'sup', 'admin']) tokens[n] = await app.login(n);
  return { db, ...app, tokens };
}
const submit = (call, token, id = 7, q = 'Q1') => call('POST', url(id, q) + '/submit', { token, body: { entries: fullEntries(PLANT_PARAMS, 10) } });
const review = (call, token, decision, reason, id = 7, q = 'Q1') => call('POST', url(id, q) + '/review', { token, body: { decision, reason } });

test('return flow: comment required, status Returned, editable, resubmit, approve', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  await submit(call, tokens.entry);
  assert.equal((await review(call, tokens.entry, 'return', 'x')).status, 403);
  assert.equal((await review(call, tokens.sup, 'return', '  ')).status, 422);
  assert.equal((await review(call, tokens.sup, 'return', 'x'.repeat(501))).status, 422);
  assert.equal((await review(call, tokens.sup, 'bogus', 'x')).status, 400);
  const r = await review(call, tokens.sup, 'return', 'Grid units look doubled');
  assert.equal(r.status, 200);

  let rec = (await call('GET', url(7), { token: tokens.entry })).data;
  assert.equal(rec.statusName, 'Returned');
  assert.equal(rec.editable, true);

  const note = (await call('GET', '/api/notifications', { token: tokens.entry })).data.notifications.find((n) => n.decision === 'Returned' || /return/i.test(n.eventType ?? ''));
  assert.ok(note, 'user notified of return');
  assert.equal(note.reason, 'Grid units look doubled');

  assert.equal((await submit(call, tokens.entry)).status, 200);
  assert.equal((await review(call, tokens.sup, 'approve')).status, 200);
  rec = (await call('GET', url(7), { token: tokens.entry })).data;
  assert.equal(rec.statusName, 'Approved');
  assert.equal(rec.editable, false);

  const hist = (await call('GET', url(7) + '/history', { token: tokens.sup })).data.history;
  assert.deepEqual(hist.map((h) => h.action), ['Submitted', 'Returned', 'Submitted', 'Approved']);
  assert.equal(hist[1].comment, 'Grid units look doubled');
  assert.equal((await call('GET', url(7) + '/history', { token: tokens.entry2 })).status, 403);
});

test('ApprovalHistory is append-only', async (t) => {
  const { db, call, tokens, close } = await setup();
  t.after(close);
  await submit(call, tokens.entry);
  assert.throws(() => db.prepare('UPDATE ApprovalHistory SET Comment = ?').run('tamper'));
  assert.throws(() => db.prepare('DELETE FROM ApprovalHistory').run());
});

test('unit mismatch is rejected', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  const r = await call('PUT', url(7), { token: tokens.entry, body: { entries: [{ parameterId: 1, value: 5, unit: 'bogus-unit' }] } });
  assert.equal(r.status, 422);
});

test('admin routes: authorization, validation, no hash leakage, last-admin guard', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  for (const tk of [tokens.entry, tokens.sup]) {
    assert.equal((await call('GET', '/api/admin/users', { token: tk })).status, 403);
    assert.equal((await call('GET', '/api/admin/locations', { token: tk })).status, 403);
  }
  assert.equal((await call('GET', '/api/admin/users', {})).status, 401);

  const list = await call('GET', '/api/admin/users', { token: tokens.admin });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.data).includes('PasswordHash'));
  assert.ok(!JSON.stringify(list.data).includes('$2'));

  const good = { userName: 'newuser.one', email: 'new.one@example.com', employeeCode: 'EMP9001', password: 'Str0ng-Password-1', role: 'User', plantIds: [7], locationIds: [] };
  const weak = await call('POST', '/api/admin/users', { token: tokens.admin, body: { ...good, password: 'short' } });
  assert.equal(weak.status, 422);
  const bad = await call('POST', '/api/admin/users', { token: tokens.admin, body: { ...good, userName: 'a b' } });
  assert.equal(bad.status, 422);
  const created = await call('POST', '/api/admin/users', { token: tokens.admin, body: good });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.ok(!JSON.stringify(created.data).includes('Str0ng'));
  assert.equal((await call('POST', '/api/admin/users', { token: tokens.admin, body: good })).status, 409);

  // new user can log in and is scoped to plant 7
  const nt = await call('POST', '/api/auth/login', { body: { username: good.userName, password: good.password } });
  assert.equal(nt.status, 200);

  // cannot deactivate self (only admin)
  const id = 103; // the only active Admin in the fixture
  assert.ok(list.data.users.some((u) => u.id === id && u.role === 'Admin'));
  const self = await call('PATCH', `/api/admin/users/${id}`, { token: tokens.admin, body: { isActive: false } });
  assert.ok([403, 409, 422].includes(self.status), `self-deactivate blocked, got ${self.status}`);
});

test('admin locations: create, validate, toggle', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  const bad = await call('POST', '/api/admin/locations', { token: tokens.admin,   body: { kind: 'office', name: '', locationType: 'Office' } });
  assert.equal(bad.status, 422);
    const ok = await call('POST', '/api/admin/locations', { token: tokens.admin, body: { kind: 'office', name: 'Test Guest House X', locationType: 'Guest House' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal((await call('POST', '/api/admin/locations', { token: tokens.admin, body: { kind: 'office', name: 'test guest house x', locationType: 'Guest House' } })).status, 409);
    assert.equal((await call('POST', '/api/admin/locations', { token: tokens.sup, body: { kind: 'office', name: 'Nope Office', locationType: 'Office' } })).status, 403);
});

test('dashboard: scope, approved-only totals, renewable share, filters', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  const dash = (token, q = '') => call('GET', `/api/dashboard?fy=${FY}${q}`, { token });
  assert.equal((await call('GET', `/api/dashboard?fy=${FY}`, {})).status, 401);
  assert.equal((await dash(tokens.admin, '&period=Q9')).status, 400);
  assert.equal((await dash(tokens.admin, '&site=junk')).status, 400);

  const base = (await dash(tokens.sup)).data.summary;
  await submit(call, tokens.entry);
  let d = (await dash(tokens.sup)).data;
  assert.equal(d.summary.approved.total, base.approved.total, 'submitted data is not counted');
  assert.equal(d.summary.awaitingReview, base.awaitingReview + 1);

  await review(call, tokens.sup, 'approve');
  d = (await dash(tokens.sup)).data;
  assert.ok(d.summary.approved.total > base.approved.total);
  const share = d.summary.renewableSharePct;
  assert.ok(share === null || (share >= 0 && share <= 100));
  assert.ok(Math.abs(d.summary.approved.renewable + d.summary.approved.nonRenewable - d.summary.approved.total) < 1e-3);
  assert.equal(d.summary.statusCounts.Approved, base.statusCounts.Approved + 1);

  // period and location filters
  const q2 = (await dash(tokens.sup, '&period=Q2')).data.summary.approved.total;
  const q1 = (await dash(tokens.sup, '&period=Q1')).data.summary.approved.total;
  assert.ok(Math.abs(q1 + q2 + (await dash(tokens.sup, '&period=Q3')).data.summary.approved.total + (await dash(tokens.sup, '&period=Q4')).data.summary.approved.total - d.summary.approved.total) < 1e-3);
  const one = (await dash(tokens.sup, '&site=plant:7&period=Q1')).data;
  assert.equal(one.locations.length, 1);
  assert.ok(one.summary.approved.total > 0);
  // scope: Supervisors only see their mapped locations
  assert.equal((await dash(tokens.sup, '&site=plant:2')).status, 403);
  // Users have no dashboard access at all, with or without filters
  for (const q of ['', '&site=plant:7', '&period=Q1']) {
    assert.equal((await dash(tokens.entry, q)).status, 403);
    assert.equal((await dash(tokens.entry2, q)).status, 403);
  }
});

test('role matrix: dashboard, review decisions, factors and unlock review', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  const path = `/api/energy/plant/7/${FY}/Q1`;
  await submit(call, tokens.entry);

  // dashboard: Admin and Supervisor yes, User no
  for (const [who, code] of [['admin', 200], ['sup', 200], ['entry', 403], ['entry2', 403]]) {
    assert.equal((await call('GET', `/api/dashboard?fy=${FY}`, { token: tokens[who] })).status, code, `dashboard as ${who}`);
  }
  // Users cannot review, approve or see the pending review list
  assert.equal((await call('POST', `${path}/review`, { token: tokens.entry, body: { decision: 'approve' } })).status, 403);
  assert.equal((await call('GET', `/api/energy/pending-review?fy=${FY}`, { token: tokens.entry })).status, 403);
  // Conversion factors are read-only for everyone; there is no edit route
  assert.equal((await call('GET', '/api/conversion-factors', { token: tokens.entry })).status, 200);
  for (const m of ['PUT', 'POST', 'PATCH', 'DELETE']) assert.equal((await call(m, '/api/conversion-factors', { token: tokens.admin, body: {} })).status, 404);
  // Supervisor may request an unlock but not decide one; the User cannot decide either
  assert.equal((await call('POST', '/api/energy/unlock-requests/1/review', { token: tokens.sup, body: { decision: 'approve' } })).status, 403);
  assert.equal((await call('POST', '/api/energy/unlock-requests/1/review', { token: tokens.entry, body: { decision: 'approve' } })).status, 403);
  // a Supervisor approves a normal submission with no Admin step, and the Admin can still decide as an exception
  assert.equal((await call('POST', `${path}/review`, { token: tokens.sup, body: { decision: 'approve' } })).data.statusName, 'Approved');
  await call('POST', `/api/energy/plant/7/${FY}/Q2/submit`, { token: tokens.entry, body: { entries: fullEntries(PLANT_PARAMS, 10) } });
  assert.equal((await call('POST', `/api/energy/plant/7/${FY}/Q2/review`, { token: tokens.admin, body: { decision: 'reject', reason: 'Exception' } })).data.statusName, 'Rejected');
});

test('fourth role is a disabled placeholder with no permissions', () => {
  assert.equal(PENDING_FOURTH_ROLE.enabled, false);
  assert.deepEqual(PENDING_FOURTH_ROLE.permissions, []);
  assert.equal(isConfiguredRole('Auditor'), false);
  assert.equal(roleHasPermission('Auditor', 'energy:view'), false);
  assert.equal(roleHasPermission(undefined, 'dashboard:view'), false);
});

test('end to end: enter, return, resubmit, approve, appears in export', async (t) => {
  const { call, tokens, close } = await setup();
  t.after(close);
  const exp = `/api/reports/energy/export?fy=${FY}&quarter=Q1`;
  const k49 = async () => {
    const r = await call('GET', exp, { token: tokens.admin });
    return r.status === 200 ? (await loadEvaluator(Buffer.from(r.data))).get('Energy Template - Consol', 'K49') : null;
  };
  await submit(call, tokens.entry);
  await review(call, tokens.sup, 'return', 'please recheck');
  assert.ok(!(await k49()), 'returned data is not exported');
  await submit(call, tokens.entry);
  await review(call, tokens.sup, 'approve');
  assert.equal(await k49(), 10, 'approved Kalinganagar value appears in Consol');
  assert.equal((await call('GET', exp, { token: tokens.entry })).status, 403);
});
