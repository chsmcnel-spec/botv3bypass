'use strict'
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { SCHEMA } = require('./constants')
const { scan, fingerprint, applyOverlays } = require('./scanner')
const { purgeAudio } = require('./purger')
const { build } = require('./builder')
const { buildZip } = require('./zip')

async function writeAtomic(file, data) {
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

class ResourcePack extends EventEmitter {
  constructor(opts) {
    super()
    this.root = path.resolve(opts.rootDir)
    this.cacheDir = path.resolve(opts.cacheDir)
    this.purge = opts.purgeAudio !== false
    this.buildZip = opts.buildZip !== false
    this.clientVersion = String(opts.clientVersion || '1.21.11')
    this.pollMs = Math.max(0, Number(opts.pollSec == null ? 15 : opts.pollSec)) * 1000
    this._log = opts.log || (() => {})
    this.state = { status: 'init', version: 'empty', fingerprint: '', builtAt: null, error: null }
    this.manifest = { schema: SCHEMA, version: 'empty', baseUrl: '/rp/files/', pack: { format: null, description: '' }, textures: {}, items: {} }
    this.manifestJson = Buffer.from(JSON.stringify(this.manifest))
    this.manifestGz = zlib.gzipSync(this.manifestJson)
    this.etag = '"empty"'
    this.report = null
    this._details = null
    this._busy = null
    this._pending = null
    this._timer = null
  }

  log(level, msg) { try { this._log(level, msg) } catch (e) {} }
  file(name) { return path.join(this.cacheDir, name) }
  get zipPath() { return this.file('pack.zip') }

  async start() {
    await fsp.mkdir(this.cacheDir, { recursive: true })
    try { await fsp.mkdir(this.root, { recursive: true }) } catch (e) {}
    await this.refresh({ reason: 'startup' })
    if (this.pollMs > 0) {
      this._timer = setInterval(() => { this.poll().catch(e => this.log('error', 'Poll lỗi: ' + e.message)) }, this.pollMs)
      if (this._timer.unref) this._timer.unref()
    }
    return this
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null }

  // Quét + (purge audio) + tính fingerprint. Chỉ rebuild nếu khác cache (hoặc force).
  async refresh({ force = false, reason = '' } = {}) {
    if (this._busy) return this._busy
    this._busy = this._refresh(force, reason).finally(() => { this._busy = null })
    return this._busy
  }

  async _scanPurged() {
    let files = await scan(this.root)
    let purged = null
    if (this.purge && files.some(f => f.audio)) {
      purged = await purgeAudio(this.root, files, (l, m) => this.log(l, m))
      this.log('info', `🔇 Đã xoá ${purged.files} file audio (${(purged.bytes / 1048576).toFixed(1)} MB)` + (purged.mcmetaFixed ? ' + bỏ "sounds" trong pack.mcmeta' : ''))
      files = await scan(this.root)
    }
    return { files, purged }
  }

  async _refresh(force, reason) {
    const { files, purged } = await this._scanPurged()
    if (!files.length) {
      this.state = { status: 'empty', version: 'empty', fingerprint: '', builtAt: null, error: null }
      this.log('warn', `Thư mục RP trống: ${this.root} — copy RP đã giải nén vào đây (cần pack.mcmeta + assets/)`)
      return this.state
    }
    const fp = fingerprint(files, this.clientVersion)
    if (!force && this.state.fingerprint === fp) return this.state
    if (!force && await this._loadCache(fp)) { this.log('info', `📦 Dùng cache RP v${this.state.version} (không đổi)`); return this.state }
    return this._rebuild(files, fp, purged, reason)
  }

  async _loadCache(fp) {
    try {
      const meta = JSON.parse(await fsp.readFile(this.file('meta.json'), 'utf8'))
      if (meta.schema !== SCHEMA || meta.fingerprint !== fp) return false
      this.manifestJson = await fsp.readFile(this.file('manifest.json'))
      this.manifest = JSON.parse(this.manifestJson.toString('utf8'))
      this.manifestGz = zlib.gzipSync(this.manifestJson)
      this.report = JSON.parse(await fsp.readFile(this.file('report.json'), 'utf8'))
      this._details = null
      this.etag = '"' + meta.etag + '"'
      this.state = { status: 'ready', version: meta.version, fingerprint: fp, builtAt: meta.builtAt, error: null }
      return true
    } catch (e) { return false }
  }

  async _rebuild(files, fp, purged, reason) {
    const t0 = Date.now()
    this.state = Object.assign({}, this.state, { status: 'building' })
    this.log('info', `🔨 Build RP (${files.length} file${reason ? ', ' + reason : ''})...`)
    try {
      const merged = applyOverlays(files, this.clientVersion)
      const ovs = [...new Set(merged.filter(f => f.overlay).map(f => f.overlay))].sort()
      this.log('info', `🧩 Overlay cho client ${this.clientVersion}: ${ovs.length ? ovs.join(', ') : 'không có'}`)
      const r = await build({ root: this.root, files: merged, log: (l, m) => this.log(l, m), purged })
      const version = fp.slice(0, 12)
      const builtAt = new Date().toISOString()
      const m = r.manifest
      m.version = version; m.builtAt = builtAt
      if (this.buildZip) {
        try {
          const z = await buildZip(this.root, files, this.zipPath) // zip giữ TẤT CẢ file (client tự chọn overlay)
          m.pack.zip = { url: '/rp/pack.zip', sha1: z.sha1, size: z.size, entries: z.entries }
        } catch (e) { r.report.issues.push({ level: 'warn', code: 'ZIP_FAIL', file: '', msg: 'Không tạo được pack.zip: ' + e.message }); r.report.issueCounts.warn++ }
      }
      const json = Buffer.from(JSON.stringify(m))
      const etag = crypto.createHash('sha256').update(json).digest('hex').slice(0, 32)
      r.report.version = version; r.report.builtAt = builtAt
      await writeAtomic(this.file('manifest.json'), json)
      await writeAtomic(this.file('details.json'), JSON.stringify(r.details))
      await writeAtomic(this.file('report.json'), JSON.stringify(r.report))
      await writeAtomic(this.file('meta.json'), JSON.stringify({ schema: SCHEMA, fingerprint: fp, version, builtAt, etag }))
      this.manifest = m; this.manifestJson = json; this.manifestGz = zlib.gzipSync(json)
      this.etag = '"' + etag + '"'; this.report = r.report; this._details = r.details
      this.state = { status: 'ready', version, fingerprint: fp, builtAt, error: null }
      const s = r.report.stats, c = r.report.issueCounts
      this.log('info', `✅ RP v${version}: ${s.items} item (${s.flat} phẳng, ${s.cube} khối, ${s.custom} custom; ${s.unresolved} không resolve) · lỗi ${c.error} · cảnh báo ${c.warn} · ${Date.now() - t0}ms`)
      if (c.error) this.log('warn', `RP có ${c.error} lỗi — xem GET /api/rp/report`)
      this.emit('built', this.state)
    } catch (e) {
      this.state = Object.assign({}, this.state, { status: 'error', error: e.message })
      this.log('error', 'Build RP thất bại: ' + e.message)
    }
    return this.state
  }

  // Polling: chỉ rebuild khi fingerprint ĐỔI rồi ĐỨNG YÊN qua 1 chu kỳ (tránh build giữa lúc admin đang copy)
  async poll() {
    if (this._busy) return
    const { files } = await this._scanPurged()
    if (!files.length) { if (this.state.status !== 'empty') await this.refresh({ reason: 'thư mục trống' }); return }
    const fp = fingerprint(files, this.clientVersion)
    if (fp === this.state.fingerprint) { this._pending = null; return }
    if (this._pending !== fp) { this._pending = fp; return }
    this._pending = null
    await this.refresh({ reason: 'phát hiện thay đổi' })
  }

  async details(id) {
    if (!this._details) {
      try { this._details = JSON.parse(await fsp.readFile(this.file('details.json'), 'utf8')) } catch (e) { this._details = {} }
    }
    return this._details[id] || null
  }

  status() {
    const s = this.report && this.report.stats
    return {
      status: this.state.status, version: this.state.version, builtAt: this.state.builtAt, error: this.state.error,
      root: 'public/resource-pack', items: s ? s.items : 0,
      issues: this.report ? this.report.issueCounts : null,
      zip: this.manifest.pack && this.manifest.pack.zip ? { url: this.manifest.pack.zip.url, sha1: this.manifest.pack.zip.sha1, size: this.manifest.pack.zip.size } : null
    }
  }
}

module.exports = { ResourcePack }
