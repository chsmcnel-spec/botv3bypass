// FEATURE MODULE: 05b-physics-vehicle.js
// Vật lý (trọng lực / va chạm khối) + gói tin hợp lệ khi ngồi thuyền.
// Loaded in order by ../runtime-loader.js; shares the single runtime scope.
//
// Ghi chú quan trọng:
// - Trọng lực + va chạm khối do plugin physics của mineflayer (prismarine-physics) tính, đúng theo
//   vanilla, và nó cũng tự gửi packet position/look/flying + teleport_confirm. Module này KHÔNG viết
//   lại vật lý, chỉ đảm bảo nó luôn bật, chặn gửi toạ độ rác, và bật lại sau teleport/respawn.
// - Khi ngồi trên phương tiện, client vanilla KHÔNG chạy vật lý của người chơi và KHÔNG gửi packet
//   position; nó gửi look + steer_vehicle + (nếu là người lái) vehicle_move + steer_boat. Module này
//   làm đúng như vậy (tên packet theo minecraft-data 1.20.x).

const PHYS_TICK_MS = 50                 // 20 tick/giây như client vanilla
const BOAT_REACH = 4.5                  // gần hơn reach server (6) để chắc chắn hợp lệ
const BOAT_MOUNT_TIMEOUT_MS = 3000
const VOID_Y_LIMIT = -80                // dưới mức này coi như rơi vực -> dừng gửi vật lý
const MAX_FALL_PER_TICK = 4             // vận tốc rơi tối đa vanilla ~3.92 block/tick

const _isBoatEntity = (e) => {
  if (!e) return false
  const n = String(e.name || e.displayName || '').toLowerCase()
  return n.includes('boat') || n.includes('raft')
}
const _finite = (...xs) => xs.every(v => typeof v === 'number' && Number.isFinite(v))
const _toNotchianYaw = (yaw) => {
  let d = (Math.PI + yaw) * 180 / Math.PI
  d = ((d % 360) + 360) % 360
  return d
}
const _toNotchianPitch = (pitch) => -pitch * 180 / Math.PI

function _clientReady(bot) {
  const c = bot && bot._client
  return !!(c && c.state === 'play' && !c.ended && c.socket && !c.socket.destroyed)
}
function _safeWrite(bot, name, data) {
  try {
    if (!_clientReady(bot)) return false
    bot._client.write(name, data)
    return true
  } catch (e) { return false }
}

function installPhysicsAndVehicle(state) {
  const bot = state.bot
  const username = state.username
  if (!bot || bot._physVehInstalled) return
  bot._physVehInstalled = true

  state.vehicle = { riding: false, entityId: null, mountedAt: 0, timer: null }
  state.physicsHalted = false

  const alive = () => !state.isDead && botStates[username] === state && state.bot === bot && !bot._destroyed

  // Vật lý luôn bật (trừ lúc ngồi phương tiện / khi toạ độ hỏng)
  const enablePhysics = () => { try { bot.physicsEnabled = true } catch (e) {} }
  bot.once('spawn', enablePhysics)
  bot.on('respawn', () => { state.physicsHalted = false; enablePhysics() })
  bot.on('forcedMove', () => { if (!state.vehicle.riding && !state.physicsHalted) enablePhysics() })

  // Bảo vệ: toạ độ NaN/Infinity hoặc rơi quá nhanh/vào vực -> dừng vật lý để không gửi packet sai
  let lastY = null
  bot.on('physicsTick', () => {
    try {
      const p = bot.entity && bot.entity.position
      if (!p) return
      if (!_finite(p.x, p.y, p.z) || p.y < VOID_Y_LIMIT || (lastY !== null && lastY - p.y > MAX_FALL_PER_TICK)) {
        if (!state.physicsHalted) {
          state.physicsHalted = true
          bot.physicsEnabled = false
          log(username, 'PHYSICS', `⚠️ Toạ độ bất thường (${p.x},${p.y},${p.z}) — tạm dừng vật lý, chờ server teleport`)
        }
        lastY = null
        return
      }
      lastY = p.y
    } catch (e) {}
  })

  bot.on('mount', () => {
    try {
      const v = bot.vehicle
      state.vehicle.riding = !!v
      state.vehicle.entityId = v ? v.id : null
      state.vehicle.mountedAt = Date.now()
      bot.physicsEnabled = false        // hành khách không có vật lý riêng
      lastY = null
      log(username, 'VEHICLE', `🚣 Đã ngồi lên ${v ? (v.name || 'phương tiện') : 'phương tiện'}`)
      startVehicleLoop()
    } catch (e) {}
  })
  bot.on('dismount', () => {
    state.vehicle.riding = false
    state.vehicle.entityId = null
    stopVehicleLoop()
    if (!state.physicsHalted) enablePhysics()
    lastY = null
    log(username, 'VEHICLE', `🚶 Đã xuống phương tiện`)
  })

  function stopVehicleLoop() {
    if (state.vehicle.timer) { clearInterval(state.vehicle.timer); state.vehicle.timer = null }
  }

  function startVehicleLoop() {
    stopVehicleLoop()
    state.vehicle.timer = setInterval(() => {
      if (!alive() || !bot.vehicle || !_clientReady(bot)) {
        if (!alive()) stopVehicleLoop()
        return
      }
      const v = bot.vehicle
      const me = bot.entity
      if (!me || !v || !v.position || !_finite(v.position.x, v.position.y, v.position.z)) return

      // Giữ toạ độ bot bám theo phương tiện (để dashboard / /home đọc đúng)
      try { me.position.x = v.position.x; me.position.y = v.position.y; me.position.z = v.position.z } catch (e) {}

      const yaw = _toNotchianYaw(me.yaw || 0)
      const pitch = _toNotchianPitch(me.pitch || 0)
      if (!_finite(yaw, pitch)) return

      // 1) look (không gửi position khi đang ngồi — đúng vanilla)
      _safeWrite(bot, 'look', { yaw, pitch, onGround: false })
      // 2) steer_vehicle: không bấm gì, không nhảy, không xuống
      _safeWrite(bot, 'steer_vehicle', { sideways: 0, forward: 0, jump: 0 })
      // 3) Người lái thuyền: vehicle_move + steer_boat (không chèo)
      if (_isBoatEntity(v)) {
        const vy = _toNotchianYaw(v.yaw || 0)
        const vp = _toNotchianPitch(v.pitch || 0)
        _safeWrite(bot, 'vehicle_move', { x: v.position.x, y: v.position.y, z: v.position.z, yaw: _finite(vy) ? vy : 0, pitch: _finite(vp) ? vp : 0 })
        _safeWrite(bot, 'steer_boat', { leftPaddle: false, rightPaddle: false })
      }
    }, PHYS_TICK_MS)
  }

  bot.once('end', stopVehicleLoop)
}

