import test from 'node:test';
import assert from 'node:assert/strict';
import { validateValue, validateEntries, validateFinancialYear, validateQuarter } from '../src/validation.js';

test('financial year format', () => {
  assert.equal(validateFinancialYear('FY26-27'), null);
  assert.equal(validateFinancialYear('FY99-00'), null);
  for (const bad of ['FY26-28', '2026-27', 'FY2627', '', undefined]) assert.ok(validateFinancialYear(bad), String(bad));
});

test('quarter codes', () => {
  assert.equal(validateQuarter('Q4'), null);
  assert.ok(validateQuarter('Q5'));
  assert.ok(validateQuarter('q1'));
});

test('value validation', () => {
  assert.deepEqual(validateValue('12.5'), { ok: true, value: 12.5 });
  assert.deepEqual(validateValue(0), { ok: true, value: 0 });
  assert.deepEqual(validateValue('1.2300'), { ok: true, value: 1.23 });
  for (const bad of ['-1', 'abc', '1e5', '1,000', '0.12345', '999999999999999', NaN, Infinity, '']) {
    assert.equal(validateValue(bad).ok, false, String(bad));
  }
  assert.deepEqual(validateValue('', { allowBlank: true }), { ok: true, value: null });
});

test('entries: unknown, duplicate and missing parameters', () => {
  const allowed = [1, 3];
  let r = validateEntries([{ parameterId: 1, value: 5 }, { parameterId: 1, value: 6 }, { parameterId: 99, value: 1 }], allowed, { submit: false });
  assert.equal(r.errors.length, 2);
  r = validateEntries([{ parameterId: 1, value: 5 }], allowed, { submit: true });
  assert.deepEqual(r.errors.map((e) => e.parameterId), [3]);
  r = validateEntries([{ parameterId: 1, value: 5 }, { parameterId: 3, value: '' }], allowed, { submit: false });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.clean, [{ parameterId: 1, value: 5 }]);
});
