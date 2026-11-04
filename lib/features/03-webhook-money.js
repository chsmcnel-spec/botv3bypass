// FEATURE MODULE: 03-webhook-money.js
// Discord webhook integration, bot events and money-history storage.
// Loaded in order by ../runtime-loader.js; shares the single runtime scope.

// ===================== WEBHOOK (giao diện embed y hệt main.js) =====================
// Webhook là cài đặt riêng từng tài khoản panel (auth.prefsOf(owner).webhook). File webhook.json cũ chỉ dùng để chuyển cho người nhận lại acc cũ.
// Mỗi bot có ĐÚNG 1 tin nhắn trên Discord: lần đầu gửi mới, các lần sau chỉ SỬA tin đó (PATCH).
// Các sự kiện (nhận/chuyển tiền, kick, reconnect, TPA, auto sell, lịch nghỉ...) hiện ở mục "Hoạt động gần đây" của tin nhắn.
const LEGACY_WEBHOOK = (() => { try { return JSON.parse(fs.readFileSync(WEBHOOK_PATH, 'utf8')).url || '' } catch (e) { return '' } })()

const messageStoreFile = path.join(DATA_DIR, 'webhook-messages.json')
const WEBHOOK_REFRESH_MS = 30 * 1000        // chu kỳ cập nhật tin nhắn khi đang chạy
const WEBHOOK_FORCE_MS = 5 * 60 * 1000      // dù nội dung không đổi vẫn làm mới sau chừng này
const MAX_BOT_EVENTS = 6                    // số dòng "Hoạt động gần đây"
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'])

const botSessions = new Map()               // 'owner:bot' -> { status, since, money0 }
const botEvents = new Map()                 // 'owner:bot' -> [{ ts, icon, text }]
const refreshState = new Map()              // 'owner:bot' -> { running, dirty, lastHash, lastSent, lastTick }
let messageStore = {}                       // 'owner:bot' -> { hook, id }
// Đọc file chính; nếu hỏng/thiếu (restart giữa lúc ghi) thì thử bản .bak để không mất id tin nhắn -> tránh gửi tin mới
for (const f of [messageStoreFile, messageStoreFile + '.bak']) {
  try { messageStore = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; break } catch (e) { messageStore = {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const botKey = (ownerId, username) => ownerId + ':' + username

// Lịch sử MONEY riêng từng bot, giữ tối đa 3 ngày và lưu bền qua lần restart.
const MONEY_HISTORY_FILE = path.join(DATA_DIR, 'money-history.json')
const MONEY_HISTORY_KEEP_MS = 3 * 24 * 60 * 60 * 1000
const MONEY_HISTORY_MAX_POINTS = 2200
let moneyHistory = {}
try {
  moneyHistory = JSON.parse(fs.readFileSync(MONEY_HISTORY_FILE, 'utf8')) || {}
} catch (e) { moneyHistory = {} }

function saveMoneyHistory() {
  try {
    fs.mkdirSync(path.dirname(MONEY_HISTORY_FILE), { recursive: true })
    const tmp = MONEY_HISTORY_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(moneyHistory), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, MONEY_HISTORY_FILE)
    return true
  } catch (e) {
    console.error('[MoneyHistory] Không lưu được lịch sử:', e.message)
    return false
  }
}

function pruneMoneyHistory(now = Date.now()) {
  const cutoff = now - MONEY_HISTORY_KEEP_MS
  let changed = false
  for (const key of Object.keys(moneyHistory)) {
    const old = Array.isArray(moneyHistory[key]) ? moneyHistory[key] : []
    const next = old.filter(p => p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.v)) && Number(p.t) >= cutoff)
      .slice(-MONEY_HISTORY_MAX_POINTS)
    if (next.length !== old.length) changed = true
    if (next.length) moneyHistory[key] = next
    else { delete moneyHistory[key]; changed = true }
  }
  return changed
}

// Ghi một điểm khi server trả số dư. Không lưu lặp cùng giá trị quá dày.
function recordMoneySample(username, value, timestamp = Date.now()) {
  const amount = typeof value === 'number' ? value : parseBalance(value)
  if (!Number.isFinite(amount)) return false
  const ownerId = ownerOf(username)
  if (!ownerId) return false
  const key = botKey(ownerId, username)
  if (!Array.isArray(moneyHistory[key])) moneyHistory[key] = []
  const points = moneyHistory[key]
  const last = points[points.length - 1]
  if (last && Number(last.v) === amount && timestamp - Number(last.t) < 10 * 60 * 1000) return false
  points.push({ t: Number(timestamp) || Date.now(), v: amount })
  const cutoff = Date.now() - MONEY_HISTORY_KEEP_MS
  moneyHistory[key] = points.filter(p => p.t >= cutoff).slice(-MONEY_HISTORY_MAX_POINTS)
  saveMoneyHistory()
  return true
}

