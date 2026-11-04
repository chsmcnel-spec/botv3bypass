// FEATURE MODULE: 06-dashboard-api.js
// Express dashboard, REST APIs, WebSocket inventory and panel routes.
// Loaded in order by ../runtime-loader.js; shares the single runtime scope.

// ===================== EXPRESS SERVER =====================
const app = express()
app.set('trust proxy', CONFIG.TRUST_PROXY ? 1 : false)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
// Nén gzip JSON của /api/* (bất đồng bộ qua thread pool, không chặn event loop). Phản hồi nhỏ gửi thẳng.
const _zlib = require('zlib')
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || !/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next()
  const orig = res.json.bind(res)
  res.json = (obj) => {
    let body
    try { body = JSON.stringify(obj) } catch (e) { return orig(obj) }
    if (body === undefined) return orig(obj)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Vary', 'Accept-Encoding')
    if (body.length < 1024) return res.end(body)
    _zlib.gzip(Buffer.from(body), { level: 4 }, (err, buf) => {
      if (res.headersSent || res.writableEnded) return
      if (err) return res.end(body)
      res.setHeader('Content-Encoding', 'gzip')
      res.end(buf)
    })
    return res
  }
  next()
})
// Tìm giao diện web: ưu tiên public/index.html, không có thì dùng index.html cùng thư mục với login.js
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname
// Nếu giao diện nằm cùng thư mục với login.js thì CHỈ phục vụ ảnh/css/font — tuyệt đối không để lộ config.json, data/, *.js
if (PUBLIC_DIR === __dirname) {
  const safeStatic = express.static(PUBLIC_DIR, { index: false, dotfiles: 'deny' })
  app.use((req, res, next) => /\.(png|jpe?g|gif|svg|ico|webp|css|woff2?)$/i.test(req.path) ? safeStatic(req, res, next) : next())
} else {
  app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: 'deny' }))
}
// Icon item cho GUI/kho đồ: MỖI item = 1 ảnh public/emojis_optimized/<item_id>.png (id không có tiền tố minecraft:)
// Không còn phụ thuộc resource pack. Tên file KHÔNG phân biệt hoa/thường (DIAMOND_SWORD.png = diamond_sword.png),
// vì hosting Linux phân biệt hoa thường còn client luôn xin tên chữ thường.
const EMOJI_DIR = path.join(__dirname, 'public', 'emojis_optimized')
let emojiIndex = new Map()   // tên thường -> tên file thật
let emojiScanAt = 0
function scanEmojis() {
  const m = new Map()
  try { for (const f of fs.readdirSync(EMOJI_DIR)) if (/\.png$/i.test(f)) m.set(f.toLowerCase(), f) } catch (e) {}
  emojiIndex = m
  emojiScanAt = Date.now()
}
scanEmojis()
app.get('/emojis_optimized/:file', (req, res) => {
  const want = String(req.params.file || '').toLowerCase()
  if (!/^[a-z0-9_.\-]+\.png$/.test(want)) return res.status(404).end()
  let real = emojiIndex.get(want)
  if (!real && Date.now() - emojiScanAt > 10000) { scanEmojis(); real = emojiIndex.get(want) }   // vừa upload ảnh mới -> tự nhận sau tối đa 10s
  if (!real) return res.status(404).end()
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.sendFile(path.join(EMOJI_DIR, real), { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.status(404).end() })
})

// Favicon: public/KingMC.jpeg. Đặt TRƯỚC auth.install để trang đăng nhập (chưa có phiên) cũng thấy icon;
// trình duyệt tự xin /favicon.ico nên trả luôn ảnh này (JPEG, trình duyệt hiện đại đều nhận).
const FAVICON_FILE = [path.join(__dirname, 'public', 'KingMC.jpeg'), path.join(__dirname, 'KingMC.jpeg')].find(f => fs.existsSync(f)) || ''
app.get(['/favicon.ico', '/KingMC.jpeg'], (req, res) => {
  if (!FAVICON_FILE) return res.status(404).end()
  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.sendFile(FAVICON_FILE, { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.status(404).end() })
})

// Đăng ký / đăng nhập + chặn mọi /api/* khi chưa đăng nhập
auth.install(app)
// Mọi route có :username chỉ cho chủ của bot đó
app.param('username', (req, res, next, username) => {
  const cfg = botCfg(username)
  if (!cfg || !cfg.ownerId || cfg.ownerId !== req.userId) return res.status(404).json({ success: false, message: 'Không tìm thấy acc' })
  next()
})

// Ảnh skin thật của người chơi (SkinsRestorer). Dùng :player (không phải :username) để không dính kiểm tra chủ bot.
app.get('/api/skin/:player', async (req, res) => {
  const name = String(req.params.player || '')
  if (!/^[A-Za-z0-9_.]{1,32}$/.test(name)) return res.status(400).end()
  const ent = skinLookup(name)
  if (!ent) return res.status(404).end()
  try {
    const buf = await skinFetchPng(ent)
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': req.query.v ? 'private, max-age=86400' : 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(buf)
  } catch (e) { res.status(404).end() }
})

app.get('/api/bots', (req, res) => {
  const list = BOT_LIST.filter(c => c.ownerId === req.userId).map(cfg => {
    const s = botStates[cfg.username]
    const info = collectBotInfo(req.userId, cfg.username) || {}
    if (s && s.balance && s.balanceUpdateAt) {
      recordMoneySample(cfg.username, s.balance, s.balanceUpdateAt)
    }
    const moneyPoints = getMoneyHistory(req.userId, cfg.username)
    const miniLog = (botMiniChatLogs.get(botKey(req.userId, cfg.username)) || []).slice(-3)

    if (!s) {
      return {
        username: cfg.username, skin: skinHashOf(cfg.username), status: 'NOT_CREATED', inCluster: false,
        isDead: false, isLoggingIn: false, balance: null, balanceUpdateAt: 0,
        lastMessage: '', ping: null, tps: null, health: null, food: null,
        moneyPerHour: getMoneyPerHour(moneyPoints),
        miniLog, statsData: null, statsLastCheckedAt: 0, statsBusy: false,
        statsError: '', statsNextCheckAt: 0, license: licenseInfo(cfg.username)
      }
    }

    let status = 'WAITING'
    if (s.isDead) status = 'DEAD'
    else if (s.inCluster) status = 'ONLINE'
    else if (s.isLoggingIn) status = 'LOGGING_IN'

    return {
      username: cfg.username, skin: skinHashOf(cfg.username), status, inCluster: s.inCluster,
      isDead: s.isDead, isLoggingIn: s.isLoggingIn,
      balance: s.balance, balanceUpdateAt: s.balanceUpdateAt,
      lastMessage: s.lastMessage,
      ping: Number.isFinite(info.ping) ? info.ping : null,
      tps: Number.isFinite(info.tps) ? info.tps : null,
      health: Number.isFinite(info.health) ? info.health : null,
      food: Number.isFinite(info.food) ? info.food : null,
      moneyPerHour: getMoneyPerHour(moneyPoints),
      miniLog,
      statsData: s.statsData || null,
      statsLastCheckedAt: s.statsLastCheckedAt || 0,
      statsBusy: !!s.statsBusy,
      statsError: s.statsError || '',
      statsNextCheckAt: s.statsNextCheckAt || 0,
      reconnectTries: s.reconnectTries || 0,
      reconnectInSec: s.isDead && s.reconnectNextAt ? Math.max(0, Math.round((s.reconnectNextAt - Date.now()) / 1000)) : 0,
      sellEnabled: getSellCfg(cfg.username).enabled,
      sellActive: !!s.sellActive,
      sellStats: s.sellStats || { moved: 0, rounds: 0, topCount: 0 },
      license: licenseInfo(cfg.username)
    }
  })
  list.forEach(b => { b.proxy = proxyLabel(getBotProxy(botCfg(b.username))) })
  res.json({ bots: list, server: SERVER_IP + ':' + SERVER_PORT, schedule: { ...auth.prefsOf(req.userId).schedule, scheduledOutActive: outActive.has(req.userId) }, reconnect: reconnectInfo() })
})

