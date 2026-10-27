import { useEffect, useState } from 'react';
import { api } from './api.js';

const EMPTY_USER = { userName: '', email: '', employeeCode: '', password: '', role: 'User', plantIds: [], locationIds: [] };

function Checks({ label, items, value, onChange }) {
  const toggle = (id) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <fieldset className="checks">
      <legend>{label}</legend>
      {items.map((i) => (
        <label key={i.id} className="inline">
          <input type="checkbox" checked={value.includes(i.id)} onChange={() => toggle(i.id)} /> {i.name}
        </label>
      ))}
    </fieldset>
  );
}

function Users({ roles, locations, onError }) {
  const [users, setUsers] = useState(null);
  const [form, setForm] = useState(EMPTY_USER);
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState('');
  const plants = locations.filter((l) => l.kind === 'plant');
  const offices = locations.filter((l) => l.kind === 'office');
  const load = () => api.adminUsers().then((r) => setUsers(r.users)).catch((e) => onError(e.message));
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const act = async (fn, ok) => {
    setMsg('');
    onError('');
    try {
      await fn();
      setMsg(ok);
      await load();
    } catch (e) {
      onError(e.details?.length ? `${e.message} ${e.details.map((d) => d.error ?? d).join(' ')}` : e.message);
    }
  };
  const save = () =>
    act(async () => {
      if (editing) {
        await api.adminUpdateUser(editing, { email: form.email, employeeCode: form.employeeCode, role: form.role, plantIds: form.plantIds, locationIds: form.locationIds });
        if (form.password) await api.adminResetPassword(editing, form.password);
      } else {
        await api.adminCreateUser(form);
      }
      setForm(EMPTY_USER);
      setEditing(null);
    }, editing ? 'User updated.' : 'User created.');

  if (!users) return <p className="muted">Loading…</p>;
  return (
    <div>
      <h3>{editing ? 'Edit user' : 'Add user'}</h3>
      <div className="form-grid">
        <label>User name<input value={form.userName} disabled={!!editing} onChange={set('userName')} /></label>
        <label>Email<input type="email" value={form.email} onChange={set('email')} /></label>
        <label>Employee code<input value={form.employeeCode} onChange={set('employeeCode')} /></label>
        <label>{editing ? 'New password (optional)' : 'Initial password'}
          <input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
        </label>
        <label>Role
          <select value={form.role} onChange={set('role')}>
            {roles.map((r) => <option key={r.id} value={r.name} disabled={!r.configured}>{r.name}{r.configured ? '' : ' (not configured)'}</option>)}
          </select>
        </label>
      </div>
      <p className="muted small">Password: at least 12 characters with upper-case, lower-case and a digit.</p>
      <Checks label="Plants" items={plants.map((p) => ({ id: p.id, name: p.name }))} value={form.plantIds} onChange={(v) => setForm({ ...form, plantIds: v })} />
      <Checks label="Offices, stockyard & guest houses" items={offices.map((p) => ({ id: p.id, name: p.name }))} value={form.locationIds} onChange={(v) => setForm({ ...form, locationIds: v })} />
      <div className="actions">
        <button className="primary" onClick={save}>{editing ? 'Save changes' : 'Create user'}</button>
        {editing && <button onClick={() => { setEditing(null); setForm(EMPTY_USER); }}>Cancel</button>}
      </div>
      {msg && <p className="ok" role="status">{msg}</p>}
      <table>
        <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Plants</th><th>Offices</th><th>Active</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.userName}<div className="muted small">{u.employeeCode}</div></td>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>{u.plantIds.length}</td>
              <td>{u.locationIds.length}</td>
              <td>{u.isActive ? 'Yes' : 'No'}</td>
              <td>
                <button className="link" onClick={() => { setEditing(u.id); setForm({ ...EMPTY_USER, userName: u.userName, email: u.email, employeeCode: u.employeeCode, role: u.role ?? 'User', plantIds: u.plantIds, locationIds: u.locationIds }); }}>Edit</button>
                {' '}
                <button className="link" onClick={() => act(() => api.adminUpdateUser(u.id, { isActive: !u.isActive }), u.isActive ? 'User deactivated.' : 'User activated.')}>{u.isActive ? 'Deactivate' : 'Activate'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Locations({ locations, types, reload, onError }) {
  const [form, setForm] = useState({ kind: 'office', name: '', locationType: types[0] ?? 'Office' });
  const [msg, setMsg] = useState('');
  const act = async (fn, ok) => {
    setMsg('');
    onError('');
    try {
      const r = await fn();
      setMsg(r?.note ? `${ok} ${r.note}` : ok);
      await reload();
    } catch (e) {
      onError(e.message);
    }
  };
  return (
    <div>
      <h3>Add location</h3>
      <div className="form-grid">
        <label>Kind
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="office">Office / stockyard / guest house</option>
            <option value="plant">Plant</option>
          </select>
        </label>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        {form.kind === 'office' && (
          <label>Type
            <select value={form.locationType} onChange={(e) => setForm({ ...form, locationType: e.target.value })}>
              {types.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="actions">
        <button className="primary" onClick={() => act(() => api.adminCreateLocation(form).then((r) => { setForm({ ...form, name: '' }); return r; }), 'Location added.')}>Add location</button>
      </div>
      {msg && <p className="ok" role="status">{msg}</p>}
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Assigned users</th><th>Export mappings</th><th>Active</th><th /></tr></thead>
        <tbody>
          {locations.map((l) => (
            <tr key={`${l.kind}:${l.id}`}>
              <td>{l.name}</td>
              <td>{l.kind === 'plant' ? 'Plant' : l.type}</td>
              <td>{l.assignedUsers}</td>
              <td>{l.exportMappings === 0 ? <span className="warn-text">none</span> : l.exportMappings}</td>
              <td>{l.isActive ? 'Yes' : 'No'}</td>
              <td><button className="link" onClick={() => act(() => api.adminSetLocationActive(l.kind, l.id, !l.isActive), l.isActive ? 'Location deactivated.' : 'Location activated.')}>{l.isActive ? 'Deactivate' : 'Activate'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Admin() {
  const [part, setPart] = useState('users');
  const [roles, setRoles] = useState([]);
  const [locs, setLocs] = useState(null);
  const [error, setError] = useState('');
  const reload = () => api.adminLocations().then(setLocs).catch((e) => setError(e.message));
  useEffect(() => {
    api.adminRoles().then((r) => setRoles(r.roles)).catch((e) => setError(e.message));
    reload();
  }, []);
  if (!locs) return <p className="muted">{error || 'Loading…'}</p>;
  return (
    <div>
      <nav className="subnav">
        <button className={part === 'users' ? 'tab active' : 'tab'} onClick={() => setPart('users')}>Users</button>
        <button className={part === 'locations' ? 'tab active' : 'tab'} onClick={() => setPart('locations')}>Locations</button>
      </nav>
      {error && <p className="error" role="alert">{error}</p>}
      {part === 'users'
        ? <Users roles={roles} locations={locs.locations} onError={setError} />
        : <Locations locations={locs.locations} types={locs.locationTypes} reload={reload} onError={setError} />}
    </div>
  );
}
