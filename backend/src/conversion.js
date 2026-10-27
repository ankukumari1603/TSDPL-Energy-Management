// Conversion uses only EnergyConversionFactor rows. Nothing is defaulted or guessed.

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** "GJ/kWh" -> { energyUnit: 'gj', perUnit: 'kwh' } */
export function parseFactorUom(uom) {
  const m = /^\s*([A-Za-z]+)\s*\/\s*([A-Za-z]+)\s*$/.exec(uom ?? '');
  return m ? { energyUnit: norm(m[1]), perUnit: norm(m[2]) } : null;
}

/**
 * Returns the usable factor for a parameter, or a problem describing why none is usable.
 * A factor is only usable if it exists, is positive, is expressed in GJ and its per-unit
 * matches the parameter's unit.
 */
export function resolveFactor(parameter, factorRow) {
  if (!factorRow) return { ok: false, problem: 'No conversion factor defined.' };
  const f = Number(factorRow.ConversionFactor);
  if (!Number.isFinite(f) || f <= 0) return { ok: false, problem: 'Conversion factor is not a positive number.' };
  const uom = parseFactorUom(factorRow.ConversionUOM);
  if (!uom || uom.energyUnit !== 'gj') {
    return { ok: false, problem: `Conversion UOM "${factorRow.ConversionUOM}" is not GJ per unit.` };
  }
  if (uom.perUnit !== norm(parameter.Unit)) {
    return {
      ok: false,
      problem: `Factor is per ${uom.perUnit} but the parameter unit is ${parameter.Unit}.`,
    };
  }
  return {
    ok: true,
    factor: f,
    uom: factorRow.ConversionUOM,
    source: factorRow.SourceName,
    category: factorRow.EnergyCategory,
  };
}

const round = (n, dp = 6) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * lines: [{ParameterID, ConsumptionValue}] ; returns per-line GJ (null when factor missing),
 * totals by category, and the list of missing/unusable factors.
 */
export function convertLines(lines, parameters, factors) {
  const pById = new Map(parameters.map((p) => [p.ParameterID, p]));
  const fById = new Map(factors.map((f) => [f.ParameterID, f]));
  const out = [];
  const missing = [];
  const totals = { Renewable: 0, NonRenewable: 0, total: 0 };
  for (const l of lines) {
    const p = pById.get(l.ParameterID);
    const r = resolveFactor(p, fById.get(l.ParameterID));
    if (!r.ok) {
      missing.push({ parameterId: l.ParameterID, source: p?.SourceOfEnergy, problem: r.problem });
      out.push({ ...l, sourceOfEnergy: p?.SourceOfEnergy, unit: p?.Unit, gj: null });
      continue;
    }
    const gj = round(Number(l.ConsumptionValue) * r.factor);
    if (totals[r.category] === undefined) {
      missing.push({ parameterId: l.ParameterID, source: p.SourceOfEnergy, problem: `Unknown energy category "${r.category}".` });
      out.push({ ...l, sourceOfEnergy: p.SourceOfEnergy, unit: p.Unit, gj: null });
      continue;
    }
    totals[r.category] = round(totals[r.category] + gj);
    totals.total = round(totals.total + gj);
    out.push({
      ...l,
      sourceOfEnergy: p.SourceOfEnergy,
      unit: p.Unit,
      factor: r.factor,
      factorUom: r.uom,
      category: r.category,
      gj,
    });
  }
  return { lines: out, totals, missing, complete: missing.length === 0 };
}

/** Factors for the whole parameter list, flagged when unusable (used by the report). */
export function factorStatus(parameters, factors) {
  const fById = new Map(factors.map((f) => [f.ParameterID, f]));
  return parameters.map((p) => {
    const r = resolveFactor(p, fById.get(p.ParameterID));
    return { parameterId: p.ParameterID, source: p.SourceOfEnergy, unit: p.Unit, ...r };
  });
}