app.get('/api/bots/:username/money-history', (req, res) => {
  // app.param(':username') đã xác minh bot thuộc tài khoản đang đăng nhập.
  const points = getMoneyHistory(req.userId, req.params.username)
  res.json({ success: true, points, keepMs: MONEY_HISTORY_KEEP_MS })
})

app.get('/api/bots/:username/stats', (req, res) => {
  const state = botStates[req.params.username]
  if (!state) return res.json({ success: false, message: 'Bot chưa được tạo.' })
  res.json({
    success: true,
    busy: !!state.statsBusy,
    error: state.statsError || '',
    lastCheckedAt: state.statsLastCheckedAt || 0,
    nextCheckAt: state.statsNextCheckAt || 0,
    data: state.statsData || null
  })
})

app.post('/api/bots/:username/stats-check', (req, res) => {
  const state = botStates[req.params.username]
  if (!state) return res.json({ success: false, message: 'Bot chưa được tạo.' })
  const result = requestStatsCheck(state, 'manual')
  res.json({ success: !!result.ok, message: result.message })
})

app.post('/api/login/:username', (req, res) => {
  const username = req.params.username
  const cfg = BOT_LIST.find(b => b.username === username)
  if (!cfg) return res.json({ success: false, message: 'Không tìm thấy bot trong config' })

  const s = botStates[username]
  if (s && !s.isDead && s.inCluster) {
    return res.json({ success: false, message: `Bot ${username} đang online, không cần login lại` })
  }
  if (s && !s.isDead && s.isLoggingIn) {
    return res.json({ success: false, message: `Bot ${username} đang login, vui lòng chờ...` })
  }

  // Login tay từ admin -> reset bộ đếm reconnect, cho phép retry lại từ đầu
  try { if (s && s.reconnectTimer) clearTimeout(s.reconnectTimer) } catch (e) {}
  log(username, 'RECONNECT', `👤 Admin bấm Login tay — reset bộ đếm reconnect`)
  createBot(username, { manual: true })
  res.json({ success: true, message: `Đang login lại bot ${username}...` })
})

// ===================== LỊCH NGHỈ (bật/tắt + chỉnh giờ, giờ máy VPS) =====================
app.get('/api/schedule', (req, res) => {
  res.json({ ...auth.prefsOf(req.userId).schedule, scheduledOutActive: outActive.has(req.userId), serverTime: new Date().toString(), reconnect: reconnectInfo() })
})

// Lưu lịch nghỉ của 1 tài khoản panel. Dùng chung cho web và Discord bot.
function saveSchedule(ownerId, body) {
  const { enabled, outTime, inTime } = body || {}
  const cur = auth.prefsOf(ownerId).schedule
  const next = {
    enabled: typeof enabled === 'boolean' ? enabled : cur.enabled,
    outTime: (typeof outTime === 'string' && /^\d{1,2}:\d{1,2}$/.test(outTime.trim())) ? _normHM(outTime.trim(), cur.outTime) : cur.outTime,
    inTime: (typeof inTime === 'string' && /^\d{1,2}:\d{1,2}$/.test(inTime.trim())) ? _normHM(inTime.trim(), cur.inTime) : cur.inTime
  }
  auth.setPrefs(ownerId, { schedule: next })
  log('SYSTEM', 'SCHEDULE', `⚙️ Lịch nghỉ: ${next.enabled ? 'BẬT' : 'TẮT'} | out ${next.outTime} → in ${next.inTime} (giờ máy VPS)`, ownerId)
  return { success: true, message: `Đã lưu lịch: ${next.enabled ? 'BẬT' : 'TẮT'} | out ${next.outTime} → in ${next.inTime}`, schedule: { ...next, scheduledOutActive: outActive.has(ownerId) } }
}
app.post('/api/schedule', (req, res) => {
  res.json(saveSchedule(req.userId, req.body))
})

app.post('/api/schedule/out-now', (req, res) => {
  scheduledOutNow(req.userId)
  res.json({ success: true, message: `Đã out tất cả bot của bạn theo lịch (nghỉ tới ${auth.prefsOf(req.userId).schedule.inTime})` })
})

app.post('/api/schedule/in-now', (req, res) => {
  scheduledInNow(req.userId).then(() => {}).catch(() => {})
  res.json({ success: true, message: 'Đang cho bot vô lại...' })
})

// ===================== AUTO SELL API (per-bot) =====================
app.get('/api/autosell', (req, res) => {
  const all = {}
  for (const cfg of BOT_LIST.filter(c => c.ownerId === req.userId)) {
    const s = botStates[cfg.username]
    all[cfg.username] = {
      ...getSellCfg(cfg.username),
      active: !!(s && s.sellActive),
      stats: (s && s.sellStats) || { moved: 0, rounds: 0, topCount: 0 }
    }
  }
  res.json({ sell: all, fullThreshold: SELL_FULL_THRESHOLD, clickDelayMs: SELL_CLICK_DELAY_MS })
})

// Toạ độ hiện tại của bot (nút "Lấy tọa độ hiện tại" ở phần Tự về /home)
app.get('/api/pos/:username', (req, res) => {
  const s = botStates[req.params.username]
  const p = s && !s.isDead && s.bot && s.bot.entity && s.bot.entity.position
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return res.json({ success: false, message: 'Bot chưa online / chưa có toạ độ' })
  const r1 = (n) => Math.round(n * 10) / 10
  let dimension = ''
  try { dimension = String(s.bot.game.dimension || '') } catch (e) {}
  res.json({ success: true, x: r1(p.x), y: r1(p.y), z: r1(p.z), dimension })
})

app.get('/api/autosell/:username', (req, res) => {
  const username = req.params.username
  if (!BOT_LIST.find(b => b.username === username)) return res.json({ success: false, message: 'Không tìm thấy acc' })
  const s = botStates[username]
  res.json({
    success: true,
    ...getSellCfg(username),
    active: !!(s && s.sellActive),
    stats: (s && s.sellStats) || { moved: 0, rounds: 0, topCount: 0 },
    fullThreshold: SELL_FULL_THRESHOLD
  })
})

