import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { makeDb, startApp, fullEntries, forwardAndApprove, PLANT_PARAMS, OFFICE_PARAMS } from './helpers.js';
import { config } from '../src/config.js';
import { setCellNumber } from '../src/excelExport.js';

const FY = 'FY26-27';
const Q = 'Q1';

async function approve(call, tokens, kind, id, params, base) {
  const p = `/api/energy/${kind}/${id}/${FY}/${Q}`;
  const s = await call('POST', p + '/submit', { token: tokens.admin, body: { entries: fullEntries(params, base) } });
  assert.equal(s.status, 200);
  const r = await forwardAndApprove(call, tokens.sup, tokens.approver, p);
  assert.equal(r.status, 200);
}

async function exportFixture() {
  const db = await makeDb();
  const app = await startApp(db);
  const tokens = { admin: await app.login('admin'), approver: await app.login('admin2'), sup: await app.login('sup'), entry: await app.login('entry') };
  try {
    await approve(app.call, tokens, 'plant', 7, PLANT_PARAMS, 10); // Kalinganagar: E7=10 ... E16=19
    await approve(app.call, tokens, 'plant', 6, PLANT_PARAMS, 100); // Pantnagar (mapping name is "Pantanagar")
    await approve(app.call, tokens, 'plant', 10, PLANT_PARAMS, 1); // Faridabad: no mappings in the database
    await approve(app.call, tokens, 'office', 6, OFFICE_PARAMS, 50); // Bhubaneswar -> column J
    // CR Jamshedpur only submitted, not approved
    await app.call('POST', `/api/energy/plant/1/${FY}/${Q}/submit`, { token: tokens.admin, body: { entries: fullEntries(PLANT_PARAMS, 1) } });
  } catch (e) {
    app.close();
    throw e;
  }
  return { db, tokens, ...app };
}

const sheetXml = async (zip, file) => zip.file(`xl/worksheets/${file}`).async('string');
const cellXml = (xml, ref) => new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(xml)?.[0];

test('setCellNumber writes into empty styled cells, keeps style, refuses formulas', () => {
  const xml = '<row><c r="E7" s="114"/><c r="E8" s="9" t="s"><v>3</v></c><c r="E9"><f>1+1</f><v>2</v></c></row>';
  assert.match(setCellNumber(xml, 'E7', 12.5), /<c r="E7" s="114"><v>12.5<\/v><\/c>/);
  assert.match(setCellNumber(xml, 'E8', 0), /<c r="E8" s="9"><v>0<\/v><\/c>/);
  assert.throws(() => setCellNumber(xml, 'E9', 1), /formula/);
  assert.throws(() => setCellNumber(xml, 'Z1', 1), /does not exist/);
});

