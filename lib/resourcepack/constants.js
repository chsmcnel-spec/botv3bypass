'use strict'
// Hằng số dùng chung cho module Resource Pack.
// SCHEMA tăng lên mỗi khi đổi định dạng manifest/cache -> ép rebuild toàn bộ.
const SCHEMA = 1

const AUDIO_EXT = new Set(['.ogg', '.oga', '.wav', '.mp3', '.flac', '.m4a', '.aac', '.opus', '.mid', '.midi'])
const SERVE_EXT = new Set(['.png', '.json', '.mcmeta', '.txt'])
const ASSET_KINDS = new Set(['textures', 'models', 'blockstates', 'items', 'sounds', 'lang', 'font', 'shaders', 'particles', 'atlases', 'texts', 'equipment', 'post_effect', 'waypoint_style'])

// Màu tint (biome plains) cho texture xám của game. Chỉ áp cho các texture có tên khớp.
const TINT_RULES = [
  [/(^|_)birch_leaves$/, '#80a755'],
  [/(^|_)spruce_leaves$/, '#619961'],
  [/(^|_)(oak|jungle|acacia|dark_oak|mangrove)_leaves$/, '#77ab2f'],
  [/^vine$/, '#77ab2f'],
  [/^(grass_block_top|short_grass|grass|tall_grass_top|tall_grass_bottom|fern|large_fern_top|large_fern_bottom|sugar_cane)$/, '#91bd59'],
  [/^lily_pad$/, '#208030'],
  [/^water_(still|flow)$/, '#3f76e4']
]
function tintFor(texKey) {
  const name = String(texKey || '').split(':').pop().split('/').pop()
  for (const [re, color] of TINT_RULES) if (re.test(name)) return color
  return null
}

// Block dạng sprite phẳng (không phải khối vuông) -> khi đoán từ texture thì vẽ phẳng
const FLAT_BLOCK_RE = /(sapling|torch|door|trapdoor|sign|rail|tulip|orchid|allium|bluet|dandelion|poppy|cornflower|lily|peony|rose|lilac|fern|vine|banner|button|pressure_plate|lever|ladder|carpet|pane|bars|chain|lantern|candle|head$|skull|cake|campfire|coral$|coral_fan|mushroom$|seeds|stem|cobweb|web|string|tripwire|redstone_wire|repeater|comparator|flower_pot|anvil|bell|brewing|hopper|cauldron|fence|wall$|gate|stairs|slab|petals|sprouts|roots|kelp|seagrass|bamboo|cactus|sugar_cane|scaffolding|frame)/
// Texture phụ của block (không phải id item thật) -> không tự sinh entry từ texture
const BLOCK_TEX_SUFFIX_RE = /_(top|side|bottom|front|back|end|overlay|inner|outer|dust|stage\d+|\d+|on|off|lit|still|flow|particle|north|south|east|west|up|down|left|right|bottom_left|top_left|active|inactive)$/

// Mặt nhìn thấy trong icon GUI của game (rotation [30,225,0]) — suy ra từ hình học + icon lò nung
// (mặt trước/north nằm bên TRÁI). Đổi ở đây nếu thấy lệch so với game.
const GUI_LEFT_FACES = ['north', 'south', 'east', 'west']
const GUI_RIGHT_FACES = ['west', 'east', 'south', 'north']
const GUI_TOP_FACES = ['up', 'down']

module.exports = { SCHEMA, AUDIO_EXT, SERVE_EXT, ASSET_KINDS, tintFor, FLAT_BLOCK_RE, BLOCK_TEX_SUFFIX_RE, GUI_LEFT_FACES, GUI_RIGHT_FACES, GUI_TOP_FACES }