// Lưu cấu hình (items/mode/intervalSec/enabled). items nhận string "a, b, c" hoặc mảng.
// Lưu cấu hình auto sell / pay / home của 1 bot. Dùng chung cho web (/api/autosell) và Discord bot.
// Trả về object { success, message, ... } (không phụ thuộc express).
function saveAutosell(username, reqBody) {
  if (!BOT_LIST.find(b => b.username === username)) return ({ success: false, message: 'Không tìm thấy acc' })
  const cur = getSellCfg(username)
  getPayCfg(username); getHomeCfg(username)   // bot cũ chưa có pay/home -> tạo mặc định
  const body = reqBody || {}
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o)
  const next = sanitizeSellCfg({
    enabled: typeof body.enabled === 'boolean' ? body.enabled : cur.enabled,
    items: typeof body.items !== 'undefined' ? body.items : cur.items,
    mode: body.mode || cur.mode,
    intervalSec: typeof body.intervalSec !== 'undefined' ? body.intervalSec : cur.intervalSec,
    pay: isObj(body.pay) ? Object.assign({}, cur.pay, body.pay) : cur.pay,
    home: isObj(body.home) ? Object.assign({}, cur.home, body.home) : cur.home
  })
  // Kiểm tra Auto Pay / Auto Home trước khi lưu (lỗi thì không lưu gì cả)
  if (next.pay.enabled && !next.pay.to) return ({ success: false, message: 'Nhập tên người nhận (3-16 ký tự: a-z, 0-9, _) để bật tự động chuyển tiền' })
  if (next.pay.enabled && next.pay.to.toLowerCase() === username.toLowerCase()) return ({ success: false, message: 'Không thể tự chuyển tiền cho chính acc này' })
  if (next.pay.webhook && !isDiscordWebhook(next.pay.webhook)) return ({ success: false, message: 'Discord Webhook của Auto Pay phải là URL webhook HTTPS hợp lệ' })
  if (next.home.enabled && (next.home.x === null || next.home.y === null || next.home.z === null)) return ({ success: false, message: 'Nhập đủ tọa độ X, Y, Z (hoặc bấm "Lấy tọa độ hiện tại") để bật tự về /home' })
  AUTOSELL[username] = next
  if (!saveConfig()) return ({ success: false, message: 'Lưu config thất bại' })
  log(username, 'SELL', `⚙️ Lưu auto sell: [${next.items.join(', ') || 'trống'}] | mode=${next.mode}${next.mode === 'timer' ? ' (' + next.intervalSec + 's)' : ''} | ${next.enabled ? 'BẬT' : 'TẮT'}`)
  log(username, 'PAY', `⚙️ Lưu auto pay: ${next.pay.enabled ? 'BẬT' : 'TẮT'} | → ${next.pay.to || '—'} | ${next.pay.mode}${next.pay.mode === 'random' ? ' ' + next.pay.minM + '–' + next.pay.maxM + 'M' : next.pay.mode === 'fixed' ? ' $' + next.pay.amount : ''} | mỗi ${next.pay.intervalSec}s`)
  log(username, 'HOME', `⚙️ Lưu auto home: ${next.home.enabled ? 'BẬT' : 'TẮT'} | ${next.home.x},${next.home.y},${next.home.z} | /home ${next.home.name || ''}`.trim())
  const s = botStates[username]
  if (s && next.pay.enabled && !cur.pay.enabled) s.payNextAt = Date.now() + 5000   // vừa bật -> chạy sau 5s
  if (s && next.home.enabled && !cur.home.enabled) { s.homeLastTry = 0; s.homeFails = 0 }
  if (next.enabled) {
    if (!next.items.length) return ({ success: false, message: 'Chưa nhập item nào — nhập item/block tiếng Anh trước' })
    if (!s || s.isDead || !s.bot || !s.bot.entity) {
      // Bot offline: chỉ lưu cấu hình, khi login lại sẽ tự chạy (createBot auto-start)
      return ({ success: true, message: `Đã lưu + BẬT (bot đang offline — sẽ tự chạy khi login lại)`, ...next })
    }
    if (startSellLoop(s)) {
      webhookSell(username, `▶ BẬT auto sell: ${next.items.join(', ')} | mode=${next.mode}`, 0x32d74b)
      return ({ success: true, message: `Đã lưu + BẬT auto sell cho ${username}`, ...next })
    }
    return ({ success: false, message: 'Chưa set item nào' })
  } else {
    if (s) stopSellLoop(s)
    return ({ success: true, message: `Đã lưu cài đặt cho ${username} (auto sell đang tắt)`, ...next })
  }
}

app.post('/api/autosell/:username', (req, res) => {
  res.json(saveAutosell(req.params.username, req.body))
})

app.post('/api/autosell/:username/start', (req, res) => {
  const username = req.params.username
  if (!BOT_LIST.find(b => b.username === username)) return res.json({ success: false, message: 'Không tìm thấy acc' })
  const cfg = getSellCfg(username)
  if (!cfg.items.length) return res.json({ success: false, message: 'Chưa set item nào — nhập item/block tiếng Anh trước' })
  const s = botStates[username]
  if (!s || s.isDead || !s.bot || !s.bot.entity) return res.json({ success: false, message: 'Bot chưa online' })
  cfg.enabled = true
  AUTOSELL[username] = cfg
  saveConfig()
  if (startSellLoop(s)) {
    webhookSell(username, `▶ BẬT auto sell: ${cfg.items.join(', ')} | mode=${cfg.mode}`, 0x32d74b)
    return res.json({ success: true, message: `Đã BẬT auto sell cho ${username}` })
  }
  return res.json({ success: false, message: 'Không bật được (chưa set item?)' })
})

function invItemLite(it) {
  if (!it) return null
  return {
    name: it.name || 'unknown',
    displayName: String(it.displayName || it.name || '?').slice(0, 40),
    count: it.count || 1
  }
}

// Xem live inv sell (shop phía trên) + balo bot để hiện lên web (dùng chung cho HTTP + WebSocket)
function buildSellView(username) {
  if (!BOT_LIST.find(b => b.username === username)) return { success: false, message: 'Không tìm thấy acc' }
  const s = botStates[username]
  if (!s || !s.bot) return { success: false, message: 'Bot chưa được tạo' }
  const out = {
    success: true,
    username,
    online: !!(!s.isDead && s.bot.entity),
    hasShop: false,
    title: null,
    guiSize: 0,
    top: [],
    topCount: 0,
    pack: [],
    armor: [],
    sell: { ...getSellCfg(username), active: !!s.sellActive, stats: s.sellStats || { moved: 0, rounds: 0, topCount: 0 } }
  }
  try {
    const win = s.bot.currentWindow
    if (win && win.slots) {
      const gs = sellGuiSize(win)
      if (gs > 0) {
        out.hasShop = true
        try { out.title = plainTitle(win.title) || 'Shop' } catch (e) { out.title = 'Shop' }
        out.guiSize = gs
        const arr = win.slots
        for (let i = 0; i < gs && i < arr.length; i++) {
          const lite = invItemLite(arr[i])
          if (lite) out.top.push({ slot: i, ...lite })
        }
        out.topCount = out.top.length
      }
    }
  } catch (e) {}
  try {
    const inv = s.bot.inventory
    if (inv && inv.slots) {
      for (let i = 9; i <= 44 && i < inv.slots.length; i++) {
        const lite = invItemLite(inv.slots[i])
        if (lite) out.pack.push({ slot: i, ...lite })
      }
      for (let i = 5; i <= 8 && i < inv.slots.length; i++) {
        const lite = invItemLite(inv.slots[i])
        if (lite) out.armor.push({ slot: i, ...lite })
      }
    }
  } catch (e) {}
  return out
}

