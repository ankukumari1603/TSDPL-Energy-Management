const TOKEN_KEY = 'tsdpl_token';

export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, path, body, raw) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the API server. Make sure the backend is running on port 4000 (cd backend; npm start), then try again.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.details);
  }
  return raw ? res : res.json();
}

export const api = {
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  me: () => request('GET', '/api/me'),
  changePassword: (currentPassword, newPassword, confirmPassword) =>
    request('POST', '/api/me/password', { currentPassword, newPassword, confirmPassword }),
  sites: () => request('GET', '/api/sites'),
  factors: () => request('GET', '/api/conversion-factors'),
  records: (fy, q) => request('GET', `/api/energy/records?fy=${fy}&quarter=${q}`),
  pendingReview: (fy) => request('GET', `/api/energy/pending-review?fy=${fy}`),
  record: (s, fy, q) => request('GET', `/api/energy/${s.kind}/${s.id}/${fy}/${q}`),
  save: (s, fy, q, entries) => request('PUT', `/api/energy/${s.kind}/${s.id}/${fy}/${q}`, { entries }),
  submit: (s, fy, q, entries) => request('POST', `/api/energy/${s.kind}/${s.id}/${fy}/${q}/submit`, { entries }),
  review: (s, fy, q, decision, reason) =>
    request('POST', `/api/energy/${s.kind}/${s.id}/${fy}/${q}/review`, { decision, reason }),
  preview: (fy, q) => request('GET', `/api/reports/energy/preview?fy=${fy}&quarter=${q}`),
  exportReport: (fy, q) => request('GET', `/api/reports/energy/export?fy=${fy}&quarter=${q}`, null, true),
  requestUnlock: (s, fy, q, reason) =>
    request('POST', '/api/energy/unlock-requests', { kind: s.kind, id: s.id, financialYear: fy, quarter: q, reason }),
  unlockRequests: (status) => request('GET', `/api/energy/unlock-requests${status ? `?status=${status}` : ''}`),
  reviewUnlock: (id, decision, reason) => request('POST', `/api/energy/unlock-requests/${id}/review`, { decision, reason }),
  notifications: () => request('GET', '/api/notifications'),
  markRead: (id) => request('POST', `/api/notifications/${id}/read`),
  markAllRead: () => request('POST', '/api/notifications/read-all'),
  clearNotifications: () => request('POST', '/api/notifications/clear'),
  history: (s, fy, q) => request('GET', `/api/energy/${s.kind}/${s.id}/${fy}/${q}/history`),
  documents: (s, fy, q) => request('GET', `/api/energy/${s.kind}/${s.id}/${fy}/${q}/documents`),
  uploadDocument: async (s, fy, q, file) => {
    const fd = new FormData();
    fd.append('file', file);
    let res;
    try {
      res = await fetch(`/api/energy/${s.kind}/${s.id}/${fy}/${q}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: fd });
    } catch {
      throw new ApiError(0, 'Cannot reach the API server.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || `Upload failed (${res.status})`, data.details);
    return data;
  },
  deleteDocument: (s, fy, q, id) => request('DELETE', `/api/energy/${s.kind}/${s.id}/${fy}/${q}/documents/${id}`),
  downloadDocument: (s, fy, q, id) => request('GET', `/api/energy/${s.kind}/${s.id}/${fy}/${q}/documents/${id}`, null, true),
  dashboard: (fy, period, site) =>
    request('GET', `/api/dashboard?fy=${fy}&period=${period}${site ? `&site=${encodeURIComponent(site)}` : ''}`),
  adminRoles: () => request('GET', '/api/admin/roles'),
  adminUsers: () => request('GET', '/api/admin/users'),
  adminCreateUser: (b) => request('POST', '/api/admin/users', b),
  adminUpdateUser: (id, b) => request('PATCH', `/api/admin/users/${id}`, b),
  adminResetPassword: (id, password) => request('POST', `/api/admin/users/${id}/reset-password`, { password }),
  adminLocations: () => request('GET', '/api/admin/locations'),
  adminCreateLocation: (b) => request('POST', '/api/admin/locations', b),
  adminSetLocationActive: (kind, id, isActive) => request('PATCH', `/api/admin/locations/${kind}/${id}`, { isActive }),
};
