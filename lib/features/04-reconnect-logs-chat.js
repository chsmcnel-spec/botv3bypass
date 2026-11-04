// FEATURE MODULE: 04-reconnect-logs-chat.js
// Reconnect policy, log formatting, chat parsing, anti-fake-pay and TPA helpers.
// Loaded in order by ../runtime-loader.js; shares the single runtime scope.

// ===================== RECONNECT (tự vô lại 2 lần, mỗi lần cách 15s) =====================
// Mất kết nối (socket closed / kick) -> DEAD -> tự vô lại, LẶP LẠI cho tới khi bot online:
//  - 2 lần đầu ("nhanh"): cách nhau 15s
//  - từ lần 3 trở đi: 1 phút -> 2 phút -> 3 phút -> 5 phút -> 8 phút -> 10 phút (giữ 10 phút cho các lần sau)
//  - bộ đếm chỉ về 0 khi bot online ổn định RECONNECT_STABLE_MS (tránh vòng lặp vào-rớt-vào-rớt mà không tăng dần)
const RECONNECT_MAX_TRIES = 2
const RECONNECT_DELAY_MS = 15 * 1000
const RECONNECT_LONG_DELAYS_MS = [60, 120, 180, 300, 480, 600].map(s => s * 1000)
const RECONNECT_STABLE_MS = 90 * 1000
function reconnectDelayFor(attempt) {
  if (attempt <= RECONNECT_MAX_TRIES) return RECONNECT_DELAY_MS
  const i = Math.min(attempt - RECONNECT_MAX_TRIES - 1, RECONNECT_LONG_DELAYS_MS.length - 1)
  return RECONNECT_LONG_DELAYS_MS[i]
}
function fmtDelay(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60), r = s % 60
  return m + ' phút' + (r ? ' ' + r + 's' : '')
}
function reconnectInfo() {
  return {
    maxTries: RECONNECT_MAX_TRIES,
    delaySec: RECONNECT_DELAY_MS / 1000,
    longSec: RECONNECT_LONG_DELAYS_MS.map(ms => ms / 1000)
  }
}

// ===================== LOG =====================
// ----- Chép nguyên từ botManager.js: màu chữ Minecraft + lọc thông báo máy chủ -----
const COLOR_HEX = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
  dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
  dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF'
};
const LEGACY_CODE = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua', '4': 'dark_red',
  '5': 'dark_purple', '6': 'gold', '7': 'gray', '8': 'dark_gray', '9': 'blue',
  a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white'
};

function toHexColor(color) {
  if (!color) return undefined;
  const value = String(color).toLowerCase();
  if (COLOR_HEX[value]) return COLOR_HEX[value];
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  return undefined;
}

function makeSegment(text, style) {
  const seg = { t: String(text) };
  if (style.color) seg.c = style.color;
  if (style.bold) seg.b = true;
  if (style.italic) seg.i = true;
  if (style.underlined) seg.u = true;
  if (style.strikethrough) seg.s = true;
  return seg;
}