function getMoneyHistory(ownerId, username) {
  const key = botKey(ownerId, username)
  const cutoff = Date.now() - MONEY_HISTORY_KEEP_MS
  const points = (moneyHistory[key] || []).filter(p => p && Number(p.t) >= cutoff && Number.isFinite(Number(p.v)))
  return points.map(p => ({ t: Number(p.t), v: Number(p.v) }))
}

function getMoneyPerHour(points) {
  if (!Array.isArray(points) || points.length < 2) return null
  const last = points[points.length - 1]
  // Ưu tiên so với điểm gần nhất trong vòng 2 giờ; tránh lấy mẫu quá cũ gây sai rate.
  let base = null
  for (let i = points.length - 2; i >= 0; i--) {
    const gap = last.t - points[i].t
    if (gap >= 5 * 60 * 1000 && gap <= 2 * 60 * 60 * 1000) { base = points[i]; break }
    if (gap > 2 * 60 * 60 * 1000) break
  }
  if (!base) return null
  return ((last.v - base.v) / (last.t - base.t)) * 60 * 60 * 1000
}

// Dọn dữ liệu cũ ngay khi khởi động và định kỳ; file chỉ giữ lịch sử tối đa 3 ngày.
if (pruneMoneyHistory()) saveMoneyHistory()
const moneyHistoryPruneTimer = setInterval(() => {
  if (pruneMoneyHistory()) saveMoneyHistory()
}, 60 * 60 * 1000)
if (moneyHistoryPruneTimer && typeof moneyHistoryPruneTimer.unref === 'function') moneyHistoryPruneTimer.unref()

// ===================== PHÂN TÍCH BOT (hoạt động / thu nhập / uptime / chỉ số) =====================
// Dữ liệu cho Discord Bot điều khiển (07-discord-control.js): lưu bền, giữ tối đa 3 ngày.
const ANALYTICS_FILE = path.join(DATA_DIR, 'bot-analytics.json')
const ANALYTICS_KEEP_MS = MONEY_HISTORY_KEEP_MS
const ACTIVITY_KEEP = 80
let analytics = {}
try { analytics = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8')) || {} } catch (e) { analytics = {} }
let _anTimer = null
function saveAnalyticsNow() {
  try {
    fs.mkdirSync(path.dirname(ANALYTICS_FILE), { recursive: true })
    const tmp = ANALYTICS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(analytics), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, ANALYTICS_FILE)
  } catch (e) {}
}
function saveAnalyticsSoon() {
  if (_anTimer) return
  _anTimer = setTimeout(() => { _anTimer = null; saveAnalyticsNow() }, 4000)
  if (_anTimer.unref) _anTimer.unref()
}
function analyticsOf(key) {
  let a = analytics[key]
  if (!a || typeof a !== 'object') a = analytics[key] = {}
  if (!Array.isArray(a.activity)) a.activity = []
  if (!Array.isArray(a.income)) a.income = []
  if (!Array.isArray(a.sessions)) a.sessions = []
  if (!a.since) a.since = Date.now()
  if (a.open === undefined) a.open = null
  return a
}
// Khởi động lại process: phiên online dang dở được khép lại tại lần cuối còn thấy bot.
for (const key of Object.keys(analytics)) {
  const a = analyticsOf(key)
  if (a.open) { a.sessions.push({ s: a.open.s, e: a.open.seen || a.open.s }); a.open = null }
}
function pruneAnalytics(now = Date.now()) {
  const cutoff = now - ANALYTICS_KEEP_MS
  for (const key of Object.keys(analytics)) {
    const a = analyticsOf(key)
    a.income = a.income.filter(x => x && x.t >= cutoff)
    a.sessions = a.sessions.filter(x => x && x.e >= cutoff)
    a.activity = a.activity.slice(0, ACTIVITY_KEEP)
  }
}
pruneAnalytics(); saveAnalyticsNow()
const analyticsPruneTimer = setInterval(() => { pruneAnalytics(); saveAnalyticsSoon() }, 60 * 60 * 1000)
if (analyticsPruneTimer.unref) analyticsPruneTimer.unref()

function recordActivity(key, icon, text) {
  const a = analyticsOf(key)
  a.activity.unshift({ t: Date.now(), icon, text: clip(text, 200) })
  if (a.activity.length > ACTIVITY_KEEP) a.activity.length = ACTIVITY_KEEP
  saveAnalyticsSoon()
}
function recordIncome(ownerId, username, dir, who, amount) {
  if (!ownerId || !Number.isFinite(amount) || amount <= 0) return
  const a = analyticsOf(botKey(ownerId, username))
  a.income.push({ t: Date.now(), dir, who: String(who || '?').slice(0, 20), amt: amount })
  saveAnalyticsSoon()
}
function analyticsStatus(key, prev, status, now) {
  const a = analyticsOf(key)
  if (prev === 'online' && a.open) { a.sessions.push({ s: a.open.s, e: now }); a.open = null; saveAnalyticsSoon() }
  if (status === 'online' && !a.open) { a.open = { s: now, seen: now }; saveAnalyticsSoon() }
}
function touchAnalytics(key, status, now) {
  const a = analyticsOf(key)
  if (status === 'online' && a.open) a.open.seen = now
  if (!a._lastSave || now - a._lastSave > 60000) { a._lastSave = now; saveAnalyticsSoon() }
}
function getActivity(ownerId, username, n = 15) { return analyticsOf(botKey(ownerId, username)).activity.slice(0, n) }

