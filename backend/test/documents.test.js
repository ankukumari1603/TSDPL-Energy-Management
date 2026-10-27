import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDb, startApp, fullEntries, PLANT_PARAMS } from './helpers.js';

const rec = '/api/energy/plant/7/FY26-27/Q1';
const PDF = Buffer.from('%PDF-1.4\n%test\n');

test('supporting documents: upload, list, download, validation, locking, scope', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsdpl-up-'));
  const db = await makeDb();
  const app = await startApp(db, { uploadDir: dir });
  try {
    const entry = await app.login('entry');
    const entry2 = await app.login('entry2');
    const sup = await app.login('sup');
    const noenergy = await app.login('noenergy');
    const upload = async (token, name, buf, p = rec) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf]), name);
      const res = await fetch(`${app.base}${p}/documents`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
      return { status: res.status, data: await res.json() };
    };

    assert.equal((await upload(null, 'a.pdf', PDF)).status, 401);
    assert.equal((await upload(sup, 'a.pdf', PDF)).status, 403, 'supervisor cannot upload');
    assert.equal((await upload(noenergy, 'a.pdf', PDF)).status, 403);
    assert.equal((await upload(entry2, 'a.pdf', PDF)).status, 403, 'no access to this plant');

    const ok = await upload(entry, '..\\..\\evil/invoice.pdf', PDF);
    assert.equal(ok.status, 201);
    assert.equal(ok.data.documents.length, 1);
    assert.equal(ok.data.documents[0].name, 'invoice.pdf');
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.ok(!fs.readdirSync(dir)[0].includes('invoice'), 'stored under a random name');

    assert.equal((await upload(entry, 'x.exe', PDF)).status, 422);
    assert.equal((await upload(entry, 'fake.pdf', Buffer.from('not a pdf'))).status, 422);
    assert.equal((await upload(entry, 'empty.csv', Buffer.alloc(0))).status, 422);
    assert.equal((await upload(entry, 'bin.csv', Buffer.from([1, 0, 2]))).status, 422);
    assert.equal((await upload(entry, 'big.pdf', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]))).status, 413);
    assert.equal((await upload(entry, 'ok.csv', Buffer.from('a,b\n1,2\n'))).status, 201);

    // supervisor with access can list and download; others cannot
    const list = await app.call('GET', `${rec}/documents`, { token: sup });
    assert.equal(list.data.documents.length, 2);
    assert.equal((await app.call('GET', `${rec}/documents`, { token: entry2 })).status, 403);
    const id = list.data.documents[0].id;
    const dl = await app.call('GET', `${rec}/documents/${id}`, { token: sup });
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.data, PDF);
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await app.call('GET', `/api/energy/plant/7/FY26-27/Q2/documents/${id}`, { token: sup })).status, 404, 'wrong period');
    assert.equal((await app.call('GET', `${rec}/documents/${id}`, { token: entry2 })).status, 403);

    // max 10 per record
    for (let i = 0; i < 8; i++) assert.equal((await upload(entry, `f${i}.csv`, Buffer.from('x'))).status, 201);
    assert.equal((await upload(entry, 'over.csv', Buffer.from('x'))).status, 409);

    // soft delete, file kept on disk
    const del = await app.call('DELETE', `${rec}/documents/${id}`, { token: entry });
    assert.equal(del.status, 200);
    assert.equal(del.data.documents.length, 9);
    assert.equal(db.prepare('SELECT IsDeleted FROM SupportingDocuments WHERE DocumentID = ?').get(id).IsDeleted, 1);
    assert.equal(fs.readdirSync(dir).length, 10);
    assert.equal((await app.call('DELETE', `${rec}/documents/${id}`, { token: entry })).status, 404);

    // locked after submit
    assert.equal((await app.call('POST', `${rec}/submit`, { token: entry, body: { entries: fullEntries(PLANT_PARAMS) } })).status, 200);
    assert.equal((await upload(entry, 'late.csv', Buffer.from('x'))).status, 409);
    const keep = (await app.call('GET', `${rec}/documents`, { token: entry })).data.documents[0].id;
    assert.equal((await app.call('DELETE', `${rec}/documents/${keep}`, { token: entry })).status, 409);
    assert.equal((await app.call('GET', `${rec}/documents/${keep}`, { token: sup })).status, 200, 'reviewer can still open evidence');
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