// Tách mã màu kiểu cũ (§c, §l, ...) trong chuỗi.
function parseLegacy(str, base) {
  const out = [];
  let style = Object.assign({}, base);
  let buf = '';
  const flush = () => { if (buf) { out.push(makeSegment(buf, style)); buf = ''; } };
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '\u00a7' && i + 1 < str.length) {
      const code = str[i + 1].toLowerCase();
      flush();
      if (LEGACY_CODE[code]) style = { color: toHexColor(LEGACY_CODE[code]) };
      else if (code === 'l') style.bold = true;
      else if (code === 'o') style.italic = true;
      else if (code === 'n') style.underlined = true;
      else if (code === 'm') style.strikethrough = true;
      else if (code === 'r') style = {};
      i += 1;
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

function plainText(segments) {
  return segments.map((seg) => seg.t).join('');
}

function formatTranslate(template, args) {
  let next = 0;
  return String(template).replace(/%(?:(\d+)\$)?([sd%])/g, (m, n, t) => {
    if (t === '%') return '%';
    const value = args[n ? Number(n) - 1 : next++];
    return value === undefined ? '' : plainText(componentToSegments(value, {}, null));
  });
}

// Chuyển component chat (JSON / NBT đã simplify) thành mảng segments.
function componentToSegments(component, inherited, language) {
  const base = inherited || {};
  if (component === null || component === undefined) return [];
  if (typeof component === 'string' || typeof component === 'number' || typeof component === 'boolean') {
    return parseLegacy(String(component), base);
  }
  if (Array.isArray(component)) {
    const out = [];
    for (const part of component) out.push(...componentToSegments(part, base, language));
    return out;
  }
  if (typeof component !== 'object') return [];
  const style = {
    color: toHexColor(component.color) || base.color,
    bold: component.bold === undefined ? base.bold : !!component.bold,
    italic: component.italic === undefined ? base.italic : !!component.italic,
    underlined: component.underlined === undefined ? base.underlined : !!component.underlined,
    strikethrough: component.strikethrough === undefined ? base.strikethrough : !!component.strikethrough
  };
  let text = '';
  if (component.text !== undefined) text = String(component.text);
  else if (component.translate !== undefined) {
    const template = (language && language[component.translate]) || component.fallback || component.translate;
    const args = component.with || component.args || [];
    text = formatTranslate(template, Array.isArray(args) ? args : [args]);
  }
  const out = text ? parseLegacy(text, style) : [];
  if (Array.isArray(component.extra)) {
    for (const part of component.extra) out.push(...componentToSegments(part, style, language));
  }
  return out;
}

const SMALL_CAPS = {
  '\u1d00': 'A', '\u0299': 'B', '\u1d04': 'C', '\u1d05': 'D',
  '\u1d07': 'E', '\u0493': 'F', '\u0262': 'G', '\u029c': 'H',
  '\u026a': 'I', '\ua7ae': 'I', '\u1d0a': 'J', '\u1d0b': 'K',
  '\u029f': 'L', '\u1d0d': 'M', '\u0274': 'N', '\u1d0f': 'O',
  '\u1d18': 'P', '\u01eb': 'Q', '\u0280': 'R', '\u01a6': 'R',
  '\ua731': 'S', '\u1d1b': 'T', '\u1d1c': 'U', '\u1d20': 'V',
  '\u1d21': 'W', '\u028f': 'Y', '\u1d22': 'Z', '\u0111': 'D',
  '\u0110': 'D'
};

function smallCapsToUpper(str) {
  return String(str || '')
    .replace(/[\u1d00\u0299\u1d04\u1d05\u1d07\u0493\u0262\u029c\u026a\ua7ae\u1d0a\u1d0b\u029f\u1d0d\u0274\u1d0f\u1d18\u01eb\u0280\u01a6\ua731\u1d1b\u1d1c\u1d20\u1d21\u028f\u1d22\u0111\u0110]/g, (ch) => SMALL_CAPS[ch] || ch)
    .toUpperCase()
    .trim();
}

// Chữ thường, bỏ dấu tiếng Việt, đổi small-caps (ᴅ, ɪ...) về chữ thường để so khớp thông báo.
function normalizeForMatch(text) {
  return smallCapsToUpper(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0110/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const SERVER_NOTICE_RES = [
  /ai la newbie.*\/commands.*\/rules/,
  /rank plus.*\/warp crate.*\/key.*\/donate/,
  /dung lenh \/rtp.*(dich chuyen|xay can cu)/,
  /tu do xay dung.*pvp.*tuan thu luat/
];

function isServerNotice(text) {
  const norm = normalizeForMatch(text);
  if (!norm) return false;
  return SERVER_NOTICE_RES.some((re) => re.test(norm));
}


// ----- Cài đặt log riêng từng tài khoản panel (data/log-settings.json) -----
// hideDebugLogs: "Bỏ log debug" | ignoreServerNotices: "Bỏ log thông báo từ máy chủ" (các thông báo quảng cáo/nhắc nhở định kỳ,
// cùng bộ lọc với botManager.js) | betterLog: log đẹp + giữ đúng màu chữ server gửi về (web tự vẽ)
const LOG_SETTINGS_FILE = path.join(DATA_DIR, 'log-settings.json')
const DEBUG_LOG_TYPES = new Set(['GUI', 'MENU', 'WS', 'SETTINGS', 'CREATE', 'START', 'LOGIN', 'CMD', 'BAL'])
let logSettings = {}
try { logSettings = JSON.parse(fs.readFileSync(LOG_SETTINGS_FILE, 'utf8')) || {} } catch (e) { logSettings = {} }
function logPrefsOf(ownerId) {
  const v = (ownerId && logSettings[ownerId]) || {}
  return {
    hideDebugLogs: !!(v.hideDebugLogs !== undefined ? v.hideDebugLogs : v.hideDebug),
    ignoreServerNotices: !!(v.ignoreServerNotices !== undefined ? v.ignoreServerNotices : v.hideServerMsg),
    betterLog: !!v.betterLog
  }
}
function logHiddenBy(prefs, type, msg) {
  if (!prefs) return false
  if (prefs.hideDebugLogs && DEBUG_LOG_TYPES.has(type)) return true
  if (prefs.ignoreServerNotices && (type === 'MSG' || type === 'CHAT') && isServerNotice(msg)) return true
  return false
}
function saveLogSettings() {
  try {
    fs.mkdirSync(path.dirname(LOG_SETTINGS_FILE), { recursive: true })
    const tmp = LOG_SETTINGS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(logSettings, null, 2), 'utf8')
    fs.renameSync(tmp, LOG_SETTINGS_FILE)
    return true
  } catch (e) { return false }
}

const LOG_KEEP = 300
const sysLogs = []   // log hệ thống (mọi thứ trừ chat trong game)
const chatLogs = []  // chat trong game, đã khử trùng lặp để hiển thị ở tab Chat
const botMiniChatLogs = new Map() // mini log riêng cho từng bot, không khử trùng lặp giữa các bot
let logSeq = 0
function addBotMiniChat(username, messageText) {
  const ownerId = ownerOf(username)
  if (!ownerId) return
  const key = botKey(ownerId, username)
  const items = botMiniChatLogs.get(key) || []
  items.push({ id: Date.now() + ':' + items.length, time: new Date().toLocaleTimeString('vi-VN', { hour12: false }), msg: String(messageText || '').slice(0, 300) })
  if (items.length > 3) items.splice(0, items.length - 3)
  botMiniChatLogs.set(key, items)
}
function log(botName, type, msg, ownerId, segments, who) {
  const now = new Date()
  const timeStr = now.toLocaleTimeString('vi-VN', { hour12: false })
  const entry = { id: ++logSeq, time: timeStr, bot: botName, type, msg: String(msg).slice(0, 500), owner: ownerId || ownerOf(botName) }
  if (entry.owner && logHiddenBy(logPrefsOf(entry.owner), type, msg)) return   // người dùng đã chọn bỏ loại log này
  if (Array.isArray(segments) && segments.length && (type === 'MSG' || type === 'CHAT')) entry.segments = segments.slice(0, 40)   // màu chữ server gửi về (Better log)
  if (who && type === 'CHAT') entry.who = String(who).slice(0, 16)   // tên người gửi chat -> FE vẽ đầu đúng skin
  // Mini log trên thẻ bot: mọi dòng log của bot đó (chat đã được 05-minecraft-runtime ghi riêng từng bot)
  if (type !== 'CHAT') { try { addBotMiniChat(botName, msg) } catch (e) {} }
  const buf = type === 'CHAT' ? chatLogs : sysLogs
  buf.push(entry)
  if (buf.length > LOG_KEEP) buf.shift()
  try {
    fs.appendFileSync(LOG_FILE, `[${now.toLocaleString('vi-VN')}] [${botName}] [${type}] ${msg}\n`, 'utf8')
  } catch (e) {}
}

// ===================== CHAT & GỢI Ý LỆNH (helpers) =====================
// Nhận diện chat người chơi (để tab "Chat" hiện đúng chat trong game, tab "Hệ thống" không có chat).
// Dựa vào: (1) message.json kiểu chat.type.* của Minecraft, (2) format <Tên>/Tên » / [Rank] Tên: ..., (3) tên người chơi đang online đứng đầu dòng.
function isGameChat(message, text, bot) {
  try {
    const j = message && message.json
    if (j && typeof j.translate === 'string' && /^chat\.type\./.test(j.translate)) return true
  } catch (e) {}
  if (parseGameChat(text, bot)) return true
  const t = String(text || '').trim()
  const m = t.match(/^(?:\[[^\]]{1,24}\]\s*)*([A-Za-z0-9_]{3,16})\s*[:»›➤➜>|~-]\s*\S/)
  if (m && bot && bot.players) {
    const low = m[1].toLowerCase()
    for (const n of Object.keys(bot.players)) {
      if (n.toLowerCase() === low) return true
    }
  }
  return false
}

// ==== HELPERS BEGIN ====
// Nhận diện tin nhắn chat của người chơi. Trả về { sender, text } hoặc null.
// - <Tên> nội dung                    : luôn coi là chat
// - Tên » nội dung / Tên > nội dung   : coi là chat
// - [Rank] Tên: nội dung              : chỉ coi là chat nếu Tên đang có trong danh sách người chơi (tránh nhầm thông báo hệ thống)
function parseGameChat(text, bot) {
  const t = String(text || '').trim()
  if (!t) return null
  let m = t.match(/^<([\w\s.\-]{1,40})>\s*(.*)$/)
  if (m) return { sender: m[1].trim(), text: m[2] }
  m = t.match(/^(?:\[[^\]]{1,24}\]\s*)*([A-Za-z0-9_]{3,16})\s*(?:»|›|➤|➜|>>)\s*(.+)$/)
  if (m) return { sender: m[1], text: m[2] }
  m = t.match(/^(?:\[[^\]]{1,24}\]\s*)+([A-Za-z0-9_]{3,16})\s*:\s*(.+)$/)
  if (m && bot && bot.players) {
    const low = m[1].toLowerCase()
    for (const n of Object.keys(bot.players)) {
      if (n.toLowerCase() === low) return { sender: m[1], text: m[2] }
    }
  }
  return null
}

