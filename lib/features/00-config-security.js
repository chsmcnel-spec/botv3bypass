// FEATURE MODULE: 00-config-security.js
// Core imports, configuration, console banner and account/key security.
// Loaded in order by ../runtime-loader.js; shares the single runtime scope.

// ===================== login.js - BOT CONTROL PANEL =====================
const mineflayer = require('mineflayer')
const express = require('express')
const { Server: WebSocketServer, WebSocket } = require('ws')
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { sha256 } = require('./secure')
const { PanelAuth } = require('./panelAuth')
const { LicenseManager } = require('./licenseManager')

const PORT = process.env.PORT || 25021
const CONFIG_PATH = path.join(__dirname, 'config.json')
const WEBHOOK_PATH = path.join(__dirname, 'webhook.json')
const LOG_FILE = path.join(__dirname, 'login.log')

// ===================== CONSOLE STYLE (màu gradient + khung mới) =====================
const ANSI_RESET = '\x1b[0m'
function _lerp(a, b, t) { return Math.round(a + (b - a) * t) }
function _mix(c1, c2, t) { return [_lerp(c1[0], c2[0], t), _lerp(c1[1], c2[1], t), _lerp(c1[2], c2[2], t)] }
function _paint(text, rgb, bold) {
  return `\x1b[${bold ? '1;' : ''}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${ANSI_RESET}`
}
// Chữ chuyển màu mượt từ màu này sang màu kia (từng ký tự)
function gradientText(text, from, to, bold) {
  const chars = [...String(text)]
  if (chars.length === 0) return ''
  if (chars.length === 1) return _paint(text, from, bold)
  return chars.map((ch, i) => {
    const t = i / (chars.length - 1)
    return _paint(ch, _mix(from, to, t), bold)
  }).join('')
}
// Nội suy qua NHIỀU điểm màu -> dải gradient liền mạch duy nhất
function _multiMix(stops, t) {
  if (t <= 0) return stops[0]
  if (t >= 1) return stops[stops.length - 1]
  const seg = t * (stops.length - 1)
  const i = Math.floor(seg)
  const f = seg - i
  return _mix(stops[i], stops[i + 1], f)
}
// Khung bo mới: dùng box-drawing double-line, không dùng === nữa
// MÀU LIỀN MẠCH: cả banner dùng 1 dải gradient duy nhất, CHỦ ĐẠO ĐỎ
// (đỏ đậm -> đỏ tươi -> cam -> vàng), tô theo VỊ TRÍ TOÀN CỤC (cột)
// nên các dòng nối tiếp nhau không bị đứt màu.
function printBanner() {
  const W = 58 // độ rộng ruột khung
  const DEEP_RED = [180, 20, 30]    // đỏ đậm mở đầu (viền trái)
  const RED = [255, 45, 60]         // đỏ tươi chủ đạo
  const ORANGE = [255, 120, 40]     // cam chuyển tiếp
  const GOLD = [255, 200, 60]       // vàng kết (viền phải)
  const GRAY = [170, 120, 120]
  const STOPS = [DEEP_RED, RED, ORANGE, GOLD] // 1 dải duy nhất, chủ đạo ĐỎ

  // Logo HEXTEKO ASCII (giữ nguyên từng ký tự, kể cả khoảng trắng để không vỡ hình)
  const LOGO = [
    'ooooo ooooo ooooooooooo ooooo  oooo ooooooooooo ooooooooooo oooo   oooo ooooooo',
    ' 888   888   888    88    888  88   88  888  88  888    88   888  o88 o888   888o',
    ' 888ooo888   888ooo8        888         888      888ooo8     888888   888     888',
    ' 888   888   888    oo     88 888       888      888    oo   888  88o 888o   o888',
    'o888o o888o o888ooo8888 o88o  o888o    o888o    o888ooo8888 o888o o888o 88ooo88',
  ]

  const top = '╔' + '═'.repeat(W) + '╗'
  const botLine = '╚' + '═'.repeat(W) + '╝'
  const mid = '╠' + '═'.repeat(W) + '╣'

  // Tô 1 dòng theo vị trí toàn cục: colOffset = cột bắt đầu trong banner
  const paintFlow = (text, colOffset) => {
    const chars = [...String(text)]
    const total = W + 2 // full chiều rộng banner (kể cả 2 viền)
    return chars.map((ch, i) => {
      const t = (colOffset + i) / (total - 1)
      return _paint(ch, _multiMix(STOPS, t), true)
    }).join('')
  }

  // Logo: mỗi DÒNG chảy cùng nhịp màu banner theo cột (trái đỏ đậm -> phải vàng)
  // -> cả khối logo liền mạch với khung bên dưới
  const paintLogoLine = (text) => {
    const chars = [...String(text)]
    if (chars.length === 0) return ''
    return chars.map((ch, i) => {
      if (ch === ' ') return ch
      const t = chars.length === 1 ? 0 : i / (chars.length - 1)
      return _paint(ch, _multiMix(STOPS, t), true)
    }).join('')
  }

  // Dòng nội dung: viền + label chảy cùng dải màu banner, value in đậm cùng nhịp
  const row = (icon, label, value) => {
    const inner = ` ${icon} ${label.padEnd(11, ' ')} ${value}`
    const plain = inner.slice(0, W).padEnd(W, ' ')
    const chars = [...plain]
    const total = W + 2
    let out = _paint('║', _multiMix(STOPS, 0), true)
    chars.forEach((ch, i) => {
      const t = (1 + i) / (total - 1)
      let rgb = _multiMix(STOPS, t)
      if (i < 15) rgb = _mix([130, 90, 90], rgb, 0.45) // label: xám-đỏ pha màu banner
      out += _paint(ch, rgb, i >= 15)
    })
    out += _paint('║', _multiMix(STOPS, 1), true)
    return out
  }

  const title = '◆ BOT AFK MINECRAFT ◆'
  const pad = Math.floor((W - title.length) / 2)
  const titleLine = _paint('║', _multiMix(STOPS, 0), true)
    + paintFlowWithOffset(' '.repeat(pad) + title + ' '.repeat(W - pad - title.length), 1)
    + _paint('║', _multiMix(STOPS, 1), true)

  // helper: khoảng chữ title tô đậm full màu, khoảng space giữ nguyên
  function paintFlowWithOffset(inner, colStart) {
    const chars = [...inner]
    const total = W + 2
    return chars.map((ch, i) => {
      if (ch === ' ') return ch
      const t = (colStart + i) / (total - 1)
      return _paint(ch, _multiMix(STOPS, t), true)
    }).join('')
  }

  const sub = 'CONTROL PANEL • BY HEXTEKO'
  const pad2 = Math.floor((W - sub.length) / 2)
  const subLine = _paint('║', _multiMix(STOPS, 0), true)
    + ' '.repeat(pad2) + _paint(sub, GRAY, false)
    + ' '.repeat(W - pad2 - sub.length) + _paint('║', _multiMix(STOPS, 1), true)

  const lines = []
  // Logo HEXTEKO nằm TRÊN CÙNG, ngoài khung
  for (const logoLine of LOGO) lines.push(paintLogoLine(logoLine))
  lines.push(paintFlow(top, 0))
  lines.push(titleLine)
  lines.push(subLine)
  lines.push(paintFlow(mid, 0))
  lines.push(row('🌐', 'Dashboard:', `http://localhost:${PORT}`))
  lines.push(row('📡', 'Server:', `${SERVER_IP}:${SERVER_PORT} (${SERVER_VERSION})`))
  lines.push(row('🤖', 'accounts:', `${BOT_LIST.length} acc`))
  lines.push(row('🔔', 'Webhook:', 'theo tung tai khoan'))
  lines.push(paintFlow(botLine, 0))

  console.clear()
  console.log('')
  for (const l of lines) console.log(l)
  console.log(_paint('  ▶ Mở web trên để thêm acc • ngắt KN • pay • gửi lệnh', GRAY, false))
  console.log('')
}

