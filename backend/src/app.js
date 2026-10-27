import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config, getJwtSecret } from './config.js';
import { createService, HttpError } from './service.js';
import { can } from './permissions.js';
import { buildExportPlan, generateWorkbook } from './excelExport.js';
import { createAdmin, validatePassword } from './admin.js';
import { createDashboard } from './dashboard.js';
import multer from 'multer';
import { createDocuments, MAX_FILE_BYTES } from './documents.js';

// Used to keep login timing similar when the user does not exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export function createApp(db, { templatePath = config.templatePath, loginLimit = 20, uploadDir = config.uploadDir } = {}) {
  const secret = getJwtSecret();
  const service = createService(db);
  const documents = createDocuments(db, service, uploadDir);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES + 1, files: 1, fields: 0 } }).single('file');
  const admin = createAdmin(db, service);
  const { dashboard } = createDashboard(db, service);
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  const authenticate = (req, _res, next) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return next(new HttpError(401, 'Authentication required.'));
    try {
      const payload = jwt.verify(h.slice(7), secret, { algorithms: ['HS256'] });
      // Reload on every request so role/mapping/active changes take effect immediately.
      const user = service.loadUser(payload.sub);
      if (!user) return next(new HttpError(401, 'Account is not active.'));
      req.user = user;
      next();
    } catch {
      next(new HttpError(401, 'Invalid or expired token.'));
    }
  };
  const need = (perm) => (req, _res, next) =>
    can(req.user, perm) ? next() : next(new HttpError(403, 'You do not have permission for this action.'));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post(
    '/api/auth/login',
    rateLimit({ windowMs: 15 * 60 * 1000, limit: loginLimit, standardHeaders: true, legacyHeaders: false }),
    wrap(async (req, res) => {
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        throw new HttpError(400, 'Username and password are required.');
      }
      const row = db.prepare('SELECT UserID, PasswordHash, IsActive FROM Users WHERE UserName = ? OR Email = ? OR EmployeeCode = ?').get(username, username, username);
      const ok = await bcrypt.compare(password, row?.PasswordHash || DUMMY_HASH);
      if (!row || !ok || !row.IsActive) throw new HttpError(401, 'Invalid credentials.');
      const user = service.loadUser(row.UserID);
      if (!user) throw new HttpError(401, 'Invalid credentials.');
      const token = jwt.sign({ sub: user.id }, secret, { algorithm: 'HS256', expiresIn: config.jwtExpiresIn });
      res.json({ token, user });
    }),
  );

  app.use('/api', authenticate);

  app.get('/api/me', (req, res) => res.json({ user: req.user }));

  app.post(
    '/api/me/password',
    rateLimit({ windowMs: 15 * 60 * 1000, limit: loginLimit, standardHeaders: true, legacyHeaders: false }),
    wrap(async (req, res) => {
      const { currentPassword, newPassword, confirmPassword } = req.body || {};
      if (typeof currentPassword !== 'string' || !currentPassword) throw new HttpError(400, 'Current password is required.');
      const policy = validatePassword(newPassword);
      if (policy) throw new HttpError(422, policy);
      if (newPassword !== confirmPassword) throw new HttpError(422, 'New password and confirmation do not match.');
      const row = db.prepare('SELECT PasswordHash FROM Users WHERE UserID = ?').get(req.user.id);
      if (!row || !(await bcrypt.compare(currentPassword, row.PasswordHash))) throw new HttpError(403, 'Current password is incorrect.');
      if (newPassword === currentPassword) throw new HttpError(422, 'New password must be different from the current password.');
      const hash = await bcrypt.hash(newPassword, 12);
      db.prepare('UPDATE Users SET PasswordHash = ? WHERE UserID = ?').run(hash, req.user.id);
      res.json({ ok: true });
    }),
  );

  app.get('/api/sites', need('energy:view'), (req, res) => res.json({ sites: service.listSites(req.user) }));

  app.get('/api/conversion-factors', need('energy:view'), (_req, res) => res.json({ factors: service.conversionFactors() }));

  app.get('/api/energy/records', need('energy:view'), (req, res) =>
    res.json({ records: service.listRecords(req.user, req.query.fy, req.query.quarter) }),
  );

  app.get('/api/energy/pending-review', (req, res, next) => (can(req.user, 'energy:review') || can(req.user, 'energy:approve') ? next() : next(new HttpError(403, 'You do not have permission for this action.'))), (req, res) =>
    res.json({ pending: service.listPending(req.user, req.query.fy) }),
  );

  const recordPath = '/api/energy/:kind/:id/:fy/:quarter';

  app.get('/api/dashboard', need('dashboard:view'), (req, res) =>
    res.json(dashboard(req.user, { fy: req.query.fy, period: req.query.period || 'ALL', site: req.query.site })),
  );

  app.get('/api/admin/roles', need('admin:manage'), (_req, res) => res.json({ roles: admin.listRoles() }));
  app.get('/api/admin/users', need('admin:manage'), (_req, res) => res.json({ users: admin.listUsers() }));
  app.post('/api/admin/users', need('admin:manage'), (req, res) => res.status(201).json(admin.createUser(req.user, req.body)));
  app.patch('/api/admin/users/:id', need('admin:manage'), (req, res) => res.json(admin.updateUser(req.user, req.params.id, req.body)));
  app.post('/api/admin/users/:id/reset-password', need('admin:manage'), (req, res) =>
    res.json(admin.resetPassword(req.user, req.params.id, req.body?.password)),
  );
  app.get('/api/admin/locations', need('admin:manage'), (_req, res) => res.json({ locations: admin.listLocations(), locationTypes: admin.LOCATION_TYPES }));
  app.post('/api/admin/locations', need('admin:manage'), (req, res) => res.status(201).json(admin.createLocation(req.user, req.body)));
  app.patch('/api/admin/locations/:kind/:id', need('admin:manage'), (req, res) =>
    res.json(admin.setLocationActive(req.params.kind, req.params.id, req.body?.isActive)),
  );

  app.get(`${recordPath}/history`, need('energy:view'), (req, res) => {
    const { kind, id, fy, quarter } = req.params;
    res.json({ history: service.history(req.user, kind, id, fy, quarter) });
  });

  app.get(`${recordPath}/documents`, need('energy:view'), (req, res) => {
    const { kind, id, fy, quarter } = req.params;
    res.json({ documents: documents.list(req.user, kind, id, fy, quarter) });
  });
  app.post(`${recordPath}/documents`, need('energy:enter'), (req, res, next) => {
    upload(req, res, (err) => {
      if (err) return next(err);
      try {
        const { kind, id, fy, quarter } = req.params;
        res.status(201).json({ documents: documents.add(req.user, kind, id, fy, quarter, req.file) });
      } catch (e) {
        next(e);
      }
    });
  });
  app.get(`${recordPath}/documents/:docId`, need('energy:view'), (req, res) => {
    const { kind, id, fy, quarter, docId } = req.params;
    const f = documents.file(req.user, kind, id, fy, quarter, docId);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.sendFile(f.path);
  });
  app.delete(`${recordPath}/documents/:docId`, need('energy:enter'), (req, res) => {
    const { kind, id, fy, quarter, docId } = req.params;
    res.json({ documents: documents.remove(req.user, kind, id, fy, quarter, docId) });
  });

  app.post('/api/energy/unlock-requests', need('energy:unlock-request'), (req, res) => {
    const { kind, id, financialYear, quarter, reason } = req.body || {};
    res.status(201).json(service.requestUnlock(req.user, kind, id, financialYear, quarter, reason));
  });
  app.get('/api/energy/unlock-requests', need('energy:view'), (req, res) =>
    res.json({ requests: service.listUnlockRequests(req.user, { status: req.query.status }) }),
  );
  app.post('/api/energy/unlock-requests/:id/review', need('energy:unlock-review'), (req, res) =>
    res.json(service.reviewUnlock(req.user, req.params.id, req.body || {})),
  );

  app.get('/api/notifications', need('energy:view'), (req, res) => res.json(service.notifier.list(req.user.id)));
  app.post('/api/notifications/read-all', need('energy:view'), (req, res) => {
    service.notifier.markAllRead(req.user.id);
    res.json(service.notifier.list(req.user.id));
  });
  app.post('/api/notifications/clear', need('energy:view'), (req, res) => {
    service.notifier.clearAll(req.user.id);
    res.json(service.notifier.list(req.user.id));
  });
  app.post('/api/notifications/:id/read', need('energy:view'), (req, res) => {
    service.notifier.markRead(req.user.id, Number(req.params.id));
    res.json(service.notifier.list(req.user.id));
  });
  app.get(recordPath, need('energy:view'), (req, res) => {
    const { kind, id, fy, quarter } = req.params;
    res.json(service.getRecord(req.user, kind, id, fy, quarter));
  });
  app.put(recordPath, need('energy:enter'), (req, res) => {
    const { kind, id, fy, quarter } = req.params;
    res.json(service.save(req.user, kind, id, fy, quarter, req.body?.entries, { submit: false }));
  });
  app.post(`${recordPath}/submit`, need('energy:enter'), (req, res) => {
    const { kind, id, fy, quarter } = req.params;
    res.json(service.save(req.user, kind, id, fy, quarter, req.body?.entries, { submit: true }));
  });
  app.post(`${recordPath}/review`, (req, res, next) => (can(req.user, 'energy:review') || can(req.user, 'energy:approve') ? next() : next(new HttpError(403, 'You do not have permission for this action.'))), (req, res) => {
    const { kind, id, fy, quarter } = req.params;
    res.json(service.review(req.user, kind, id, fy, quarter, req.body || {}));
  });

  app.get('/api/reports/energy/preview', need('energy:export'), (req, res) => {
    const plan = buildExportPlan(db, service, req.user, req.query.fy, req.query.quarter);
    res.json(plan);
  });
  app.get(
    '/api/reports/energy/export',
    need('energy:export'),
    wrap(async (req, res) => {
      const plan = buildExportPlan(db, service, req.user, req.query.fy, req.query.quarter);
      if (!plan.cells.some((c) => c.site !== 'conversion')) throw new HttpError(409, 'No approved data to export.');
      const buf = await generateWorkbook(templatePath, plan);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="TSDPL-Energy-${plan.financialYear}-${plan.quarter}.xlsx"`);
      res.setHeader('X-Export-Warnings', String(plan.warnings.length));
      res.send(buf);
    }),
  );

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof multer.MulterError) {
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 10 MB.' : 'Invalid upload.' });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  });
  return app;
}
