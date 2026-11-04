'use strict'
const fsp = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const { SCHEMA, BLOCK_TEX_SUFFIX_RE } = require('./constants')
const { Resolver } = require('./resolver')
const { tick } = require('./scanner')

class IssueList {
  constructor(cap) { this.cap = cap; this.list = []; this.counts = { error: 0, warn: 0, info: 0 }; this.seen = new Set() }
  add(level, code, file, msg) {
    const key = code + '|' + file + '|' + msg
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.counts[level] = (this.counts[level] || 0) + 1
    if (this.list.length < this.cap) this.list.push({ level, code, file: file || '', msg })
  }
}

async function mapPool(arr, n, fn) {
  let i = 0
  const worker = async () => {
    while (i < arr.length) {
      const idx = i++
      await fn(arr[idx], idx)
      if (idx % 64 === 63) await tick()
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, worker))
}

async function readJson(abs) {
  const txt = (await fsp.readFile(abs, 'utf8')).replace(/^\uFEFF/, '')
  return JSON.parse(txt)
}

// Đọc kích thước PNG từ IHDR + kiểm tra đuôi IEND (phát hiện file copy dở / hỏng)
async function pngInfo(abs, size) {
  const fh = await fsp.open(abs, 'r')
  try {
    const b = Buffer.alloc(24)
    const { bytesRead } = await fh.read(b, 0, 24, 0)
    if (bytesRead < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a || b.toString('ascii', 12, 16) !== 'IHDR') return null
    let complete = false
    if (size >= 12 + 24) {
      const tail = Buffer.alloc(12)
      await fh.read(tail, 0, 12, size - 12)
      complete = tail.toString('ascii', 4, 8) === 'IEND'
    }
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), complete }
  } finally { await fh.close() }
}

function plainText(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(plainText).join('')
  if (typeof v === 'object') return (typeof v.text === 'string' ? v.text : '') + plainText(v.extra)
  return String(v)
}

// animation (.png.mcmeta) -> {n: số frame, q: [[index, ticks], ...]}
function animationOf(meta, w, h, issues, file) {
  const a = meta && meta.animation
  if (!a || typeof a !== 'object') return { n: Math.max(1, h >= w && w > 0 ? Math.floor(h / w) : 1), q: null, animated: false }
  const fw = Number(a.width) > 0 ? Number(a.width) : w
  const fh = Number(a.height) > 0 ? Number(a.height) : (Number(a.width) > 0 ? Number(a.width) : w)
  if (fw !== w) issues.add('info', 'ANIM_TILE', file, 'animation.width khác chiều rộng ảnh — chỉ hỗ trợ frame xếp dọc')
  const n = Math.max(1, Math.floor(h / fh))
  const ft = Math.max(1, parseInt(a.frametime, 10) || 1)
  let q = []
  if (Array.isArray(a.frames) && a.frames.length) {
    for (const f of a.frames) {
      const idx = typeof f === 'number' ? f : f && f.index
      const time = typeof f === 'object' && f && f.time ? Math.max(1, parseInt(f.time, 10) || ft) : ft
      if (Number.isInteger(idx) && idx >= 0 && idx < n) q.push([idx, time])
      else issues.add('warn', 'ANIM_BAD', file, 'frame index ' + idx + ' ngoài phạm vi 0..' + (n - 1))
    }
  } else for (let i = 0; i < n; i++) q.push([i, ft])
  if (q.length <= 1 || n <= 1) return { n, q: null, animated: false }
  return { n, q, animated: true }
}