// Khoảng cách chỉnh sửa (Levenshtein) để gợi ý lệnh "gần giống"
function editDistance(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

// Gợi ý giống Minecraft: ưu tiên khớp phần đầu; nếu không có thì tìm lệnh chứa chuỗi, rồi lệnh gần giống (sai 1-2 ký tự)
function rankSuggestions(typed, names, limit) {
  const t = String(typed || '').toLowerCase()
  const uniq = Array.from(new Set(names.filter(Boolean)))
  const byLenAlpha = (a, b) => a.length - b.length || a.localeCompare(b)
  if (!t) return uniq.sort((a, b) => a.localeCompare(b)).slice(0, limit)
  const pre = [], sub = [], fuzzy = []
  for (const n of uniq) {
    const l = n.toLowerCase()
    if (l.startsWith(t)) pre.push(n)
    else if (l.includes(t)) sub.push(n)
    else if (t.length >= 3) {
      const d = editDistance(t, l.slice(0, Math.max(t.length, 1) + 1))
      const dFull = editDistance(t, l)
      if (Math.min(d, dFull) <= (t.length >= 5 ? 2 : 1)) fuzzy.push({ n, d: Math.min(d, dFull) })
    }
  }
  pre.sort(byLenAlpha); sub.sort(byLenAlpha)
  fuzzy.sort((a, b) => a.d - b.d || byLenAlpha(a.n, b.n))
  if (pre.length) return pre.slice(0, limit)   // có lệnh khớp phần đầu -> chỉ hiện nhóm đó (giống Minecraft)
  return sub.concat(fuzzy.map(x => x.n)).slice(0, limit)   // không có -> thử "chứa" rồi "gần giống"
}

// Đọc packet declare_commands (cây lệnh Brigadier của server) thành dạng gọn
function nodeInfo(n) {
  const f = n && n.flags
  let type, redirect = false
  if (typeof f === 'number') { type = f & 3; redirect = !!(f & 8) }
  else if (f) { type = f.command_node_type; redirect = !!f.has_redirect_node }
  const d = n && n.extraNodeData
  const name = typeof d === 'string' ? d : (d && d.name)
  return { type, name: name ? String(name) : '', children: (n && n.children) || [], redirect: redirect && typeof n.redirectNode === 'number' ? n.redirectNode : null }
}

function parseCommandTree(pkt) {
  if (!pkt || !Array.isArray(pkt.nodes) || !pkt.nodes.length) return null
  return { nodes: pkt.nodes.map(nodeInfo), root: typeof pkt.rootIndex === 'number' ? pkt.rootIndex : 0 }
}

// Đi theo các từ đã gõ xong trong cây lệnh, trả về các nhánh con kế tiếp
function treeNext(tree, doneTokens) {
  const nodes = tree.nodes
  let current = [tree.root]
  for (const tok of doneTokens) {
    const next = []
    for (const idx of current) {
      let node = nodes[idx]
      if (!node) continue
      let kids = node.children
      if (!kids.length && node.redirect !== null && nodes[node.redirect]) kids = nodes[node.redirect].children
      for (const c of kids) {
        const cn = nodes[c]
        if (!cn) continue
        if (cn.type === 1) { if (cn.name.toLowerCase() === tok.toLowerCase()) next.push(c) }
        else next.push(c)
      }
    }
    current = Array.from(new Set(next)).slice(0, 200)
    if (!current.length) break
  }
  const literals = []
  let hasArg = false
  for (const idx of current) {
    const node = nodes[idx]
    if (!node) continue
    let kids = node.children
    if (!kids.length && node.redirect !== null && nodes[node.redirect]) kids = nodes[node.redirect].children
    for (const c of kids) {
      const cn = nodes[c]
      if (!cn) continue
      if (cn.type === 1 && cn.name) literals.push(cn.name)
      else if (cn.type === 2) hasArg = true
    }
  }
  return { literals, hasArg, matched: current.length > 0 }
}

const FALLBACK_COMMANDS = ['spawn', 'home', 'sethome', 'delhome', 'tpa', 'tpahere', 'tpaccept', 'tpdeny', 'tpcancel', 'pay', 'bal', 'balance', 'baltop', 'sell', 'menu', 'warp', 'rtp', 'msg', 'tell', 'r', 'reply', 'help', 'commands', 'kit', 'ah', 'shop', 'back', 'trade', 'ignore', 'mail', 'playtime', 'rules', 'dn', 'login', 'register', 'l']
// ==== HELPERS END ====

// ===================== ANTI FAKE PAY =====================
const FILTERED_MESSAGES = [
  'Tự do xây dựng, tự do PvP',
  'Đã donate key, rank bằng thẻ',
  'giá bán item có thể tăng hoặc giảm',
  'Chơi server dưới 180 phút',
  'Ai là newbie thì dùng lệnh /commands',
  'Để có rank plus và key',
  'Dùng lệnh /rtp để dịch chuyển ngẫu nhiên',
  'Xin lưu ý: giá bán item',
  'Tự do xây dựng',
  'donate key',
  'newbie thì dùng lệnh',
  'rank plus và key',
  '/rtp để dịch chuyển',
  'SẢNH ➞ Đăng nhập thành công',
  'Bạn hãy hỏi những người chơi khác',
  'Nếu như không biết cách chơi',
  'Hoặc dùng lệnh /help',
  'Để xem cách chơi nhé'
]

const messageCache = new Map()
const CACHE_TIMEOUT = 2000

function isDuplicateMessage(msgText) {
  const key = String(msgText).trim()
  if (messageCache.has(key)) return true
  messageCache.set(key, Date.now())
  setTimeout(() => messageCache.delete(key), CACHE_TIMEOUT)
  return false
}

function shouldFilterMessage(msgText) {
  const lower = msgText.toLowerCase()
  for (const filtered of FILTERED_MESSAGES) {
    if (lower.includes(filtered.toLowerCase())) return true
  }
  if (lower.includes('[system]') || lower.includes('system')) {
    const keywords = ['nhận', 'pay', 'chuyển', 'received', 'nhận được', '$', 'coin']
    for (const k of keywords) {
      if (lower.includes(k)) return false
    }
    return true
  }
  return false
}

function getColoredChatParts(message) {
  const parts = []
  try {
    const json = (message && message.json) || message || {}
    const walk = (node) => {
      if (!node) return
      if (typeof node === 'string') {
        parts.push({ text: node, color: null })
        return
      }
      if (typeof node.text !== 'undefined') {
        parts.push({ text: node.text, color: node.color || null })
      }
      if (Array.isArray(node.extra)) {
        for (const child of node.extra) walk(child)
      }
    }
    walk(json)
  } catch (e) {}
  return parts
}

function isValidReceiveMessage(message, msgText) {
  if (msgText.trimStart().startsWith('Bạn nhận được')) return true

  const parts = getColoredChatParts(message)
  let foundGreenMoney = false
  let foundYellowName = false
  for (const part of parts) {
    const text = (part.text || '').trim()
    const color = (part.color || '').toLowerCase()
    const isGreen = color === 'green' || color === 'dark_green' || color === 'lime' || color === '#55ff55'
    const isYellow = color === 'yellow' || color === 'gold' || color === '#ffff55'
    if (isGreen && /\$?\d/.test(text)) {
      foundGreenMoney = true
    } else if (isYellow && text.length > 0 && !/\$/.test(text)) {
      foundYellowName = true
    }
  }
  return foundGreenMoney && foundYellowName
}

function parseReceiveMoney(message) {
  const msgText = message.toString()
  if (msgText.includes('chuyển cho') || msgText.includes('transfer to')) return null
  if (!isValidReceiveMessage(message, msgText)) return null

  const patterns = [
    /Bạn nhận được \$?([\d.]+)\s*([KMB]?)\s*(?:từ|from)\s*(\w+)/i,
    /nhận được \$?([\d.]+)\s*([KMB]?)\s*(?:từ|from)\s*(\w+)/i,
    /received \$?([\d.]+)\s*([KMB]?)\s*(?:from|từ)\s*(\w+)/i,
    /\+\s*\$?([\d.]+)\s*([KMB]?)\s*(?:từ|from)\s*(\w+)/i,
    /Bạn nhận được (\d+)\s*([KMB]?)\s*(?:từ|from)\s*(\w+)/i
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(msgText)
    if (match) {
      let amount = parseFloat(match[1])
      const suffix = match[2] ? match[2].toUpperCase() : ''
      if (suffix === 'K') amount *= 1000
      else if (suffix === 'M') amount *= 1000000
      else if (suffix === 'B') amount *= 1000000000
      return { sender: match[3], amount: Math.floor(amount), raw: msgText }
    }
  }
  return null
}

function parseSendMoney(msgText) {
  const patterns = [
    /Bạn đã chuyển cho (\w+)\s*\$?([\d.]+)\s*([KMB]?)/i,
    /\/pay\s+(\w+)\s+([\d.]+)\s*([KMB]?)/i,
    /\/chuyen\s+(\w+)\s+([\d.]+)\s*([KMB]?)/i
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(msgText)
    if (match) {
      let amount = parseFloat(match[2])
      const suffix = match[3] ? match[3].toUpperCase() : ''
      if (suffix === 'K') amount *= 1000
      else if (suffix === 'M') amount *= 1000000
      else if (suffix === 'B') amount *= 1000000000
      return { receiver: match[1], amount: Math.floor(amount), raw: msgText }
    }
  }
  return null
}

// ===================== GUI VIEWER + TPA SETTINGS =====================
// MENU vẫn auto để bot tự vào cụm; GUI Xác nhận/Confirm/TPA thì CHỜ bấm tay trên web
// AUTO_MENU / AUTO_CONFIRM là cài đặt riêng từng tài khoản (auth.prefsOf)

function snapshotWindow(win) {
  if (!win) return null
  const slots = []
  const arr = win.slots || []
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i]
    if (!it) continue
    let lore = null
    try {
      if (Array.isArray(it.lore)) lore = it.lore.join('\n').slice(0, 500)
      else if (typeof it.lore === 'string') lore = it.lore.slice(0, 500)
      else if (it.nbt && it.nbt.value && it.nbt.value.display && it.nbt.value.display.value && it.nbt.value.display.value.Lore) {
        const l = it.nbt.value.display.value.Lore.value.value || []
        lore = l.map(x => String(x).slice(0, 200)).join('\n').slice(0, 500)
      }
    } catch (e) {}
    slots.push({
      slot: i,
      name: it.name || 'unknown',
      displayName: it.displayName || it.name || ('Slot ' + i),
      count: it.count || 1,
      type: it.type,
      lore
    })
  }
  // mineflayer Window: slots gồm cả inventory người chơi ở cuối.
  // Tách GUI phía trên (rương/shop/xác nhận) và túi đồ bot phía dưới để web vẽ giống Minecraft
  let guiSize = sellGuiSize(win)
  if (!(guiSize > 0) || guiSize > arr.length) guiSize = arr.length
  const playerSlots = slots.filter(s => s.slot >= guiSize)
  return { title: plainTitle(win.title), size: arr.length, guiSize, slots, playerSlots, openedAt: Date.now() }
}

