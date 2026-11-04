// Entry point KingSMP.
// Toàn bộ tính năng đã được chuyển sang lib/features/.
// Phần kết nối Mineflayer, login và quản lý vòng đời bot nằm trong
// lib/features/05-minecraft-runtime.js; file này chỉ khởi chạy runtime.
'use strict'

require('./lib/runtime-loader').start()
