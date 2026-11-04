'use strict'
const fs = require('fs')
const path = require('path')
const { SERVE_EXT, AUDIO_EXT } = require('./constants')

// Gắn route vào app Express hiện có.
//  Public (không cần đăng nhập — client web/game tự tải):
//    GET /rp/manifest.json  /rp/version.json  /rp/item.json?id=  /rp/pack.zip  /rp/files/<đường dẫn trong RP>
//  Cần đăng nhập panel (nằm dưới /api nên auth.install đã chặn sẵn):
//    GET /api/rp/status  /api/rp/report   POST /api/rp/rescan
function install(app, rp, opts) {
  opts = opts || {}
  const express = opts.express || require('express') // feature module truyền express đang dùng
  const cors = opts.cors !== false
  const canAdmin = opts.canAdmin || (() => true)

  app.use('/rp', (req, res, next) => {
    if (cors) res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })

  app.get('/rp/version.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.json({ version: rp.state.version, status: rp.state.status, builtAt: rp.state.builtAt })
  })

  app.get('/rp/manifest.json', (req, res) => {
    res.setHeader('ETag', rp.etag)
    res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Vary', 'Accept-Encoding')
    if (req.headers['if-none-match'] === rp.etag) return res.status(304).end()
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.setHeader('Content-Encoding', 'gzip')
      return res.end(rp.manifestGz)
    }
    res.end(rp.manifestJson)
  })

  app.get('/rp/item.json', async (req, res) => {
    let id = String(req.query.id || '').toLowerCase().trim()
    if (id.startsWith('minecraft:')) id = id.slice(10)
    const it = rp.manifest.items[id]
    if (!it) return res.status(404).json({ success: false, message: 'Không có item trong RP' })
    const det = await rp.details(id)
    const textures = {}
    for (const k of (it.l || it.f)) textures[k] = rp.manifest.textures[k]
    res.setHeader('Cache-Control', 'public, max-age=60')
    res.json({ success: true, id, version: rp.state.version, icon: it, textures, detail: det })
  })

  app.get('/rp/pack.zip', (req, res) => {
    const z = rp.manifest.pack && rp.manifest.pack.zip
    if (!z || !fs.existsSync(rp.zipPath)) return res.status(404).json({ success: false, message: 'Chưa có pack.zip' })
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('X-Pack-SHA1', z.sha1)
    res.type('application/zip')
    res.sendFile(rp.zipPath)
  })

  // File gốc của RP: chỉ cho phép png/json/mcmeta/txt, tuyệt đối không phục vụ audio
  app.use('/rp/files', (req, res, next) => {
    const ext = path.extname(req.path).toLowerCase()
    if (AUDIO_EXT.has(ext) || /(^|\/)sounds(\/|\.json$)/i.test(req.path) || !SERVE_EXT.has(ext)) return res.status(404).end()
    const immutable = req.query.v && req.query.v === rp.state.version
    res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
    next()
  }, express.static(rp.root, { index: false, dotfiles: 'deny', fallthrough: false, extensions: false }))

  app.get('/api/rp/status', (req, res) => res.json(Object.assign({ success: true }, rp.status())))
  app.get('/api/rp/report', (req, res) => {
    if (!canAdmin(req)) return res.status(403).json({ success: false, message: 'Không đủ quyền' })
    res.json({ success: true, report: rp.report })
  })
  let lastRescan = 0
  app.post('/api/rp/rescan', async (req, res) => {
    if (!canAdmin(req)) return res.status(403).json({ success: false, message: 'Không đủ quyền' })
    if (Date.now() - lastRescan < 10000) return res.status(429).json({ success: false, message: 'Đợi 10 giây giữa các lần quét' })
    lastRescan = Date.now()
    const force = !!(req.body && req.body.force)
    await rp.refresh({ force, reason: 'rescan thủ công' })
    res.json(Object.assign({ success: true }, rp.status()))
  })
}

module.exports = { install }
