import { useEffect, useState } from 'react';
import { api } from './api.js';
import { validateAll } from './validation.js';
import History from './History.jsx';
import Documents from './Documents.jsx';

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 4 }));

export default function EntryForm({ site, fy, quarter, canEnter, canReview, canRequestUnlock }) {
  const [rec, setRec] = useState(null);
  const [unlockReason, setUnlockReason] = useState('');
  const [showUnlock, setShowUnlock] = useState(false);
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const load = (r) => {
    setRec(r);
    setValues(Object.fromEntries(r.entries.map((e) => [e.parameterId, e.value ?? ''])));
    setErrors({});
  };

  useEffect(() => {
    api.record(site, fy, quarter).then(load).catch((e) => setMessage({ type: 'error', text: e.message }));
  }, [site, fy, quarter]);

  if (!rec) return <p className="muted">{message ? message.text : 'Loading…'}</p>;

  const editable = canEnter && rec.editable;
  const toEntries = () => Object.entries(values).map(([parameterId, value]) => ({ parameterId: Number(parameterId), value }));

  const run = async (fn, submit, okText) => {
    const errs = validateAll(values, { submit });
    setErrors(errs);
    if (Object.keys(errs).length) return setMessage({ type: 'error', text: 'Please correct the highlighted values.' });
    setBusy(true);
    setMessage(null);
    try {
      load(await fn(site, fy, quarter, toEntries()));
      setMessage({ type: 'ok', text: okText });
    } catch (e) {
      if (e.details?.length) setErrors(Object.fromEntries(e.details.filter((d) => d.parameterId).map((d) => [d.parameterId, d.error])));
      setMessage({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const review = async (decision) => {
    setBusy(true);
    setMessage(null);
    try {
      load(await api.review(site, fy, quarter, decision, reason));
      setReason('');
      setMessage({ type: 'ok', text: { approve: 'Record approved.', reject: 'Record rejected.', return: 'Record returned to the user.' }[decision] });
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const requestUnlock = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.requestUnlock(site, fy, quarter, unlockReason);
      load(await api.record(site, fy, quarter));
      setUnlockReason('');
      setShowUnlock(false);
      setMessage({ type: 'ok', text: 'Unlock request sent to the administrators.' });
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const locked = !rec.editable && [2, 3].includes(rec.status) && rec.statusName !== 'Rejected';
  const { totals, missing } = rec.conversion;
  return (
    <div>
      <h2>{site.name} <span className={`badge s-${(rec.statusName || '').toLowerCase().replace(' ', '-')}`}>{rec.statusName}</span></h2>
      {['Rejected', 'Returned'].includes(rec.statusName) && rec.rejectionReason && <p className="error">{rec.statusName}: {rec.rejectionReason}</p>}
      <table>
        <thead><tr><th>Source of energy</th><th>Unit</th><th>Consumption ({fy} {quarter})</th><th>Energy (GJ)</th></tr></thead>
        <tbody>
          {rec.entries.map((e) => (
            <tr key={e.parameterId}>
              <td>{e.sourceOfEnergy}<div className="muted small">{e.parameterName}</div></td>
              <td>{e.unit}</td>
              <td>
                <input
                  inputMode="decimal"
                  value={values[e.parameterId] ?? ''}
                  disabled={!editable || busy}
                  aria-invalid={!!errors[e.parameterId]}
                  aria-label={`${e.sourceOfEnergy} (${e.unit})`}
                  onChange={(ev) => setValues({ ...values, [e.parameterId]: ev.target.value })}
                />
                {errors[e.parameterId] && <div className="error small">{errors[e.parameterId]}</div>}
              </td>
              <td className="num">{fmt(e.gj)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan="3">Renewable (GJ)</td><td className="num">{fmt(totals.Renewable)}</td></tr>
          <tr><td colSpan="3">Non-renewable (GJ)</td><td className="num">{fmt(totals.NonRenewable)}</td></tr>
          <tr><td colSpan="3"><b>Total (GJ)</b></td><td className="num"><b>{fmt(totals.total)}</b></td></tr>
        </tfoot>
      </table>
      {missing.length > 0 && (
        <div className="warn" role="alert">
          Totals are incomplete. No usable conversion factor for:
          <ul>{missing.map((m) => <li key={m.parameterId}>{m.source}: {m.problem}</li>)}</ul>
        </div>
      )}
      {message && <p className={message.type === 'ok' ? 'ok' : 'error'} role="status">{message.text}</p>}
      {editable && (
        <div className="actions">
          <button disabled={busy} onClick={() => run(api.save, false, 'Draft saved.')}>Save draft</button>
          <button className="primary" disabled={busy} onClick={() => run(api.submit, true, 'Submitted for review.')}>Submit</button>
        </div>
      )}
      {rec.stageName && <p className="muted" role="status">{rec.stageName}.</p>}
      {canReview && rec.stage && (
        <div className="actions">
          <input placeholder="Comment (required to reject or return)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <button className="primary" disabled={busy} onClick={() => review('approve')}>Approve</button>
          <button disabled={busy || !reason.trim()} onClick={() => review('reject')}>Reject</button>
          <button disabled={busy || !reason.trim()} onClick={() => review('return')}>Return for correction</button>
        </div>
      )}
      {rec.pendingUnlock && <p className="warn" role="status">Unlock requested on {rec.pendingUnlock.createdOn} UTC: “{rec.pendingUnlock.reason}”. Awaiting administrator decision.</p>}
      {canRequestUnlock && locked && !rec.pendingUnlock && (
        <div className="actions">
          {!showUnlock ? <button onClick={() => setShowUnlock(true)}>Request unlock</button> : (
            <>
              <input placeholder="Reason for unlocking (required)" value={unlockReason} maxLength={500} onChange={(e) => setUnlockReason(e.target.value)} />
              <button className="primary" disabled={busy || !unlockReason.trim()} onClick={requestUnlock}>Send request</button>
              <button disabled={busy} onClick={() => setShowUnlock(false)}>Cancel</button>
            </>
          )}
        </div>
      )}
      {rec.submittedOn && <p className="muted small">Submitted by user {rec.submittedBy} on {rec.submittedOn} (UTC)</p>}
      <Documents site={site} fy={fy} quarter={quarter} canEdit={editable} />
      <details>
        <summary>Workflow history</summary>
        <History site={site} fy={fy} quarter={quarter} version={`${rec.status}|${rec.pendingUnlock?.id ?? ''}`} />
      </details>
    </div>
  );
}
