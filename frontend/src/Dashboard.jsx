import { useEffect, useState } from 'react';
import { api } from './api.js';

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const STATUS_ORDER = ['Not started', 'Draft', 'Submitted', 'Returned', 'Rejected', 'Approved'];

export default function Dashboard({ fy, sites }) {
  const [period, setPeriod] = useState('ALL');
  const [site, setSite] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    setError('');
    api.dashboard(fy, period, site).then(setData).catch((e) => setError(e.message));
  }, [fy, period, site]);

  const s = data?.summary;
  return (
    <div>
      <section className="selectors">
        <label>Reporting period
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="ALL">Full year</option>
            {['Q1', 'Q2', 'Q3', 'Q4'].map((q) => <option key={q}>{q}</option>)}
          </select>
        </label>
        <label>Location
          <select value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">All my locations</option>
            {sites.map((x) => <option key={`${x.kind}:${x.id}`} value={`${x.kind}:${x.id}`}>{x.name}</option>)}
          </select>
        </label>
      </section>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {s && (
        <>
          <p className="muted small">Energy totals count approved records only ({fy}, {period === 'ALL' ? 'full year' : period}).</p>
          <div className="cards">
            <div className="card"><div className="muted small">Total energy (GJ)</div><b>{fmt(s.approved.total)}</b></div>
            <div className="card"><div className="muted small">Renewable (GJ)</div><b>{fmt(s.approved.renewable)}</b></div>
            <div className="card"><div className="muted small">Non-renewable (GJ)</div><b>{fmt(s.approved.nonRenewable)}</b></div>
            <div className="card"><div className="muted small">Renewable share</div><b>{s.renewableSharePct === null ? 'n/a' : `${fmt(s.renewableSharePct)} %`}</b></div>
            <div className="card"><div className="muted small">Awaiting review</div><b>{s.awaitingReview}</b></div>
            <div className="card"><div className="muted small">Pending submission</div><b>{s.pendingSubmission}</b></div>
          </div>
          {s.incomplete && (
            <div className="warn" role="alert">
              Totals are incomplete. No usable conversion factor for:
              <ul>{s.missingFactors.map((m) => <li key={m.parameterId}>{m.source}: {m.problem}</li>)}</ul>
            </div>
          )}
          <h3>Approval status (location × period)</h3>
          <p>{STATUS_ORDER.map((k) => <span key={k} className="chip">{k}: {s.statusCounts[k]}</span>)}</p>
          <h3>Location-wise (approved GJ)</h3>
          <table>
            <thead><tr><th>Location</th><th>Renewable</th><th>Non-renewable</th><th>Total</th><th>Status by period</th></tr></thead>
            <tbody>
              {data.locations.map((l) => (
                <tr key={`${l.site.kind}:${l.site.id}`}>
                  <td>{l.site.name}</td>
                  <td className="num">{fmt(l.approved.renewable)}</td>
                  <td className="num">{fmt(l.approved.nonRenewable)}</td>
                  <td className="num">{fmt(l.approved.total)}</td>
                  <td>{l.periods.map((p) => <span key={p.quarter} className={`badge s-${p.statusName.toLowerCase().replace(' ', '-')}`} title={p.statusName}>{p.quarter}: {p.statusName}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.bySource.length > 0 && (
            <>
              <h3>By energy source (approved GJ)</h3>
              <table>
                <thead><tr><th>Source</th><th>GJ</th></tr></thead>
                <tbody>{data.bySource.map((b) => <tr key={b.source}><td>{b.source}</td><td className="num">{fmt(b.gj)}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
