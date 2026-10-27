import { describe, it, expect } from 'vitest';
import { validateValue, validateAll, currentFinancialYear, financialYearOptions, validateNewPassword } from './validation.js';

describe('client validation', () => {
  it('accepts numbers and zero', () => {
    expect(validateValue('0', { allowBlank: false })).toBeNull();
    expect(validateValue('12.5', { allowBlank: false })).toBeNull();
  });
  it('rejects bad input', () => {
    for (const v of ['-1', 'abc', '1e3', '0.12345', '']) expect(validateValue(v, { allowBlank: false })).not.toBeNull();
  });
  it('allows blanks for drafts only', () => {
    expect(validateValue('', { allowBlank: true })).toBeNull();
    expect(validateAll({ 1: '', 2: '3' }, { submit: true })).toEqual({ 1: 'Required (enter 0 if none).' });
    expect(validateAll({ 1: '', 2: '3' }, { submit: false })).toEqual({});
  });
  it('computes financial years', () => {
    expect(currentFinancialYear(new Date(2026, 9, 23))).toBe('FY26-27');
    expect(currentFinancialYear(new Date(2026, 1, 1))).toBe('FY25-26');
    expect(financialYearOptions(new Date(2026, 9, 23))).toEqual(['FY25-26', 'FY26-27', 'FY27-28']);
  });
});

describe('validateNewPassword', () => {
  it('enforces the password policy', () => {
    expect(validateNewPassword('Ab1-short')).toMatch(/12 characters/);
    expect(validateNewPassword('alllowercase-123')).toMatch(/upper-case/);
    expect(validateNewPassword('ALLUPPERCASE-123')).toMatch(/lower-case/);
    expect(validateNewPassword('No-Digits-Here-Abc')).toMatch(/digit/);
    expect(validateNewPassword('Another-Strong-Pass-9')).toBeNull();
  });
});
