import { useEffect, useState } from 'react';
import { api } from './api.js';

export default function ReviewQueue({ fy, quarter, canEnter, onOpen }) {
  const [records, setRecords] = useState(null);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setRecords(null);
    setPending(null);
    setError('');
    api.records(fy, quarter).then((r) => setRecords(r.records)).catch((e) => setError(e.message));
    api.pendingReview(fy).then((r) => setPending(r.pending)).catch((e) => setError(e.message));
  }, [fy, quarter]);

  if (error) return <p className="error">{error}</p>;
  if (!records || !pending) return <p className="muted">Loading…</p>;
  return (
    <div>
      <h2>Waiting for your action ({fy})</h2>
      {pending.length === 0 ? <p className="muted">No submitted records are waiting for you in {fy}.</p> : (
        <table>
          <thead><tr><th>Location</th><th>Quarter</th><th>Stage</th><th>Submitted</th><th /></tr></thead>
          <tbody>
            {pending.map((p) => (
              <tr key={`${p.site.kind}:${p.site.id}:${p.quarter}`}>
                <td>{p.site.name}</td>
                <td>{p.quarter}</td>
                <td>{p.stage === 'AwaitingAdmin' ? 'Previously escalated (awaiting decision)' : 'Awaiting review'}</td>
                <td>{p.submittedOn ? `${p.submittedOn} UTC` : ''}</td>
                <td><button className="link" onClick={() => onOpen(p.site, fy, p.quarter)}>Review</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>All locations ({fy} {quarter})</h2>
      <table>
        <thead><tr><th>Location</th><th>Type</th><th>Status ({fy} {quarter})</th><th /></tr></thead>
        <tbody>
          {records.map((r) => (
            <tr key={`${r.site.kind}:${r.site.id}`}>
              <td>{r.site.name}</td>
              <td>{r.site.kind === 'plant' ? 'Plant' : r.site.type}</td>
              <td>
                <span className={`badge s-${r.statusName.toLowerCase().replace(' ', '-')}`}>{r.statusName}</span>
                {r.stage === 'AwaitingSupervisor' && <div className="muted small">Awaiting supervisor</div>}
                {r.stage === 'AwaitingAdmin' && <div className="muted small">Previously escalated (awaiting decision)</div>}
              </td>
              <td>
                {r.status || canEnter
                  ? <button className="link" onClick={() => onOpen(r.site, fy, quarter)}>{r.stage ? 'Review' : 'Open'}</button>
                  : <span className="muted small">No submission for this quarter</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
