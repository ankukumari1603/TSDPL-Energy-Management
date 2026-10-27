import { useEffect, useState } from 'react';
import { api } from './api.js';

const ALLOWED = ['.pdf', '.png', '.jpg', '.jpeg', '.xlsx', '.csv'];
const MAX_BYTES = 10 * 1024 * 1024;
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function Documents({ site, fy, quarter, canEdit }) {
  const [docs, setDocs] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.documents(site, fy, quarter).then((r) => setDocs(r.documents)).catch((e) => setMsg(e.message));
  }, [site, fy, quarter, canEdit]);

  const upload = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED.includes(ext)) return setMsg('Unsupported file type. Allowed: PDF, PNG, JPG, XLSX, CSV.');
    if (file.size > MAX_BYTES) return setMsg('File is larger than 10 MB.');
    setBusy(true);
    setMsg(null);
    try {
      setDocs((await api.uploadDocument(site, fy, quarter, file)).documents);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    setBusy(true);
    setMsg(null);
    try {
      setDocs((await api.deleteDocument(site, fy, quarter, id)).documents);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const download = async (d) => {
    try {
      const res = await api.downloadDocument(site, fy, quarter, d.id);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = d.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <div>
      <h3>Supporting documents</h3>
      {docs.length === 0 && <p className="muted small">No documents attached.</p>}
      <ul>
        {docs.map((d) => (
          <li key={d.id}>
            <button className="link" onClick={() => download(d)}>{d.name}</button>{' '}
            <span className="muted small">{size(d.size)} · {d.uploadedBy} · {d.uploadedOn} UTC</span>{' '}
            {canEdit && <button className="link" disabled={busy} onClick={() => remove(d.id)}>Remove</button>}
          </li>
        ))}
      </ul>
      {canEdit && (
        <label>
          Attach file (PDF, PNG, JPG, XLSX, CSV; max 10 MB; up to 10 files){' '}
          <input type="file" accept={ALLOWED.join(',')} disabled={busy} onChange={upload} />
        </label>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}
    </div>
  );
}
