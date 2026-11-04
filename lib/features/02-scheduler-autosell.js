// FEATURE MODULE: 02-scheduler-autosell.js
// Scheduled bot downtime and auto-sell configuration/helpers.
// Loaded in order by ../runtime-loader.js; shares the single runtime scope.

// ===================== LỊCH NGHỈ (giờ máy VPS - local time) =====================
// Mặc định: 04:20 out hết, 05:05 vô lại hết. Có nút bật/tắt + chỉnh giờ trên web.
const outActive = new Set()   // ownerId đang trong giờ nghỉ -> chặn auto-reconnect bot của họ
const _schedLast = new Map()  // ownerId -> { out, in } ngày đã chạy
const isOutActive = (username) => outActive.has(ownerOf(username))

function _schedTodayStr(d) {
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}
function _schedHM(d) {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return h + ':' + m
}
function _normHM(s, fallback) {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(s || ''))
  if (!m) return fallback
  let h = Math.min(23, Math.max(0, parseInt(m[1], 10)))
  let mi = Math.min(59, Math.max(0, parseInt(m[2], 10)))
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
}

function scheduledOutNow(ownerId) {
  const sch = auth.prefsOf(ownerId).schedule
  let count = 0
  for (const cfg of BOT_LIST) {
    if (cfg.ownerId !== ownerId) continue
    const s = botStates[cfg.username]
    if (s && s.bot && !s.isDead) {
      try { if (s.reconnectTimer) clearTimeout(s.reconnectTimer) } catch (e) {}
      try { stopSellLoop(s, true) } catch (e) {}
      s.manualDisconnect = true
      s.isDead = true
      s.inCluster = false
      stopStatsAutoCheck(s)
      s.isLoggingIn = false
      s.pendingWindow = null
      s.pendingAutoClick = null
      try { s.bot.removeAllListeners('kicked') } catch (e) {}
      try { s.bot.removeAllListeners('end') } catch (e) {}
      try { s.bot.removeAllListeners('error') } catch (e) {}
      try { if (s.bot.end) s.bot.end() } catch (e) {}
      count++
    }
  }
  outActive.add(ownerId)
  log('SYSTEM', 'SCHEDULE', `😴 Lịch nghỉ ${sch.outTime}: đã out ${count} bot — nghỉ tới ${sch.inTime} (giờ máy VPS)`, ownerId)
  webhookSchedule('😴 BOT NGHỈ THEO LỊCH (' + sch.outTime + ')', 'Đã out **' + count + '** bot. Sẽ tự vô lại lúc **' + sch.inTime + '** (giờ máy VPS).', 0xffd60a, ownerId)
}

async function scheduledInNow(ownerId) {
  const sch = auth.prefsOf(ownerId).schedule
  outActive.delete(ownerId)
  const mine = BOT_LIST.filter(c => c.ownerId === ownerId && c.username)
  log('SYSTEM', 'SCHEDULE', `⏰ Tới giờ ${sch.inTime}: vô lại ${mine.length} bot (giờ máy VPS)`, ownerId)
  webhookSchedule('⏰ HẾT GIỜ NGHỈ — BOT VÔ LẠI (' + sch.inTime + ')', 'Đang login lại **' + mine.length + '** bot...', 0x32d74b, ownerId)
  for (const cfg of mine) {
    try {
      const cur = botStates[cfg.username]
      if (cur && !cur.isDead && cur.inCluster) continue // đang online thì bỏ qua
      createBot(cfg.username, { manual: true })
    } catch (e) {}
    await new Promise(r => setTimeout(r, 8000))
  }
}

setInterval(() => {
  try {
    const now = new Date() // giờ máy VPS (local)
    const hm = _schedHM(now)
    const today = _schedTodayStr(now)
    for (const uid of new Set(BOT_LIST.map(b => b.ownerId).filter(Boolean))) {
      const sch = auth.prefsOf(uid).schedule
      if (!sch.enabled) continue
      const last = _schedLast.get(uid) || { out: '', in: '' }
      _schedLast.set(uid, last)
      if (hm === _normHM(sch.outTime, '04:20') && last.out !== today) {
        last.out = today
        scheduledOutNow(uid)
      } else if (hm === _normHM(sch.inTime, '05:05') && last.in !== today) {
        last.in = today
        scheduledInNow(uid).catch(() => {})
      }
    }
  } catch (e) {}
}, 20 * 1000)

