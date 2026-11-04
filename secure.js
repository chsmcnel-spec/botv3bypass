'use strict';
// Mã hóa dữ liệu nhạy cảm (mật khẩu Minecraft, key đã lưu) bằng AES-256-GCM.
// Khóa gốc lấy từ biến môi trường KINGSMP_SECRET, nếu không có thì tự sinh vào data/secret.key (chmod 600).
// CẦN SAO LƯU file này: mất nó thì không giải mã được mật khẩu đã lưu.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadSecret(dataDir) {
  if (process.env.KINGSMP_SECRET) return String(process.env.KINGSMP_SECRET);
  const file = path.join(dataDir, 'secret.key');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch (_) { /* chưa có */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function makeCipher(secret) {
  const key = crypto.createHash('sha256').update('kingsmp:' + secret).digest();
  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(String(text === undefined ? '' : text), 'utf8'), c.final()]);
      return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    // Chuỗi không có tiền tố enc1: (dữ liệu cũ chưa mã hóa) được trả nguyên.
    decrypt(value) {
      const s = String(value === undefined || value === null ? '' : value);
      if (!s.startsWith('enc1:')) return s;
      const buf = Buffer.from(s.slice(5), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    }
  };
}

const identityCipher = { encrypt: (t) => String(t), decrypt: (t) => String(t) };
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

module.exports = { loadSecret, makeCipher, identityCipher, sha256 };
