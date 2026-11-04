'use strict'
// Zip writer tối giản (không phụ thuộc thư viện) để game client tải RP qua server.properties:
//   resource-pack=http://<vps>/rp/pack.zip   resource-pack-sha1=<sha1 trong manifest>
// Deterministic (thời gian cố định, thứ tự tên) -> cùng nội dung ra cùng sha1.
const fs = require('fs')
const fsp = fs.promises
const zlib = require('zlib')
const path = require('path')
const crypto = require('crypto')

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(buf, crc) {
  let c = (crc == null ? 0 : crc) ^ 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1 // 1980-01-01 00:00

async function buildZip(root, files, outPath, opts) {
  const maxEntries = 65000, maxBytes = 3.5 * 1024 * 1024 * 1024
  const list = files.filter(f => !f.audio)
  if (list.length > maxEntries) throw new Error('Quá nhiều file cho zip32 (' + list.length + ')')
  if (list.reduce((s, f) => s + f.size, 0) > maxBytes) throw new Error('RP quá lớn cho zip32')
  const tmp = outPath + '.tmp'
  const ws = fs.createWriteStream(tmp)
  const sha1 = crypto.createHash('sha1')
  let offset = 0
  const write = (buf) => new Promise((res, rej) => {
    sha1.update(buf); offset += buf.length
    ws.write(buf, (e) => e ? rej(e) : res())
  })
  const central = []
  let i = 0
  try {
    for (const f of list) {
      const data = await fsp.readFile(path.join(root, f.rel))
      const store = /\.(png|ogg)$/i.test(f.rel) || data.length < 64
      const body = store ? data : zlib.deflateRawSync(data, { level: 6 })
      const method = store || body.length >= data.length ? 0 : 8
      const payload = method === 0 ? data : body
      const name = Buffer.from(f.rel, 'utf8')
      const crc = crc32(data)
      const lh = Buffer.alloc(30)
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8)
      lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14)
      lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28)
      central.push({ name, crc, csize: payload.length, usize: data.length, method, offset })
      await write(lh); await write(name); await write(payload)
      if (++i % 100 === 0) await new Promise(r => setImmediate(r))
    }
    const cdStart = offset
    for (const c of central) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(c.method, 10)
      h.writeUInt16LE(DOS_TIME, 12); h.writeUInt16LE(DOS_DATE, 14); h.writeUInt32LE(c.crc, 16)
      h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.usize, 24); h.writeUInt16LE(c.name.length, 28)
      h.writeUInt32LE(c.offset, 42)
      await write(h); await write(c.name)
    }
    const cdSize = offset - cdStart
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16)
    await write(end)
    await new Promise((res, rej) => ws.end((e) => e ? rej(e) : res()))
    await fsp.rename(tmp, outPath)
    return { sha1: sha1.digest('hex'), size: offset, entries: central.length }
  } catch (e) {
    try { ws.destroy() } catch (_) {}
    try { await fsp.unlink(tmp) } catch (_) {}
    throw e
  }
}

module.exports = { buildZip, crc32 }
