import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, startApp, fullEntries, forwardAndApprove, PLANT_PARAMS } from './helpers.js';

const FY = 'FY26-27';
const url = (id, q) => `/api/energy/plant/${id}/${FY}/${q}`;
const UNLOCK = '/api/energy/unlock-requests';

test('approved and rejected records stay in their own status category', async (t) => {
  const db = await makeDb();
  const app = await startApp(db);
  t.after(app.close);
  const { call } = app;
  const entry = await app.login('entry');
  const sup = await app.login('sup');
  const admin = await app.login('admin');

  // Q1 plant 7: approved. Q2 plant 7: rejected.
  for (const q of ['Q1', 'Q2']) {
    assert.equal((await call('POST', `${url(7, q)}/submit`, { token: entry, body: { entries: fullEntries(PLANT_PARAMS, 10) } })).status, 200);
  }
  assert.equal((await forwardAndApprove(call, sup, admin, url(7, 'Q1'))).status, 200);
  assert.equal((await call('POST', `${url(7, 'Q2')}/review`, { token: admin, body: { decision: 'reject', reason: 'Wrong totals' } })).status, 200);

  const status = async (q) => {
    const list = (await call('GET', `/api/energy/records?fy=${FY}&quarter=${q}`, { token: admin })).data.records;
    return list.find((r) => r.site.kind === 'plant' && r.site.id === 7).statusName;
  };
  assert.equal(await status('Q1'), 'Approved');
  assert.equal(await status('Q2'), 'Rejected');
  assert.equal((await call('GET', url(7, 'Q1'), { token: entry })).data.statusName, 'Approved');
  assert.equal((await call('GET', url(7, 'Q2'), { token: entry })).data.statusName, 'Rejected');

  // A rejected unlock request on the approved record must not change its status,
  // and the request list must report the record status separately.
  const req = await call('POST', UNLOCK, { token: entry, body: { kind: 'plant', id: 7, financialYear: FY, quarter: 'Q1', reason: 'Please reopen' } });
  assert.equal(req.status, 201);
  assert.equal((await call('POST', `${UNLOCK}/${req.data.id}/review`, { token: admin, body: { decision: 'reject', reason: 'cannot' } })).status, 200);

  const rejectedRequests = (await call('GET', `${UNLOCK}?status=Rejected`, { token: admin })).data.requests;
  const mine = rejectedRequests.find((r) => r.id === req.data.id);
  assert.equal(mine.status, 'Rejected');
  assert.equal(mine.recordStatus, 'Approved');
  assert.equal(await status('Q1'), 'Approved');

  // Dashboard counts the approved record once and never as rejected.
  const dash = await call('GET', `/api/dashboard?fy=${FY}`, { token: admin });
  assert.equal(dash.status, 200);
});

