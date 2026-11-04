'use strict'
const { VANILLA_MODELS } = require('./vanilla')
const { tintFor, FLAT_BLOCK_RE, GUI_LEFT_FACES, GUI_RIGHT_FACES, GUI_TOP_FACES } = require('./constants')

const MAX_DEPTH = 16
const normRef = (v) => {
  let s = String(v == null ? '' : v).trim()
  if (!s) return ''
  s = s.replace(/\.(json|png)$/i, '')
  return s.includes(':') ? s : 'minecraft:' + s
}
const intToHex = (n) => '#' + (Number(n) & 0xffffff).toString(16).padStart(6, '0')

class Resolver {
  // models/blockstates/itemDefs: Map('ns:path' -> json) · textures: Map('ns:path' -> {p,w,h,n,q})
  constructor({ models, blockstates, itemDefs, textures, issues }) {
    this.models = models; this.blockstates = blockstates; this.itemDefs = itemDefs
    this.textures = textures; this.issues = issues
    this.parentMissing = new Map() // parent -> số model dùng nó (gộp báo cáo)
  }

  // ---- model: đi hết chuỗi parent, gộp textures/elements/display ----
  resolveModel(ref) {
    const out = { chain: [], textures: {}, elements: null, display: {}, builtin: null, missing: [] }
    const layers = []
    const seen = new Set()
    let cur = normRef(ref), depth = 0
    while (cur) {
      if (seen.has(cur) || ++depth > MAX_DEPTH) { out.missing.push('cycle:' + cur); this.issues.add('error', 'MODEL_CYCLE', cur, 'Vòng lặp parent / quá sâu'); break }
      seen.add(cur)
      if (cur.startsWith('minecraft:builtin/')) { out.builtin = cur.slice('minecraft:builtin/'.length); out.chain.push(cur); break }
      const m = this.models.get(cur) || VANILLA_MODELS[cur]
      if (!m || typeof m !== 'object') {
        out.missing.push(cur)
        this.parentMissing.set(cur, (this.parentMissing.get(cur) || 0) + 1)
        break
      }
      out.chain.push(cur); layers.push(m)
      cur = m.parent ? normRef(m.parent) : ''
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const m = layers[i]
      if (m.textures && typeof m.textures === 'object') for (const k of Object.keys(m.textures)) if (typeof m.textures[k] === 'string') out.textures[k] = m.textures[k]
      if (Array.isArray(m.elements)) out.elements = m.elements
      if (m.display && typeof m.display === 'object') for (const k of Object.keys(m.display)) out.display[k] = Object.assign({}, out.display[k], m.display[k])
    }
    return out
  }

  // '#var' -> theo chuỗi tới 'ns:path' có thật trong RP; null nếu không resolve được
  texKey(res, v, ctx) {
    let cur = String(v || ''), hop = 0
    while (cur.startsWith('#')) {
      if (++hop > MAX_DEPTH) break
      cur = res.textures[cur.slice(1)]
      if (typeof cur !== 'string') { this.issues.add('warn', 'TEXTURE_UNRESOLVED', ctx, 'Biến texture "' + v + '" không được định nghĩa'); return null }
    }
    if (cur.startsWith('#')) { this.issues.add('warn', 'TEXTURE_UNRESOLVED', ctx, 'Biến texture "' + v + '" vòng lặp'); return null }
    const key = normRef(cur)
    if (!key) return null
    if (!this.textures.has(key)) { this.issues.add('warn', 'TEXTURE_MISSING', ctx, 'Thiếu texture ' + key); return null }
    return key
  }

  // ---- model -> mô tả icon GUI ----
  describeModel(ref, ctx, tints) {
    const res = this.resolveModel(ref)
    const T = (v) => this.texKey(res, v, ctx)
    const model = normRef(ref)
    if (res.builtin === 'generated' || (!res.elements && res.textures.layer0)) {
      const l = [], t = []
      for (let i = 0; i < 8; i++) {
        const v = res.textures['layer' + i]
        if (!v) break
        const k = T(v)
        if (!k) continue
        l.push(k)
        const tt = tints && tints[i] ? tints[i] : null
        t.push(tt)
      }
      if (l.length) return this._flat(l, t, { model, chain: res.chain })
      return null
    }
    if (Array.isArray(res.elements) && res.elements.length) return this._cube(res, T, { model, chain: res.chain })
    if (res.builtin === 'entity' && res.textures.particle) {
      const k = T(res.textures.particle)
      if (k) return this._flat([k], [null], { model, chain: res.chain })
    }
    return null
  }

  _flat(l, t, meta) {
    const d = { s: 'f', l }
    if (t && t.some(Boolean)) d.t = t.map(x => x || 0)
    else if (l.length === 1 && tintFor(l[0]) && /(^|\/)(lily_pad)$/.test(l[0])) d.t = [tintFor(l[0])]
    Object.defineProperty(d, '_meta', { value: meta, enumerable: false })
    return d
  }