test('preview and export fill mapped cells and report gaps', async (t) => {
  const { call, tokens, close } = await exportFixture();
  t.after(close);

  const preview = (await call('GET', `/api/reports/energy/preview?fy=${FY}&quarter=${Q}`, { token: tokens.sup })).data;
  const codes = preview.warnings.map((w) => w.code);
  assert.ok(!codes.includes('NO_EXPORT_MAPPING'), 'Faridabad is now mapped');
  assert.ok(codes.includes('SHEET_ALIAS'), 'Pantanagar alias');
  assert.ok(preview.warnings.some((w) => w.code === 'NOT_EXPORTED' && /CR - JAMSHEDPUR/.test(w.message)));
  assert.equal(preview.missingFactors.length, 0);
  // 10 + 10 + 10 plant cells, 6 office cells, 10 factors
  assert.equal(preview.cells.length, 46);

  const res = await call('GET', `/api/reports/energy/export?fy=${FY}&quarter=${Q}`, { token: tokens.sup });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /TSDPL-Energy-FY26-27-Q1\.xlsx/);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(Buffer.from(res.data).subarray(0, 2).toString(), 'PK');

  const out = await JSZip.loadAsync(res.data);
  const orig = await JSZip.loadAsync(fs.readFileSync(config.templatePath));

  // sheet2 = Consol, sheet11 = Kalinganagar, sheet10 = Pantnagar, sheet14 = Offices, sheet4 = CR, sheet8 = Faridabad
  const kal = await sheetXml(out, 'sheet11.xml');
  assert.match(cellXml(kal, 'E7'), /<v>10<\/v>/);
  assert.match(cellXml(kal, 'E16'), /<v>19<\/v>/);
  assert.match(cellXml(await sheetXml(out, 'sheet10.xml'), 'E7'), /<v>100<\/v>/);
  const off = await sheetXml(out, 'sheet14.xml');
  assert.match(cellXml(off, 'J7'), /<v>50<\/v>/); // solar
  assert.match(cellXml(off, 'J11'), /<v>53<\/v>/); // LPG is parameter 5, the 4th office entry (50+3)
  assert.equal(cellXml(off, 'E7'), cellXml(await sheetXml(orig, 'sheet14.xml'), 'E7'));
  // unapproved sites stay blank; Faridabad is written from its verified mapping
  assert.equal(cellXml(await sheetXml(out, 'sheet4.xml'), 'E7'), cellXml(await sheetXml(orig, 'sheet4.xml'), 'E7'));
  const far = await sheetXml(out, 'sheet8.xml');
  assert.match(cellXml(far, 'E7'), /<v>1<\/v>/);
  assert.match(cellXml(far, 'E16'), /<v>10<\/v>/);
  // conversion factors from the database
  const con = await sheetXml(out, 'sheet2.xml');
  assert.match(cellXml(con, 'J33'), /<v>0\.0036<\/v>/);
  assert.match(cellXml(con, 'J36'), /<v>38\.6<\/v>/);
  assert.match(cellXml(con, 'J42'), /<v>1<\/v>/);
  // formulas untouched
  assert.equal(cellXml(con, 'M33'), cellXml(await sheetXml(orig, 'sheet2.xml'), 'M33'));
  assert.match(cellXml(con, 'M33'), /<f[ >]/);
});

test('export preserves workbook structure, formatting parts and sheet names', async (t) => {
  const { call, tokens, close } = await exportFixture();
  t.after(close);
  const res = await call('GET', `/api/reports/energy/export?fy=${FY}&quarter=${Q}`, { token: tokens.admin });
  const out = await JSZip.loadAsync(res.data);
  const orig = await JSZip.loadAsync(fs.readFileSync(config.templatePath));
  const fileNames = (z) => Object.keys(z.files).filter((n) => !z.files[n].dir).sort();
  assert.deepEqual(fileNames(out), fileNames(orig));
  const changed = ['xl/workbook.xml'];
  const patchedSheets = new Set(['sheet2', 'sheet8', 'sheet10', 'sheet11', 'sheet14']);
  for (const name of Object.keys(orig.files)) {
    if (orig.files[name].dir) continue;
    const same = Buffer.compare(await orig.file(name).async('nodebuffer'), await out.file(name).async('nodebuffer')) === 0;
    const m = /^xl\/worksheets\/(sheet\d+)\.xml$/.exec(name);
    const expectChange = changed.includes(name) || (m && patchedSheets.has(m[1]));
    assert.equal(same, !expectChange, `${name} ${expectChange ? 'should' : 'should not'} change`);
  }
  const wbOut = await out.file('xl/workbook.xml').async('string');
  assert.match(wbOut, /fullCalcOnLoad="1"/);
  assert.deepEqual(wbOut.match(/<sheets>.*<\/sheets>/)[0], (await orig.file('xl/workbook.xml').async('string')).match(/<sheets>.*<\/sheets>/)[0]);

  // opens in an independent reader with all sheets and formulas intact
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.data);
  assert.equal(wb.worksheets.length, 14);
  assert.equal(wb.getWorksheet('Kalinganagar').getCell('E8').value, 11);
  assert.match(String(wb.getWorksheet('Energy Template - Consol').getCell('M33').value.formula), /H33\*J33/);
});

