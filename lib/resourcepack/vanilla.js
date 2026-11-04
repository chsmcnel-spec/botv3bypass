'use strict'
// RP thường KHÔNG chứa model "cha" của vanilla (block/cube_all, item/generated...) vì chúng nằm trong client jar.
// Bảng dưới là phiên bản rút gọn của các model cha phổ biến để resolver vẫn đi hết chuỗi parent.
const FACE_NAMES = ['down', 'up', 'north', 'south', 'west', 'east']
const fullCube = (tintindex) => ({
  from: [0, 0, 0], to: [16, 16, 16],
  faces: Object.fromEntries(FACE_NAMES.map(f => [f, Object.assign({ texture: '#' + f, cullface: f }, tintindex != null ? { tintindex } : {})]))
})
const GUI_BLOCK = { gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } }

const M = {}
const B = (name, def) => { M['minecraft:' + name] = def }

B('block/block', { display: GUI_BLOCK })
B('block/cube', { parent: 'minecraft:block/block', elements: [fullCube()] })
B('block/cube_all', { parent: 'minecraft:block/cube', textures: { particle: '#all', down: '#all', up: '#all', north: '#all', south: '#all', east: '#all', west: '#all' } })
B('block/cube_mirrored_all', { parent: 'minecraft:block/cube_all' })
B('block/leaves', { parent: 'minecraft:block/block', elements: [fullCube(0)], textures: { particle: '#all', down: '#all', up: '#all', north: '#all', south: '#all', east: '#all', west: '#all' } })
B('block/cube_column', { parent: 'minecraft:block/cube', textures: { particle: '#side', down: '#end', up: '#end', north: '#side', south: '#side', east: '#side', west: '#side' } })
B('block/cube_column_horizontal', { parent: 'minecraft:block/cube_column' })
B('block/cube_column_mirrored', { parent: 'minecraft:block/cube_column' })
B('block/cube_bottom_top', { parent: 'minecraft:block/cube', textures: { particle: '#side', down: '#bottom', up: '#top', north: '#side', south: '#side', east: '#side', west: '#side' } })
B('block/cube_top', { parent: 'minecraft:block/cube', textures: { particle: '#side', down: '#top', up: '#top', north: '#side', south: '#side', east: '#side', west: '#side' } })
B('block/orientable', { parent: 'minecraft:block/cube', textures: { particle: '#front', down: '#top', up: '#top', north: '#front', south: '#side', east: '#side', west: '#side' } })
B('block/orientable_with_bottom', { parent: 'minecraft:block/cube', textures: { particle: '#front', down: '#bottom', up: '#top', north: '#front', south: '#side', east: '#side', west: '#side' } })
B('block/cube_directional', { parent: 'minecraft:block/cube_all' })

B('item/generated', { parent: 'minecraft:builtin/generated', display: { gui: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] } } })
for (const n of ['handheld', 'handheld_rod', 'handheld_mace', 'template_spawn_egg']) B('item/' + n, { parent: 'minecraft:item/generated' })

module.exports = { VANILLA_MODELS: M }