app.get('/api/sellview/:username', (req, res) => {
  res.json(buildSellView(req.params.username))
})

// ===================== KHO ĐỒ / GUI VIEWER (xem inv, GUI đang mở, chuyển item, vứt item) =====================
const invQueues = {} // mỗi bot một hàng đợi để không click chồng lên nhau
function invQueue(username, fn) {
  const prev = invQueues[username] || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  invQueues[username] = next.catch(() => {})
  return next
}

function invEnchantList(it) {
  const out = []
  try {
    const root = it.nbt && it.nbt.value
    const list = root && (root.Enchantments || root.StoredEnchantments)
    const arr = list && list.value && list.value.value
    if (Array.isArray(arr)) {
      for (const e of arr) {
        const id = e && e.id && e.id.value
        const lvl = e && e.lvl && e.lvl.value
        if (id) out.push({ id: String(id).replace('minecraft:', ''), lvl: Number(lvl) || 1 })
      }
    }
  } catch (e) {}
  if (!out.length && Array.isArray(it.components)) {
    try {
      const c = it.components.find(x => x && /enchant/.test(String(x.type)))
      const data = c && c.data
      const levels = data && (data.levels || data)
      if (levels && typeof levels === 'object') {
        for (const k of Object.keys(levels)) {
          if (typeof levels[k] === 'number') out.push({ id: k.replace('minecraft:', ''), lvl: levels[k] })
        }
      }
    } catch (e) {}
  }
  return out
}

function invDurability(it) {
  const max = Number(it.maxDurability) || 0
  if (max <= 0) return null
  let used = Number(it.durabilityUsed)
  if (!(used >= 0)) {
    try { used = Number(it.nbt.value.Damage.value) } catch (e) {}
  }
  if (!(used >= 0)) used = 0
  return { max, left: Math.max(0, max - used), used }
}

function invLore(it) {
  try {
    let arr = null
    if (Array.isArray(it.lore)) arr = it.lore
    else if (typeof it.lore === 'string') arr = it.lore.split('\n')
    else if (it.nbt && it.nbt.value && it.nbt.value.display && it.nbt.value.display.value && it.nbt.value.display.value.Lore) {
      arr = it.nbt.value.display.value.Lore.value.value || []
    }
    if (!arr) return []
    return arr.map(x => String(x)).filter(x => x.trim()).map(x => plainTitle(x)).slice(0, 8)
  } catch (e) { return [] }
}

function invFull(it, bot) {
  if (!it) return null
  const name = it.name || 'unknown'
  let isBlock = false
  try { isBlock = !!(bot && bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[name]) } catch (e) {}
  return {
    id: name,
    displayName: String(it.displayName || name).slice(0, 60),
    count: it.count || 1,
    stackSize: it.stackSize || 64,
    isBlock,
    enchants: invEnchantList(it),
    durability: invDurability(it),
    lore: invLore(it)
  }
}

// Ảnh chụp GUI đang mở (nếu có) hoặc túi đồ bot (nếu không có GUI)
function invSnapshot(bot) {
  const win = bot.currentWindow
  const src = win || bot.inventory
  const arr = (src && src.slots) || []
  const guiSize = win ? sellGuiSize(win) : 0
  const slots = new Array(arr.length)
  for (let i = 0; i < arr.length; i++) slots[i] = arr[i] ? invFull(arr[i], bot) : null
  return {
    hasGui: !!win,
    title: win ? plainTitle(win.title) : 'Túi đồ bot',
    guiSize,
    total: arr.length,
    slots,
    cursor: src && src.selectedItem ? invFull(src.selectedItem, bot) : null
  }
}

// Xem inv + GUI đang mở
app.get('/api/inv/:username', (req, res) => {
  const s = botStates[req.params.username]
  if (!s || !s.bot) return res.json({ success: false, message: 'Bot chưa được tạo' })
  const online = !!(s.bot.entity && !s.isDead)
  let snap = null
  try { snap = invSnapshot(s.bot) } catch (e) {}
  if (!snap) snap = { hasGui: false, title: '', guiSize: 0, total: 0, slots: [], cursor: null }
  res.json({
    success: true,
    username: s.username,
    online,
    ...snap,
    closedGui: !snap.hasGui && s.pendingWindow ? { title: s.pendingWindow.title } : null
  })
})

function invRequireOnline(req, res) {
  const s = botStates[req.params.username]
  if (!s || !s.bot) { res.json({ success: false, message: 'Bot chưa được tạo' }); return null }
  if (!s.bot.entity || s.isDead) { res.json({ success: false, message: 'Bot đang offline' }); return null }
  return s
}

// Chuyển item: nhấp ô nguồn (nhặt cả stack) rồi nhấp ô đích (đặt xuống / gộp / đổi chỗ)
app.post('/api/inv/:username/move', (req, res) => {
  const s = invRequireOnline(req, res)
  if (!s) return
  const from = parseInt(req.body && req.body.from, 10)
  const to = parseInt(req.body && req.body.to, 10)
  if (isNaN(from) || isNaN(to) || from < 0 || to < 0) return res.json({ success: false, message: 'Ô không hợp lệ' })
  if (from === to) return res.json({ success: true, message: 'Cùng một ô, không cần chuyển' })
  invQueue(s.username, async () => {
    const cur = () => s.bot.currentWindow || s.bot.inventory
    if (!cur().slots[from]) throw new Error('Ô nguồn đang trống')
    if (to >= cur().slots.length) throw new Error('Ô đích không tồn tại')
    await s.bot.clickWindow(from, 0, 0)
    await s.bot.clickWindow(to, 0, 0)
    // còn đồ trên con trỏ (ô đích không nhận được) -> trả về ô gốc
    if (cur().selectedItem) await s.bot.clickWindow(from, 0, 0)
  }).then(() => {
    log(s.username, 'GUI', `🔀 Web chuyển đồ ô ${from} → ${to}`)
    res.json({ success: true, message: `Đã chuyển ô ${from} → ${to}` })
  }).catch(e => res.json({ success: false, message: e.message }))
})