// ===================== AUTO SELL (riêng từng bot) =====================
// - User nhập item/block tiếng Anh (VD: cobblestone, wheat, cactus) -> lưu per-bot
// - Bật lên: bot gõ /sell, GUI mở ra -> shift-click hết đồ khớp sang inv trên
// - Mode 'full': inv trên đầy >= 43 slot -> click 1 slot hàng cuối, đợi 0.5s,
//   click slot dưới-cùng-bên-trái, lặp lại
// - Mode 'timer': mỗi N giây tự click 1 slot hàng cuối (không cần đợi đầy 43)
const SELL_FULL_THRESHOLD = 43
const SELL_CLICK_DELAY_MS = 500
const SELL_TICK_MS = 500
const SELL_OPEN_RETRY_MS = 5000
const SELL_MOVE_DELAY_MS = 50
const SELL_MOVE_PER_TICK = 15 // mỗi tick chuyển tối đa 15 stack, tick sau chuyển tiếp
const SELL_WAIT_LOG_MS = 30 * 1000 // hết đồ thì 30s mới log "đang đợi" 1 lần, tránh spam

let AUTOSELL = {}
try {
  if (CONFIG.AUTOSELL && typeof CONFIG.AUTOSELL === 'object') {
    for (const k of Object.keys(CONFIG.AUTOSELL)) {
      const v = CONFIG.AUTOSELL[k] || {}
      AUTOSELL[k] = sanitizeSellCfg(v)
    }
  }
} catch (e) {}

function sanitizeSellCfg(v) {
  v = v || {}
  let items = []
  if (Array.isArray(v.items)) items = v.items
  else if (typeof v.items === 'string') items = v.items.split(',')
  items = items.map(s => String(s || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')).filter(s => /^[a-z0-9_]{2,40}$/.test(s)).slice(0, 30)
  let mode = v.mode === 'timer' ? 'timer' : 'full'
  let intervalSec = parseInt(v.intervalSec, 10)
  if (isNaN(intervalSec)) intervalSec = 60
  intervalSec = Math.min(3600, Math.max(5, intervalSec))
  return { enabled: !!v.enabled, items, mode, intervalSec, pay: sanitizePayCfg(v.pay), home: sanitizeHomeCfg(v.home) }
}

// ----- Tự động chuyển tiền (/pay) + tự về /home: lưu chung trong cấu hình của từng bot -----
// (Không dùng const ở đây: hàm này được gọi lúc nạp config, trước khi các const phía dưới được khởi tạo)
function parseCoord(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/\s+/g, '').replace(',', '.'))   // chấp nhận 416039,7 lẫn 416039.7
  return Number.isFinite(n) && Math.abs(n) < 3e7 ? Math.round(n * 100) / 100 : null
}
function sanitizePayCfg(v) {
  v = (v && typeof v === 'object') ? v : {}
  let to = String(v.to == null ? '' : v.to).trim()
  if (!/^[A-Za-z0-9_.]{3,16}$/.test(to)) to = ''
  const mode = (v.mode === 'random' || v.mode === 'fixed') ? v.mode : 'all'
  let intervalSec = parseInt(v.intervalSec, 10)
  if (isNaN(intervalSec)) intervalSec = 60
  intervalSec = Math.min(86400, Math.max(10, intervalSec))
  let minM = parseInt(v.minM, 10); if (isNaN(minM)) minM = 1
  let maxM = parseInt(v.maxM, 10); if (isNaN(maxM)) maxM = 5
  minM = Math.min(100000, Math.max(1, minM))
  maxM = Math.min(100000, Math.max(1, maxM))
  if (maxM < minM) { const t = minM; minM = maxM; maxM = t }
  let amount = Math.floor(Number(String(v.amount == null ? '' : v.amount).replace(/[,\s]/g, '')))
  if (!Number.isFinite(amount) || amount < 1) amount = 1000000
  amount = Math.min(1e13, amount)
  const webhook = String(v.webhook == null ? '' : v.webhook).trim().slice(0, 300)   // kiểm tra hợp lệ ở API (isDiscordWebhook)
  return { enabled: !!v.enabled, to, mode, intervalSec, minM, maxM, amount, webhook }
}
function sanitizeHomeCfg(v) {
  v = (v && typeof v === 'object') ? v : {}
  let name = String(v.name == null ? '' : v.name).trim()
  if (!/^[A-Za-z0-9_\-]{1,32}$/.test(name)) name = ''
  return { enabled: !!v.enabled, x: parseCoord(v.x), y: parseCoord(v.y), z: parseCoord(v.z), name }
}