  _cube(res, T, meta) {
    let best = null, bestVol = -1
    const bounds = [16, 16, 16, 0, 0, 0]
    for (const el of res.elements) {
      if (!el || !Array.isArray(el.from) || !Array.isArray(el.to) || el.from.length !== 3 || el.to.length !== 3) continue
      const f = el.from.map(Number), t = el.to.map(Number)
      if (f.concat(t).some(isNaN)) continue
      for (let i = 0; i < 3; i++) { bounds[i] = Math.min(bounds[i], f[i], t[i]); bounds[i + 3] = Math.max(bounds[i + 3], f[i], t[i]) }
      const vol = Math.abs((t[0] - f[0]) * (t[1] - f[1]) * (t[2] - f[2]))
      if (vol > bestVol) { bestVol = vol; best = { el, from: f, to: t } }
    }
    if (!best) return null
    const pick = (names) => {
      for (const n of names) {
        const face = best.el.faces && best.el.faces[n]
        if (face && face.texture) {
          const k = T(face.texture)
          if (k) return { k, tint: face.tintindex != null ? tintFor(k) : null }
        }
      }
      return null
    }
    const top = pick(GUI_TOP_FACES), left = pick(GUI_LEFT_FACES), right = pick(GUI_RIGHT_FACES)
    const any = top || left || right
    if (!any) return null
    const faces = [(top || any), (left || any), (right || any)]
    const full = best.from.every(v => v === 0) && best.to.every(v => v === 16)
    const d = { s: full ? 'c' : 'x', f: faces.map(x => x.k) }
    if (faces.some(x => x.tint)) d.t = faces.map(x => x.tint || 0)
    const h = Math.round(Math.min(1, Math.max(0.0625, (bounds[4] - bounds[1]) / 16)) * 1000) / 1000
    if (!full && h < 1) d.h = h
    Object.defineProperty(d, '_meta', { value: meta, enumerable: false })
    return d
  }

  // ---- items/<id>.json (1.21.4+) ----
  describeItemDef(def, ctx) {
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 8) return null
      const type = String(node.type || 'model').replace('minecraft:', '')
      switch (type) {
        case 'model': {
          let tints = null
          if (Array.isArray(node.tints)) tints = node.tints.map(t => {
            if (!t || typeof t !== 'object') return null
            const v = t.value != null ? t.value : t.default
            if (typeof v === 'number') return intToHex(v)
            if (Array.isArray(v) && v.length === 3) return intToHex(((v[0] * 255) << 16) | ((v[1] * 255) << 8) | (v[2] * 255))
            return null
          })
          return node.model ? this.describeModel(node.model, ctx, tints) : null
        }
        case 'condition': return walk(node.on_false || node.on_true, depth + 1)
        case 'select': return walk(node.fallback || (node.cases && node.cases[0] && node.cases[0].model), depth + 1)
        case 'range_dispatch': return walk(node.fallback || (node.entries && node.entries[0] && node.entries[0].model), depth + 1)
        case 'composite': return walk(node.models && node.models[0], depth + 1)
        case 'special': return node.base ? this.describeModel(node.base, ctx) : null
        default: return null
      }
    }
    return walk(def && def.model, 0)
  }

  // ---- blockstates/<id>.json: chọn 1 biến thể mặc định ----
  describeBlockstate(bs, ctx) {
    const firstModel = (v) => { if (Array.isArray(v)) v = v[0]; return v && typeof v === 'object' ? v.model : null }
    let ref = null
    if (bs && bs.variants && typeof bs.variants === 'object') {
      const keys = Object.keys(bs.variants)
      const score = (k) => (k === '' || k === 'normal' ? 100 : 0) + (/axis=y|facing=north|half=bottom|type=bottom/.test(k) ? 10 : 0)
      keys.sort((a, b) => score(b) - score(a))
      if (keys.length) ref = firstModel(bs.variants[keys[0]])
    } else if (bs && Array.isArray(bs.multipart)) {
      const uncond = bs.multipart.find(p => p && !p.when && p.apply)
      ref = firstModel((uncond || bs.multipart.find(p => p && p.apply) || {}).apply)
    }
    return ref ? this.describeModel(ref, ctx) : null
  }

  // ---- không có model: đoán từ tên texture (thay cho textures/item/*.png kiểu cũ) ----
  guess(ns, id) {
    const T = (n) => (this.textures.has(ns + ':' + n) ? ns + ':' + n : null)
    const meta = { model: null, chain: [] }
    const item = T('item/' + id)
    if (item) return this._flat([item], [null], meta)
    const base = T('block/' + id), top = T('block/' + id + '_top'), side = T('block/' + id + '_side'), front = T('block/' + id + '_front')
    if (base && !top && !side && !front) {
      if (FLAT_BLOCK_RE.test(id)) return this._flat([base], [tintFor(base)], meta)
      const t = tintFor(base)
      const d = { s: 'c', f: [base, base, base] }
      if (t) d.t = [t, t, t]
      Object.defineProperty(d, '_meta', { value: meta, enumerable: false })
      return d
    }
    if (top || side || front) {
      const f = [top || base || side || front, front || side || base || top, side || base || front || top]
      const d = { s: 'c', f }
      const t = f.map(k => tintFor(k))
      if (t.some(Boolean)) d.t = t.map(x => x || 0)
      Object.defineProperty(d, '_meta', { value: meta, enumerable: false })
      return d
    }
    return null
  }
}

module.exports = { Resolver, normRef }
