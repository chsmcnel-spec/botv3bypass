// FEATURE MODULE: 07-resource-pack.js
// Tự động nạp Resource Pack từ public/resource-pack/: quét, xoá audio, parse model/blockstate,
// sinh manifest + cache + pack.zip và mở endpoint /rp/* cho web/game client.
// Loaded in order by ../runtime-loader.js; shares the single runtime scope.

// ===================== RESOURCE PACK (public/resource-pack) =====================
// Admin chỉ cần copy RP đã giải nén vào public/resource-pack/ (có pack.mcmeta + assets/).
// Tuỳ chọn trong config.json: RP_PURGE_AUDIO (mặc định true), RP_BUILD_ZIP (true), RP_POLL_SEC (15, 0 = tắt tự quét),
// RP_CLIENT_VERSION ('1.21.11': áp dụng overlay_* có version <= bản này), RP_CORS (true), RP_ADMIN_IDS (mảng userId được xem report / quét lại; rỗng = mọi tài khoản panel).
const { createResourcePack } = require('./lib/resourcepack')

const RP_ROOT = path.join(__dirname, 'public', 'resource-pack')
const resourcePack = createResourcePack({
  rootDir: RP_ROOT,
  cacheDir: path.join(DATA_DIR, 'rp-cache'),
  purgeAudio: CONFIG.RP_PURGE_AUDIO !== false,
  buildZip: CONFIG.RP_BUILD_ZIP !== false,
  clientVersion: CONFIG.RP_CLIENT_VERSION || '1.21.11',
  pollSec: CONFIG.RP_POLL_SEC == null ? 15 : CONFIG.RP_POLL_SEC,
  log: (level, msg) => {
    const line = '[RESOURCEPACK] ' + msg
    if (level === 'error') console.error(line)
    else console.log(line)
  }
})

const _rpAdmins = Array.isArray(CONFIG.RP_ADMIN_IDS) ? CONFIG.RP_ADMIN_IDS.map(String) : []
resourcePack.install(app, {
  express,
  cors: CONFIG.RP_CORS !== false,
  canAdmin: (req) => _rpAdmins.length === 0 || _rpAdmins.includes(String(req.userId))
})

resourcePack.start().catch((e) => console.error('❌ Resource Pack lỗi khởi động:', e.message))
