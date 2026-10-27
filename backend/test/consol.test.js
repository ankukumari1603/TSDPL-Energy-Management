import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, startApp, fullEntries, forwardAndApprove, PLANT_PARAMS, OFFICE_PARAMS } from './helpers.js';
import { loadEvaluator } from './evalWorkbook.js';

const FY = 'FY26-27';
const Q = 'Q1';
const CONSOL = 'Energy Template - Consol';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

async function fixture() {
  const db = await makeDb();
  const app = await startApp(db);
  const admin = await app.login('admin');
  const sup = await app.login('sup');
  const approver = await app.login('admin2');
  try {
    const approve = async (kind, id, params, base) => {
      const p = `/api/energy/${kind}/${id}/${FY}/${Q}`;
      assert.equal((await app.call('POST', p + '/submit', { token: admin, body: { entries: fullEntries(params, base) } })).status, 200);
      assert.equal((await forwardAndApprove(app.call, sup, approver, p)).status, 200);
    };
    await approve('plant', 7, PLANT_PARAMS, 10); // Kalinganagar
    await approve('plant', 6, PLANT_PARAMS, 100); // Pantnagar
    await approve('plant', 10, PLANT_PARAMS, 1000); // Faridabad: approved but no export mapping
    await approve('office', 6, OFFICE_PARAMS, 50);
    // CR Jamshedpur: submitted only
    await app.call('POST', `/api/energy/plant/1/${FY}/${Q}/submit`, { token: admin, body: { entries: fullEntries(PLANT_PARAMS, 5000) } });
    const res = await app.call('GET', `/api/reports/energy/export?fy=${FY}&quarter=${Q}`, { token: sup });
    assert.equal(res.status, 200);
    return { db, ev: await loadEvaluator(Buffer.from(res.data)), ...app };
  } catch (e) {
    app.close();
    throw e;
  }
}

test('Consol report combines approved, mapped plants and offices; excludes the rest', async (t) => {
  const { db, ev, close } = await fixture();
  t.after(close);

  // independent expectation straight from the database: approved + export-mapped plants only
  const mappedPlants = db.prepare("SELECT DISTINCT PlantID FROM EnergyExportCellMapping WHERE MappingType = 'PLANT_CONSUMPTION'").all().map((r) => r.PlantID);
  assert.ok(mappedPlants.includes(10), 'Faridabad is mapped (verified against the template)');
  const plantSum = (pid) =>
    db
      .prepare(`SELECT SUM(ConsumptionValue) AS s FROM EnergyConsumption WHERE FinancialYear=? AND QuarterCode=? AND StatusID=3 AND ParameterID=? AND PlantID IN (${mappedPlants.join(',')})`)
      .get(FY, Q, pid).s ?? 0;
  const officeVal = (pid) =>
    db.prepare('SELECT SUM(ConsumptionValue) AS s FROM OfficeEnergyConsumption WHERE FinancialYear=? AND QuarterCode=? AND StatusID=3 AND ParameterID=?').get(FY, Q, pid).s ?? 0;

  // Table 3: row 32+parameterId
  for (const pid of PLANT_PARAMS) {
    const row = 32 + pid;
    near(ev.get(CONSOL, `D${row}`), plantSum(pid), `plants total row ${row}`);
  }
  assert.equal(ev.get(CONSOL, 'D33'), 10 + 100 + 1000); // CR (5000) is submitted only, so excluded

  // Offices flow in through the Offices sheet totals; Consol links exist for parameters 1,3,4,6,10
  for (const pid of [1, 3, 4, 6, 10]) near(ev.get(CONSOL, `F${32 + pid}`), officeVal(pid), `office row ${32 + pid}`);
  for (const pid of PLANT_PARAMS) {
    const row = 32 + pid;
    const sum = ['D', 'E', 'F', 'G'].reduce((s, c) => s + ev.get(CONSOL, `${c}${row}`), 0);
    near(ev.get(CONSOL, `H${row}`), sum, `H${row}`);
    near(ev.get(CONSOL, `M${row}`), ev.get(CONSOL, `H${row}`) * ev.get(CONSOL, `J${row}`), `M${row} = H*J`);
  }

  // Factors in column J are the verified database factors, not hard-coded numbers
  const factors = db.prepare('SELECT ParameterID, ConversionFactor FROM EnergyConversionFactor').all();
  for (const f of factors) {
    if (f.ParameterID >= 1 && f.ParameterID <= 10) near(ev.get(CONSOL, `J${32 + f.ParameterID}`), f.ConversionFactor, `factor ${f.ParameterID}`);
  }

  // Summary block
  const m = (r) => ev.get(CONSOL, `M${r}`);
  near(ev.get(CONSOL, 'G7'), m(33), 'G7');
  near(ev.get(CONSOL, 'G8'), m(34), 'G8');
  near(ev.get(CONSOL, 'G10'), ev.get(CONSOL, 'G7') + ev.get(CONSOL, 'G8') + ev.get(CONSOL, 'G9'), 'G10');
  near(ev.get(CONSOL, 'G13'), m(36) + m(37) + m(38) + m(39), 'G13');
  near(ev.get(CONSOL, 'G16'), ev.get(CONSOL, 'G10') + ev.get(CONSOL, 'G15'), 'G16');
  near(ev.get(CONSOL, 'D25'), (ev.get(CONSOL, 'D23') / ev.get(CONSOL, 'D24')) * 100, 'D25 %');
});

test('Consol: per-plant source cells are linked to the right plant sheets', async (t) => {
  const { ev, close } = await fixture();
  t.after(close);
  // column order in the Consol sheet: CR, Bara, Demag, Chennai, Faridabad, Pune, Kalinganagar, Pantnagar, Tada, Sanand
  assert.equal(ev.get(CONSOL, 'K49'), 10); // Kalinganagar
  assert.equal(ev.get(CONSOL, 'L49'), 100); // Pantnagar
  assert.equal(ev.get(CONSOL, 'I49'), 1000); // Faridabad
  for (const c of ['E', 'F', 'G', 'H', 'J', 'M', 'N']) assert.equal(ev.get(CONSOL, `${c}49`), 0, `${c}49 must stay empty`);
});

test('KNOWN TEMPLATE GAP: office LPG is not linked into Consol (O53 is a constant 0)', async (t) => {
  const { db, ev, close } = await fixture();
  t.after(close);
  const lpg = db.prepare('SELECT ConsumptionValue FROM OfficeEnergyConsumption WHERE LocationID = 6 AND ParameterID = 5 AND FinancialYear=? AND QuarterCode=?').get(FY, Q);
  assert.equal(lpg.ConsumptionValue, 53);
  assert.equal(ev.get('Offices, Stockyard&Guest House', 'Q11'), 53);
  assert.equal(ev.get(CONSOL, 'F37'), 0, 'the template does not carry office LPG into Consol; documented, template left unchanged');
});
