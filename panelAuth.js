'use strict';
// PanelAuth: đăng ký / đăng nhập panel, phiên cookie, cài đặt riêng từng tài khoản, chống dò mật khẩu / key.
// - Tài khoản lưu ở data/users.json (mật khẩu băm scrypt, xem userStore.js).
// - Phiên: cookie HttpOnly, server chỉ lưu băm SHA-256 của token (data/sessions.json).
// - Cài đặt riêng mỗi tài khoản (webhook Discord, lịch nghỉ, MENU) lưu ở data/prefs.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UserStore } = require('./userStore');
const { loadSecret, makeCipher, sha256 } = require('./secure');

const COOKIE = 'hxt_sid';
const HM_RE = /^\d{1,2}:\d{1,2}$/;
// Chỉ nhận webhook Discord để người dùng không bắt server gọi tới địa chỉ tùy ý (SSRF).
const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/[\w\-./?=&%]+$/i;

const defaultPrefs = () => ({
  webhook: '',
  autoMenu: true,
  autoConfirm: false,
  schedule: { enabled: false, outTime: '04:20', inTime: '05:05' }
});

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) {}
  });
  return out;
}

class PanelAuth {
  constructor({ dataDir, sessionDays, allowRegister }) {
    this.dataDir = dataDir;
    this.cipher = makeCipher(loadSecret(dataDir));
    this.users = new UserStore(path.join(dataDir, 'users.json'));
    this.allowRegister = allowRegister !== false;
    this.sessionDays = Math.max(1, Number(sessionDays) || 30);
    this.sessionsPath = path.join(dataDir, 'sessions.json');
    this.prefsPath = path.join(dataDir, 'prefs.json');
    this.sessions = this._loadSessions();   // sha256(token) -> { userId, exp }
    this.prefs = this._loadPrefs();         // userId -> prefs
    this.failures = new Map();              // 'bucket:ip' -> [timestamp]
    this._sessTimer = null;
    this.guard = this.guard.bind(this);
  }