// Vứt item: Q = vứt 1 cái, Ctrl+Q = vứt cả stack (mode 4 của Minecraft)
app.post('/api/inv/:username/drop', (req, res) => {
  const s = invRequireOnline(req, res)
  if (!s) return
  const slot = parseInt(req.body && req.body.slot, 10)
  const all = !!(req.body && req.body.all)
  if (isNaN(slot) || slot < 0) return res.json({ success: false, message: 'Ô không hợp lệ' })
  let itemName = ''
  invQueue(s.username, async () => {
    const cur = s.bot.currentWindow || s.bot.inventory
    const it = cur.slots[slot]
    if (!it) throw new Error('Ô trống, không có gì để vứt')
    itemName = String(it.displayName || it.name)
    await s.bot.clickWindow(slot, all ? 1 : 0, 4)
  }).then(() => {
    log(s.username, 'GUI', `🗑️ Web vứt ${itemName} từ ô ${slot}${all ? ' (cả stack)' : ' (1 cái)'}`)
    res.json({ success: true, message: `Đã vứt ${itemName} từ ô ${slot}${all ? ' (cả stack)' : ''}` })
  }).catch(e => res.json({ success: false, message: e.message }))
})

// ===================== WEBSOCKET REALTIME INV =====================
// Web sub bot nào -> slot đổi là server đẩy inv mới ngay (debounce 250ms),
// khỏi polling mỗi 2s
let wss = null
const wsSubs = new Map() // ws -> username
const sellPushTimers = {}

function pushSellView(ws, username) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'sellview', data: buildSellView(username) }))
  } catch (e) {}
}

function broadcastSellView(username) {
  try {
    for (const [ws, sub] of wsSubs) {
      if (sub === username) pushSellView(ws, username)
    }
  } catch (e) {}
}

function queueSellPush(username) {
  if (sellPushTimers[username]) return
  sellPushTimers[username] = setTimeout(() => {
    try { delete sellPushTimers[username] } catch (e) {}
    broadcastSellView(username)
  }, 250)
}

function setupSellSocket(server) {
  try {
    wss = new WebSocketServer({ server, path: '/ws' })
    wss.on('connection', (ws, req) => {
      try {
        // Chỉ nhận WebSocket từ phiên đã đăng nhập, cùng origin (chống cross-site WebSocket hijacking)
        const uid = auth.userIdFromReq(req)
        let sameOrigin = true
        try { if (req.headers.origin) sameOrigin = new URL(req.headers.origin).host === req.headers.host } catch (e) { sameOrigin = false }
        if (!uid || !sameOrigin) { try { ws.close(4401, 'unauthorized') } catch (e) {} return }
        ws._uid = uid
        ws.on('message', (raw) => {
          try {
            const m = JSON.parse(String(raw))
            if (m && m.type === 'sub' && typeof m.bot === 'string' && m.bot && ownerOf(m.bot) === ws._uid) {
              wsSubs.set(ws, m.bot)
              pushSellView(ws, m.bot)
            }
          } catch (e) {}
        })
        ws.on('close', () => { try { wsSubs.delete(ws) } catch (e) {} })
        ws.on('error', () => { try { wsSubs.delete(ws) } catch (e) {} })
      } catch (e) {}
    })
    log('SYSTEM', 'WS', `🔌 WebSocket realtime inv sẵn sàng tại /ws`)
  } catch (e) {
    console.error('WS setup error:', e.message)
  }
}

app.post('/api/autosell/:username/stop', (req, res) => {
  const username = req.params.username
  if (!BOT_LIST.find(b => b.username === username)) return res.json({ success: false, message: 'Không tìm thấy acc' })
  const cfg = getSellCfg(username)
  cfg.enabled = false
  AUTOSELL[username] = cfg
  saveConfig()
  const s = botStates[username]
  if (s) stopSellLoop(s)
  log(username, 'SELL', `⏸️ TẮT auto sell từ web`)
  return res.json({ success: true, message: `Đã TẮT auto sell cho ${username}` })
})

// ===================== THÊM / XOÁ ACC TRÊN WEB =====================
app.post('/api/bots', async (req, res) => {
  let { username, password, proxy } = req.body || {}
  username = String(username || '').trim()
  password = String(password || '').trim()
  proxy = String(proxy || '').trim()
  if (!username || !password) return res.json({ success: false, message: 'Nhập đầy đủ Username + Password (mật khẩu /dn)' })
  if (!/^\w{3,16}$/.test(username)) return res.json({ success: false, message: 'Username phải 3-16 ký tự (a-z, 0-9, _)' })
  if (proxy) {
    if (proxy.length > 300) return res.json({ success: false, message: 'Proxy URL quá dài' })
    try { buildAgent(proxy) } catch (e) { return res.json({ success: false, message: e.message }) }
  }
  const exists = BOT_LIST.find(b => b.username.toLowerCase() === username.toLowerCase())
  let adopt = null
  if (exists) {
    if (!exists.ownerId && decryptPw(exists.password) === password) adopt = exists
    else return res.json({ success: false, message: `Acc ${exists.username} đã có trong danh sách` })
  }
  const encPw = auth.cipher.encrypt(password)
  const encProxy = proxy ? auth.cipher.encrypt(proxy) : ''
  let entry, backup = null
  if (adopt) {
    backup = { password: adopt.password, ownerId: adopt.ownerId, proxy: adopt.proxy }
    adopt.password = encPw; adopt.ownerId = req.userId
    delete adopt.keyId
    if (encProxy) adopt.proxy = encProxy; else delete adopt.proxy
    entry = adopt
  } else {
    entry = { username, password: encPw, ownerId: req.userId }
    if (encProxy) entry.proxy = encProxy
    BOT_LIST.push(entry)
  }
  if (!saveConfig()) {
    if (adopt) Object.assign(adopt, backup); else BOT_LIST.pop()
    return res.json({ success: false, message: 'Không lưu được config.json' })
  }
  if (adopt) auth.adoptLegacy(req.userId, { webhook: LEGACY_WEBHOOK, schedule: CONFIG.SCHEDULE })
  log('SYSTEM', 'ADD', `➕ Đã thêm acc ${entry.username} (NOKEY) | Tổng: ${BOT_LIST.length}`, req.userId)
  createBot(entry.username)
  res.json({ success: true, message: `Đã thêm acc và đang login ${entry.username}...` })
})

// ===================== PROXY: ĐẶT / XOÁ / KIỂM TRA =====================
// Đặt (hoặc xoá nếu để trống) proxy cho 1 bot có sẵn. Áp dụng ở lần login tiếp theo của bot.
app.get('/api/bots/:username/proxy', (req, res) => {
  const proxy = getBotProxy(botCfg(req.params.username))
  res.json({ success: true, hasProxy: !!proxy, proxy: proxyLabel(proxy) })
})
app.post('/api/bots/:username/proxy', (req, res) => {
  const username = req.params.username
  const cfg = botCfg(username)
  const proxy = String((req.body || {}).proxy || '').trim()
  if (proxy) {
    if (proxy.length > 300) return res.json({ success: false, message: 'Proxy URL quá dài' })
    try { buildAgent(proxy) } catch (e) { return res.json({ success: false, message: e.message }) }
  }
  const prev = cfg.proxy
  if (proxy) cfg.proxy = auth.cipher.encrypt(proxy); else delete cfg.proxy
  if (!saveConfig()) {
    if (prev) cfg.proxy = prev; else delete cfg.proxy
    return res.json({ success: false, message: 'Không lưu được config.json' })
  }
  log(username, 'PROXY', proxy ? `🌐 Đã đặt proxy ${proxyLabel(proxy)} (áp dụng ở lần login tới)` : '🌐 Đã xoá proxy (lần login tới nối thẳng)')
  res.json({ success: true, message: proxy ? 'Đã lưu proxy ' + proxyLabel(proxy) + ' — bấm Login lại để áp dụng' : 'Đã xoá proxy — bấm Login lại để nối thẳng' })
})

