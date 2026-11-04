// ===================== KINGSM P MODULAR RUNTIME LOADER =====================
// Các feature file trong lib/features là những phần nguồn của cùng một runtime.
// Ghép chúng theo thứ tự để giữ nguyên state/hàm dùng chung của phiên bản gốc.
// Không require trực tiếp từng feature file.
'use strict'

const fs = require('fs')
const path = require('path')
const Module = require('module')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const FEATURE_DIR = path.join(__dirname, 'features')
const FEATURE_FILES = [
  '00-config-security.js',
  '01-proxy.js',
  '02-scheduler-autosell.js',
  '03-webhook-money.js',
  '04-reconnect-logs-chat.js',
  '05-minecraft-runtime.js',
  '05b-physics-vehicle.js',
  '06-dashboard-api.js',
  '07-discord-control.js'
]

function start() {
  const missing = FEATURE_FILES.filter(name => !fs.existsSync(path.join(FEATURE_DIR, name)))
  if (missing.length) {
    throw new Error('Thiếu feature module trong lib/features: ' + missing.join(', '))
  }

  const source = FEATURE_FILES.map(name => {
    const file = path.join(FEATURE_DIR, name)
    return `\n// ===== BEGIN ${name} =====\n` + fs.readFileSync(file, 'utf8') + `\n// ===== END ${name} =====\n`
  }).join('\n')

  // Đặt filename ảo ở thư mục gốc để __dirname và require('./secure'...) vẫn
  // tương thích với cấu trúc project cũ dù source đã chuyển vào lib/features.
  const runtimeFilename = path.join(PROJECT_ROOT, 'login.runtime.js')
  const runtimeModule = new Module(runtimeFilename, module.parent)
  runtimeModule.filename = runtimeFilename
  runtimeModule.paths = Module._nodeModulePaths(PROJECT_ROOT)
  runtimeModule._compile(source, runtimeFilename)
  return runtimeModule.exports
}

module.exports = { start }