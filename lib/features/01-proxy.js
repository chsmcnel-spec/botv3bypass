// FEATURE MODULE: 01-proxy.js
// Proxy transport, proxy checks, license helpers and config persistence.
// Loaded in order by ../runtime-loader.js; shares the single runtime scope.

// ===================== PROXY (kết nối bot qua proxy ) =====================
// Proxy lưu RIÊNG TỪNG BOT trong config.json (cfg.proxy, mã hoá cùng khoá với mật khẩu acc).
// Hỗ trợ http / https / socks4 / socks5. Để trống = nối thẳng như cũ.
// Ví dụ: http://user:pass@1.2.3.4:8080  |  socks5://user:pass@1.2.3.4:1080
function buildAgent(proxyUrl) {
  if (!proxyUrl) return undefined
  let parsed
  try { parsed = new URL(proxyUrl) } catch (e) { throw new Error('Proxy URL khong hop le.') }
  if (['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    const { SocksProxyAgent } = require('socks-proxy-agent')
    return new SocksProxyAgent(proxyUrl)
  }
  if (['http:', 'https:'].includes(parsed.protocol)) {
    const { HttpsProxyAgent } = require('https-proxy-agent')
    return new HttpsProxyAgent(proxyUrl)
  }
  throw new Error('Proxy chi ho tro http/https/socks4/socks5.')
}

// Lấy proxy (đã giải mã) của 1 bot. Cho phép sửa tay config.json bằng proxy dạng chữ thường.
function getBotProxy(cfg) {
  const raw = cfg && cfg.proxy
  if (!raw) return ''
  const dec = decryptPw(raw)
  if (dec) return dec
  return /^[a-z0-9+.-]+:\/\//i.test(String(raw)) ? String(raw).trim() : ''
}

// Chỉ hiện giao thức + host:port (giấu user:pass) để gửi ra web / log
function proxyLabel(proxyUrl) {
  if (!proxyUrl) return ''
  try {
    const u = new URL(proxyUrl)
    return u.protocol.replace(':', '') + '://' + u.hostname + (u.port ? ':' + u.port : '')
  } catch (e) { return '' }
}

// Mở 1 socket TCP tới host:port của server Minecraft THÔNG QUA proxy
function connectViaProxy(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(proxyUrl) } catch (e) { return reject(new Error('Proxy URL khong hop le.')) }
    const user = decodeURIComponent(u.username || '')
    const pass = decodeURIComponent(u.password || '')
    if (['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(u.protocol)) {
      const { SocksClient } = require('socks') // đi kèm socks-proxy-agent
      const type = (u.protocol === 'socks4:' || u.protocol === 'socks4a:') ? 4 : 5
      SocksClient.createConnection({
        proxy: { host: u.hostname, port: Number(u.port) || 1080, type, userId: user || undefined, password: pass || undefined },
        command: 'connect',
        destination: { host, port },
        timeout: 15000
      }).then((info) => resolve(info.socket)).catch(reject)
      return
    }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Proxy chi ho tro http/https/socks4/socks5.'))
    const lib = u.protocol === 'https:' ? https : http
    const headers = { Host: host + ':' + port }
    if (user || pass) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
    const req = lib.request({
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: host + ':' + port,
      headers,
      timeout: 15000
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        try { socket.destroy() } catch (e) {}
        return reject(new Error('Proxy tu choi CONNECT: HTTP ' + res.statusCode))
      }
      try { socket.setTimeout(0) } catch (e) {}
      resolve(socket)
    })
    req.on('timeout', () => req.destroy(new Error('Proxy timeout')))
    req.on('error', reject)
    req.end()
  })
}

function licenseInfo(username) {
  const lm = licenses.get(username)
  if (!lm) return { valid: false, hasKey: false, keyHint: '', daysLeft: null, expiresAt: null, error: 'Chưa có key' }
  const st = lm.status()
  return { valid: st.valid, hasKey: st.hasKey, keyHint: st.keyHint, daysLeft: st.daysLeft, expiresAt: st.expiresAt, error: st.error }
}

function attachLicense(username, lm) {
  const old = licenses.get(username)
  if (old && old !== lm) { try { old.destroy() } catch (e) {} }
  licenses.set(username, lm)
  lm.on('change', (status, wasValid) => onLicenseChange(username, lm, status, wasValid))
}

function onLicenseChange(username, lm, status, wasValid) {
  if (licenses.get(username) !== lm || !botCfg(username)) return
  const s = botStates[username]
  if (!status.valid) {
    if (wasValid) log(username, 'LICENSE', `🔒 Key không còn hợp lệ (${status.error || 'hết hạn'}) — ngắt bot`)
    if (s && s.bot && !s.isDead) { disconnectBot(username); s.licenseBlocked = true }
  } else if (!wasValid) {
    log(username, 'LICENSE', `🔓 Key hợp lệ — bot được phép chạy`)
    if ((!s || s.licenseBlocked) && !isOutActive(username)) createBot(username, { manual: true })
  }
}

function saveConfig() {
  try {
    CONFIG.BOTS = BOT_LIST
    CONFIG.SERVER_IP = SERVER_IP
    CONFIG.SERVER_PORT = SERVER_PORT
    CONFIG.SERVER_VERSION = SERVER_VERSION
    CONFIG.AUTOSELL = AUTOSELL
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), 'utf8')
    return true
  } catch (e) {
    console.error('❌ Lỗi lưu config.json:', e.message)
    return false
  }
}