// ===================== ĐỌC CONFIG =====================
// Có sẵn file -> giữ nguyên, không đụng vào.
// Chưa có -> tự tạo mẫu trống (không tài khoản/mật khẩu), user mở web để thêm acc.
if (!fs.existsSync(CONFIG_PATH)) {
  const DEFAULT_CONFIG = {
    SERVER_IP: 'kingmc.vn',
    SERVER_PORT: 25565,
    SERVER_VERSION: '1.20.1',
    BOTS: [],
    LICENSE: {
      url: 'https://spectacularcustardr4mq7vl2.netlify.app/.netlify/functions/api',
      origin: 'https://kingsmp-bot.local',
      recheckMs: 60000,
      graceFailures: 3,
      timeoutMs: 10000
    }
  }
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
    console.log('ℹ️ Chưa có config.json — đã tạo mẫu trống. Mở web http://localhost:3000 để thêm acc.')
  } catch (e) {
    console.error('❌ Không tạo được config.json:', e.message)
    process.exit(1)
  }
}

let CONFIG = {}
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
} catch (e) {
  console.error('❌ Lỗi đọc config.json:', e.message)
  process.exit(1)
}

const SERVER_IP = CONFIG.SERVER_IP || 'kingmc.vn'
const SERVER_PORT = CONFIG.SERVER_PORT || 25565
const SERVER_VERSION = CONFIG.SERVER_VERSION || '1.20.1'
let BOT_LIST = Array.isArray(CONFIG.BOTS) ? CONFIG.BOTS : []
if (!Array.isArray(CONFIG.BOTS)) CONFIG.BOTS = BOT_LIST

// ===================== TÀI KHOẢN + KEY (1 key = 1 bot) =====================
// - Mỗi người đăng ký/đăng nhập panel; chỉ thấy và điều khiển bot của chính mình.
// - Mỗi bot cần đúng 1 key (xác minh với KeyVault); 1 key không dùng được cho 2 bot.
// - Key hết hạn / bị thu hồi -> bot đó bị ngắt và không thể login tới khi nhập key mới.
const DATA_DIR = path.join(__dirname, 'data')
const auth = new PanelAuth({ dataDir: DATA_DIR, sessionDays: CONFIG.SESSION_DAYS, allowRegister: CONFIG.ALLOW_REGISTER !== false })
const LICENSE_CFG = Object.assign({
  url: 'https://spectacularcustardr4mq7vl2.netlify.app/.netlify/functions/api',
  origin: 'https://kingsmp-bot.local',
  recheckMs: 60000,
  graceFailures: 3,
  timeoutMs: 10000
}, CONFIG.LICENSE || {})
const licenses = new Map()    // username -> LicenseManager
const keyOwners = new Map()   // keyId -> username (hoặc 'pending' khi đang kích hoạt)
const keyIdOf = (key) => sha256('hextekokey:' + String(key).trim())
const licenseFile = (username) => path.join(DATA_DIR, 'licenses', sha256('bot:' + String(username).toLowerCase()).slice(0, 24) + '.json')
const botCfg = (username) => BOT_LIST.find(b => b.username === username)
const ownerOf = (username) => { const c = botCfg(username); return (c && c.ownerId) || null }
const decryptPw = (v) => { try { return auth.cipher.decrypt(v) } catch (e) { return '' } }
const licenseOk = (username) => true // NOKEY: panel license activation disabled
const newLicense = (username) => new LicenseManager({ config: { license: LICENSE_CFG }, filePath: licenseFile(username), cipher: auth.cipher })