// Thu nhập: tổng nhận / chuyển theo cửa sổ thời gian + top người gửi + giao dịch gần đây
function incomeStats(ownerId, username, now = Date.now()) {
  const list = analyticsOf(botKey(ownerId, username)).income
  const win = (ms) => {
    let inn = 0, out = 0, cin = 0, cout = 0
    for (const x of list) if (x.t >= now - ms) { if (x.dir === 'in') { inn += x.amt; cin++ } else { out += x.amt; cout++ } }
    return { in: inn, out, cin, cout }
  }
  const senders = new Map()
  for (const x of list) if (x.dir === 'in' && x.t >= now - 24 * 3600000) senders.set(x.who, (senders.get(x.who) || 0) + x.amt)
  const top = [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  return { h1: win(3600000), h6: win(6 * 3600000), h24: win(24 * 3600000), d3: win(3 * 86400000), top, recent: list.slice(-6).reverse() }
}
// Chênh lệch số dư trong cửa sổ ms (theo lịch sử money), null nếu chưa đủ dữ liệu
function moneyDelta(points, ms, now = Date.now()) {
  if (!Array.isArray(points) || points.length < 2) return null
  const from = now - ms
  let base = null
  for (const p of points) { if (p.t <= from) base = p; else break }
  if (!base) base = points[0]
  const last = points[points.length - 1]
  if (last.t - base.t < 60000) return null
  return { delta: last.v - base.v, perHour: ((last.v - base.v) / (last.t - base.t)) * 3600000, spanMs: last.t - base.t }
}
// Uptime online: phiên hiện tại, tổng online 24h / 3 ngày, số lần rớt, phiên dài nhất
function uptimeStats(ownerId, username, now = Date.now()) {
  const a = analyticsOf(botKey(ownerId, username))
  const segs = a.sessions.map(x => ({ s: x.s, e: x.e }))
  if (a.open) segs.push({ s: a.open.s, e: now })
  const win = (ms) => {
    const from = now - ms
    let on = 0
    for (const g2 of segs) { const s0 = Math.max(g2.s, from), e0 = Math.min(g2.e, now); if (e0 > s0) on += e0 - s0 }
    const span = Math.min(ms, Math.max(60000, now - a.since))
    return { on, span, pct: Math.min(100, (on / span) * 100) }
  }
  const drops24 = a.sessions.filter(x => x.e >= now - 24 * 3600000).length
  let longest = 0
  for (const g2 of segs) longest = Math.max(longest, g2.e - g2.s)
  return { current: a.open ? now - a.open.s : 0, h24: win(24 * 3600000), d3: win(3 * 86400000), drops24, longest, tracked: now - a.since }
}

// Lịch sử chỉ số (ping/TPS/máu/đói) mỗi 30s, giữ 1 giờ trong RAM — cho biểu đồ mini
const VITALS_EVERY_MS = 30 * 1000
const VITALS_KEEP = 120
const vitalsHist = new Map()
function sampleVitals(key, username, status, now) {
  if (status !== 'online') return
  let h = vitalsHist.get(key)
  if (!h) { h = { last: 0, pts: [], lowHpAt: 0 }; vitalsHist.set(key, h) }
  if (now - h.last < VITALS_EVERY_MS) return
  h.last = now
  const st = botStates[username]
  const bot = st && st.bot
  const p = { t: now, ping: g(() => bot.player.ping), tps: tpsOf(st), hp: g(() => bot.health), food: g(() => bot.food) }
  h.pts.push(p)
  if (h.pts.length > VITALS_KEEP) h.pts.shift()
  // Máu thấp -> ghi vào hoạt động (và cảnh báo Discord), tối đa 1 lần / 5 phút
  if (Number.isFinite(p.hp) && p.hp > 0 && p.hp <= 6 && now - h.lowHpAt > 5 * 60 * 1000) {
    h.lowHpAt = now
    const ownerId = key.slice(0, key.indexOf(':'))
    pushBotEvent(ownerId, username, '❤️', 'Máu thấp: ' + fmtNum(p.hp) + ' / 20')
  }
}
function getVitals(ownerId, username) { const h = vitalsHist.get(botKey(ownerId, username)); return h ? h.pts : [] }

function saveMessageStore() {
  try {
    fs.mkdirSync(path.dirname(messageStoreFile), { recursive: true })
    const tmp = messageStoreFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(messageStore, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { fs.copyFileSync(messageStoreFile, messageStoreFile + '.bak') } catch (e) {}
    fs.renameSync(tmp, messageStoreFile)
  } catch (e) { console.error('[Webhook] Không lưu được webhook-messages.json — restart sẽ gửi tin mới:', e.message) }
}

function discordWebhookUrl(ownerId) {
  try { return String(auth.prefsOf(ownerId).webhook || '').trim() } catch (e) { return '' }
}
function isDiscordWebhook(value) {
  try {
    const u = new URL(String(value))
    return u.protocol === 'https:' && DISCORD_HOSTS.has(u.hostname) && /^\/api(\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(u.pathname)
  } catch (e) { return false }
}
function hasWebhook(ownerId) {
  const url = discordWebhookUrl(ownerId)
  return !!url && isDiscordWebhook(url)
}
function webhookBase(url) { const u = new URL(url); return u.origin + u.pathname.replace(/\/+$/, '') }
function hookTag(url) { return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 12) }

// ---------- gọi API Discord (có retry khi bị rate limit 429 / lỗi mạng / 5xx) ----------
function discordRequest(method, urlStr, payload, extraHeaders) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr) } catch (e) { return resolve({ status: 0 }) }
    const body = payload ? Buffer.from(JSON.stringify(payload)) : null
    const headers = { 'User-Agent': 'KingSMP-Panel/1.0' }
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length }
    if (extraHeaders) Object.assign(headers, extraHeaders)
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: 8000 }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { if (data.length < 65536) data += c })
      res.on('end', () => {
        let json = null; try { json = data ? JSON.parse(data) : null } catch (e) {}
        let retryAfter = 0
        if (res.statusCode === 429) retryAfter = Math.ceil((Number(json && json.retry_after) || Number(res.headers['retry-after']) || 1) * 1000)
        resolve({ status: res.statusCode, json, retryAfter })
      })
    })
    req.on('timeout', () => req.destroy(new Error('Webhook timeout')))
    req.on('error', () => resolve({ status: 0 }))
    req.end(body || undefined)
  })
}
async function discordRequestRetry(method, url, payload, tries = 3, extraHeaders) {
  let r = { status: 0 }
  for (let i = 0; i < tries; i++) {
    r = await discordRequest(method, url, payload, extraHeaders)
    if (r.status === 429) { await sleep(Math.min(Math.max(r.retryAfter, 500), 15000)); continue }
    if (r.status === 0 || r.status >= 500) { await sleep(1000 * (i + 1)); continue }
    return r
  }
  return r
}

