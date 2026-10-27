import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { makeDb, startApp, fullEntries, PLANT_PARAMS } from './helpers.js';

const FY = 'FY26-27';

test('dashboard authorization: 401 without a valid login, 403 for User, 200 for Supervisor and Admin', async (t) => {
  const db = await makeDb();
  const { call, login, close, base } = await startApp(db);
  t.after(close);
  const tk = { entry: await login('entry'), entry2: await login('entry2'), sup: await login('sup'), admin: await login('admin') };

  // approved data exists, so a leak would be visible
  await call('POST', `/api/energy/plant/7/${FY}/Q1/submit`, { token: tk.entry, body: { entries: fullEntries(PLANT_PARAMS, 10) } });
  assert.equal((await call('POST', `/api/energy/plant/7/${FY}/Q1/review`, { token: tk.sup, body: { decision: 'approve' } })).status, 200);

  const paths = [
    `/api/dashboard?fy=${FY}`,
    `/api/dashboard?fy=${FY}&period=Q1`,
    `/api/dashboard?fy=${FY}&site=plant:7`,
    '/api/dashboard',
    '/api/dashboard/',
    '/api/Dashboard',
  ];

  // 1. no token / malformed header / bad token / token signed with another secret -> 401, no data
  const forged = jwt.sign({ sub: 100 }, 'not-the-real-secret', { algorithm: 'HS256' });
  for (const p of paths) {
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer garbage' }, { authorization: `Bearer ${forged}` }]) {
      const res = await fetch(base + p, { headers });
      assert.equal(res.status, 401, `${p} with ${JSON.stringify(headers).slice(0, 30)}`);
      const body = await res.json();
      assert.deepEqual(Object.keys(body), ['error']);
    }
  }

  // 2. User role -> 403 and the body carries only an error, never dashboard data
  for (const who of ['entry', 'entry2']) {
    for (const p of paths.slice(0, 4)) {
      const r = await call('GET', p, { token: tk[who] });
      assert.equal(r.status, 403, `${who} ${p}`);
      assert.deepEqual(Object.keys(r.data), ['error']);
    }
    // other methods must not reach the dashboard either
    for (const m of ['POST', 'PUT', 'DELETE']) assert.notEqual((await call(m, `/api/dashboard?fy=${FY}`, { token: tk[who], body: {} })).status, 200);
  }

  // 3. Supervisor and Admin -> 200 with data
  for (const who of ['sup', 'admin']) {
    const r = await call('GET', `/api/dashboard?fy=${FY}`, { token: tk[who] });
    assert.equal(r.status, 200, who);
    assert.ok(r.data.summary && Array.isArray(r.data.locations));
  }

  // 4. the User keeps their normal pages, so the 403 is specific to the dashboard
  assert.equal((await call('GET', `/api/energy/records?fy=${FY}&quarter=Q1`, { token: tk.entry })).status, 200);
});

test('dashboard authorization: an existing token stops working when the account is deactivated', async (t) => {
  const db = await makeDb();
  const { call, login, close } = await startApp(db);
  t.after(close);
  const sup = await login('sup');
  assert.equal((await call('GET', `/api/dashboard?fy=${FY}`, { token: sup })).status, 200);
  db.prepare('UPDATE Users SET IsActive = 0 WHERE UserID = 102').run();
  const r = await call('GET', `/api/dashboard?fy=${FY}`, { token: sup });
  assert.equal(r.status, 401);
  assert.deepEqual(Object.keys(r.data), ['error']);
});
