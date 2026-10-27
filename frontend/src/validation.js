// Client-side mirror of the server rules, for immediate feedback only. The server is authoritative.
export function validateValue(raw, { allowBlank }) {
  const s = String(raw ?? '').trim();
  if (s === '') return allowBlank ? null : 'Required (enter 0 if none).';
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 'Must be a plain number.';
  if (Number(s) < 0) return 'Must not be negative.';
  if (Number(s) > 99999999999999) return 'Value is too large.';
  const dec = s.split('.')[1];
  if (dec && dec.replace(/0+$/, '').length > 4) return 'At most 4 decimal places.';
  return null;
}

export function validateAll(values, { submit }) {
  const errors = {};
  for (const [id, v] of Object.entries(values)) {
    const e = validateValue(v, { allowBlank: !submit });
    if (e) errors[id] = e;
  }
  return errors;
}

/** Current Indian financial year, e.g. FY26-27 for Oct 2026. */
export function currentFinancialYear(date = new Date()) {
  const y = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `FY${String(y).slice(2)}-${String(y + 1).slice(2)}`;
}

export function financialYearOptions(date = new Date()) {
  const cur = Number(currentFinancialYear(date).slice(2, 4));
  return [cur - 1, cur, cur + 1].map((a) => `FY${String(a).padStart(2, '0')}-${String((a + 1) % 100).padStart(2, '0')}`);
}

export function validateNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Password must be at least 12 characters.';
  if (new TextEncoder().encode(pw).length > 72) return 'Password must be at most 72 bytes.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain upper-case, lower-case and a digit.';
  return null;
}