app.delete('/api/bots/:username', (req, res) => {
  const username = req.params.username
  const idx = BOT_LIST.findIndex(b => b.username === username)
  if (idx === -1) return res.json({ success: false, message: 'Không tìm thấy acc' })

  // Ngắt kết nối bot nếu đang chạy (dùng chung helper, không bắn webhook rác)
  disconnectBot(username)
  try { delete botStates[username] } catch (e) {}
  try { delete AUTOSELL[username] } catch (e) {}

  const removed = BOT_LIST.splice(idx, 1)[0]
  try { botMiniChatLogs.delete(botKey(removed.ownerId, username)) } catch (e) {}
  try { dropBotMessage(removed.ownerId, username) } catch (e) {}   // xoá tin nhắn trạng thái trên Discord
  const lmDel = licenses.get(username)
  licenses.delete(username)
  if (lmDel) { try { lmDel.deactivate(); lmDel.destroy() } catch (e) {} }
  if (removed.keyId) keyOwners.delete(removed.keyId)   // giải phóng key
  if (!saveConfig()) {
    return res.json({ success: false, message: 'Đã xoá khỏi RAM nhưng lưu config thất bại' })
  }
  log('SYSTEM', 'REMOVE', `🗑️ Đã xoá acc ${removed.username} từ web | Còn lại: ${BOT_LIST.length}`, req.userId)
  res.json({ success: true, message: `Đã xoá acc ${removed.username}` })
})

// ===================== NGẮT KẾT NỐI RIÊNG TỪNG ACC =====================
app.post('/api/disconnect/:username', (req, res) => {
  const username = req.params.username
  const cfg = BOT_LIST.find(b => b.username === username)
  if (!cfg) return res.json({ success: false, message: 'Không tìm thấy acc' })

  const s = botStates[username]
  if (!s || !s.bot) {
    return res.json({ success: false, message: `Bot ${username} chưa được tạo / đã offline` })
  }
  if (s.isDead && !s.bot.entity) {
    return res.json({ success: false, message: `Bot ${username} đã offline rồi` })
  }

  const r = disconnectBot(username)
  if (!r.ok) return res.json({ success: false, message: r.message || 'Ngắt kết nối thất bại' })
  log(username, 'DISCONNECT', `🔌 Đã ngắt kết nối thủ công từ web${r.wasOnline ? ' (đang online)' : ''} | Acc vẫn giữ trong list, bấm Login lại để vào tiếp`)
  res.json({ success: true, message: `Đã ngắt kết nối ${username} (acc vẫn giữ, bấm Login lại để vào tiếp)` })
})

app.post('/api/disconnect-all', (req, res) => {
  let count = 0
  for (const cfg of BOT_LIST) {
    const s = botStates[cfg.username]
    if (cfg.ownerId === req.userId && s && s.bot && !s.isDead) {
      disconnectBot(cfg.username)
      count++
    }
  }
  log('SYSTEM', 'DISCONNECT', `🔌 Đã ngắt ${count} bot thủ công từ web`, req.userId)
  res.json({ success: true, message: `Đã ngắt ${count} bot` })
})

app.post('/api/cmd', (req, res) => {
  const { bot: username, command } = req.body
  if (!command) return res.json({ success: false, message: 'Thiếu lệnh' })

  if (username !== 'all' && ownerOf(username) !== req.userId) return res.json({ success: false, message: 'Không tìm thấy acc' })
  const targets = username === 'all'
    ? Object.values(botStates).filter(s => s && ownerOf(s.username) === req.userId && !s.isDead && s.bot && s.bot.entity)
    : [botStates[username]].filter(s => s && !s.isDead && s.bot && s.bot.entity)

  if (targets.length === 0) return res.json({ success: false, message: 'Không có bot nào online' })

  for (const s of targets) {
    try {
      s.bot.chat(command)
      log(s.username, 'CMD', `⚡ ${command}`)
    } catch (e) {}
  }
  res.json({ success: true, message: `Đã gửi đến ${targets.length} bot` })
})

app.post('/api/bots/:username/boat/board', async (req, res) => {
  try { const r = await boardBoat(req.params.username); res.json({ success: r.ok, message: r.message }) }
  catch (e) { res.json({ success: false, message: e.message }) }
})
app.post('/api/bots/:username/boat/leave', (req, res) => {
  const r = leaveVehicle(req.params.username)
  res.json({ success: r.ok, message: r.message })
})

app.post('/api/balance/:username', (req, res) => {
  const s = botStates[req.params.username]
  if (!s || s.isDead || !s.bot || !s.bot.entity) {
    return res.json({ success: false, message: 'Bot chưa sẵn sàng' })
  }
  try {
    s.bot.chat('/bal')
    log(s.username, 'BAL', `💰 Gửi lệnh /bal`)
    res.json({ success: true, message: 'Đang kiểm tra số dư...' })
  } catch (e) {
    res.json({ success: false, message: e.message })
  }
})

app.get('/api/webhook', (req, res) => res.json({ url: auth.prefsOf(req.userId).webhook }))
app.post('/api/webhook', (req, res) => {
  const url = String((req.body || {}).url || '').trim()
  if (url && !isDiscordWebhook(url)) return res.json({ success: false, message: 'URL phải là Discord webhook HTTPS hợp lệ.' })
  const oldUrl = discordWebhookUrl(req.userId)
  try {
    auth.setPrefs(req.userId, { webhook: url })
  } catch (e) {
    return res.json({ success: false, message: e.message })
  }
  log('SYSTEM', 'WEBHOOK', `🔔 Đã lưu webhook: ${url ? 'Có' : 'Trống'}`, req.userId)
  const mine = BOT_LIST.filter(c => c.ownerId === req.userId && c.username)
  if (url !== oldUrl) {
    for (const c of mine) dropBotMessage(req.userId, c.username, oldUrl)   // xóa tin nhắn cũ trên Discord (webhook cũ)
    if (url) for (const c of mine) refreshBotMessage(req.userId, c.username, true)   // webhook mới: tạo ngay tin nhắn trạng thái
  }
  res.json({ success: true, message: 'Đã lưu webhook' })
})

