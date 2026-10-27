import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { makeDb, startApp, PASSWORD, USERS } from './helpers.js';

const URL = '/api/me/password';
const NEW = 'Another-Strong-Pass-9';
const body = (o = {}) => ({ currentPassword: PASSWORD, newPassword: NEW, confirmPassword: NEW, ...o });

async function setup() {
  const db = await makeDb();
  const app = await startApp(db);
  return { db, ...app, token: await app.login('entry') };
}

test('change password: success, hashed with bcrypt, old password stops working', async (t) => {
  const { db, call, login, token, close } = await setup();
  t.after(close);
  const r = await call('POST', URL, { token, body: body() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
  assert.ok(!JSON.stringify(r.data).includes(NEW));

  const stored = db.prepare('SELECT PasswordHash FROM Users WHERE UserID = ?').get(USERS.entry.id).PasswordHash;
  assert.notEqual(stored, NEW);
  assert.ok(stored.startsWith('$2'));
  assert.ok(bcrypt.compareSync(NEW, stored));
  assert.equal(bcrypt.getRounds(stored), 12);

  const bad = await call('POST', '/api/auth/login', { body: { username: USERS.entry.name, password: PASSWORD } });
  assert.equal(bad.status, 401);
  const good = await call('POST', '/api/auth/login', { body: { username: USERS.entry.name, password: NEW } });
  assert.equal(good.status, 200);
  void login;
});

test('change password: wrong current password is rejected and nothing changes', async (t) => {
  const { db, call, token, close } = await setup();
  t.after(close);
  const before = db.prepare('SELECT PasswordHash FROM Users WHERE UserID = ?').get(USERS.entry.id).PasswordHash;
  const r = await call('POST', URL, { token, body: body({ currentPassword: 'Wrong-Password-123' }) });
  assert.equal(r.status, 403);
  assert.equal((await call('POST', URL, { token, body: body({ currentPassword: '' }) })).status, 400);
  assert.equal((await call('POST', URL, { token, body: { newPassword: NEW, confirmPassword: NEW } })).status, 400);
  assert.equal(db.prepare('SELECT PasswordHash FROM Users WHERE UserID = ?').get(USERS.entry.id).PasswordHash, before);
});

test('change password: invalid new passwords are rejected', async (t) => {
  const { db, call, token, close } = await setup();
  t.after(close);
  const before = db.prepare('SELECT PasswordHash FROM Users WHERE UserID = ?').get(USERS.entry.id).PasswordHash;
  const cases = {
    short: 'Ab1-short',
    noUpper: 'alllowercase-123',
    noLower: 'ALLUPPERCASE-123',
    noDigit: 'No-Digits-Here-Abc',
    tooLongBytes: 'Aa1' + 'x'.repeat(80),
    notString: 12345678901234,
  };
  for (const [name, pw] of Object.entries(cases)) {
    const r = await call('POST', URL, { token, body: body({ newPassword: pw, confirmPassword: pw }) });
    assert.equal(r.status, 422, name);
  }
  assert.equal((await call('POST', URL, { token, body: body({ confirmPassword: NEW + 'x' }) })).status, 422, 'mismatch');
  assert.equal((await call('POST', URL, { token, body: body({ newPassword: PASSWORD, confirmPassword: PASSWORD }) })).status, 422, 'same as current');
  assert.equal(db.prepare('SELECT PasswordHash FROM Users WHERE UserID = ?').get(USERS.entry.id).PasswordHash, before);
});

test('change password: requires authentication and only affects the caller', async (t) => {
  const { db, call, token, close } = await setup();
  t.after(close);
  assert.equal((await call('POST', URL, { body: body() })).status, 401);
  const other = db.prepare('SELECT PasswordHash FROM Users WHERE UserID = ?').get(USERS.sup.id).PasswordHash;
  await call('POST', URL, { token, body: { ...body(), userId: USERS.sup.id } });
  assert.equal(db.prepare('SELECT PasswordHash FROM Users WHERE UserID = ?').get(USERS.sup.id).PasswordHash, other);
});

test('change password works for a user without the energy module', async (t) => {
  const { call, login, close } = await setup();
  t.after(close);
  const token = await login('noenergy');
  assert.equal((await call('POST', URL, { token, body: body() })).status, 200);
});