// Gửi tin mới (lần đầu) hoặc sửa tin cũ. Nếu tin cũ bị xóa trên Discord (404) thì tự gửi lại tin mới.
async function upsertDiscordMessage(ownerId, username, embed) {
  const url = discordWebhookUrl(ownerId)
  if (!url || !isDiscordWebhook(url)) return false
  const base = webhookBase(url)
  const key = botKey(ownerId, username), tag = hookTag(url)
  const payload = { embeds: [embed], allowed_mentions: { parse: [] } }
  const saved = messageStore[key]
  if (saved && saved.hook === tag && saved.id) {
    const r = await discordRequestRetry('PATCH', base + '/messages/' + saved.id, payload)
    if (r.status >= 200 && r.status < 300) return true
    if (r.status !== 404) return false          // lỗi khác: giữ nguyên id, thử lại sau
  }
  const r = await discordRequestRetry('POST', base + '?wait=true', payload)
  if (r.status >= 200 && r.status < 300 && r.json && r.json.id) {
    messageStore[key] = { hook: tag, id: String(r.json.id) }
    saveMessageStore()
    return true
  }
  return false
}
// Xóa tin nhắn đã gửi của bot (khi gỡ/đổi webhook hoặc xoá bot) để không để lại tin "chết" trong kênh.
// urlOverride: URL webhook CŨ (khi vừa đổi sang URL mới).
function dropBotMessage(ownerId, username, urlOverride) {
  const key = botKey(ownerId, username)
  const url = urlOverride || discordWebhookUrl(ownerId)
  const saved = messageStore[key]
  refreshState.delete(key)
  if (!saved) return
  delete messageStore[key]
  saveMessageStore()
  if (url && isDiscordWebhook(url) && saved.id && saved.hook === hookTag(url)) discordRequestRetry('DELETE', webhookBase(url) + '/messages/' + saved.id, null, 2)
}

