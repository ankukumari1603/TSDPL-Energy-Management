import test from 'node:test';
import assert from 'node:assert/strict';
import { convertLines, resolveFactor, parseFactorUom, factorStatus } from '../src/conversion.js';
import { makeDb } from './helpers.js';

const params = [
  { ParameterID: 1, Unit: 'kWh', SourceOfEnergy: 'Solar' },
  { ParameterID: 4, Unit: 'kL', SourceOfEnergy: 'Diesel' },
  { ParameterID: 5, Unit: 'kg', SourceOfEnergy: 'LPG' },
];
const f = (id, v, uom, cat) => ({ ParameterID: id, ConversionFactor: v, ConversionUOM: uom, SourceName: 'BRSR', EnergyCategory: cat });

test('parses factor UOM', () => {
  assert.deepEqual(parseFactorUom('GJ/kWh'), { energyUnit: 'gj', perUnit: 'kwh' });
  assert.equal(parseFactorUom('GJ'), null);
});

test('converts with verified factors and totals by category', () => {
  const r = convertLines(
    [{ ParameterID: 1, ConsumptionValue: 1000 }, { ParameterID: 4, ConsumptionValue: 2 }],
    params,
    [f(1, 0.0036, 'GJ/kWh', 'Renewable'), f(4, 38.6, 'GJ/kL', 'NonRenewable')],
  );
  assert.equal(r.complete, true);
  assert.equal(r.lines[0].gj, 3.6);
  assert.equal(r.lines[1].gj, 77.2);
  assert.deepEqual(r.totals, { Renewable: 3.6, NonRenewable: 77.2, total: 80.8 });
});

test('missing factor is reported, never defaulted', () => {
  const r = convertLines([{ ParameterID: 5, ConsumptionValue: 10 }], params, []);
  assert.equal(r.complete, false);
  assert.equal(r.lines[0].gj, null);
  assert.equal(r.totals.total, 0);
  assert.match(r.missing[0].problem, /No conversion factor/);
});

test('rejects factors with mismatched or non-GJ units, or invalid values', () => {
  assert.equal(resolveFactor(params[0], f(1, 0.0036, 'GJ/kg', 'Renewable')).ok, false);
  assert.equal(resolveFactor(params[0], f(1, 3.6, 'MJ/kWh', 'Renewable')).ok, false);
  assert.equal(resolveFactor(params[0], f(1, 0, 'GJ/kWh', 'Renewable')).ok, false);
  assert.equal(resolveFactor(params[0], f(1, 0.0036, 'GJ/kWh', 'Renewable')).ok, true);
});

test('unknown category is not silently counted', () => {
  const r = convertLines([{ ParameterID: 1, ConsumptionValue: 1 }], params, [f(1, 1, 'GJ/kWh', 'Mystery')]);
  assert.equal(r.complete, false);
  assert.equal(r.totals.total, 0);
});

test('supplied workbook factors are all usable with ParameterMaster units', async () => {
  const db = await makeDb();
  const status = factorStatus(db.prepare('SELECT * FROM ParameterMaster').all(), db.prepare('SELECT * FROM EnergyConversionFactor').all());
  assert.equal(status.length, 10);
  assert.deepEqual(status.filter((s) => !s.ok), []);
});
