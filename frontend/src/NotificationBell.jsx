import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const POLL_MS = 30000;

export default function NotificationBell({ onOpenUnlock }) {
  const [data, setData] = useState({ unread: 0, notifications: [] });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  const box = useRef(null);

  const refresh = useCallback(() => api.notifications().then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const act = (fn) => fn().then(setData).catch((e) => setError(e.message));

  return (
    <div className="bell" ref={box}>
      <button className="link" aria-label={`Notifications, ${data.unread} unread`} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) refresh(); }}>
        🔔{data.unread > 0 && <span className="count">{data.unread}</span>}
      </button>
      {open && (
        <div className="panel" role="dialog" aria-label="Notifications">
          <div className="panel-head">
            <b>Notifications</b>
            <span>
              <button className="link" disabled={!data.unread} onClick={() => act(api.markAllRead)}>Mark all read</button>
              <button className="link" disabled={!data.notifications.length} onClick={() => act(api.clearNotifications)}>Clear</button>
            </span>
          </div>
          {error && <p className="error small">{error}</p>}
          {data.notifications.length === 0 && <p className="muted small pad">No notifications.</p>}
          <ul>
            {data.notifications.map((n) => (
              <li key={n.id} className={n.read ? 'read' : 'unread'}>
                <button
                  className="note"
                  onClick={() => {
                    if (!n.read) act(() => api.markRead(n.id));
                    if (n.unlockRequestId && onOpenUnlock) { setOpen(false); onOpenUnlock(); }
                  }}
                >
                  <span>{n.message}</span>
                  <span className="muted small">{n.eventOn} UTC</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
