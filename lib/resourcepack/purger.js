'use strict'
const fsp = require('fs').promises
const path = require('path')

// Xoá VĨNH VIỄN file audio + sounds.json trong RP, dọn thư mục rỗng, bỏ khoá "sounds" trong pack.mcmeta.
async function purgeAudio(root, files, log) {
  const res = { files: 0, bytes: 0, errors: 0, mcmetaFixed: false }
  const rootAbs = path.resolve(root)
  const dirs = new Set()
  for (const f of files) {
    if (!f.audio) continue
    const abs = path.resolve(rootAbs, f.rel)
    if (!abs.startsWith(rootAbs + path.sep)) continue // an toàn: không bao giờ xoá ngoài root
    try {
      await fsp.unlink(abs)
      res.files++; res.bytes += f.size
      dirs.add(path.dirname(abs))
    } catch (e) { res.errors++; log && log('warn', 'Không xoá được ' + f.rel + ': ' + e.message) }
  }
  // dọn thư mục rỗng từ trong ra ngoài (dừng ở root)
  const sorted = [...dirs].sort((a, b) => b.length - a.length)
  for (let d of sorted) {
    while (d.startsWith(rootAbs + path.sep)) {
      try { await fsp.rmdir(d) } catch (e) { break } // ENOTEMPTY -> dừng
      d = path.dirname(d)
    }
  }
  // pack.mcmeta: bỏ entry sounds nếu có
  try {
    const p = path.join(rootAbs, 'pack.mcmeta')
    const txt = (await fsp.readFile(p, 'utf8')).replace(/^\uFEFF/, '')
    const j = JSON.parse(txt)
    if (j && typeof j === 'object' && 'sounds' in j) {
      delete j.sounds
      const tmp = p + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify(j, null, 2), 'utf8')
      await fsp.rename(tmp, p)
      res.mcmetaFixed = true
    }
  } catch (e) { /* không có / hỏng pack.mcmeta: builder sẽ báo */ }
  return res
}

module.exports = { purgeAudio }
