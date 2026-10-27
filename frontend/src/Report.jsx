import { useEffect, useState } from 'react';
import { api } from './api.js';
import { saveXlsx } from './download.js';

export default function Report({ fy, quarter }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPlan(null);
    setError('');
    api.preview(fy, quarter).then(setPlan).catch((e) => setError(e.message));
  }, [fy, quarter]);

  const download = async () => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      const res = await api.exportReport(fy, quarter);
      const name = await saveXlsx(res, `TSDPL-Energy-${fy}-${quarter}.xlsx`);
      setDone(`Downloaded ${name}. Check your browser's Downloads folder.`);
    } catch (e) {
      setError(`Download failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (error && !plan) return <p className="error">{error}</p>;
  if (!plan) return <p className="muted">Loading…</p>;
  const dataCells = plan.cells.filter((c) => c.site !== 'conversion').length;
  const groups = [
    ['missingData', 'Missing data'],
    ['awaitingApproval', 'Data awaiting approval'],
    ['missingMapping', 'Missing Excel cell mappings'],
    ['companyConfirmation', 'Items requiring company confirmation'],
  ];
  const noEntries = plan.noEntries || [];
  return (
    <div>
      <h3 data-testid="report-period">Reporting period: {plan.period?.financialYear || fy}, {plan.period?.quarter || quarter}</h3>
      <p>Only <b>approved</b> records are written into a copy of the original template. {dataCells} data cells and {plan.cells.length - dataCells} conversion-factor cells will be filled.</p>
      {groups.map(([key, title]) => {
        const items = plan.warnings.filter((w) => w.category === key);
        return items.length > 0 && (
          <div className="warn" key={key}>
            <b>{title}</b>
            <ul>{items.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
          </div>
        );
      })}
      {noEntries.length > 0 && (
        <p className="muted">No entries for this period (not an error): {noEntries.join(', ')}.</p>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="muted" role="status">{done}</p>}
      {dataCells === 0 && <p className="muted">Download is unavailable: there are no approved, mapped records for this period yet.</p>}
      <button className="primary" disabled={busy || dataCells === 0} onClick={download}>{busy ? 'Preparing Excel file…' : 'Download Excel report'}</button>
    </div>
  );
}
