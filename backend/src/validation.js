export const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
export const MAX_VALUE = 99999999999999; // DECIMAL(18,4): 14 integer digits
export const MAX_DECIMALS = 4;

export function parseFinancialYear(fy) {
  const m = /^FY(\d{2})-(\d{2})$/.exec(fy ?? '');
  if (!m) return null;
  const a = Number(m[1]);
  return (a + 1) % 100 === Number(m[2]) ? { startYear: 2000 + a, endYear: 2001 + a } : null;
}

export function validateFinancialYear(fy) {
  return parseFinancialYear(fy) ? null : 'Financial year must look like FY26-27 with consecutive years.';
}

export function validateQuarter(q) {
  return QUARTERS.includes(q) ? null : `Quarter must be one of ${QUARTERS.join(', ')}.`;
}

/** Validates a single consumption value. Blank is allowed only when `allowBlank` (drafts). */
export function validateValue(raw, { allowBlank = false } = {}) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return allowBlank ? { ok: true, value: null } : { ok: false, error: 'A value is required (enter 0 if none).' };
  }
  const s = typeof raw === 'number' ? String(raw) : String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, error: 'Must be a plain number.' };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: 'Must be a finite number.' };
  if (n < 0) return { ok: false, error: 'Must not be negative.' };
  if (n > MAX_VALUE) return { ok: false, error: 'Value is too large.' };
  const dec = s.split('.')[1];
  if (dec && dec.replace(/0+$/, '').length > MAX_DECIMALS) {
    return { ok: false, error: `At most ${MAX_DECIMALS} decimal places are allowed.` };
  }
  return { ok: true, value: n };
}

/**
 * Validates a set of entries ({parameterId, value}) against the parameters allowed for the site.
 * For submission every allowed parameter must be present.
 */
export function validateEntries(entries, allowedParameterIds, { submit, units = {} }) {
  const errors = [];
  const clean = [];
  if (!Array.isArray(entries)) return { errors: [{ error: 'entries must be an array.' }], clean };
  const seen = new Set();
  for (const e of entries) {
    const pid = Number(e?.parameterId);
    if (!allowedParameterIds.includes(pid)) {
      errors.push({ parameterId: e?.parameterId, error: 'Parameter is not applicable to this location.' });
      continue;
    }
    if (seen.has(pid)) {
      errors.push({ parameterId: pid, error: 'Duplicate parameter.' });
      continue;
    }
    seen.add(pid);
    if (e.unit !== undefined && e.unit !== null && units[pid] && String(e.unit).trim().toLowerCase() !== String(units[pid]).trim().toLowerCase()) {
      errors.push({ parameterId: pid, error: `Unit must be ${units[pid]}.` });
      continue;
    }
    const r = validateValue(e.value, { allowBlank: !submit });
    if (!r.ok) errors.push({ parameterId: pid, error: r.error });
    else if (r.value !== null) clean.push({ parameterId: pid, value: r.value });
  }
  if (submit) {
    for (const pid of allowedParameterIds) {
      if (!seen.has(pid)) errors.push({ parameterId: pid, error: 'A value is required (enter 0 if none).' });
    }
  }
  return { errors, clean };
}