// ---------- thu thập thông số bot ----------
const g = (fn) => { try { const v = fn(); return v === undefined ? null : v } catch (e) { return null } }
const fmtNum = (n) => Number.isFinite(n) ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }) : 'N/A'
const signed = (n) => (n >= 0 ? '+' : '-') + fmtNum(Math.abs(n))
const compact = (n) => {
  const a = Math.abs(n)
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(Math.round(n))
}
const bar = (v, max, len = 10) => {
  if (!Number.isFinite(v) || !max) return ''
  const filled = Math.max(0, Math.min(len, Math.round((v / max) * len)))
  return '▰'.repeat(filled) + '▱'.repeat(len - filled)
}
const clip = (s, n = 1000) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const statusLabel = (s) => ({ online: 'Đang online', offline: 'Offline', connecting: 'Đang kết nối', starting: 'Đang khởi động' }[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Không rõ'))

// Số dư của login.js là chuỗi kiểu "1,234.5K" -> đổi ra số để tính chênh lệch / giờ
function parseBalance(v) {
  const m = /^\s*([\d,\.]+)\s*([KMB]?)\s*$/i.exec(String(v == null ? '' : v))
  if (!m) return null
  const n = parseFloat(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  return n * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1)
}

function botStatusOf(s) {
  if (!s || !s.bot || s.isDead) return 'offline'
  if (s.inCluster) return 'online'
  return 'connecting'
}

function ensureSession(key, status) {
  let s = botSessions.get(key)
  if (!s) { s = { status, since: Date.now(), money0: null }; botSessions.set(key, s); analyticsStatus(key, undefined, status, s.since); return { session: s, previous: undefined } }
  if (s.status !== status) {
    const previous = s.status
    s = { status, since: Date.now(), money0: null }
    botSessions.set(key, s)
    analyticsStatus(key, previous, status, s.since)
    return { session: s, previous }
  }
  return { session: s, previous: s.status }
}

// Lịch nghỉ của login.js: outTime = tắt bot, inTime = bật lại (giờ máy VPS)
function nextScheduleFor(ownerId) {
  let sch = null
  try { sch = auth.prefsOf(ownerId).schedule } catch (e) {}
  if (!sch || !sch.enabled) return null
  const now = new Date()
  let best = null
  for (const [hm, action] of [[sch.outTime, 'stop'], [sch.inTime, 'start']]) {
    const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(hm || ''))
    if (!m) continue
    let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.min(23, +m[1]), Math.min(59, +m[2]), 0)
    if (d <= now) d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, Math.min(23, +m[1]), Math.min(59, +m[2]), 0)
    if (!best || d < best.date) best = { date: d, action }
  }
  return best
}

// TPS: mineflayer không có sẵn bot.getTps() nên panel tự đo từ packet update_time (xem tpsSample ở 05)
function tpsOf(st) {
  const bot = st && st.bot
  const v = g(() => typeof bot.getTps === 'function' ? Number(bot.getTps()) : null)
  if (Number.isFinite(v)) return v
  if (st && Number.isFinite(st.tps) && Date.now() - (st.tpsAt || 0) < 30000) return st.tps
  return null
}
// Shards lấy từ GUI /stats mà panel đã quét (mục có tên chứa "shard")
function shardsOf(st) {
  try {
    const items = st && st.statsData && st.statsData.items
    if (!Array.isArray(items)) return null
    const it = items.find(x => /shard/i.test(String(x.displayName || ''))) || items.find(x => /shard/i.test(String(x.name || '')))
    if (!it) return null
    const lore = (it.lore || []).map(x => String(x || '').trim()).filter(Boolean)
    return lore.length ? lore.join(', ').slice(0, 60) : null
  } catch (e) { return null }
}

function collectBotInfo(ownerId, username) {
  const cfg = botCfg(username)
  if (!cfg || cfg.ownerId !== ownerId) return null
  const st = botStates[username]
  const bot = st && st.bot
  const status = botStatusOf(st)
  const { session } = ensureSession(botKey(ownerId, username), status)

  const money = st ? parseBalance(st.balance) : null
  if (status === 'online' && session.money0 == null && Number.isFinite(money)) session.money0 = money

  const pos = g(() => bot.entity.position)
  const held = g(() => bot.heldItem)
  return {
    username: cfg.username, status, session, money,
    ping: g(() => {
      const p = bot.player && bot.player.ping
      if (Number.isFinite(p) && p > 0) return p
      const me = bot.players && bot.players[bot.username]
      return me && Number.isFinite(me.ping) ? me.ping : (Number.isFinite(p) ? p : null)
    }),
    tps: tpsOf(st),
    shards: shardsOf(st),
    skin: skinHashOf(cfg.username),
    health: g(() => bot.health), food: g(() => bot.food), level: g(() => bot.experience.level),
    pos: pos && Number.isFinite(pos.x) ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
    dimension: g(() => String(bot.game.dimension || '')), gameMode: g(() => String(bot.game.gameMode || '')),
    players: g(() => Object.keys(bot.players || {}).length),
    invUsed: g(() => bot.inventory.items().length),
    held: held ? (held.displayName || held.name || '') + (held.count > 1 ? ' ×' + held.count : '') : null,
    server: SERVER_IP + (Number(SERVER_PORT) !== 25565 ? ':' + SERVER_PORT : ''),
    keyValid: licenseOk(username),
    next: nextScheduleFor(ownerId)
  }
}