app.post('/api/webhook/test', async (req, res) => {
  const url = discordWebhookUrl(req.userId)
  if (!url) return res.json({ success: false, message: 'Chưa cấu hình webhook' })
  if (!isDiscordWebhook(url)) return res.json({ success: false, message: 'URL phải là Discord webhook HTTPS hợp lệ.' })
  const mine = BOT_LIST.filter(c => c.ownerId === req.userId && c.username)
  if (!mine.length) return res.json({ success: false, message: 'Chưa có bot nào để gửi thử' })
  // Gửi thử = sửa lại tin trạng thái của từng bot và báo kết quả thật
  const results = await Promise.all(mine.map(c => refreshBotMessage(req.userId, c.username, true)))
  if (!results.some(Boolean)) return res.json({ success: false, message: 'Không gửi được webhook. Kiểm tra URL hoặc quyền webhook.' })
  res.json({ success: true, message: 'Đã gửi test webhook' })
})

// ===================== XEM GUI / BẤM SLOT / TPA =====================
app.get('/api/settings', (req, res) => {
  const p = auth.prefsOf(req.userId)
  res.json({ autoMenu: p.autoMenu, autoConfirm: p.autoConfirm })
})

app.post('/api/settings', (req, res) => {
  const { autoMenu, autoConfirm } = req.body || {}
  const p = auth.setPrefs(req.userId, { autoMenu, autoConfirm })
  log('SYSTEM', 'SETTINGS', `⚙️ autoMenu=${p.autoMenu} autoConfirm=${p.autoConfirm}`, req.userId)
  res.json({ success: true, autoMenu: p.autoMenu, autoConfirm: p.autoConfirm })
})

// Xem GUI đang mở của 1 bot (đọc live từ bot.currentWindow để luôn mới)
app.get('/api/gui/:username', (req, res) => {
  const s = botStates[req.params.username]
  if (!s || !s.bot) return res.json({ hasGui: false, message: 'Bot chưa được tạo' })
  pruneTpaRequests(s)
  try {
    const live = s.bot.currentWindow
    if (live) {
      const snap = snapshotWindow(live)
      s.pendingWindow = snap
      return res.json({ hasGui: true, username: s.username, ...snap, tpaRequests: s.tpaRequests.slice(-5) })
    }
  } catch (e) {}
  if (s.pendingWindow) {
    return res.json({ hasGui: true, username: s.username, ...s.pendingWindow, closed: true, tpaRequests: s.tpaRequests.slice(-5) })
  }
  return res.json({ hasGui: false, username: s.username, tpaRequests: s.tpaRequests.slice(-5) })
})

// TPA tự hết hạn sau 1 phút nếu không duyệt
const TPA_EXPIRE_MS = 60 * 1000

function pruneTpaRequests(s) {
  if (!s || !Array.isArray(s.tpaRequests) || s.tpaRequests.length === 0) return []
  const now = Date.now()
  const expired = []
  s.tpaRequests = s.tpaRequests.filter(r => {
    const exp = r.expiresAt || ((r.at || now) + TPA_EXPIRE_MS)
    if (now > exp) { expired.push(r); return false }
    return true
  })
  for (const r of expired) {
    log(s.username, 'TPA', `⏳ Tự xoá lời xin TPA của ${r.from} (quá 1 phút không duyệt)`)
  }
  return expired
}

// Quét định kỳ mỗi 15s để tự xoá TPA hết hạn (kể cả khi không ai mở web)
setInterval(() => {
  try {
    for (const uname of Object.keys(botStates)) pruneTpaRequests(botStates[uname])
  } catch (e) {}
}, 15 * 1000)

// Xoá 1 lời xin TPA (sau khi đã bấm slot Đồng ý/Từ chối trong inv)
function removeTpaRequest(s, from) {
  if (!s || !Array.isArray(s.tpaRequests) || s.tpaRequests.length === 0) return null
  if (from) {
    const idx = s.tpaRequests.findIndex(r => String(r.from || '').toLowerCase() === String(from).toLowerCase())
    if (idx !== -1) return s.tpaRequests.splice(idx, 1)[0]
    return null
  }
  // Không truyền from -> xoá yêu cầu mới nhất (vừa xử lý xong)
  return s.tpaRequests.pop()
}

// Bấm 1 slot trong GUI (Đồng ý / Từ chối) -> tự xoá lời xin TPA vừa xử lý
app.post('/api/gui/:username/click', (req, res) => {
  const s = botStates[req.params.username]
  if (!s || s.isDead || !s.bot || !s.bot.entity) {
    return res.json({ success: false, message: 'Bot chưa sẵn sàng' })
  }
  const slot = parseInt(req.body && req.body.slot, 10)
  const from = req.body && req.body.from ? String(req.body.from) : null
  if (isNaN(slot) || slot < 0) return res.json({ success: false, message: 'Slot không hợp lệ' })
  try {
    const win = s.bot.currentWindow
    if (!win) return res.json({ success: false, message: 'Bot đang không mở GUI nào (đã đóng hoặc hết hạn)' })
    s.bot.clickWindow(slot, 0, 0)
    const removed = removeTpaRequest(s, from)
    if (removed) {
      log(s.username, 'TPA', `🧹 Đã xử lý slot ${slot} -> xoá lời xin TPA của ${removed.from}`)
    } else {
      log(s.username, 'GUI', `👆 Web bấm slot ${slot} trong "${win.title || 'Unknown'}"`)
    }
    res.json({ success: true, message: `Đã bấm slot ${slot}` + (removed ? ` — đã xoá TPA của ${removed.from}` : ''), removed: removed || null })
  } catch (e) {
    res.json({ success: false, message: e.message })
  }
})

// Đóng GUI đang mở
app.post('/api/gui/:username/close', (req, res) => {
  const s = botStates[req.params.username]
  if (!s || !s.bot) return res.json({ success: false, message: 'Bot chưa được tạo' })
  try {
    if (s.bot.currentWindow) s.bot.closeWindow(s.bot.currentWindow)
    s.pendingWindow = null
    log(s.username, 'GUI', `📁 Đóng GUI từ web`)
    res.json({ success: true, message: 'Đã đóng GUI' })
  } catch (e) {
    res.json({ success: false, message: e.message })
  }
})

// Danh sách TPA của 1 bot / tất cả bot (lọc hết hạn trước khi trả)
app.get('/api/tpa/:username', (req, res) => {
  const s = botStates[req.params.username]
  if (!s) return res.json({ requests: [] })
  pruneTpaRequests(s)
  res.json({ requests: s.tpaRequests.slice().reverse() })
})

app.get('/api/tpa', (req, res) => {
  const all = []
  for (const uname of Object.keys(botStates)) {
    if (ownerOf(uname) !== req.userId) continue
    const s = botStates[uname]
    pruneTpaRequests(s)
    for (const r of (s.tpaRequests || []).slice(-5)) {
      all.push({ bot: uname, ...r })
    }
  }
  all.sort((a, b) => (b.at || 0) - (a.at || 0))
  res.json({ requests: all.slice(0, 20) })
})

// Duyệt TPA từ web: Đồng ý = /tpaccept rồi đợi GUI mở auto bấm slot 16,
// Từ chối = vẫn /tpaccept rồi đợi GUI mở auto bấm slot 10
const TPA_ACCEPT_SLOT = 16
const TPA_DENY_SLOT = 10
const TPA_GUI_WAIT_MS = 20 * 1000

