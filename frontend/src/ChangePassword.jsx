import { useState } from 'react';
import { api } from './api.js';
import { validateNewPassword } from './validation.js';

export default function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setMessage(null);
    if (!current) return setMessage({ type: 'error', text: 'Enter your current password.' });
    const policy = validateNewPassword(next);
    if (policy) return setMessage({ type: 'error', text: policy });
    if (next !== confirm) return setMessage({ type: 'error', text: 'New password and confirmation do not match.' });
    setBusy(true);
    try {
      await api.changePassword(current, next, confirm);
      setCurrent('');
      setNext('');
      setConfirm('');
      setMessage({ type: 'ok', text: 'Password changed.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="form-grid" style={{ maxWidth: 360 }}>
      <h2>Change password</h2>
      <label>Current password
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label>New password
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label>Confirm new password
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <p className="muted small">At least 12 characters with upper-case, lower-case and a digit.</p>
      {message && <p className={message.type === 'ok' ? 'ok' : 'error'} role="status">{message.text}</p>}
      <div className="actions"><button className="primary" type="submit" disabled={busy}>Change password</button></div>
    </form>
  );
}
