'use strict';
// UserStore: tài khoản đăng nhập panel (username + password), lưu cục bộ trong data/users.json.
// Mật khẩu được băm bằng scrypt + salt ngẫu nhiên, không bao giờ lưu dạng gốc.
// Mỗi user có bộ cài đặt riêng (ignoreServerNotices, hideDebugLogs, betterLogs).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
const DEFAULT_SETTINGS = { ignoreServerNotices: false, hideDebugLogs: false, betterLogs: false };
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

class UserStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.users = new Map();     // id -> user
    this.byName = new Map();    // username (chữ thường) -> id
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const u of (raw && raw.users) || []) {
        if (!u || !u.id || !u.username || !u.salt || !u.hash) continue;
        this.users.set(u.id, u);
        this.byName.set(String(u.username).toLowerCase(), u.id);
      }
    } catch (_) { /* chưa có file */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users: Array.from(this.users.values()) }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  async hash(password, salt) {
    return (await scrypt(String(password), salt, 64)).toString('hex');
  }

  async register(rawUsername, password) {
    const username = String(rawUsername || '').trim();
    password = String(password || '');
    if (!USERNAME_RE.test(username)) throw new Error('Tên đăng nhập 3-24 ký tự, chỉ gồm chữ, số, dấu . _ -');
    if (password.length < 6) throw new Error('Mật khẩu tối thiểu 6 ký tự.');
    if (password.length > 128) throw new Error('Mật khẩu quá dài.');
    const lower = username.toLowerCase();
    if (this.byName.has(lower)) throw new Error('Tên đăng nhập đã tồn tại.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await this.hash(password, salt);
    if (this.byName.has(lower)) throw new Error('Tên đăng nhập đã tồn tại.');   // kiểm tra lại sau await
    const user = { id: 'u_' + crypto.randomBytes(12).toString('hex'), username, salt, hash, createdAt: Date.now(), settings: Object.assign({}, DEFAULT_SETTINGS) };
    this.users.set(user.id, user);
    this.byName.set(lower, user.id);
    this.save();
    return user;
  }

  async verify(rawUsername, password) {
    const id = this.byName.get(String(rawUsername || '').trim().toLowerCase());
    const user = id && this.users.get(id);
    // Luôn băm 1 lần dù user không tồn tại để thời gian phản hồi không lộ tên đăng nhập có thật.
    const salt = user ? user.salt : '0'.repeat(32);
    const hash = Buffer.from(await this.hash(String(password || '').slice(0, 128), salt), 'hex');
    if (!user) return null;
    const stored = Buffer.from(user.hash, 'hex');
    return stored.length === hash.length && crypto.timingSafeEqual(stored, hash) ? user : null;
  }

  get(id) { return this.users.get(id) || null; }

  settingsOf(id) {
    const user = id && this.users.get(id);
    return Object.assign({}, DEFAULT_SETTINGS, (user && user.settings) || {});
  }

  updateSettings(id, patch) {
    const user = this.users.get(id);
    if (!user) throw new Error('Không tìm thấy tài khoản.');
    const next = this.settingsOf(id);
    for (const key of SETTING_KEYS) if (patch && typeof patch[key] === 'boolean') next[key] = patch[key];
    user.settings = next;
    this.save();
    return next;
  }
}

module.exports = { UserStore, DEFAULT_SETTINGS };