// ---------- dựng embed (giao diện tin nhắn Discord) ----------
function buildBotEmbed(ownerId, username) {
  const i = collectBotInfo(ownerId, username)
  if (!i) return null
  const online = i.status === 'online'
  const color = online ? 0x57f287 : (i.status === 'offline' ? 0xed4245 : 0xfee75c)
  const dot = online ? '🟢' : (i.status === 'offline' ? '🔴' : '🟡')
  const sinceSec = Math.floor(i.session.since / 1000)
  const fields = []
  const add = (name, value, inline = true) => { if (value !== null && value !== undefined && String(value).trim()) fields.push({ name, value: clip(value), inline }) }

  const hours = (Date.now() - i.session.since) / 3600000
  const trend = (now, base) => (online && Number.isFinite(now) && Number.isFinite(base) && hours * 60 >= 1)
    ? '\n└ ' + signed(now - base) + ' · ' + (now - base >= 0 ? '+' : '-') + compact(Math.abs(now - base) / hours) + '/giờ' : ''
  const dim = i.dimension ? (/nether/i.test(i.dimension) ? 'Nether' : /end/i.test(i.dimension) ? 'The End' : /overworld/i.test(i.dimension) ? 'Overworld' : i.dimension) : ''

  // Hàng 1: Ping · TPS · Thế giới | Hàng 2: Máu · Đói · Vị trí | Hàng 3: Tiền · Shards · Key
  if (online) {
    const pingIcon = Number.isFinite(i.ping) ? (i.ping < 100 ? '🟢' : i.ping < 250 ? '🟡' : '🔴') : '⚪'
    const tpsIcon = Number.isFinite(i.tps) ? (i.tps >= 18 ? '🟢' : i.tps >= 15 ? '🟡' : '🔴') : '⚪'
    add('📶 Ping', pingIcon + ' **' + (Number.isFinite(i.ping) ? fmtNum(i.ping) + ' ms' : 'N/A') + '**')
    add('⚡ TPS', tpsIcon + ' **' + fmtNum(i.tps) + '** / 20')
    add('🌍 Thế giới', dim ? '**' + dim + '**' : '*N/A*')
    add('❤️ Máu', Number.isFinite(i.health) ? '`' + bar(i.health, 20) + '`\n**' + fmtNum(i.health) + '** / 20' : null)
    add('🍗 Đói', Number.isFinite(i.food) ? '`' + bar(i.food, 20) + '`\n**' + fmtNum(i.food) + '** / 20' : null)
    add('📍 Vị trí', i.pos ? '`' + i.pos.x + ' / ' + i.pos.y + ' / ' + i.pos.z + '`' : '*N/A*')
  }
  add('💰 Tiền', Number.isFinite(i.money) ? '**' + fmtNum(i.money) + '**' + trend(i.money, i.session.money0) : '*Chưa có dữ liệu*')
  if (online) add('💎 Shards', i.shards ? '**' + i.shards + '**' : '*Chưa có dữ liệu*')
  add('🔑 Key', i.keyValid === null ? null : (i.keyValid ? '✅ Hợp lệ' : '⚠️ Hết hạn / chưa hợp lệ'))
  if (i.next) {
    const ts = Math.floor(i.next.date.getTime() / 1000)
    add('🗓️ Lịch kế tiếp', (i.next.action === 'start' ? '▶️ Bật bot' : '⏹️ Tắt bot') + ' · <t:' + ts + ':R> · <t:' + ts + ':t>', false)
  }

  const events = botEvents.get(botKey(ownerId, username)) || []
  if (events.length) add('📜 Hoạt động gần đây', events.map((e) => e.icon + ' ' + e.text + ' · <t:' + e.ts + ':R>').join('\n'), false)

  const embed = {
    title: dot + ' ' + i.username,
    description: '**' + statusLabel(i.status) + '** · ' + (online ? '⏱️ online từ' : '🕒 từ') + ' <t:' + sinceSec + ':R>',
    color, fields,
    footer: { text: (i.server ? i.server + ' · ' : '') + 'KingSMP Panel · tự cập nhật mỗi ' + (WEBHOOK_REFRESH_MS / 1000) + ' giây' }
  }
  // Head đúng skin SkinsRestorer: Discord cần URL công khai nên dùng hash texture (textures.minecraft.net) thay vì tên
  if (i.skin) embed.thumbnail = { url: 'https://mc-heads.net/avatar/' + i.skin + '/100' }
  else if (/^[A-Za-z0-9_]{3,16}$/.test(i.username)) embed.thumbnail = { url: 'https://mc-heads.net/avatar/' + i.username + '/100' }
  return embed
}