app.post('/api/tpa/:username', (req, res) => {
  const s = botStates[req.params.username]
  if (!s || s.isDead || !s.bot || !s.bot.entity) {
    return res.json({ success: false, message: 'Bot chưa sẵn sàng' })
  }
  const { action, from } = req.body || {}
  const slot = action === 'deny' ? TPA_DENY_SLOT : TPA_ACCEPT_SLOT
  const full = from ? `/tpaccept ${from}` : '/tpaccept'
  try {
    s.bot.chat(full)
    // Hẹn giờ: khi GUI xác nhận mở ra sẽ tự bấm slot đã hẹn
    s.pendingAutoClick = { slot, from: from || null, expiresAt: Date.now() + TPA_GUI_WAIT_MS }
    setTimeout(() => {
      if (s.pendingAutoClick && Date.now() > s.pendingAutoClick.expiresAt) {
        log(s.username, 'TPA', `⏳ Hết 20s chờ GUI cho ${from || 'TPA'} — bỏ auto-click slot ${slot}`)
        s.pendingAutoClick = null
      }
    }, TPA_GUI_WAIT_MS + 1000)
    log(s.username, 'TPA', `${action === 'deny' ? '❌ Từ chối' : '✅ Đồng ý'} TPA ${from || '(mới nhất)'}: đã gửi "${full}" — đợi GUI mở rồi auto bấm slot ${slot}`)
    res.json({ success: true, message: `Đã gửi: ${full} — đợi GUI mở rồi auto bấm slot ${slot}` })
  } catch (e) {
    res.json({ success: false, message: e.message })
  }
})

// Xoá tay 1 lời xin TPA (nút 🗑 trên web) hoặc xoá hết
app.delete('/api/tpa/:username', (req, res) => {
  const s = botStates[req.params.username]
  if (!s) return res.json({ success: false, message: 'Không tìm thấy bot' })
  const { from } = req.query || {}
  if (from) {
    const removed = removeTpaRequest(s, String(from))
    if (!removed) return res.json({ success: false, message: 'Không tìm thấy yêu cầu của ' + from })
    log(s.username, 'TPA', `🧹 Xoá tay lời xin TPA của ${removed.from}`)
    return res.json({ success: true, message: `Đã xoá TPA của ${removed.from}` })
  }
  const n = (s.tpaRequests || []).length
  s.tpaRequests = []
  log(s.username, 'TPA', `🧹 Xoá hết ${n} lời xin TPA từ web`)
  res.json({ success: true, message: `Đã xoá ${n} yêu cầu` })
})

// cat: all | system | chat  — chỉ log của bot thuộc tài khoản đang đăng nhập, tối đa 300 dòng gần nhất
app.get('/api/logs', (req, res) => {
  const cat = String(req.query.cat || 'all')
  let limit = parseInt(req.query.limit, 10)
  if (!(limit > 0)) limit = 100
  limit = Math.min(limit, LOG_KEEP)
  const mine = (e) => e.owner === req.userId
  const lp = logPrefsOf(req.userId)
  const sys = sysLogs.filter(e => mine(e) && !logHiddenBy(lp, e.type, e.msg))   // áp luôn cho log đã có trong bộ nhớ
  const chat = chatLogs.filter(mine)
  let list
  if (cat === 'chat') list = chat
  else if (cat === 'system') list = sys
  else list = sys.concat(chat).sort((a, b) => a.id - b.id).slice(-LOG_KEEP)
  const shown = list.slice(-limit).map(e => {
    if (e.type !== 'CHAT') return e
    const who = skinChatWho(e.msg)
    return who ? Object.assign({}, e, { who }) : e
  })
  const skins = {}
  for (const e of shown) if (e.who) skins[String(e.who).toLowerCase()] = skinHashOf(e.who)
  res.json({
    logs: shown,
    skins,
    counts: { all: Math.min(LOG_KEEP, sys.length + chat.length), system: sys.length, chat: chat.length }
  })
})

// Cài đặt log (3 nút trong mục Cài đặt)
app.get('/api/logsettings', (req, res) => res.json(Object.assign({ success: true }, logPrefsOf(req.userId))))
app.post('/api/logsettings', (req, res) => {
  const body = req.body || {}
  const cur = logPrefsOf(req.userId)
  for (const k of ['hideDebugLogs', 'ignoreServerNotices', 'betterLog']) if (typeof body[k] === 'boolean') cur[k] = body[k]
  logSettings[req.userId] = cur
  if (!saveLogSettings()) return res.json(Object.assign({ success: false, message: 'Không lưu được cài đặt log' }, cur))
  res.json(Object.assign({ success: true, message: 'Đã lưu cài đặt log' }, cur))
})

// Xoá log của riêng tài khoản này (không đụng log người khác)
app.post('/api/logs/clear', (req, res) => {
  for (const buf of [sysLogs, chatLogs]) {
    const keep = buf.filter(e => e.owner !== req.userId)
    buf.length = 0
    keep.forEach(e => buf.push(e))
  }
  res.json({ success: true, message: 'Đã xoá log của bạn' })
})

// index.html (~170KB): đọc + nén gzip 1 lần, chỉ làm lại khi file đổi -> mỗi lần mở web chỉ gửi bản nén ~30KB, không đọc đĩa
let _indexCache = { mtime: 0, raw: null, gz: null, etag: '' }
app.get('/', (req, res) => {
  const indexFile = path.join(PUBLIC_DIR, 'index.html')
  let st
  try { st = fs.statSync(indexFile) } catch (e) { return res.status(404).send('Thiếu file index.html (đặt cùng thư mục login.js hoặc trong thư mục public)') }
  if (_indexCache.mtime !== st.mtimeMs || !_indexCache.raw) {
    const raw = fs.readFileSync(indexFile)
    _indexCache = { mtime: st.mtimeMs, raw, gz: _zlib.gzipSync(raw, { level: 9 }), etag: 'W/"' + st.size + '-' + Math.floor(st.mtimeMs) + '"' }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('ETag', _indexCache.etag)
  res.setHeader('Vary', 'Accept-Encoding')
  if (req.headers['if-none-match'] === _indexCache.etag) return res.status(304).end()
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.setHeader('Content-Encoding', 'gzip')
    return res.end(_indexCache.gz)
  }
  res.end(_indexCache.raw)
})

const httpServer = app.listen(PORT, () => {
  printBanner()
})
setupSellSocket(httpServer)

// Giám sát event loop: nếu bị nghẽn >300ms (CPU quá tải) thì ghi log PERF, tối đa 1 lần / 30 giây
;(function () {
  let last = Date.now(), lastWarn = 0
  const t = setInterval(() => {
    const now = Date.now(), lag = now - last - 1000
    last = now
    if (lag > 300 && now - lastWarn > 30000) {
      lastWarn = now
      log('SYSTEM', 'PERF', `⚠️ Event loop bị nghẽn ${lag}ms — web và bot sẽ chậm (CPU quá tải)`)
    }
  }, 1000)
  if (t.unref) t.unref()
})()

process.on('unhandledRejection', (e) => console.error('❌ Unhandled Rejection:', e))
process.on('uncaughtException', (e) => console.error('❌ Uncaught Exception:', e))

startAll()