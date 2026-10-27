import { HttpError } from './service.js';
import { STATUS, overallStatus } from './permissions.js';
import { validateFinancialYear, validateQuarter, QUARTERS } from './validation.js';
import { convertLines } from './conversion.js';

const round = (n, dp = 6) => Math.round(n * 10 ** dp) / 10 ** dp;
const STATUS_LABEL = { 1: 'Draft', 2: 'Submitted', 3: 'Approved', 4: 'Rejected', 5: 'Returned' };
const NOT_STARTED = 'Not started';

/**
 * Dashboard figures for the sites the user may see. Headline energy totals use APPROVED records only,
 * converted with the verified factors; anything that cannot be converted is reported, never defaulted.
 */
export function createDashboard(db, service) {
  const nameOf = (s) => STATUS_LABEL[s] ?? NOT_STARTED;

  function dashboard(user, { fy, period = 'ALL', site } = {}) {
    const e = validateFinancialYear(fy);
    if (e) throw new HttpError(400, e);
    if (period !== 'ALL') {
      const pe = validateQuarter(period);
      if (pe) throw new HttpError(400, 'Period must be ALL, Q1, Q2, Q3 or Q4.');
    }
    let sites = service.listSites(user);
    if (site) {
      const m = /^(plant|office):(\d+)$/.exec(site);
      if (!m) throw new HttpError(400, 'Location filter must look like plant:7 or office:6.');
      sites = sites.filter((s) => s.kind === m[1] && s.id === Number(m[2]));
      if (sites.length === 0) throw new HttpError(403, 'You do not have access to this location.');
    }
    const quarters = period === 'ALL' ? QUARTERS : [period];
    const params = service.parameters();
    const facs = service.factors();

    const statusCounts = Object.fromEntries([...Object.values(STATUS_LABEL), NOT_STARTED].map((k) => [k, 0]));
    const bySource = new Map();
    const missing = new Map();
    const total = { renewable: 0, nonRenewable: 0, total: 0 };
    const locations = [];

    for (const s of sites) {
      const approved = { renewable: 0, nonRenewable: 0, total: 0 };
      const periods = quarters.map((q) => {
        const rows = service.rowsFor(s, fy, q);
        const status = overallStatus(rows);
        statusCounts[nameOf(status)] += 1;
        const conv = convertLines(rows.map((r) => ({ ParameterID: r.ParameterID, ConsumptionValue: r.ConsumptionValue })), params, facs);
        const gj = rows.length ? { renewable: conv.totals.Renewable, nonRenewable: conv.totals.NonRenewable, total: conv.totals.total, complete: conv.complete } : null;
        if (status === STATUS.APPROVED) {
          approved.renewable = round(approved.renewable + conv.totals.Renewable);
          approved.nonRenewable = round(approved.nonRenewable + conv.totals.NonRenewable);
          approved.total = round(approved.total + conv.totals.total);
          for (const l of conv.lines) {
            const key = l.sourceOfEnergy ?? String(l.ParameterID);
            bySource.set(key, round((bySource.get(key) ?? 0) + (l.gj ?? 0)));
          }
          for (const m of conv.missing) missing.set(m.parameterId, m);
        }
        return { quarter: q, status, statusName: nameOf(status), gj };
      });
      total.renewable = round(total.renewable + approved.renewable);
      total.nonRenewable = round(total.nonRenewable + approved.nonRenewable);
      total.total = round(total.total + approved.total);
      locations.push({ site: s, approved, periods });
    }

    const awaitingReview = statusCounts.Submitted;
    const pendingSubmission = statusCounts[NOT_STARTED] + statusCounts.Draft + statusCounts.Returned + statusCounts.Rejected;
    return {
      filters: { financialYear: fy, period, site: site ?? null },
      summary: {
        approved: total,
        renewableSharePct: total.total > 0 ? round((total.renewable / total.total) * 100, 2) : null,
        awaitingReview,
        pendingSubmission,
        statusCounts,
        incomplete: missing.size > 0,
        missingFactors: [...missing.values()],
      },
      bySource: [...bySource.entries()].map(([source, gj]) => ({ source, gj })),
      locations,
    };
  }

  return { dashboard };
}