// Gửi/sửa tin cho 1 bot. Mỗi bot chạy độc lập (không chặn nhau); lệnh trùng khi đang gửi sẽ được gộp lại.
async function sendBotMessage(ownerId, username, force) {
  try {
    if (!hasWebhook(ownerId)) return false
    const embed = buildBotEmbed(ownerId, username)
    if (!embed) return false
    const st = getRefreshState(botKey(ownerId, username))
    const hash = JSON.stringify(embed)
    if (!force && hash === st.lastHash && Date.now() - st.lastSent < WEBHOOK_FORCE_MS) return true
    embed.timestamp = new Date().toISOString()
    const ok = await upsertDiscordMessage(ownerId, username, embed)
    if (ok) { st.lastHash = hash; st.lastSent = Date.now() }
    return ok
  } catch (e) { return false }
}
function getRefreshState(key) {
  let st = refreshState.get(key)
  if (!st) { st = { running: null, dirty: false, lastHash: '', lastSent: 0, lastTick: 0 }; refreshState.set(key, st) }
  return st
}
function refreshBotMessage(ownerId, username, force = false) {
  const st = getRefreshState(botKey(ownerId, username))
  if (st.running) { st.dirty = true; return st.running }
  st.running = (async () => {
    let ok = false
    try {
      do { st.dirty = false; ok = await sendBotMessage(ownerId, username, force); force = false } while (st.dirty)
    } finally { st.running = null }
    return ok
  })()
  return st.running
}
function pushBotEvent(ownerId, username, icon, text) {
  if (!ownerId || !username) return
  const key = botKey(ownerId, username)
  const list = botEvents.get(key) || []
  list.unshift({ ts: Math.floor(Date.now() / 1000), icon, text: clip(text, 140) })
  list.length = Math.min(list.length, MAX_BOT_EVENTS)
  botEvents.set(key, list)
  recordActivity(key, icon, text)
  try { if (typeof discordAlert === 'function') discordAlert(ownerId, username, icon, text) } catch (e) {}
  if (hasWebhook(ownerId)) refreshBotMessage(ownerId, username, true)
}
function pushOwnerEvent(ownerId, icon, text) {
  if (!ownerId) return
  for (const c of BOT_LIST) if (c.ownerId === ownerId) pushBotEvent(ownerId, c.username, icon, text)
}
function hasRecentEvent(key, sec) {
  const list = botEvents.get(key) || []
  return list.length > 0 && (Date.now() / 1000 - list[0].ts) <= sec
}

