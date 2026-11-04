'use strict'
const fsp = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const { AUDIO_EXT, ASSET_KINDS } = require('./constants')

const tick = () => new Promise(r => setImmediate(r))

// Phân loại 1 đường dẫn tương đối (posix) của RP
function classify(rel) {
  if (rel === 'pack.mcmeta') return { kind: 'pack' }
  if (rel === 'pack.png') return { kind: 'packicon' }
  let m = /^assets\/([^/]+)\/sounds\.json$/.exec(rel)
  if (m) return { kind: 'sounds', ns: m[1], sub: 'sounds.json' }
  m = /^assets\/([^/]+)\/([^/]+)\/(.+)$/.exec(rel)
  if (m) return { kind: ASSET_KINDS.has(m[2]) ? m[2] : 'other', ns: m[1], sub: m[3] }
  return { kind: 'other' }
}

function isAudio(rel) {
  const ext = path.posix.extname(rel).toLowerCase()
  return AUDIO_EXT.has(ext) || /^(overlay_[^/]+\/)?assets\/[^/]+\/sounds\.json$/.test(rel)
}

// ---- Overlay (overlay_1_21_11/, ...) ----
// Mỗi overlay ghi đè file cùng đường dẫn logic trong assets/. Overlay có version <= client thì áp dụng,
// overlay mới hơn ghi đè overlay cũ, overlay cũ ghi đè bản gốc. Trả về danh sách đã gộp (1 file / đường dẫn logic);
// f.rel vẫn là đường dẫn thật (để phục vụ file), f.lrel là đường dẫn logic.
const OVERLAY_RE = /^overlay_(\d+)_(\d+)(?:_(\d+))?$/
const verKey = (a, b, c) => (+a || 0) * 1e6 + (+b || 0) * 1e3 + (+c || 0)
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(v || '').trim())
  return m ? verKey(m[1], m[2], m[3]) : null
}

function applyOverlays(files, clientVersion) {
  const clientKey = parseVersion(clientVersion)
  const best = new Map()
  for (const f of files) {
    const top = f.rel.split('/')[0]
    const m = OVERLAY_RE.exec(top)
    let prio = 0, lrel = f.rel, dir = null
    if (m) {
      if (clientKey == null) continue
      const k = verKey(m[1], m[2], m[3])
      if (k > clientKey) continue
      lrel = f.rel.slice(top.length + 1)
      if (!lrel.startsWith('assets/')) continue
      prio = k; dir = top
    }
    const cur = best.get(lrel)
    if (cur && cur.prio >= prio) continue
    best.set(lrel, { f, prio, lrel, dir })
  }
  const out = []
  for (const { f, lrel, dir } of best.values()) {
    out.push(Object.assign({}, f, classify(lrel), { lrel, overlay: dir, audio: f.audio || isAudio(lrel) }))
  }
  out.sort((a, b) => (a.lrel < b.lrel ? -1 : a.lrel > b.lrel ? 1 : 0))
  return out
}

// Quét đệ quy, KHÔNG đi theo symlink. Trả về [{rel, size, mtimeMs, kind, ns, sub, audio}]
async function scan(root) {
  const out = []
  const stack = ['']
  let n = 0
  while (stack.length) {
    const relDir = stack.pop()
    let entries
    try { entries = await fsp.readdir(path.join(root, relDir), { withFileTypes: true }) } catch (e) { continue }
    const files = []
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.isSymbolicLink()) continue
      const rel = relDir ? relDir + '/' + ent.name : ent.name
      if (ent.isDirectory()) stack.push(rel)
      else if (ent.isFile()) files.push(rel)
    }
    await Promise.all(files.map(async (rel) => {
      try {
        const st = await fsp.lstat(path.join(root, rel))
        if (!st.isFile()) return
        out.push(Object.assign({ rel, size: st.size, mtimeMs: Math.round(st.mtimeMs), audio: isAudio(rel) }, classify(rel)))
      } catch (e) {}
    }))
    if ((n += files.length) > 400) { n = 0; await tick() }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

// Dấu vân tay của cả thư mục: đổi tên/kích thước/mtime bất kỳ file nào -> hash đổi
function fingerprint(files, extra) {
  const h = crypto.createHash('sha256')
  h.update('client:' + (extra || '') + '\n')
  for (const f of files) h.update(f.rel + '|' + f.size + '|' + f.mtimeMs + '\n')
  return h.digest('hex')
}

module.exports = { scan, fingerprint, classify, isAudio, tick, applyOverlays, parseVersion }