// ---- Điều khiển từ dashboard ----
function findNearestBoat(bot) {
  const me = bot && bot.entity
  if (!me) return null
  let best = null, bestD = Infinity
  for (const id of Object.keys(bot.entities || {})) {
    const e = bot.entities[id]
    if (!e || e === me || !e.position || !_isBoatEntity(e)) continue
    const d = e.position.distanceTo(me.position)
    if (d < bestD) { best = e; bestD = d }
  }
  return best ? { entity: best, dist: bestD } : null
}

async function boardBoat(username) {
  const s = botStates[username]
  if (!s || s.isDead || !s.bot || !s.bot.entity || !s.inCluster) return { ok: false, message: 'Bot chưa sẵn sàng' }
  const bot = s.bot
  if (bot.vehicle) return { ok: false, message: 'Bot đang ngồi phương tiện rồi' }
  const found = findNearestBoat(bot)
  if (!found) return { ok: false, message: 'Không thấy thuyền nào gần bot' }
  if (found.dist > BOAT_REACH) return { ok: false, message: `Thuyền ở xa ${found.dist.toFixed(1)} block (tối đa ${BOAT_REACH}) — đưa bot lại gần thuyền trước` }
  try {
    // Nhìn vào thuyền trước (client vanilla luôn nhắm vào entity khi tương tác) rồi gửi use_entity
    await bot.lookAt(found.entity.position.offset(0, (found.entity.height || 0.5) / 2, 0), true)
    bot.activateEntity(found.entity)
  } catch (e) { return { ok: false, message: 'Không tương tác được: ' + e.message } }
  const t0 = Date.now()
  while (Date.now() - t0 < BOAT_MOUNT_TIMEOUT_MS) {
    if (bot.vehicle) return { ok: true, message: 'Đã ngồi lên thuyền' }
    await _sleep(100)
  }
  return { ok: false, message: 'Server không cho ngồi (thuyền đầy / khu vực chặn)' }
}

function leaveVehicle(username) {
  const s = botStates[username]
  if (!s || s.isDead || !s.bot) return { ok: false, message: 'Bot chưa sẵn sàng' }
  if (!s.bot.vehicle) return { ok: false, message: 'Bot không ngồi phương tiện nào' }
  try { s.bot.dismount(); return { ok: true, message: 'Đã gửi yêu cầu xuống thuyền' } }
  catch (e) { return { ok: false, message: e.message } }
}