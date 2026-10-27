import { describe, it, expect } from 'vitest';
import { navTabs } from './navTabs.js';

const keys = (role) => navTabs({ role }).map(([k]) => k);

describe('navTabs', () => {
  it('Admin: Approvals and Unlock requests are separate and adjacent', () => {
    const tabs = navTabs({ role: 'Admin' });
    const i = tabs.findIndex(([k]) => k === 'review');
    expect(tabs[i]).toEqual(['review', 'Approvals']);
    expect(tabs[i + 1]).toEqual(['unlock', 'Unlock requests']);
  });

  it('Supervisor: Review and My unlock requests are adjacent, dashboard visible', () => {
    const tabs = navTabs({ role: 'Supervisor' });
    const i = tabs.findIndex(([k]) => k === 'review');
    expect(tabs[i]).toEqual(['review', 'Review']);
    expect(tabs[i + 1]).toEqual(['unlock', 'My unlock requests']);
    expect(keys('Supervisor')).toContain('dashboard');
    expect(keys('Supervisor')).not.toContain('admin');
  });

  it('User: no Dashboard, no review, no report, but keeps entry, unlock, factors and password', () => {
    expect(keys('User')).toEqual(['entry', 'unlock', 'factors', 'password']);
    expect(navTabs({ role: 'User' }).find(([k]) => k === 'unlock')[1]).toBe('My unlock requests');
  });

  it('Admin keeps every tab with unique keys', () => {
    const k = keys('Admin');
    expect(new Set(k).size).toBe(k.length);
    expect(k).toEqual(['dashboard', 'entry', 'review', 'unlock', 'report', 'factors', 'admin', 'password']);
  });
});