function detectTpaType(msgText) {
  const t = String(msgText || '').toLowerCase()
  // Họ muốn BẠN đến chỗ HỌ (tphere): "dịch chuyển bạn đến họ", "bạn đến chỗ", "tpahere", "tpa here"
  if (/bạn\s*(đến|den|tới|toi)\s*(chỗ|cho|chổ|vị trí|chỗ của|chỗ họ|nơi)?|dịch chuyển bạn|dich chuyen ban|tpahere|tpa\s*here|you\s*to\s*(them|him|her|me)/i.test(msgText || '')) return 'tpahere'
  return 'tpa'
}

function parseTpaRequest(msgText, botName) {
  const t = String(msgText || '')
  const patterns = [
    /Bạn nhận được yêu cầu (?:dịch chuyển|dich chuyen|dịch-chuyển|teleport|tpa)\s*(?:.*?)\s*từ\s*(\w{3,16})/i,
    /(\w{3,16})\s+muốn\s*(?:dịch chuyển|dich chuyen|dịch-chuyển|teleport|dich-chuyen)\s*(?:đến|den|tới|toi|qua|tới chỗ|đến chỗ|qua chỗ)?\s*(?:bạn|ban|chỗ bạn|chỗ của bạn)?/i,
    /(\w{3,16})\s+(?:đã gửi|da gui|gửi|gui|gởi)\s*yêu cầu\s*(?:dịch chuyển|dich chuyen|dịch-chuyển|teleport|tpa)(?:\s*bạn\s*(?:đến|den|tới|toi)\s*(?:họ|ho|chỗ họ|chỗ của họ|nơi của họ))?/i,
    /yêu cầu\s*(?:dịch chuyển|dich chuyen|teleport|tpa).*?từ\s*(\w{3,16})/i,
    /yêu cầu\s*(?:dịch chuyển|dich chuyen|teleport).*?bạn\s*(?:đến|den|tới|toi).*?(\w{3,16})/i,
    /(\w{3,16})\s+has\s*(?:sent you a teleport|requested to teleport|sent a teleport request)/i,
    /teleport\s*request.*?from\s*(\w{3,16})/i,
    /tpahere.*?(\w{3,16})/i,
    /\[\s*TPA\s*\].*?(\w{3,16})/i
  ]
  for (const p of patterns) {
    const m = p.exec(t)
    if (m && m[1]) {
      const from = m[1]
      // Bỏ qua tên bot / tên hệ thống
      if (botName && from.toLowerCase() === String(botName).toLowerCase()) continue
      if (/^bạn$|^ban$|^server$|^system$|^kingmc$/i.test(from)) continue
      return { from, type: detectTpaType(t), raw: t.slice(0, 300) }
    }
  }
  // Fallback: câu có cả từ "dịch chuyển/teleport/tpa" + "yêu cầu/muốn/đến bạn/tới bạn" -> bắt tên đầu tiên hợp lệ
  if (/(dịch chuyển|dich chuyen|teleport|\btpa\b)/i.test(t) && /(yêu cầu|yeu cau|muốn|muon|request|đến bạn|den ban|tới bạn|toi ban)/i.test(t)) {
    const m = /(\w{3,16})/.exec(t)
    if (m && m[1]) {
      const from = m[1]
      if (botName && from.toLowerCase() === String(botName).toLowerCase()) return null
      if (!/^bạn$|^ban$|^server$|^system$/i.test(from)) {
        return { from, type: detectTpaType(t), raw: t.slice(0, 300), fallback: true }
      }
    }
  }
  return null
}

function tpaTypeLabel(type) {
  return type === 'tpahere' ? 'muốn BẠN đến chỗ HỌ (tphere)' : 'muốn đến chỗ BẠN (tpa)'
}