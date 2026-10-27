import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export default function UnlockRequests({ isAdmin, onOpen }) {
  const [list, setList] = useState(null);
  const loadSeq = useRef(0);
  const [filter, setFilter] = useState('Pending');
  const [reasons, setReasons] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState(null);

  const load = async (status = filter) => {
    const seq = ++loadSeq.current;
    try {
      const r = await api.unlockRequests(status || undefined);
      if (seq === loadSeq.current) setList(r.requests);
    } catch (e) {
      if (seq === loadSeq.current) setMessage({ type: 'error', text: e.message });
    }
  };
  useEffect(() => { setList(null); load(filter); }, [filter]);

  const decide = async (id, decision) => {
    setBusyId(id);
    setMessage(null);
    try {
      await api.reviewUnlock(id, decision, reasons[id] ?? '');
      setReasons(({ [id]: _done, ...rest }) => rest);
      setMessage({ type: 'ok', text: decision === 'approve' ? 'Request approved; the record is open for editing again and must be resubmitted for review.' : 'Request rejected; the record stays locked.' });
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setBusyId(null);
    }
    await load();
  };

  return (
    <div>
      <h2>{isAdmin ? 'Unlock requests' : 'My unlock requests'}</h2>
      <p className="muted small">These are requests to reopen a locked record. A rejected request does not reject the record itself; its status is shown in “Record status”.</p>
      <label>Show
        <select value={filter} onChange={(e) => { setMessage(null); setFilter(e.target.value); }}>
          {['Pending', 'Approved', 'Rejected', ''].map((s) => <option key={s} value={s}>{s || 'All'}</option>)}
        </select>
      </label>
      {message && <p className={message.type === 'ok' ? 'ok' : 'error'} role="status">{message.text}</p>}
      {!list ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">No requests.</p> : (
        <table>
          <thead><tr><th>Location</th><th>Period</th><th>Requested by</th><th>Reason</th><th>Request status</th><th>Record status</th>{isAdmin && <th>Decision</th>}</tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td><button className="link" onClick={() => onOpen(r.site, r.financialYear, r.quarter)}>{r.site.name}</button></td>
                <td>{r.financialYear} {r.quarter}</td>
                <td>{r.requestedBy}<div className="muted small">{r.createdOn} UTC</div></td>
                <td>{r.reason}</td>
                <td>{r.status}{r.status === 'Rejected' && r.rejectionReason && <div className="muted small">{r.rejectionReason}</div>}</td>
                <td><span className={`badge s-${(r.recordStatus ?? '').toLowerCase().replace(' ', '-')}`}>{r.recordStatus}</span></td>
                {isAdmin && (
                  <td>
                    {r.status === 'Pending' ? (
                      <div className="actions">
                        <input placeholder="Reason (required to reject)" maxLength={500} value={reasons[r.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })} />
                        <button className="primary" disabled={busyId === r.id} onClick={() => decide(r.id, 'approve')}>Approve</button>
                        <button disabled={busyId === r.id || !(reasons[r.id] ?? '').trim()} onClick={() => decide(r.id, 'reject')}>Reject</button>
                      </div>
                    ) : <span className="muted small">{r.reviewedBy ?? ''}</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