function getSellCfg(username) {
  if (!AUTOSELL[username]) AUTOSELL[username] = { enabled: false, items: [], mode: 'full', intervalSec: 60, pay: sanitizePayCfg({}), home: sanitizeHomeCfg({}) }
  return AUTOSELL[username]
}
function getPayCfg(username) {
  const c = getSellCfg(username)
  if (!c.pay) c.pay = sanitizePayCfg({})
  return c.pay
}
function getHomeCfg(username) {
  const c = getSellCfg(username)
  if (!c.home) c.home = sanitizeHomeCfg({})
  return c.home
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function sellNorm(s) {
  return String(s || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
}

function sellMatch(item, items) {
  if (!item || !items || items.length === 0) return false
  const names = [sellNorm(item.name), sellNorm(item.displayName)]
  for (const want of items) {
    const w = sellNorm(want)
    if (!w) continue
    for (const n of names) {
      if (n === w || n.endsWith('_' + w) || w.endsWith('_' + n)) return true
    }
  }
  return false
}

function sellGuiSize(win) {
  // prismarine-windows: slot 0..inventoryStart-1 là inv trên (shop/rương),
  // từ inventoryStart trở đi là balo player -> đây là cách tách chuẩn nhất
  try {
    if (win && typeof win.inventoryStart === 'number' && win.inventoryStart > 0) return win.inventoryStart
    const total = (win.slots || []).length
    if (win.inventorySlots && win.inventorySlots.length) return total - win.inventorySlots.length
    if (typeof win.capacity === 'number' && win.capacity > 0 && win.capacity < total) return win.capacity
    if (total > 36) return total - 36 // fallback: trừ 36 ô balo player
  } catch (e) {}
  return (win.slots || []).length
}

// Tên GUI server gửi dạng JSON {"text":"..."} -> bóc ra chữ thường để hiện lên web/log
function plainTitle(t) {
  const s = String(t == null ? '' : t).trim()
  if (!s) return 'Unknown'
  if (s[0] !== '{' && s[0] !== '[') return s.slice(0, 100)
  try {
    const o = JSON.parse(s)
    const texts = []
    const walk = (n) => {
      if (!n) return
      if (typeof n === 'string') { texts.push(n); return }
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (typeof n.text === 'string') texts.push(n.text)
      if (Array.isArray(n.extra)) n.extra.forEach(walk)
    }
    walk(o)
    const out = texts.join('').trim()
    return (out || s).slice(0, 100)
  } catch (e) { return s.slice(0, 100) }
}

function sellCountTop(win, guiSize) {
  let n = 0
  const arr = win.slots || []
  for (let i = 0; i < guiSize && i < arr.length; i++) {
    if (arr[i]) n++
  }
  return n
}

// Slot bán chốt cứng: click 1 = slot cuối hàng cuối inv trên (VD 53),
// click 2 = slot trái-cuối (VD 45). Tính tương đối theo guiSize để đúng mọi size GUI.
function sellClickSlots(guiSize) {
  return { first: Math.max(0, guiSize - 1), second: Math.max(0, guiSize - 9) }
}