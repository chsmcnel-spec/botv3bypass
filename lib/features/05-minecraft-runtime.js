// FEATURE MODULE: 05-minecraft-runtime.js
// Mineflayer bot creation, server login, stats checks, auto-sell loop and lifecycle.
// Loaded in order by ../runtime-loader.js; shares the single runtime scope.

// ===================== BOT MANAGER =====================
const botStates = {}

// ===================== SKIN NGƯỜI CHƠI (SkinsRestorer) =====================
// Server dùng SkinsRestorer nên skin hiển thị KHÁC skin Mojang theo tên (mc-heads/minotar sẽ ra sai).
// Cách đúng: đọc property "textures" trong packet player_info mà server gửi cho bot -> lấy URL skin thật
// -> panel tải PNG về rồi phát qua /api/skin/<tên>. Chỉ cho phép host textures.minecraft.net (chống SSRF).
const SKIN_STORE = new Map()   // tên thường -> { name, url, hash }
const SKIN_PNG = new Map()     // hash -> Buffer PNG
const SKIN_PNG_MAX = 300
const SKIN_HOSTS = ['textures.minecraft.net']

function skinSafeUrl(u) {
  try {
    const p = new URL(String(u))
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return ''
    if (!SKIN_HOSTS.includes(p.hostname.toLowerCase())) return ''
    p.protocol = 'https:'
    p.port = ''
    return p.toString()
  } catch (e) { return '' }
}
function skinFromUrl(u) {
  const url = skinSafeUrl(u)
  if (!url) return null
  const hash = new URL(url).pathname.split('/').pop()
  if (!/^[0-9a-f]{16,64}$/i.test(hash)) return null
  return { url, hash: hash.toLowerCase() }
}
function skinFromProps(props) {
  if (!Array.isArray(props)) return null
  const t = props.find(p => p && (p.key === 'textures' || p.name === 'textures'))
  if (!t || !t.value) return null
  try {
    const j = JSON.parse(Buffer.from(String(t.value), 'base64').toString('utf8'))
    return skinFromUrl(j && j.textures && j.textures.SKIN && j.textures.SKIN.url)
  } catch (e) { return null }
}
function skinRemember(name, props) {
  const sk = skinFromProps(props)
  if (!name || !sk) return
  SKIN_STORE.set(String(name).toLowerCase(), { name: String(name), url: sk.url, hash: sk.hash })
  if (SKIN_STORE.size > 5000) SKIN_STORE.delete(SKIN_STORE.keys().next().value)
}
// Hỗ trợ cả định dạng cũ (data[].name/properties) lẫn 1.19.3+ (data[].player.name/properties)
function skinOnPlayerInfo(pkt) {
  const list = pkt && pkt.data
  if (!Array.isArray(list)) return
  for (const d of list) {
    if (!d) continue
    const pl = d.player || d
    skinRemember(pl.name || d.name, pl.properties || d.properties)
  }
}
function skinLookup(name) {
  const low = String(name || '').toLowerCase()
  if (!low) return null
  const hit = SKIN_STORE.get(low)
  if (hit) return hit
  // Dự phòng: dữ liệu skin mà mineflayer tự parse trong bot.players
  for (const k of Object.keys(botStates)) {
    const b = botStates[k] && botStates[k].bot
    if (!b || !b.players) continue
    const pl = b.players[name] || Object.values(b.players).find(x => x && String(x.username || '').toLowerCase() === low)
    const sk = pl && pl.skinData && skinFromUrl(pl.skinData.url)
    if (sk) {
      const ent = { name: String(name), url: sk.url, hash: sk.hash }
      SKIN_STORE.set(low, ent)
      return ent
    }
  }
  return null
}
function skinHashOf(name) { const e = skinLookup(name); return e ? e.hash : '' }
function skinFetchPng(ent) {
  const cached = SKIN_PNG.get(ent.hash)
  if (cached) return Promise.resolve(cached)
  return new Promise((resolve, reject) => {
    const req = https.get(ent.url, { timeout: 8000, headers: { 'User-Agent': 'KingSMP-Panel/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      let n = 0
      res.on('data', (c) => {
        n += c.length
        if (n > 262144) return req.destroy(new Error('skin quá lớn'))
        chunks.push(c)
      })
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return reject(new Error('không phải PNG'))
        SKIN_PNG.set(ent.hash, buf)
        if (SKIN_PNG.size > SKIN_PNG_MAX) SKIN_PNG.delete(SKIN_PNG.keys().next().value)
        resolve(buf)
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}
// Lấy tên người gửi từ dòng chat (cùng kiểu nhận diện với giao diện); chỉ trả về khi đã biết skin của người đó
function skinChatWho(msg) {
  const t = String(msg || '').replace(/§[0-9a-fk-or]/gi, '').replace(/[\uE000-\uF8FF\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '').trim()
  const m = t.match(/^(?:<([A-Za-z0-9_.]{3,16})>|(?:\[[^\]]{1,40}\]\s*|\([^)]{1,40}\)\s*|[^\w\s<\[(]{1,6}\s*)*([A-Za-z0-9_.]{3,16})\s*(?:»|›|➤|➜|➔|≫|❯|→|>>|:))/)
  const who = m && (m[1] || m[2])
  return who && skinLookup(who) ? who : ''
}

function createBot(username, opts) {
  opts = opts || {}
  const isAutoRetry = !!opts.autoRetry
  const isManual = !!opts.manual
  const cfg = BOT_LIST.find(b => b.username === username)
  if (!cfg) {
    log('SYSTEM', 'ERROR', `Không tìm thấy bot ${username} trong config`)
    return null
  }

  const old = botStates[username]
  // Giữ số lần reconnect đã thử + số dư + TPA cũ khi auto retry
  const prevTries = old && typeof old.reconnectTries === 'number' ? old.reconnectTries : 0
  const prevBalance = old ? old.balance : null
  const prevBalanceAt = old ? old.balanceUpdateAt : 0
  const prevTpa = old && Array.isArray(old.tpaRequests) ? old.tpaRequests : []
  if (old && old.bot) {
    try {
      old.bot._destroyed = true
      old.bot.removeAllListeners()
      if (old.bot.end) old.bot.end()
    } catch (e) {}
  }
  if (old && old.reconnectTimer) {
    try { clearTimeout(old.reconnectTimer) } catch (e) {}
  }
  if (old && old._stableTimer) {
    try { clearTimeout(old._stableTimer) } catch (e) {}
  }
  if (old && old.sellLoopTimer) {
    try { clearInterval(old.sellLoopTimer) } catch (e) {}
  }
  if (old) stopStatsAutoCheck(old)

  log(username, 'CREATE', `Tạo bot mới | ${SERVER_IP}:${SERVER_PORT}${isAutoRetry ? ' (reconnect lần ' + prevTries + ')' : ''}`)

  let bot
  try {
    const botOpts = {
      host: SERVER_IP,
      port: SERVER_PORT,
      username: cfg.username,
      version: SERVER_VERSION,
      checkTimeoutInterval: 60000,
      // AFK chỉ cần chunk quanh chân: mặc định mineflayer xin 'far' (12 chunk) -> giải mã ~600 chunk/bot, ngốn CPU + RAM
      viewDistance: Number(CONFIG.BOT_VIEW_DISTANCE) || 3
    }
    // Có proxy -> mở socket qua proxy rồi giao cho mineflayer (không có thì nối thẳng như cũ)
    const proxyUrl = getBotProxy(cfg)
    if (proxyUrl) {
      botOpts.agent = buildAgent(proxyUrl) // proxy sai định dạng -> ném lỗi, rơi xuống catch bên dưới
      botOpts.connect = (client) => {
        connectViaProxy(proxyUrl, SERVER_IP, SERVER_PORT).then((socket) => {
          client.setSocket(socket)
          client.emit('connect')
        }).catch((err) => {
          // Proxy chết/sai: báo lỗi + 'end' để cơ chế tự reconnect của bot chạy tiếp
          try { client.emit('error', err) } catch (e) {}
          try { client.emit('end', 'Proxy lỗi: ' + err.message) } catch (e) {}
        })
      }
      log(username, 'PROXY', `🌐 Kết nối qua proxy ${proxyLabel(proxyUrl)}`)
    }
    bot = mineflayer.createBot(botOpts)
  } catch (e) {
    log(username, 'ERROR', `Không tạo được bot: ${e.message}`)
    // Tạo bot lỗi ngay từ đầu cũng tính là 1 lần thử -> hẹn retry tiếp
    if (!isManual) scheduleReconnect(username, e.message, 'error', prevTries)
    return null
  }

  const state = {
    username,
    bot,
    password: decryptPw(cfg.password),
    inCluster: false,
    isDead: false,
    isLoggingIn: false,
    balance: prevBalance,
    balanceUpdateAt: prevBalanceAt,
    lastMessage: '',
    createdAt: Date.now(),
    _loginAttempted: false,
    _menuAttempted: false,
    pendingWindow: null,
    tpaRequests: prevTpa,
    pendingAutoClick: null,
    reconnectTries: isAutoRetry ? prevTries : 0,
    reconnectTimer: null,
    manualDisconnect: false,
    sellActive: false,
    sellBusy: false,
    sellLoopTimer: null,
    sellLastSell: 0,
    sellLastOpenTry: 0,
    sellLastWaitLog: 0,
    sellStats: { moved: 0, rounds: 0, topCount: 0 },
    tps: null, tpsAt: 0, _tpsSamples: [],
    payBusy: false, payNextAt: 0, lastPaySent: null,
    payStats: old && old.payStats ? old.payStats : { count: 0, total: 0, last: null },
    homeLastTry: 0, homeFails: 0,
    statsData: old && old.statsData ? old.statsData : null,
    statsLastCheckedAt: old && old.statsLastCheckedAt ? old.statsLastCheckedAt : 0,
    statsBusy: false, statsAwaitingWindow: false, statsError: '',
    statsNextCheckAt: 0, statsInitialTimer: null, statsAutoTimer: null, statsRetryTimer: null,
    statsTimeout: null, statsCommandTimer: null
  }
  botStates[username] = state
  setupBotEvents(state)
  // Bot restart mà auto sell đang BẬT -> tự chạy lại khi bot sẵn sàng (loop tự đợi vào cụm)
  try {
    if (getSellCfg(username).enabled) startSellLoop(state)
  } catch (e) {}
  return state
}

// Hẹn reconnect: không bỏ cuộc — lặp lại tới khi bot hết DEAD, thời gian chờ tăng dần (xem reconnectDelayFor)
function scheduleReconnect(username, reason, type, currentTries) {
  // Không reconnect nếu: đang trong giờ nghỉ lịch, bot đã bị xoá, admin ngắt tay
  if (isOutActive(username)) {
    log(username, 'RECONNECT', `⏸️ Đang trong giờ nghỉ lịch — không auto reconnect`)
    return
  }
  const cfg = BOT_LIST.find(b => b.username === username)
  if (!cfg) return
  const tries = typeof currentTries === 'number' ? currentTries : ((botStates[username] && botStates[username].reconnectTries) || 0)
  const nextAttempt = tries + 1
  const delayMs = reconnectDelayFor(nextAttempt)
  log(username, 'RECONNECT', `🔄 Mất KN (${type}) — bot DEAD, thử vô lại lần ${nextAttempt} sau ${fmtDelay(delayMs)} (tự lặp tới khi online) | Lý do: ${String(reason).slice(0, 200)}`)
  if (nextAttempt <= RECONNECT_MAX_TRIES) webhookReconnectAttempt(username, reason, nextAttempt, delayMs)
  else if (nextAttempt === RECONNECT_MAX_TRIES + 1) webhookReconnectFailed(username, reason, delayMs)   // từ lần 3: chỉ báo 1 lần, tránh spam Discord
  try {
    const st = botStates[username]
    if (st && st.reconnectTimer) clearTimeout(st.reconnectTimer)
  } catch (e) {}
  const timer = setTimeout(() => {
    try {
      // Hủy nếu bot đã bị xoá khỏi list / đang trong giờ nghỉ / đã được vô lại (tay hoặc timer khác)
      if (!BOT_LIST.find(b => b.username === username)) return
      if (isOutActive(username)) {
        log(username, 'RECONNECT', `⏸️ Tới giờ retry nhưng đang nghỉ lịch — hủy retry lần ${nextAttempt}`)
        return
      }
      const cur = botStates[username]
      if (cur && cur.bot && !cur.isDead) return   // đang online / đang login dở -> không đè lên
      if (cur) { cur.reconnectTries = nextAttempt; cur.reconnectNextAt = 0 }
      else botStates[username] = { reconnectTries: nextAttempt }
      createBot(username, { autoRetry: true })
    } catch (e) {
      log(username, 'ERROR', `Reconnect timer lỗi: ${e.message}`)
    }
  }, delayMs)
  try {
    if (botStates[username]) { botStates[username].reconnectTimer = timer; botStates[username].reconnectNextAt = Date.now() + delayMs }
  } catch (e) {}
}

const STATS_CHECK_INTERVAL_MS = 60 * 60 * 1000
const STATS_FIRST_CHECK_DELAY_MS = 25 * 1000
const STATS_RESPONSE_TIMEOUT_MS = 18 * 1000

function statsComponentText(value, depth = 0) {
  if (value == null || depth > 12) return ''
  if (typeof value === 'string' || typeof value === 'number') {
    const raw = String(value)
    // Mineflayer đôi lúc trả JSON component dưới dạng chuỗi.
    if ((raw[0] === '{' || raw[0] === '[') && raw.length < 20000) {
      try { return statsComponentText(JSON.parse(raw), depth + 1) } catch (e) {}
    }
    return raw
  }
  if (Array.isArray(value)) return value.map(v => statsComponentText(v, depth + 1)).join('')
  if (typeof value !== 'object') return ''

  // NBT wrapper: { type, value } hoặc { value: { ... } }.
  if (Object.prototype.hasOwnProperty.call(value, 'value') && value.text === undefined && value.extra === undefined && value[''] === undefined) {
    const nested = statsComponentText(value.value, depth + 1)
    if (nested) return nested
  }
  let out = ''
  if (typeof value.text === 'string') out += value.text
  if (typeof value[''] === 'string') out += value['']
  if (value.extra) out += statsComponentText(value.extra, depth + 1)
  if (!out && value.translate) out = String(value.translate)
  return out
}

function cleanStatsText(value) {
  let text = statsComponentText(value)
  if (!text) {
    try { text = plainTitle(value == null ? '' : value) } catch (e) { text = String(value == null ? '' : value) }
  }
  return String(text)
    .replace(/§x(§[0-9a-f]){6}/gi, '')
    .replace(/&x(&[0-9a-f]){6}/gi, '')
    .replace(/&#[0-9a-f]{6}/gi, '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/&[0-9a-fk-or]/gi, '')
    .replace(/[\u00a0\u200b\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeStatsDisplayName(value) {
  const map = {
    'ᴀ':'A','ʙ':'B','ᴄ':'C','ᴅ':'D','ᴇ':'E','ғ':'F','ɢ':'G','ʜ':'H','ɪ':'I','Ɪ':'I',
    'ᴊ':'J','ᴋ':'K','ʟ':'L','ᴍ':'M','ɴ':'N','ᴏ':'O','ᴘ':'P','ǫ':'Q','ʀ':'R','Ʀ':'R',
    'ꜱ':'S','ᴛ':'T','ᴜ':'U','ᴠ':'V','ᴡ':'W','x':'X','ʏ':'Y','ᴢ':'Z','đ':'D','Đ':'D'
  }
  return cleanStatsText(value).replace(/[ᴀʙᴄᴅᴇғɢʜɪꞮᴊᴋʟᴍɴᴏᴘǫʀƦꜱᴛᴜᴠᴡxʏᴢđĐ]/gu, ch => map[ch] || ch).toUpperCase().trim()
}

function statsLoreOf(item) {
  if (Array.isArray(item.customLore)) return item.customLore
  if (Array.isArray(item.lore)) return item.lore
  try {
    const root = item.nbt && (item.nbt.value || item.nbt)
    if (!root) return []
    const display = root.display && (root.display.value || root.display)
    let rawLore = display && (display.lore || display.Lore)
    if (!rawLore) rawLore = root['minecraft:lore'] || root.lore
    if (!rawLore) return []
    let lines = rawLore.value !== undefined ? rawLore.value : rawLore
    if (lines && lines.value !== undefined) lines = lines.value
    if (typeof lines === 'string') lines = [lines]
    if (!Array.isArray(lines)) return []
    return lines.map(line => {
      if (line && typeof line === 'object' && line.value !== undefined) return line.value
      return line
    })
  } catch (e) {}
  return []
}

// Cùng logic trích xuất GUI của CheckStatsKingMC: quét item, displayName và lore từ NBT.
function extractStatsWindow(window) {
  const slots = window && Array.isArray(window.slots) ? window.slots : []
  const guiSize = Number.isInteger(window && window.inventoryStart) && window.inventoryStart > 0
    ? Math.min(window.inventoryStart, slots.length)
    : (window && window.inventorySlots && window.inventorySlots.length
      ? Math.max(0, slots.length - window.inventorySlots.length)
      : (slots.length > 36 ? slots.length - 36 : slots.length))
  const items = []
  for (let i = 0; i < guiSize; i++) {
    const item = slots[i]
    if (!item) continue
    const displayRaw = cleanStatsText(item.customName || item.displayName || '')
    const displayName = normalizeStatsDisplayName(displayRaw) || cleanStatsText(item.name || 'Thông tin')
    const itemName = String(item.name || '').toLowerCase()
    const lore = statsLoreOf(item).map(cleanStatsText).filter(line => {
      if (!line || /^[_\-+=*~]*$/.test(line)) return false
      if (line.includes('------') || line.includes('======') || line.includes('______')) return false
      if (/nhấp|click|click chuột/i.test(line)) return false
      return true
    })
    if (itemName === 'air' || itemName === 'barrier' || itemName.includes('glass_pane')) continue
    if (!lore.length) continue
    items.push({ slot: i, name: item.name || 'unknown', displayName, lore: lore.slice(0, 12) })
  }
  return { title: cleanStatsText(window && window.title ? window.title : 'Stats') || 'Stats', items }
}

function finishStatsCheck(state, window) {
  if (!state || !state.statsBusy || botStates[state.username] !== state) return
  const result = extractStatsWindow(window)
  if (!result.items.length) {
    failStatsCheck(state, 'GUI /stats không có dữ liệu hợp lệ.')
    return
  }
  const now = Date.now()
  state.statsData = { title: result.title || 'Stats', checkedAt: now, items: result.items }
  state.statsLastCheckedAt = now
  state.statsError = ''
  state.statsBusy = false
  state.statsAwaitingWindow = false
  if (state.statsTimeout) clearTimeout(state.statsTimeout)
  state.statsTimeout = null
  if (state.statsCommandTimer) clearTimeout(state.statsCommandTimer)
  state.statsCommandTimer = null
  log(state.username, 'STATS', `✅ Đã cập nhật Stats (${result.items.length} mục)`)
  try { if (state.bot && state.bot.currentWindow === window) state.bot.closeWindow(window) } catch (e) {}
}

function failStatsCheck(state, message) {
  if (!state || !state.statsBusy) return
  state.statsBusy = false
  state.statsAwaitingWindow = false
  state.statsError = String(message || 'Không lấy được Stats').slice(0, 240)
  if (state.statsTimeout) clearTimeout(state.statsTimeout)
  if (state.statsCommandTimer) clearTimeout(state.statsCommandTimer)
  state.statsTimeout = null
  state.statsCommandTimer = null
  log(state.username, 'STATS', `⚠️ Check Stats thất bại: ${state.statsError}`)
}

function requestStatsCheck(state, source = 'manual') {
  if (!state || state.isDead || !state.bot || !state.bot.entity || !state.inCluster) {
    return { ok: false, message: 'Bot chưa online trong cụm KingSMP.' }
  }
  if (state.statsBusy) {
    if (source === 'auto') scheduleStatsRetry(state)
    return { ok: false, message: 'Bot đang kiểm tra Stats.' }
  }
  if (state.sellBusy || state.bot.currentWindow) {
    if (source === 'auto') scheduleStatsRetry(state)
    return { ok: false, message: 'Bot đang thao tác GUI / Auto Sell. Thử lại sau khi bot rảnh.' }
  }

  if (state.statsRetryTimer) { clearTimeout(state.statsRetryTimer); state.statsRetryTimer = null }
  state.statsBusy = true
  state.statsError = ''
  state.statsRequestedAt = Date.now()
  state.statsAwaitingWindow = false
  log(state.username, 'STATS', `${source === 'auto' ? '⏰ Tự động' : '🔎'} bắt đầu Check Stats (chu kỳ 1 giờ)`)
  try {
    // Cập nhật số dư cùng chu kỳ để lịch sử Money có thêm điểm dữ liệu cho biểu đồ.
    state.bot.chat('/bal')
  } catch (e) {
    failStatsCheck(state, 'Không gửi được /bal: ' + e.message)
    return { ok: false, message: state.statsError }
  }

  state.statsCommandTimer = setTimeout(() => {
    if (!state.statsBusy || state.isDead || !state.bot) return
    state.statsAwaitingWindow = true
    try {
      // CheckStatsKingMC sử dụng chính cú pháp /stats <tên người chơi> rồi đọc GUI trả về.
      state.bot.chat('/stats ' + state.username)
    } catch (e) {
      failStatsCheck(state, 'Không gửi được /stats: ' + e.message)
    }
  }, 1200)

  state.statsTimeout = setTimeout(() => {
    if (state.statsBusy) failStatsCheck(state, 'Timeout! Server không mở GUI /stats sau ' + Math.round(STATS_RESPONSE_TIMEOUT_MS / 1000) + ' giây.')
  }, STATS_RESPONSE_TIMEOUT_MS + 1200)
  return { ok: true, message: 'Đã gửi /bal và /stats; đang chờ GUI trả dữ liệu.' }
}

function scheduleStatsRetry(state) {
  if (!state || state.isDead || !state.inCluster || state.statsRetryTimer) return
  state.statsNextCheckAt = Date.now() + 60 * 1000
  state.statsRetryTimer = setTimeout(() => {
    state.statsRetryTimer = null
    if (!state.isDead && state.inCluster && botStates[state.username] === state) requestStatsCheck(state, 'auto')
  }, 60 * 1000)
}

function startStatsAutoCheck(state) {
  if (!state || state.isDead || !state.inCluster || state.statsAutoTimer) return
  state.statsNextCheckAt = Date.now() + STATS_FIRST_CHECK_DELAY_MS
  state.statsInitialTimer = setTimeout(() => {
    state.statsInitialTimer = null
    state.statsNextCheckAt = Date.now() + STATS_CHECK_INTERVAL_MS
    if (!state.isDead && state.inCluster) requestStatsCheck(state, 'auto')
  }, STATS_FIRST_CHECK_DELAY_MS)
  state.statsAutoTimer = setInterval(() => {
    if (state.isDead || !state.inCluster || botStates[state.username] !== state) return
    state.statsNextCheckAt = Date.now() + STATS_CHECK_INTERVAL_MS
    requestStatsCheck(state, 'auto')
  }, STATS_CHECK_INTERVAL_MS)
}

function stopStatsAutoCheck(state) {
  if (!state) return
  for (const key of ['statsInitialTimer', 'statsAutoTimer', 'statsRetryTimer', 'statsTimeout', 'statsCommandTimer']) {
    if (state[key]) {
      if (key === 'statsAutoTimer') clearInterval(state[key])
      else clearTimeout(state[key])
    }
    state[key] = null
  }
  state.statsBusy = false
  state.statsAwaitingWindow = false
  state.statsNextCheckAt = 0
}

function setupBotEvents(state) {
  const bot = state.bot
  const username = state.username

  try { installPhysicsAndVehicle(state) } catch (e) { log(username, 'ERROR', 'Physics/vehicle: ' + e.message) }

  bot.once('spawn', () => {
    if (state.isDead) return
    const pos = bot.entity && bot.entity.position
    // Reconnect thành công -> reset bộ đếm + báo webhook
    if (state.reconnectTries > 0) {
      log(username, 'RECONNECT', `✅ Vô lại thành công sau ${state.reconnectTries} lần thử!`)
      webhookReconnectSuccess(username, state.reconnectTries)
      // KHÔNG reset ngay: nếu bot vừa vào đã rớt tiếp thì vẫn phải tăng dần thời gian chờ.
      // Chỉ reset khi online ổn định đủ RECONNECT_STABLE_MS.
      try { if (state._stableTimer) clearTimeout(state._stableTimer) } catch (e) {}
      state._stableTimer = setTimeout(() => {
        if (!state.isDead && botStates[username] === state) {
          state.reconnectTries = 0
          log(username, 'RECONNECT', `🟢 Bot online ổn định ${RECONNECT_STABLE_MS / 1000}s — reset bộ đếm reconnect`)
        }
      }, RECONNECT_STABLE_MS)
    }
    log(username, 'SPAWN', `✅ Spawn thành công! Pos: ${pos ? Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z) : 'unknown'}`)
    setTimeout(() => startLogin(state), 2000)
  })

  bot.on('windowOpen', (window) => {
    if (!window || state.isDead) return
    const title = String(window.title || 'Unknown')
    // Lưu GUI để xem trên web (mọi GUI đều lưu, kể cả MENU)
    try { state.pendingWindow = snapshotWindow(window) } catch (e) {}
    log(username, 'GUI', `📂 Mở GUI: ${plainTitle(title)} (${(window.slots || []).length} slot, shop=${sellGuiSize(window)})`)
    // Realtime inv: slot trong shop đổi -> đẩy ngay về web
    try {
      window.on('updateSlot', () => queueSellPush(username))
    } catch (e) {}
    queueSellPush(username)
    // GUI mở ngay sau lệnh /stats <username>: chờ packet slot ổn định rồi trích xuất item + lore.
    if (state.statsBusy && state.statsAwaitingWindow) {
      state.statsAwaitingWindow = false
      setTimeout(() => {
        if (state.statsBusy && !state.isDead && botStates[username] === state) finishStatsCheck(state, window)
      }, 250)
      return
    }
        // Auto sell: GUI shop mở (sau /sell) -> báo cho loop xử lý ngay
    try {
      if (state.sellActive && !title.includes('MENU')) sellOnGuiOpen(state)
    } catch (e) {}

    // Duyệt TPA từ web: đã bấm Đồng ý/Từ chối -> đợi GUI này mở rồi auto bấm slot đã hẹn
    if (state.pendingAutoClick) {
      if (Date.now() > state.pendingAutoClick.expiresAt) {
        log(username, 'TPA', `⏳ Quá thời gian chờ GUI cho ${state.pendingAutoClick.from || 'TPA'} — bỏ auto-click slot ${state.pendingAutoClick.slot}`)
        state.pendingAutoClick = null
      } else {
        const job = state.pendingAutoClick
        state.pendingAutoClick = null
        log(username, 'TPA', `🎯 GUI đã mở cho ${job.from || 'TPA'} — auto bấm slot ${job.slot} sau 1s`)
        setTimeout(() => {
          try {
            if (state.isDead || !bot.currentWindow) {
              log(username, 'TPA', `⚠️ GUI đã đóng trước khi bấm slot ${job.slot} cho ${job.from || 'TPA'}`)
              return
            }
            bot.clickWindow(job.slot, 0, 0)
            const removed = removeTpaRequest(state, job.from)
            log(username, 'TPA', `✅ Đã bấm slot ${job.slot} cho ${job.from || 'TPA'}${removed ? ' — đã xoá khỏi danh sách' : ''}`)
            setTimeout(() => { try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (e) {} }, 1500)
          } catch (e) {
            log(username, 'ERROR', `Không bấm được slot ${job.slot}: ${e.message}`)
          }
        }, 1000)
        return
      }
    }

    // MENU login: vẫn auto (giữ bot tự vào cụm), nhưng vẫn hiện lên web để xem
    if (title.includes('MENU')) {
      state._menuAttempted = true
      if (!auth.prefsOf(ownerOf(username)).autoMenu) {
        log(username, 'MENU', `⏸️ AUTO_MENU đang TẮT — chờ bạn bấm tay trên web`)
        return
      }
      let targetSlot = 24
      let found = false

      if (window.slots[24]) {
        found = true
        targetSlot = 24
      } else {
        const commonSlots = [13, 22, 25, 31, 40, 49]
        for (const slot of commonSlots) {
          if (window.slots[slot]) {
            targetSlot = slot
            found = true
            break
          }
        }
        if (!found) {
          for (let i = 0; i < window.slots.length; i++) {
            if (window.slots[i]) {
              targetSlot = i
              found = true
              break
            }
          }
        }
      }

      if (found) {
        log(username, 'MENU', `🎯 Auto click slot ${targetSlot} (xem lại trên web)`)
        try { bot.clickWindow(targetSlot, 0, 0) } catch (e) {}
        // Không đóng ngay để web kịp đọc; đợi 2s mới đóng
        setTimeout(() => {
          try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (e) {}
        }, 2000)
        setTimeout(() => {
          if (!state.inCluster && !state.isDead) {
            state.inCluster = true
            log(username, 'CLUSTER', `✅ Đã vào cụm (fallback)`)
            startStatsAutoCheck(state)
          }
        }, 10000)
      }
      return
    }

    // GUI Xác nhận / Confirm / TPA: chỉ auto khi đã hẹn từ web (Đồng ý=slot 16, Từ chối=slot 10)
    // Nếu GUI tự mở mà không có hẹn trước thì chỉ ghi log, không tự bấm
    if (title.includes('Xác nhận') || title.includes('Confirm') || /tpa|teleport|dịch chuyển|dich chuyen/i.test(title)) {
      log(username, 'GUI', `⏳ GUI xác nhận đang chờ — bấm Đồng ý/Từ chối trên web để bot tự bấm slot (16/10)`)
      return
    }
    // Các GUI khác (rương/shop...): chỉ lưu để xem, không tự click
  })

  bot.on('windowClose', (window) => {
    state.pendingWindow = null
    try {
      const t = window && window.title ? String(window.title) : ''
      log(username, 'GUI', `📁 Đóng GUI: ${t || 'Unknown'}`)
      if (state.sellActive) log(username, 'SELL', `⏳ Shop bị đóng — sẽ tự gõ lại /sell để mở tiếp`)
    } catch (e) {}
    queueSellPush(username)
  })

  // Realtime inv: balo đổi (farm về/mất đồ) -> đẩy ngay về web
  try {
    if (bot.inventory && bot.inventory.on) {
      bot.inventory.on('updateSlot', () => queueSellPush(username))
    }
  } catch (e) {}

  bot.on('message', (message) => {
    if (!message || state.isDead) return
    const msgText = message.toString()
    if (!msgText.trim()) return
    state.lastMessage = msgText
    // Màu chữ server gửi về (chỉ dùng khi khớp đúng nội dung chữ thường; không khớp thì hiện chữ thường như cũ)
    let msgSegs
    try {
      msgSegs = componentToSegments(message.json !== undefined ? message.json : msgText, {}, null)
      if (plainText(msgSegs).trim() !== msgText.trim()) msgSegs = undefined
    } catch (e) { msgSegs = undefined }

    // Ưu tiên 1: bắt TPA TRƯỚC mọi filter/duplicate để "hiện luôn"
    // (kể cả log kiểu "muốn dịch chuyển đến bạn" hay "gửi yêu cầu dịch chuyển bạn đến họ")
    try {
      const tpaEarly = parseTpaRequest(msgText, username)
      if (tpaEarly) {
        const dupKey = username + '|TPA|' + tpaEarly.from + '|' + tpaEarly.type
        if (!isDuplicateMessage(dupKey)) {
          pruneTpaRequests(state)
          // Nếu cùng người xin lại thì xoá cũ, push mới (reset 1 phút)
          state.tpaRequests = (state.tpaRequests || []).filter(r => String(r.from || '').toLowerCase() !== String(tpaEarly.from).toLowerCase())
          state.tpaRequests.push({ from: tpaEarly.from, type: tpaEarly.type, raw: tpaEarly.raw, time: new Date().toLocaleTimeString('vi-VN', { hour12: false }), at: Date.now(), expiresAt: Date.now() + TPA_EXPIRE_MS })
          if (state.tpaRequests.length > 10) state.tpaRequests.shift()
          log(username, 'TPA', `📨 ${tpaEarly.from} ${tpaTypeLabel(tpaEarly.type)} — duyệt trên web (tự xoá sau 1 phút) | ${tpaEarly.raw.slice(0, 120)}`)
          webhookTpa(username, tpaEarly.from, tpaEarly.raw, tpaEarly.type)
        }
      }
    } catch (e) {}

    // Chat trong game -> log riêng (type CHAT). Tin nhắn chat là chung cho cả server nên chỉ ghi 1 lần dù nhiều bot cùng nhận.
    const chatInfo = isGameChat(message, msgText, bot)
    if (chatInfo) {
      // Mini log riêng cho từng bot, để bot nào cũng có 3 dòng chat gần nhất.
      addBotMiniChat(username, msgText)
      if (!isDuplicateMessage('CHAT|' + msgText)) log(username, 'CHAT', msgText, undefined, msgSegs)
    } else {
      log(username, 'MSG', msgText, undefined, msgSegs)
    }

    if (shouldFilterMessage(msgText)) return
    if (isDuplicateMessage(username + '|' + msgText)) return

    if (!state.inCluster && state._menuAttempted) {
      const kws = ['đã vào', 'joined', 'vào cụm', 'welcome', 'chào mừng', 'successfully', 'đã đến']
      for (const k of kws) {
        if (msgText.toLowerCase().includes(k.toLowerCase())) {
          state.inCluster = true
          log(username, 'CLUSTER', `✅ Đã vào cụm qua chat`)
          startStatsAutoCheck(state)
          break
        }
      }
    }

    const received = parseReceiveMoney(message)
    if (received) {
      const amountStr = formatMoney(received.amount)
      log(username, 'RECEIVED', `💰 Nhận ${amountStr} từ ${received.sender}`)
      webhookReceived(username, received.sender, amountStr, received.raw, received.amount)
    } else if (/Bạn nhận được|nhận được \$|received \$/.test(msgText)) {
      log(username, 'FAKE', `⚠️ Fake pay không hợp lệ: ${msgText}`)
    }

    const sent = parseSendMoney(msgText)
    const isCommandEcho = /^\s*\/(pay|chuyen|chuyển)\b/i.test(msgText)
    if (sent && !isCommandEcho) {
      state.lastPaySent = { receiver: sent.receiver, amount: sent.amount, at: Date.now() }
      const amountStr = formatMoney(sent.amount)
      log(username, 'SENT', `💸 Chuyển ${amountStr} → ${sent.receiver}`)
      webhookPay(username, sent.receiver, amountStr, sent.raw, sent.amount)
    }

    const balMatch = msgText.match(/Bạn có \$?([\d,\.]+)\s*([KMB]?)/i)
      || msgText.match(/Số dư:?\s*\$?([\d,\.]+)\s*([KMB]?)/i)
      || msgText.match(/Balance:?\s*\$?([\d,\.]+)\s*([KMB]?)/i)
    if (balMatch) {
      state.balance = balMatch[1] + (balMatch[2] || '')
      state.balanceUpdateAt = Date.now()
      recordMoneySample(username, state.balance, state.balanceUpdateAt)
      log(username, 'BALANCE', `💰 Số dư: ${state.balance}`)
    }

  })

  bot.on('chat', () => {})

  // Học danh sách lệnh của server (cây lệnh Brigadier) để gợi ý lệnh trên web
  try {
    if (bot._client && bot._client.on) {
      bot._client.on('declare_commands', (pkt) => {
        try { state.cmdTree = parseCommandTree(pkt) } catch (e) {}
      })
    }
  } catch (e) {}

  // Bắt skin thật (SkinsRestorer) từ packet player_info của server
  try {
    if (bot._client && bot._client.on) bot._client.on('player_info', skinOnPlayerInfo)
  } catch (e) {}
  // Đo TPS thật từ tuổi thế giới (world age) trong packet update_time
  try {
    if (bot._client && bot._client.on) bot._client.on('update_time', (pkt) => { try { tpsSample(state, pkt) } catch (e) {} })
  } catch (e) {}

  bot.on('kicked', (reason) => {
    if (state.isDead) return
    if (state.manualDisconnect) return
    state.isDead = true
    state.inCluster = false
    state.isLoggingIn = false
    stopStatsAutoCheck(state)
    let r = 'unknown'
    try {
      r = typeof reason === 'string' ? reason : JSON.stringify(reason).slice(0, 300)
    } catch (e) { r = String(reason).slice(0, 300) }
    log(username, 'KICKED', `⛔ BỊ KICK: ${r}`)
    webhookDisconnect(username, r, 'kicked')
    scheduleReconnect(username, r, 'kicked', state.reconnectTries || 0)
  })

  bot.on('end', (reason) => {
    if (state.isDead) return
    if (state.manualDisconnect) return
    state.isDead = true
    state.inCluster = false
    state.isLoggingIn = false
    stopStatsAutoCheck(state)
    log(username, 'END', `⛔ Mất kết nối: ${reason || 'unknown'}`)
    webhookDisconnect(username, reason || 'end', 'end')
    scheduleReconnect(username, reason || 'end', 'end', state.reconnectTries || 0)
  })

  bot.on('error', (err) => {
    log(username, 'ERROR', err.message)
    const fatalCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET']
    if (err.code && fatalCodes.includes(err.code)) {
      webhookDisconnect(username, err.message + ' (' + err.code + ')', 'error')
    }
  })
}

function formatMoney(amount) {
  if (amount >= 1000000000) return (amount / 1000000000).toFixed(1) + 'B'
  if (amount >= 1000000) return (amount / 1000000).toFixed(1) + 'M'
  if (amount >= 1000) return (amount / 1000).toFixed(1) + 'K'
  return String(amount)
}

function startLogin(state) {
  if (state.isDead) return
  if (state._loginAttempted) return
  state._loginAttempted = true
  state.isLoggingIn = true

  const bot = state.bot
  const loginCmd = '/dn ' + state.password

  log(state.username, 'LOGIN', `📝 [1/2] Gửi /dn`)
  try { bot.chat(loginCmd) } catch (e) {}

  setTimeout(() => {
    if (state.isDead) return
    log(state.username, 'LOGIN', `📝 [2/2] Gửi lại /dn`)
    try { bot.chat(loginCmd) } catch (e) {}
  }, 3000)

  setTimeout(() => {
    if (state.isDead) return
    if (state.inCluster) return
    log(state.username, 'MENU', `🔄 Gửi /menu`)
    try { bot.chat('/menu') } catch (e) {}
  }, 7000)
}

// ===================== ĐO TPS (từ packet update_time) =====================
// Server tăng world age đúng 20 tick/giây khi TPS = 20 -> TPS = (chênh lệch age) / (số giây thật), kẹp trong 0..20.
const TPS_MIN_WINDOW_MS = 8000
const TPS_MAX_WINDOW_MS = 45000
function ageToNumber(a) {
  if (typeof a === 'bigint') return Number(a)
  if (Array.isArray(a)) return a[0] * 4294967296 + (a[1] >>> 0)   // kiểu Long cũ [high, low]
  return Number(a)
}
function tpsSample(state, pkt) {
  const age = ageToNumber(pkt && (pkt.age !== undefined ? pkt.age : pkt.worldAge))
  if (!Number.isFinite(age)) return
  const now = Date.now()
  const arr = state._tpsSamples || (state._tpsSamples = [])
  const last = arr[arr.length - 1]
  if (last && age < last.age) arr.length = 0                       // thế giới bị reset -> đo lại
  arr.push({ age, at: now })
  while (arr.length > 2 && now - arr[0].at > TPS_MAX_WINDOW_MS) arr.shift()
  const dt = now - arr[0].at
  if (dt < TPS_MIN_WINDOW_MS) return
  const tps = (age - arr[0].age) / (dt / 1000)
  if (!Number.isFinite(tps)) return
  state.tps = Math.max(0, Math.min(20, Math.round(tps * 10) / 10))
  state.tpsAt = now
}

// ===================== TỰ VỀ /home KHI LỆCH TOẠ ĐỘ =====================
const HOME_TOLERANCE = 1             // ±1 block ở CẢ 3 chiều; vượt ở bất kỳ chiều nào là gửi /home
const HOME_COOLDOWN_MS = 20000       // chờ giữa 2 lần gửi (tăng dần nếu về rồi mà vẫn lệch, tối đa x6)
function homeTick(state) {
  const username = state.username
  const cfg = getHomeCfg(username)
  if (!cfg.enabled || cfg.x === null || cfg.y === null || cfg.z === null) return
  const bot = state.bot
  if (!bot || state.isDead || !state.inCluster || !bot.entity || !bot.entity.position) return
  const p = bot.entity.position
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return
  const dx = p.x - cfg.x, dy = p.y - cfg.y, dz = p.z - cfg.z
  if (Math.abs(dx) <= HOME_TOLERANCE && Math.abs(dy) <= HOME_TOLERANCE && Math.abs(dz) <= HOME_TOLERANCE) {
    state.homeFails = 0
    return
  }
  const now = Date.now()
  if (now - (state.homeLastTry || 0) < HOME_COOLDOWN_MS * Math.min(6, 1 + (state.homeFails || 0))) return
  state.homeLastTry = now
  state.homeFails = (state.homeFails || 0) + 1
  const cmd = cfg.name ? '/home ' + cfg.name : '/home'
  const f = (n) => (Math.round(n * 10) / 10).toString()
  try { bot.chat(cmd) } catch (e) { return }
  log(username, 'HOME', `📍 Lệch toạ độ (Δx=${f(dx)} Δy=${f(dy)} Δz=${f(dz)}) → gửi ${cmd}`)
  pushBotEvent(ownerOf(username), username, '📍', `Lệch toạ độ (${f(dx)}/${f(dy)}/${f(dz)}) → ${cmd}`)
}

// ===================== TỰ CHUYỂN TIỀN (/bal -> /pay) =====================
const PAY_BAL_RX = [/Bạn có \$?([\d,\.]+)\s*([KMB]?)/i, /Số dư:?\s*\$?([\d,\.]+)\s*([KMB]?)/i, /Balance:?\s*\$?([\d,\.]+)\s*([KMB]?)/i]
// Gõ /bal rồi đợi dòng số dư. Dùng listener riêng (không qua bộ lọc trùng lặp) để lần /bal thứ 2 giống hệt lần 1 vẫn đọc được.
function payReadBalance(state, timeoutMs) {
  return new Promise((resolve) => {
    const bot = state.bot
    let done = false, timer = null
    const finish = (v) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { bot.removeListener('message', onMsg) } catch (e) {}
      resolve(v)
    }
    const onMsg = (message) => {
      const text = String(message)
      for (const rx of PAY_BAL_RX) {
        const m = rx.exec(text)
        if (m) {
          const n = parseBalance(m[1] + (m[2] || ''))
          if (Number.isFinite(n)) return finish(n)
        }
      }
    }
    timer = setTimeout(() => finish(null), timeoutMs || 8000)
    try { bot.on('message', onMsg); bot.chat('/bal') } catch (e) { finish(null) }
  })
}
// Đợi dòng xác nhận "Bạn đã chuyển cho <người nhận> $..." sau khi gõ /pay
function payWaitConfirm(state, receiver, timeoutMs) {
  return new Promise((resolve) => {
    const bot = state.bot
    let done = false, timer = null
    const finish = (v) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { bot.removeListener('message', onMsg) } catch (e) {}
      resolve(v)
    }
    const onMsg = (message) => {
      const text = String(message)
      if (/^\s*\/(pay|chuyen|chuyển)\b/i.test(text)) return
      const sent = parseSendMoney(text)
      if (sent && String(sent.receiver).toLowerCase() === String(receiver).toLowerCase()) finish(sent)
    }
    timer = setTimeout(() => finish(null), timeoutMs || 6000)
    try { bot.on('message', onMsg) } catch (e) { finish(null) }
  })
}
function payPickAmount(cfg, bal) {
  if (cfg.mode === 'fixed') return bal >= cfg.amount ? Math.floor(cfg.amount) : 0
  if (cfg.mode === 'random') {
    const hi = Math.min(cfg.maxM, Math.floor(bal / 1e6))
    if (hi < cfg.minM) return 0
    return (cfg.minM + Math.floor(Math.random() * (hi - cfg.minM + 1))) * 1e6
  }
  return Math.floor(bal)   // all
}
async function payRun(state, cfg) {
  const username = state.username
  const bot = state.bot
  const before = await payReadBalance(state, 8000)
  if (before === null) { log(username, 'PAY', '⚠️ Không đọc được số dư (/bal) — bỏ qua lượt này'); return }
  const amount0 = payPickAmount(cfg, before)
  if (!(amount0 >= 1) || amount0 > before || amount0 >= 1e15) {
    log(username, 'PAY', `⏭️ Bỏ qua: số dư $${fmtNum(before)} không đủ cho chế độ ${cfg.mode}`)
    return
  }
  // Pay All: server có thể hiển thị số dư làm tròn (1.25M) nên nếu lần đầu thất bại thì thử lại với 99%
  const tries = cfg.mode === 'all' ? [amount0, Math.floor(before * 0.99)] : [amount0]
  let ok = false, amount = amount0, after = null, note = ''
  for (let i = 0; i < tries.length; i++) {
    amount = tries[i]
    if (!(amount >= 1)) break
    const confirmP = payWaitConfirm(state, cfg.to, 6000)
    try { bot.chat(`/pay ${cfg.to} ${amount}`) } catch (e) { note = 'Không gửi được lệnh: ' + e.message; break }
    log(username, 'PAY', `💸 /pay ${cfg.to} ${amount} | chế độ ${cfg.mode} | số dư trước $${fmtNum(before)}${i ? ' (thử lại 99%)' : ''}`)
    const confirmed = await confirmP
    after = await payReadBalance(state, 6000)
    ok = !!confirmed || (after !== null && before - after >= amount * 0.5)
    if (ok) break
    note = 'Không thấy xác nhận từ server và số dư không giảm' + (i + 1 < tries.length ? ' — thử lại' : '')
    log(username, 'PAY', `⚠️ ${note}`)
    if (state.isDead) return
  }
  if (ok) {
    const st = state.payStats || (state.payStats = { count: 0, total: 0, last: null })
    st.count += 1
    st.total += amount
    st.last = Date.now()
    log(username, 'PAY', `✅ Đã chuyển $${fmtNum(amount)} cho ${cfg.to}${after !== null ? ' | số dư còn $' + fmtNum(after) : ''}`)
    const ownerId = ownerOf(username)
    if (ownerId && !hasRecentEvent(botKey(ownerId, username), 10)) pushBotEvent(ownerId, username, '💸', 'Auto pay ' + compact(amount) + ' cho ' + cfg.to)
  }
  webhookAutoPay(username, { ok, to: cfg.to, amount, mode: cfg.mode, before, after, stats: state.payStats, note: ok ? '' : note }).catch(() => {})
}
async function payTick(state) {
  const cfg = getPayCfg(state.username)
  if (!cfg.enabled || !cfg.to || state.payBusy) return
  const bot = state.bot
  if (!bot || state.isDead || !state.inCluster || !bot.entity) return
  const now = Date.now()
  if (!state.payNextAt) { state.payNextAt = now + 10000; return }   // vừa vào cụm: đợi 10s cho ổn định rồi mới chuyển
  if (now < state.payNextAt) return
  state.payNextAt = now + cfg.intervalSec * 1000
  state.payBusy = true
  try { await payRun(state, cfg) } catch (e) { log(state.username, 'PAY', '❌ Lỗi auto pay: ' + e.message) } finally { state.payBusy = false }
}
setInterval(() => {
  for (const k of Object.keys(botStates)) {
    const s = botStates[k]
    if (!s || s.isDead || !s.bot) continue
    try { homeTick(s) } catch (e) {}
    payTick(s).catch(() => {})
  }
}, 2000)

// ===================== AUTO SELL LOOP =====================
function startSellLoop(state) {
  const username = state.username
  const cfg = getSellCfg(username)
  if (!cfg.items || cfg.items.length === 0) {
    log(username, 'SELL', `⚠️ Chưa set item nào — nhập item/block tiếng Anh trên web rồi mới bật`)
    return false
  }
  stopSellLoop(state, true)
  state.sellActive = true
  state.sellBusy = false
  state.sellStats = state.sellStats || { moved: 0, rounds: 0, topCount: 0 }
  log(username, 'SELL', `▶ BẬT auto sell | ${cfg.items.join(', ')} | mode=${cfg.mode}${cfg.mode === 'timer' ? ' (' + cfg.intervalSec + 's)' : ' (đầy ' + SELL_FULL_THRESHOLD + ' slot)'}`)
  state.sellLoopTimer = setInterval(() => { sellTick(state).catch(() => {}) }, SELL_TICK_MS)
  sellTick(state).catch(() => {})
  return true
}

function stopSellLoop(state, silent) {
  try { if (state.sellLoopTimer) clearInterval(state.sellLoopTimer) } catch (e) {}
  state.sellLoopTimer = null
  state.sellActive = false
  state.sellBusy = false
  if (!silent) {
    try { if (state.bot && state.bot.currentWindow) state.bot.closeWindow(state.bot.currentWindow) } catch (e) {}
    state.pendingWindow = null
  }
}

async function sellTick(state) {
  const username = state.username
  if (!state.sellActive || state.isDead || state.sellBusy) return
  const cfg = getSellCfg(username)
  if (!cfg.enabled || !cfg.items.length) return
  const bot = state.bot
  if (!bot || !bot.entity) return
  if (!state.inCluster) return // chưa vào cụm thì đợi, không spam /sell

  state.sellBusy = true // chống tick chồng nhau khi chuyển nhiều stack
  try {
    let win = null
    try { win = bot.currentWindow } catch (e) {}
    if (!win) {
      // GUI chưa mở -> gõ /sell để mở lại (throttle 5s)
      const now = Date.now()
      if (now - (state.sellLastOpenTry || 0) >= SELL_OPEN_RETRY_MS) {
        state.sellLastOpenTry = now
        try {
          bot.chat('/sell')
          log(username, 'SELL', `📝 Gõ /sell để mở shop...`)
        } catch (e) {}
      }
      return
    }

    const guiSize = sellGuiSize(win)
    if (!(guiSize > 9)) return

    // B1: balo có đồ đã set -> shift-click sang inv trên, tối đa 5 stack/tick
    // (không có -> đợi, 30s mới log 1 lần để khỏi spam)
    let moved = 0
    try {
      const arr = win.slots || []
      for (let i = guiSize; i < arr.length && moved < SELL_MOVE_PER_TICK; i++) {
        const it = arr[i]
        if (!it) continue
        if (!sellMatch(it, cfg.items)) continue
        try {
          await bot.clickWindow(i, 0, 1) // shift-click: balo -> inv trên
          moved++
          state.sellStats.moved++
          await _sleep(SELL_MOVE_DELAY_MS)
        } catch (e) {}
      }
    } catch (e) {}
    if (moved > 0) {
      log(username, 'SELL', `📦 Chuyển ${moved} stack (${cfg.items.join(', ')}) lên shop`)
      // Đọc lại inv sau khi server cập nhật rồi mới xét bán
      await _sleep(150)
    }

    // B2: đếm đồ inv trên (GUI vẫn giữ nguyên sau mỗi vòng bán nên lặp lại luôn)
    let top = 0
    try {
      win = bot.currentWindow || win
      top = sellCountTop(win, sellGuiSize(win))
    } catch (e) {}
    state.sellStats.topCount = top

    if (moved === 0 && top === 0) {
      const now = Date.now()
      if (now - (state.sellLastWaitLog || 0) >= SELL_WAIT_LOG_MS) {
        state.sellLastWaitLog = now
        log(username, 'SELL', `⏳ Balo chưa có [${cfg.items.join(', ')}] — đang đợi có đồ...`)
      }
      return
    }
    state.sellLastWaitLog = 0

    // B3: đủ điều kiện -> click slot bất kỳ hàng cuối, đợi 0.5s, click trái-cuối
    if (cfg.mode === 'timer') {
      if (top <= 0) return
      if (Date.now() - (state.sellLastSell || 0) >= cfg.intervalSec * 1000) {
        await sellClickSequence(state, 'hẹn giờ ' + cfg.intervalSec + 's (shop ' + top + ' slot)')
      }
    } else {
      if (top >= SELL_FULL_THRESHOLD) {
        await sellClickSequence(state, 'đầy ' + top + '/' + SELL_FULL_THRESHOLD)
      }
    }
  } finally {
    state.sellBusy = false
  }
}

async function sellClickSequence(state, why) {
  const username = state.username
  try {
    let win = null
    try { win = state.bot.currentWindow } catch (e) {}
    if (!win) return
    const guiSize = sellGuiSize(win)
    if (!(guiSize > 9)) return
    const { first, second } = sellClickSlots(guiSize)
    try { await state.bot.clickWindow(first, 0, 0) } catch (e) {}
    log(username, 'SELL', `🖱️ Click slot ${first} (cuối hàng cuối, ${why}) — đợi 0.5s rồi click slot ${second} (trái-cuối)`)
    await _sleep(SELL_CLICK_DELAY_MS)
    try {
      win = state.bot.currentWindow
      if (!win) return // GUI đóng thì tick sau tự /sell mở lại
      const gs2 = sellGuiSize(win)
      if (!(gs2 > 9)) return
      await state.bot.clickWindow(sellClickSlots(gs2).second, 0, 0)
    } catch (e) {}
    state.sellLastSell = Date.now()
    state.sellStats.rounds++
    log(username, 'SELL', `✅ Bán xong vòng ${state.sellStats.rounds} (${why}) | GUI vẫn mở — quay lại chuyển đồ tiếp | tổng đã chuyển ${state.sellStats.moved} stack`)
  } catch (e) {}
}

function sellOnGuiOpen(state) {
  // GUI sell vừa mở trong lúc auto sell đang bật -> reset throttle để tick xử lý ngay
  if (!state.sellActive) return
  state.sellLastOpenTry = 0
  log(state.username, 'SELL', `📂 Shop đã mở — bắt đầu theo dõi đồ`)
}

// ===================== KHỞI ĐỘNG =====================
async function startAll() {
  log('SYSTEM', 'START', `🚀 Khởi động bot NOKEY | ${SERVER_IP}:${SERVER_PORT}`)
  for (const cfg of BOT_LIST) {
    if (!cfg.username) continue
    createBot(cfg.username)
    await new Promise(r => setTimeout(r, 8000))
  }
  log('SYSTEM', 'START', `✅ Đã tạo xong tất cả bot`)
}

// ===================== NGẮT KẾT NỐI THỦ CÔNG =====================
function disconnectBot(username) {
  const s = botStates[username]
  if (!s || !s.bot) return { ok: false, message: 'Bot chưa được tạo' }
  // Đánh dấu DEAD + manual trước để handler kicked/end return sớm
  // (tránh bắn webhook + tránh auto reconnect), rồi mới end kết nối
  try { if (s.reconnectTimer) clearTimeout(s.reconnectTimer) } catch (e) {}
  s.reconnectTimer = null
  try { stopSellLoop(s, true) } catch (e) {}
  s.manualDisconnect = true
  s.isDead = true
  s.inCluster = false
  stopStatsAutoCheck(s)
  s.isLoggingIn = false
  s.pendingWindow = null
  s.pendingAutoClick = null
  const wasOnline = !!(s.bot && s.bot.entity)
  try { s.bot.removeAllListeners('kicked') } catch (e) {}
  try { s.bot.removeAllListeners('end') } catch (e) {}
  try { s.bot.removeAllListeners('error') } catch (e) {}
  try { if (s.bot.end) s.bot.end() } catch (e) {}
  return { ok: true, wasOnline }
}