async function build({ root, files, log, purged }) {
  const t0 = Date.now()
  const issues = new IssueList(500)
  const byRel = new Map(files.map(f => [f.lrel || f.rel, f]))
  const byKind = {}
  for (const f of files) byKind[f.kind] = (byKind[f.kind] || 0) + 1
  const abs = (rel) => path.join(root, rel)

  // ---- pack.mcmeta ----
  const pack = { format: null, description: '' }
  if (!byRel.has('pack.mcmeta')) issues.add('error', 'NO_PACK_MCMETA', 'pack.mcmeta', 'Thiếu pack.mcmeta ở thư mục gốc RP (game client sẽ không nhận pack)')
  else {
    try {
      const j = await readJson(abs('pack.mcmeta'))
      pack.format = j && j.pack && j.pack.pack_format != null ? j.pack.pack_format : (j && j.pack && j.pack.min_format != null ? j.pack.min_format : null)
      pack.description = plainText(j && j.pack && j.pack.description).slice(0, 200)
      if (pack.format == null) issues.add('warn', 'MCMETA_BAD', 'pack.mcmeta', 'Không thấy pack.pack_format')
    } catch (e) { issues.add('error', 'JSON_PARSE', 'pack.mcmeta', e.message) }
  }

  // ---- đọc JSON model / blockstate / items / lang ----
  const models = new Map(), blockstates = new Map(), itemDefs = new Map()
  const loadJson = async (list, into, label) => {
    await mapPool(list, 24, async (f) => {
      if (!f.sub.endsWith('.json')) return
      try { into.set(f.ns + ':' + f.sub.slice(0, -5), await readJson(abs(f.rel))) }
      catch (e) { issues.add('error', 'JSON_PARSE', f.rel, e.message) }
    })
  }
  await loadJson(files.filter(f => f.kind === 'models'), models)
  await loadJson(files.filter(f => f.kind === 'blockstates'), blockstates)
  await loadJson(files.filter(f => f.kind === 'items'), itemDefs)

  // lang: ưu tiên en_us (fallback file lang bất kỳ của minecraft)
  let lang = {}
  const langFiles = files.filter(f => f.kind === 'lang' && f.ns === 'minecraft' && f.sub.endsWith('.json'))
  const langFile = langFiles.find(f => f.sub === 'en_us.json') || langFiles[0]
  if (langFile) { try { lang = await readJson(abs(langFile.rel)) } catch (e) { issues.add('warn', 'JSON_PARSE', langFile.rel, e.message) } }

  // ---- texture: kích thước + animation ----
  const textures = new Map()
  const texFiles = files.filter(f => f.kind === 'textures' && f.sub.endsWith('.png'))
  await mapPool(texFiles, 24, async (f) => {
    const key = f.ns + ':' + f.sub.slice(0, -4)
    let info = null
    try { info = await pngInfo(abs(f.rel), f.size) } catch (e) {}
    if (!info) { issues.add('error', 'PNG_BAD', f.rel, 'Không phải PNG hợp lệ'); return }
    if (!info.complete) issues.add('warn', 'PNG_TRUNCATED', f.rel, 'PNG có vẻ bị cắt dở (thiếu IEND) — copy chưa xong?')
    let meta = null
    const mm = byRel.get((f.lrel || f.rel) + '.mcmeta')
    if (mm) { try { meta = await readJson(abs(mm.rel)) } catch (e) { issues.add('warn', 'MCMETA_BAD', mm.rel, e.message) } }
    const an = animationOf(meta, info.w, info.h, issues, f.rel)
    if (!meta && info.h > info.w && info.w > 0 && info.h % info.w !== 0) issues.add('warn', 'TEX_ASPECT', f.rel, 'Ảnh ' + info.w + 'x' + info.h + ' không vuông và không có .mcmeta')
    const t = { p: f.rel, w: info.w, h: info.h }
    if (an.n > 1) t.n = an.n
    if (an.q) t.q = an.q
    textures.set(key, t)
  })

  // ---- danh sách id ----
  const idsByNs = new Map()
  const addId = (ns, id) => { let s = idsByNs.get(ns); if (!s) idsByNs.set(ns, s = new Set()); s.add(id) }
  for (const k of itemDefs.keys()) { const i = k.indexOf(':'); addId(k.slice(0, i), k.slice(i + 1)) }
  for (const k of models.keys()) { const m = /^([^:]+):item\/(.+)$/.exec(k); if (m) addId(m[1], m[2]) }
  for (const k of blockstates.keys()) { const i = k.indexOf(':'); addId(k.slice(0, i), k.slice(i + 1)) }
  for (const k of textures.keys()) {
    const m = /^([^:]+):(item|block)\/([^/]+)$/.exec(k)
    if (!m) continue
    if (m[2] === 'block' && BLOCK_TEX_SUFFIX_RE.test(m[3])) {
      // furnace_front/_side/_top -> id "furnace" (block chỉ có texture từng mặt, không có file <id>.png)
      const f = /^(.+)_(top|side|front|bottom|end|back)$/.exec(m[3])
      if (f) addId(m[1], f[1])
      continue
    }
    addId(m[1], m[3])
  }

  // ---- resolve từng id ----
  const R = new Resolver({ models, blockstates, itemDefs, textures, issues })
  const items = {}, details = {}
  const stats = { items: 0, flat: 0, cube: 0, custom: 0, fromItemDef: 0, fromModel: 0, fromBlockstate: 0, fromTexture: 0, unresolved: 0 }
  let n = 0
  for (const [ns, set] of idsByNs) {
    for (const id of [...set].sort()) {
      const full = ns + ':' + id
      const out = ns === 'minecraft' ? id : full
      let d = null, src = ''
      if (itemDefs.has(full)) { d = R.describeItemDef(itemDefs.get(full), 'items/' + id + '.json'); if (d) { src = 'items'; stats.fromItemDef++ } }
      if (!d && models.has(ns + ':item/' + id)) { d = R.describeModel(ns + ':item/' + id, 'models/item/' + id + '.json'); if (d) { src = 'models/item'; stats.fromModel++ } }
      if (!d && blockstates.has(full)) { d = R.describeBlockstate(blockstates.get(full), 'blockstates/' + id + '.json'); if (d) { src = 'blockstates'; stats.fromBlockstate++ } }
      if (!d && models.has(ns + ':block/' + id)) { d = R.describeModel(ns + ':block/' + id, 'models/block/' + id + '.json'); if (d) { src = 'models/block'; stats.fromModel++ } }
      if (!d) { d = R.guess(ns, id); if (d) { src = 'textures'; stats.fromTexture++ } }
      if (!d) { stats.unresolved++; continue }
      items[out] = d
      stats.items++
      if (d.s === 'f') stats.flat++; else if (d.s === 'c') stats.cube++; else stats.custom++
      const nm = lang['item.' + ns + '.' + id] || lang['block.' + ns + '.' + id]
      const meta = d._meta || {}
      details[out] = { id: out, src, model: meta.model || null, chain: meta.chain || [], name: typeof nm === 'string' ? nm : null }
      if (++n % 200 === 0) await tick()
    }
  }
  // model cha vanilla không có trong RP: bình thường -> gộp thành 1 dòng info
  if (R.parentMissing.size) {
    const top = [...R.parentMissing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + '×' + v).join(', ')
    issues.add('info', 'MODEL_PARENT_MISSING', '', R.parentMissing.size + ' model cha không có trong RP (dùng bảng vanilla rút gọn / đoán từ texture): ' + top)
  }

  // ---- manifest chỉ giữ texture có người dùng ----
  const used = new Set()
  for (const d of Object.values(items)) for (const k of (d.l || d.f)) used.add(k)
  const texOut = {}
  for (const k of [...used].sort()) texOut[k] = textures.get(k)

  const manifest = {
    schema: SCHEMA,
    baseUrl: '/rp/files/',
    pack,
    textures: texOut,
    items
  }
  const stable = JSON.stringify(manifest)
  const contentHash = crypto.createHash('sha256').update(stable).digest('hex')
  const report = {
    schema: SCHEMA,
    durationMs: Date.now() - t0,
    files: files.length,
    byKind,
    purged: purged || { files: 0, bytes: 0 },
    stats,
    textures: { indexed: textures.size, used: used.size },
    issueCounts: issues.counts,
    issues: issues.list
  }
  return { manifest, details, report, contentHash }
}

module.exports = { build }
