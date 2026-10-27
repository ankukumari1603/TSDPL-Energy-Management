import { useEffect, useState } from 'react';
import { api } from './api.js';

const LABEL = {
  Submitted: 'Submitted',
  Forwarded: 'Reviewed and forwarded to Admin',
  Approved: 'Approved',
  Rejected: 'Rejected',
  Returned: 'Returned for correction',
  UnlockRequested: 'Unlock requested',
  UnlockApproved: 'Unlock approved',
  UnlockRejected: 'Unlock rejected',
};

export default function History({ site, fy, quarter, version }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.history(site, fy, quarter).then((r) => setRows(r.history)).catch((e) => setError(e.message));
  }, [site, fy, quarter, version]);

  if (error) return <p className="error small">{error}</p>;
  if (!rows) return <p className="muted small">Loading history…</p>;
  if (rows.length === 0) return <p className="muted small">No workflow history yet.</p>;
  return (
    <table className="history">
      <thead><tr><th>When (UTC)</th><th>Action</th><th>By</th><th>Comment</th></tr></thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h.id ?? `${h.createdOn}-${h.action}`}>
            <td>{h.at}</td>
            <td>{LABEL[h.action] ?? h.action}</td>
            <td>{h.by} ({h.role})</td>
            <td style={{ whiteSpace: 'pre-wrap' }}>{h.comment ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