// ---------- các sự kiện của bot -> dòng trong "Hoạt động gần đây" ----------
function webhookReceived(botName, from, amount, raw, amountNum) {
  const n = Number.isFinite(amountNum) ? amountNum : parseBalance(amount)
  recordIncome(ownerOf(botName), botName, 'in', from, n)
  pushBotEvent(ownerOf(botName), botName, '💰', 'Nhận ' + amount + ' từ ' + from)
}
function webhookPay(botName, to, amount, raw, amountNum) {
  const n = Number.isFinite(amountNum) ? amountNum : parseBalance(amount)
  recordIncome(ownerOf(botName), botName, 'out', to, n)
  pushBotEvent(ownerOf(botName), botName, '💸', 'Chuyển ' + amount + ' cho ' + to)
}
function webhookDisconnect(botName, reason, type) {
  const icons = { kicked: '⛔', end: '🔌', error: '⚠️' }
  const labels = { kicked: 'Bị kick', end: 'Mất kết nối', error: 'Lỗi kết nối' }
  pushBotEvent(ownerOf(botName), botName, icons[type] || '🔌', (labels[type] || 'Mất kết nối') + ': ' + String(reason))
}
function webhookReconnectAttempt(botName, reason, attempt, delayMs) {
  pushBotEvent(ownerOf(botName), botName, '🔄', 'Thử vô lại lần ' + attempt + ' sau ' + fmtDelay(delayMs) + ': ' + String(reason))
}
function webhookReconnectFailed(botName, reason, delayMs) {
  pushBotEvent(ownerOf(botName), botName, '❌', 'Vô lại nhanh ' + RECONNECT_MAX_TRIES + ' lần thất bại (DEAD) — tự thử lại sau ' + fmtDelay(delayMs) + ', thời gian tăng dần: ' + String(reason))
}
function webhookReconnectSuccess(botName, attempt) {
  pushBotEvent(ownerOf(botName), botName, '✅', 'Đã vô lại thành công sau lần thử ' + attempt)
}
function webhookTpa(botName, from, raw, type) {
  pushBotEvent(ownerOf(botName), botName, '📨', from + ' ' + tpaTypeLabel(type) + ' — duyệt trên web')
}
// Embed riêng cho Auto Pay: gửi 1 tin MỚI mỗi lượt chuyển (webhook riêng của bot -> không có thì dùng webhook chung của tài khoản)
async function webhookAutoPay(botName, d) {
  try {
    const ownerId = ownerOf(botName)
    if (!ownerId) return false
    const pcfg = getPayCfg(botName)
    let url = String(pcfg.webhook || '').trim()
    if (!url || !isDiscordWebhook(url)) url = discordWebhookUrl(ownerId)
    if (!url || !isDiscordWebhook(url)) return false
    const modeLabel = { all: 'Chuyển tất cả (Pay All)', random: 'Ngẫu nhiên ' + pcfg.minM + '–' + pcfg.maxM + ' triệu', fixed: 'Số tiền cố định' }[d.mode] || d.mode
    const ok = d.ok === true, fail = d.ok === false
    const fields = []
    const add = (name, value, inline = true) => fields.push({ name, value: clip(value), inline })
    add('👤 Người gửi', '`' + botName + '`')
    add('🎯 Người nhận', '`' + d.to + '`')
    add('💵 Số tiền', '**$' + fmtNum(d.amount) + '**\n' + compact(d.amount))
    add('💰 Số dư', (Number.isFinite(d.before) ? '$' + fmtNum(d.before) : 'N/A') + ' ➜ ' + (Number.isFinite(d.after) ? '**$' + fmtNum(d.after) + '**' : '*chưa đọc được*'))
    add('🧮 Chế độ', modeLabel)
    if (d.stats) add('📊 Tổng đã chuyển', '**$' + fmtNum(d.stats.total) + '**\n' + d.stats.count + ' lần')
    add('⏱️ Chu kỳ', pcfg.intervalSec + ' giây')
    if (d.note) add('📝 Ghi chú', d.note, false)
    const embed = {
      title: (fail ? '❌' : ok ? '💸' : '⏳') + ' Auto Pay — ' + botName,
      description: fail ? '**Chuyển tiền chưa thành công**' : ok ? '**Đã chuyển tiền thành công**' : '**Đã gửi lệnh /pay** (chưa xác nhận được kết quả)',
      color: fail ? 0xed4245 : ok ? 0x57f287 : 0xfee75c,
      fields,
      footer: { text: 'KingSMP Panel · Auto Pay' },
      timestamp: new Date().toISOString()
    }
    const hash = skinHashOf(botName)
    if (hash) embed.thumbnail = { url: 'https://mc-heads.net/avatar/' + hash + '/100' }
    const r = await discordRequestRetry('POST', webhookBase(url) + '?wait=true', { embeds: [embed], allowed_mentions: { parse: [] } })
    return r.status >= 200 && r.status < 300
  } catch (e) { return false }
}
function webhookSell(botName, text, color) {
  pushBotEvent(ownerOf(botName), botName, '💰', 'Auto sell: ' + String(text))
}
function webhookSchedule(title, desc, color, ownerId) {
  pushOwnerEvent(ownerId, color === 0x32d74b ? '⏰' : '😴', 'Lịch: ' + String(desc || '').replace(/\*\*/g, ''))
}

// Mỗi 5 giây: theo dõi trạng thái mọi bot (uptime, hoạt động, chỉ số) — kể cả khi không dùng webhook.
// Với bot đã liên kết webhook: đổi trạng thái -> cập nhật ngay; còn lại cập nhật mỗi WEBHOOK_REFRESH_MS.
// Chỉ SỬA tin nhắn cũ, không gửi tin mới.
setInterval(() => {
  try {
    const now = Date.now()
    for (const cfg of BOT_LIST) {
      const ownerId = cfg.ownerId
      if (!ownerId || !cfg.username) continue
      const username = cfg.username
      const status = botStatusOf(botStates[username])
      const key = botKey(ownerId, username)
      const { previous } = ensureSession(key, status)
      touchAnalytics(key, status, now)
      sampleVitals(key, username, status, now)
      const hooked = hasWebhook(ownerId)
      const st = getRefreshState(key)
      if (previous !== undefined && previous !== status) {
        st.lastTick = now
        if (status === 'online' && !hasRecentEvent(key, 15)) pushBotEvent(ownerId, username, '🟢', 'Bot đã online')
        else if (status === 'offline' && !hasRecentEvent(key, 15)) pushBotEvent(ownerId, username, '🔴', 'Bot đã offline')
        else if (hooked) refreshBotMessage(ownerId, username, true)
      } else if (hooked && now - st.lastTick >= WEBHOOK_REFRESH_MS) {
        st.lastTick = now
        refreshBotMessage(ownerId, username)
      }
    }
  } catch (e) {}
}, 5000)