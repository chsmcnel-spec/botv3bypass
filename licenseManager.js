'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { identityCipher } = require('./secure');

// Đổi giá trị ngày hết hạn (ISO / timestamp giây / timestamp mili giây) thành mili giây; không hiểu thì trả null.
function toEpochMs(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.getTime() : null;
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim()))) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);   // < 1e12 coi là timestamp giây
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

// Tìm ngày hết hạn trong phản hồi KeyVault: expiresAt / expiry / expires_at / expireAt / expires,
// ở gốc hoặc nằm trong json.key / json.data / json.license.
function readExpiry(json) {
  const names = ['expiresAt', 'expiry', 'expires_at', 'expireAt', 'expires'];
  const holders = [json, json && json.key, json && json.data, json && json.license];
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object') continue;
    for (const name of names) {
      const ms = toEpochMs(holder[name]);
      if (ms !== null) return ms;
    }
  }
  return null;
}

// Kiểm tra key với KeyVault (Netlify): POST { action: 'verifyKey', key } -> { valid: true|false }
// - Chỉ coi là "key sai/hết hạn" khi server trả valid:false rõ ràng.
// - Lỗi mạng / phản hồi lạ chỉ được cộng dồn; vượt graceFailures lần liên tiếp mới khóa.
class LicenseManager extends EventEmitter {
  constructor({ config, filePath, cipher }) {
    super();
    const cfg = (config && config.license) || {};
    this.url = String(cfg.url || '').trim();
    this.origin = String(cfg.origin || '').trim();
    this.recheckMs = Math.max(15000, Number(cfg.recheckMs) || 60000);
    this.graceFailures = Math.max(0, cfg.graceFailures === undefined ? 3 : Number(cfg.graceFailures));
    this.timeoutMs = Math.max(3000, Number(cfg.timeoutMs) || 10000);
    this.filePath = filePath;
    this.cipher = cipher || identityCipher;   // key lưu trên đĩa được mã hóa

    this.key = '';
    this.valid = false;
    this.checking = false;
    this.lastCheckedAt = 0;
    this.lastError = '';
    this.expiresAt = null;   // mili giây, null nếu server không trả ngày hết hạn
    this.failCount = 0;
    this.timer = null;
    this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (data && typeof data.key === 'string') this.key = this.cipher.decrypt(data.key).trim();
    } catch (_) { /* chưa có file */ }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ key: this.cipher.encrypt(this.key) }, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  isValid() { return this.valid; }

  status() {
    const msLeft = this.expiresAt === null ? null : this.expiresAt - Date.now();
    return {
      valid: this.valid,
      hasKey: !!this.key,
      keyHint: this.key ? '••••' + this.key.slice(-4) : '',
      lastCheckedAt: this.lastCheckedAt,
      error: this.lastError,
      expiresAt: this.expiresAt,
      msLeft,
      daysLeft: msLeft === null ? null : Math.max(0, Math.floor(msLeft / 86400000))
    };
  }

  // Cập nhật ngày hết hạn; đổi thì phát 'change' để giao diện cập nhật realtime.
  _setExpiry(ms) {
    const next = ms === undefined ? null : ms;
    if (next === this.expiresAt) return;
    this.expiresAt = next;
    this.emit('change', this.status(), this.valid);
  }

  _setValid(next, error) {
    const changed = next !== this.valid || (error || '') !== this.lastError;
    const wasValid = this.valid;
    this.valid = next;
    this.lastError = error || '';
    if (changed) this.emit('change', this.status(), wasValid);
  }

  // Trả về { valid } khi server trả lời rõ ràng; throw khi lỗi mạng/phản hồi lạ.
  async _remoteVerify(key) {
    if (!this.url) throw new Error('Chưa cấu hình license.url trong config.json.');
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // API KeyVault chỉ nhận cùng origin; Node không tự gửi Origin nên phải thêm tay.
          Origin: this.origin || new URL(this.url).origin,
          'Sec-Fetch-Site': 'same-origin'
        },
        body: JSON.stringify({ action: 'verifyKey', key }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      throw new Error('Không kết nối được máy chủ key: ' + (e.cause && e.cause.code ? e.cause.code : e.message));
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error('Máy chủ key trả về dữ liệu lạ (HTTP ' + res.status + '). Nếu site Netlify đang bật mật khẩu bảo vệ thì API sẽ bị chặn.');
    }
    if (res.status === 429) throw new Error('Máy chủ key đang giới hạn tần suất (429).');
    if (typeof json.valid !== 'boolean') throw new Error(json.error || 'Phản hồi không hợp lệ (HTTP ' + res.status + ').');
    return { valid: json.valid, expiresAt: readExpiry(json) };
  }

  // Người dùng nhập key: kiểm tra ngay, đúng thì lưu và bắt đầu kiểm tra định kỳ.
  async activate(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) throw new Error('Hãy nhập key.');
    if (key.length > 300) throw new Error('Key không hợp lệ.');
    const result = await this._remoteVerify(key);
    if (!result.valid) throw new Error('Key không hợp lệ hoặc đã hết hạn.');
    this.key = key;
    this._save();
    this.failCount = 0;
    this.lastCheckedAt = Date.now();
    this.expiresAt = result.expiresAt;
    this._setValid(true, '');
    this._schedule();
    return this.status();
  }

  deactivate() {
    this.key = '';
    this.expiresAt = null;
    this.failCount = 0;
    try { fs.unlinkSync(this.filePath); } catch (_) {}
    this._unschedule();
    this._setValid(false, '');
    return this.status();
  }

  async recheck() {
    if (!this.key || this.checking) return;
    this.checking = true;
    try {
      const result = await this._remoteVerify(this.key);
      this.lastCheckedAt = Date.now();
      this.failCount = 0;
      this._setExpiry(result.expiresAt);
      if (result.valid) this._setValid(true, '');
      else this._setValid(false, 'Key đã hết hạn hoặc bị thu hồi.');
    } catch (e) {
      this.failCount += 1;
      if (this.failCount > this.graceFailures) this._setValid(false, e.message);
      else this.lastError = e.message; // vẫn cho chạy trong thời gian ân hạn
    } finally {
      this.checking = false;
    }
  }

  _schedule() {
    this._unschedule();
    // Lệch pha ngẫu nhiên để nhiều key không cùng gọi KeyVault một lúc.
    const jitter = Math.floor(Math.random() * this.recheckMs);
    this.timer = setTimeout(() => {
      this.recheck();
      this.timer = setInterval(() => { this.recheck(); }, this.recheckMs);
      if (this.timer.unref) this.timer.unref();
    }, jitter);
    if (this.timer.unref) this.timer.unref();
  }

  _unschedule() {
    if (this.timer) { clearInterval(this.timer); clearTimeout(this.timer); }
    this.timer = null;
  }

  // Giải phóng timer (không xóa key đã lưu).
  destroy() { this._unschedule(); }

  // Gọi lúc khởi động: có key đã lưu thì kiểm tra lại ngay.
  async start() {
    if (!this.key) return this.status();
    try {
      const result = await this._remoteVerify(this.key);
      this.lastCheckedAt = Date.now();
      this.expiresAt = result.expiresAt;
      this._setValid(!!result.valid, result.valid ? '' : 'Key đã hết hạn hoặc bị thu hồi.');
    } catch (e) {
      this._setValid(false, e.message); // khởi động mà không xác minh được thì không chạy
    }
    this._schedule();
    return this.status();
  }
}

module.exports = { LicenseManager };