  // ----- phiên -----
  _loadSessions() {
    const map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionsPath, 'utf8'));
      for (const [h, s] of Object.entries(raw || {})) if (s && s.userId && s.exp > Date.now()) map.set(h, s);
    } catch (_) { /* chưa có */ }
    return map;
  }

  _saveSessions() {
    clearTimeout(this._sessTimer);
    this._sessTimer = null;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.sessionsPath, JSON.stringify(Object.fromEntries(this.sessions)), { encoding: 'utf8', mode: 0o600 });
    } catch (e) { console.error('[Auth] Không lưu được phiên:', e.message); }
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(sha256(token), { userId, exp: Date.now() + this.sessionDays * 86400000 });
    this._saveSessions();
    return token;
  }

  destroySession(token) {
    if (token && this.sessions.delete(sha256(token))) this._saveSessions();
  }

  userIdFromToken(token) {
    if (!token) return null;
    const key = sha256(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.exp < Date.now()) { this.sessions.delete(key); return null; }
    return this.users.get(s.userId) ? s.userId : null;
  }

  // Dùng cho cả HTTP và WebSocket (req.headers.cookie).
  userIdFromReq(req) {
    return this.userIdFromToken(parseCookies(req && req.headers && req.headers.cookie)[COOKIE]);
  }

  userName(userId) {
    const u = this.users.get(userId);
    return u ? u.username : '';
  }

  // ----- chống dò mật khẩu / key -----
  _recent(bucket, ip, windowMs) {
    const k = bucket + ':' + ip;
    const now = Date.now();
    const list = (this.failures.get(k) || []).filter((t) => now - t < windowMs);
    if (list.length) this.failures.set(k, list); else this.failures.delete(k);
    return list;
  }

  tooMany(bucket, ip, max, windowMs) { return this._recent(bucket, ip, windowMs).length >= max; }

  recordFail(bucket, ip) {
    const k = bucket + ':' + ip;
    const list = this.failures.get(k) || [];
    list.push(Date.now());
    this.failures.set(k, list);
  }

  // ----- cài đặt riêng từng tài khoản -----
  _loadPrefs() {
    try { return JSON.parse(fs.readFileSync(this.prefsPath, 'utf8')) || {}; } catch (_) { return {}; }
  }

  _savePrefs() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.prefsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.prefs, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.prefsPath);
    } catch (e) { console.error('[Auth] Không lưu được cài đặt:', e.message); }
  }

  prefsOf(userId) {
    const base = defaultPrefs();
    const raw = (userId && this.prefs[userId]) || {};
    return {
      webhook: typeof raw.webhook === 'string' ? raw.webhook : base.webhook,
      autoMenu: typeof raw.autoMenu === 'boolean' ? raw.autoMenu : base.autoMenu,
      autoConfirm: typeof raw.autoConfirm === 'boolean' ? raw.autoConfirm : base.autoConfirm,
      schedule: Object.assign(base.schedule, raw.schedule || {})
    };
  }

  setPrefs(userId, patch) {
    if (!userId) throw new Error('Chưa đăng nhập.');
    const next = this.prefsOf(userId);
    patch = patch || {};
    if (typeof patch.webhook === 'string') {
      const url = patch.webhook.trim();
      if (url && !WEBHOOK_RE.test(url)) throw new Error('Webhook phải là link Discord (https://discord.com/api/webhooks/...).');
      next.webhook = url;
    }
    if (typeof patch.autoMenu === 'boolean') next.autoMenu = patch.autoMenu;
    if (typeof patch.autoConfirm === 'boolean') next.autoConfirm = patch.autoConfirm;
    if (patch.schedule && typeof patch.schedule === 'object') {
      const s = patch.schedule;
      if (typeof s.enabled === 'boolean') next.schedule.enabled = s.enabled;
      if (HM_RE.test(String(s.outTime || ''))) next.schedule.outTime = String(s.outTime);
      if (HM_RE.test(String(s.inTime || ''))) next.schedule.inTime = String(s.inTime);
    }
    this.prefs[userId] = next;
    this._savePrefs();
    return next;
  }

  // Dữ liệu cũ (webhook / lịch nghỉ dùng chung trước khi có tài khoản) chuyển cho người đầu tiên nhận lại acc cũ.
  adoptLegacy(userId, legacy) {
    if (this.prefs._legacyDone || !userId) return;
    this.prefs._legacyDone = true;
    const patch = {};
    if (legacy && legacy.webhook && WEBHOOK_RE.test(legacy.webhook)) patch.webhook = legacy.webhook;
    if (legacy && legacy.schedule) patch.schedule = legacy.schedule;
    try { this.setPrefs(userId, patch); } catch (_) { this._savePrefs(); }
  }

  // ----- HTTP -----
  _setCookie(req, res, token) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (this.sessionDays * 86400) + secure);
  }

  _clearCookie(req, res) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure);
  }

  // Mọi /api/* (trừ /api/auth/*) cần đăng nhập.
  guard(req, res, next) {
    if (req.path.startsWith('/auth/')) return next();
    const uid = this.userIdFromReq(req);
    if (!uid) return res.status(401).json({ success: false, auth: false, message: 'Chưa đăng nhập.' });
    req.userId = uid;
    next();
  }

  install(app) {
    const H = 15 * 60 * 1000;

    app.get('/api/auth/me', (req, res) => {
      const uid = this.userIdFromReq(req);
      if (!uid) return res.status(401).json({ success: false, auth: false, allowRegister: this.allowRegister });
      res.json({ success: true, auth: true, user: { username: this.userName(uid) } });
    });

    app.post('/api/auth/register', async (req, res) => {
      try {
        if (!this.allowRegister) return res.json({ success: false, message: 'Đăng ký đang đóng.' });
        if (this.tooMany('reg', req.ip, 5, 60 * 60 * 1000)) return res.status(429).json({ success: false, message: 'Đăng ký quá nhiều lần, thử lại sau.' });
        const { username, password } = req.body || {};
        this.recordFail('reg', req.ip);   // đếm mọi lượt đăng ký để chặn spam tạo tài khoản
        const user = await this.users.register(username, password);
        this._setCookie(req, res, this.createSession(user.id));
        res.json({ success: true, user: { username: user.username } });
      } catch (e) {
        res.json({ success: false, message: e.message });
      }
    });

    app.post('/api/auth/login', async (req, res) => {
      try {
        if (this.tooMany('login', req.ip, 10, H)) return res.status(429).json({ success: false, message: 'Nhập sai quá nhiều lần, thử lại sau 15 phút.' });
        const { username, password } = req.body || {};
        const user = await this.users.verify(username, password);
        if (!user) {
          this.recordFail('login', req.ip);
          return res.json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu.' });
        }
        this._setCookie(req, res, this.createSession(user.id));
        res.json({ success: true, user: { username: user.username } });
      } catch (e) {
        res.json({ success: false, message: e.message });
      }
    });

    app.post('/api/auth/logout', (req, res) => {
      this.destroySession(parseCookies(req.headers.cookie)[COOKIE]);
      this._clearCookie(req, res);
      res.json({ success: true });
    });

    app.use('/api', this.guard);
  }
}

module.exports = { PanelAuth, parseCookies, defaultPrefs };