test('Faridabad mapping is verified against the template, idempotent, and identical in layout to Kalinganagar', async () => {
  const db = await makeDb();
  const { ensureFaridabadMapping } = await import('../src/migrations.js');
  ensureFaridabadMapping(db);
  const rows = (id) => db.prepare("SELECT ParameterID p, CellColumn c, CellRow r FROM EnergyExportCellMapping WHERE MappingType='PLANT_CONSUMPTION' AND PlantID=? ORDER BY ParameterID").all(id);
  const far = rows(10);
  assert.equal(far.length, 10);
  assert.deepEqual(far.map((x) => `${x.c}${x.r}`), ['E7', 'E8', 'E9', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'E16']);
  // must stay in step with the template: Consol I49:I58 reads Faridabad!E7:E16
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(config.templatePath);
  const consol = wb.getWorksheet('Energy Template - Consol');
  for (let i = 0; i < 10; i++) assert.match(String(consol.getCell(`I${49 + i}`).value.formula), new RegExp(`^Faridabad!E${7 + i}$`));
  assert.equal(db.prepare("SELECT WorksheetName w FROM EnergyExportCellMapping WHERE PlantID=10 LIMIT 1").get().w, 'Faridabad');
  ensureFaridabadMapping(db);
  assert.equal(rows(10).length, 10, 'running again adds nothing');
});

test('report groups warnings, shows the period, and treats no-entry sites as information only', async (t) => {
  const { call, tokens, close } = await exportFixture();
  t.after(close);
  const p = (await call('GET', `/api/reports/energy/preview?fy=${FY}&quarter=${Q}`, { token: tokens.admin })).data;
  assert.deepEqual(p.period, { financialYear: FY, quarter: Q, label: `${FY} ${Q}` });
  const groups = new Set(['missingData', 'awaitingApproval', 'missingMapping', 'companyConfirmation']);
  assert.ok(p.warnings.every((w) => groups.has(w.category)), 'every warning has a known group');
  const cat = (code) => p.warnings.find((w) => w.code === code)?.category;
  assert.equal(cat('NOT_EXPORTED'), 'awaitingApproval');
  assert.equal(cat('SHEET_ALIAS'), 'companyConfirmation');
  assert.equal(cat('FACTOR_REVIEW'), 'companyConfirmation');
  // CR is submitted (awaiting approval); a site with no rows is informational, never a NOT_EXPORTED warning
  assert.ok(p.warnings.some((w) => w.code === 'NOT_EXPORTED' && /CR - JAMSHEDPUR/.test(w.message)));
  assert.ok(p.noEntries.length > 0);
  assert.ok(!p.warnings.some((w) => /no data/.test(w.message)));
  assert.ok(p.noEntries.every((n) => !/CR - JAMSHEDPUR/.test(n)));
});

test('export contains approved records only', async (t) => {
  const { call, tokens, close } = await exportFixture();
  t.after(close);
  const p = (await call('GET', `/api/reports/energy/preview?fy=${FY}&quarter=${Q}`, { token: tokens.sup })).data;
  const sites = new Set(p.cells.filter((c) => c.site !== 'conversion').map((c) => c.site.toUpperCase()));
  assert.ok(!sites.has('CR - JAMSHEDPUR'), 'submitted-only record is excluded');
  for (const s of ['KALINGANAGAR', 'PANTNAGAR', 'FARIDABAD']) assert.ok(sites.has(s), `${s} in ${[...sites]}`);
});

test('export refuses when nothing is approved and validates input', async (t) => {
  const db = await makeDb();
  const app = await startApp(db);
  t.after(app.close);
  const sup = await app.login('sup');
  assert.equal((await app.call('GET', `/api/reports/energy/export?fy=${FY}&quarter=Q2`, { token: sup })).status, 409);
  assert.equal((await app.call('GET', '/api/reports/energy/export?fy=bad&quarter=Q2', { token: sup })).status, 400);
});

test('a missing conversion factor is flagged and its cell left blank', async (t) => {
  const { db, call, tokens, close } = await exportFixture();
  t.after(close);
  db.exec('DELETE FROM EnergyConversionFactor WHERE ParameterID = 7');
  const preview = (await call('GET', `/api/reports/energy/preview?fy=${FY}&quarter=${Q}`, { token: tokens.sup })).data;
  assert.deepEqual(preview.missingFactors.map((m) => m.parameterId), [7]);
  assert.ok(!preview.cells.some((c) => c.sheet === 'Energy Template - Consol' && c.cell === 'J39'));
  const rec = (await call('GET', `/api/energy/plant/7/${FY}/${Q}`, { token: tokens.sup })).data;
  assert.equal(rec.conversion.complete, false);
  assert.equal(rec.entries.find((e) => e.parameterId === 7).gj, null);
});
