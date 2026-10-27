import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import { currentFinancialYear, financialYearOptions } from './validation.js';
import Login from './Login.jsx';
import EntryForm from './EntryForm.jsx';
import ReviewQueue from './ReviewQueue.jsx';
import Report from './Report.jsx';
import Factors from './Factors.jsx';
import NotificationBell from './NotificationBell.jsx';
import UnlockRequests from './UnlockRequests.jsx';
import { navTabs } from './navTabs.js';
import Dashboard from './Dashboard.jsx';
import Admin from './Admin.jsx';
import ChangePassword from './ChangePassword.jsx';

const siteKey = (s) => `${s.kind}:${s.id}`;

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const [sites, setSites] = useState([]);
  const [fy, setFy] = useState(currentFinancialYear());
  const [quarter, setQuarter] = useState('Q1');
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState('entry');

  useEffect(() => {
    if (!getToken()) return;
    api.me().then((r) => setUser(r.user)).catch(() => setToken(null)).finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    api.sites().then((r) => {
      setSites(r.sites);
      setSelected((cur) => cur ?? r.sites[0] ?? null);
    }).catch(() => setSites([]));
  }, [user]);

  const logout = () => {
    setToken(null);
    setUser(null);
    setSites([]);
    setSelected(null);
    setTab('entry');
  };

  if (booting) return <p className="muted pad">Loading…</p>;
  if (!user) return <Login onLogin={(u) => setUser(u)} />;

  const isAdmin = user.role === 'Admin';
  const canReview = isAdmin || user.role === 'Supervisor';
  const canEnter = ['Admin', 'User'].includes(user.role);
  const tabs = navTabs({ role: user.role });
  const openRecord = (site, f, q) => {
    const match = sites.find((s) => siteKey(s) === siteKey(site));
    if (match) setSelected(match);
    if (f) setFy(f);
    if (q) setQuarter(q);
    setTab('entry');
  };

  return (
    <div className="app">
      <header>
        <h1>TSDPL Energy Data</h1>
        <div className="who">
          <NotificationBell onOpenUnlock={() => setTab('unlock')} />
          {user.name} · {user.role}
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </header>
      <section className="selectors">
        <label>Financial year
          <select value={fy} onChange={(e) => setFy(e.target.value)}>
            {financialYearOptions().map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
        <label>Quarter
          <select value={quarter} onChange={(e) => setQuarter(e.target.value)}>
            {['Q1', 'Q2', 'Q3', 'Q4'].map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
        <label>Location
          <select value={selected ? siteKey(selected) : ''} onChange={(e) => setSelected(sites.find((s) => siteKey(s) === e.target.value))}>
            <optgroup label="Plants">
              {sites.filter((s) => s.kind === 'plant').map((s) => <option key={siteKey(s)} value={siteKey(s)}>{s.name}</option>)}
            </optgroup>
            <optgroup label="Offices, stockyard & guest houses">
              {sites.filter((s) => s.kind === 'office').map((s) => <option key={siteKey(s)} value={siteKey(s)}>{s.name}</option>)}
            </optgroup>
          </select>
        </label>
      </section>
      <nav>
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
      <main>
        {tab === 'dashboard' && canReview && <Dashboard fy={fy} sites={sites} />}
        {tab === 'entry' && (selected
          ? <EntryForm key={`${siteKey(selected)}|${fy}|${quarter}`} site={selected} fy={fy} quarter={quarter}           canEnter={canEnter} canReview={canReview} canRequestUnlock={!isAdmin} />
          : <p className="muted">No locations are assigned to you.</p>)}
        {tab === 'review' && <ReviewQueue fy={fy} quarter={quarter} canEnter={canEnter} onOpen={openRecord} />}
        {tab === 'unlock' && <UnlockRequests isAdmin={isAdmin} onOpen={openRecord} />}
        {tab === 'report' && <Report fy={fy} quarter={quarter} />}
        {tab === 'factors' && <Factors />}
        {tab === 'admin' && isAdmin && <Admin />}
        {tab === 'password' && <ChangePassword />}
      </main>
    </div>
  );
}
