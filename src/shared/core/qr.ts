// Свой QR-код — этап 6, вход в Google с устройства без клавиатуры.
//
// ПОЧЕМУ СВОЙ, А НЕ БИБЛИОТЕКА И НЕ ЧУЖАЯ КАРТИНКА
// В код едет адрес с одноразовым пропуском ко входу в чужой аккаунт.
// Отдать его стороннему рисовальщику картинок — значит отдать его целиком
// чужому серверу, да и в разрешения приложения пришлось бы вписать ещё
// один адрес. Сторонней библиотеки в package.json нет, и тащить её ради
// одного квадрата на одном экране незачем.
//
// ЧТО ЗДЕСЬ УМЕЮТ, А ЧЕГО НЕТ
// Ровно один вид кода: байтовый режим, уровень стойкости M, версии
// с первой по десятую. Больше не нужно: внутрь идёт короткий адрес вида
// https://www.google.com/device?user_code=ABCD-EFGH — это полсотни байт,
// а десятая версия вмещает двести тринадцать. Уровень M — середина:
// восстанавливает около пятой части потерь и не раздувает картинку.
//
// Модуль платформенно чистый и без единого импорта: ни моста, ни DOM,
// ни журнала — чистая считалка. Наружу отдаётся сетка тёмных клеток
// и, отдельно, готовая разметка SVG.
//
// Стандарт здесь ISO/IEC 18004. Самые неочевидные его места — чередование
// блоков, обход змейкой и выбор маски — подписаны по ходу.

/** Уровень стойкости M в поле сведений о формате обозначается двумя нулями. */
const LEVEL_BITS = 0b00

/** Наибольшая версия, которую здесь умеют. */
const MAX_VERSION = 10

/**
 * Устройство каждой версии на уровне M: [байт данных, байт стойкости
 * на блок, блоков в первой группе, байт в её блоке, блоков во второй,
 * байт в её блоке]. Нулевая строка — затычка: версии считают с единицы.
 *
 * Числа взяты из стандарта и сверены: байты данных равны сумме блоков,
 * а вместе со стойкостью — полной емкости версии (26, 44, 70, 100, 134,
 * 172, 196, 242, 292, 346).
 */
const PLAN: Array<[number, number, number, number, number, number]> = [
  [0, 0, 0, 0, 0, 0],
  [16, 10, 1, 16, 0, 0],
  [28, 16, 1, 28, 0, 0],
  [44, 26, 1, 44, 0, 0],
  [64, 18, 2, 32, 0, 0],
  [86, 24, 2, 43, 0, 0],
  [108, 16, 4, 27, 0, 0],
  [124, 18, 4, 31, 0, 0],
  [154, 22, 2, 38, 2, 39],
  [182, 22, 3, 36, 2, 37],
  [216, 26, 4, 43, 1, 44],
]

/**
 * Где стоят узоры выравнивания. У первой версии их нет вовсе, дальше
 * координаты берутся парами: узор ставится на каждом пересечении,
 * кроме трёх углов, где уже сидят искатели.
 */
const ALIGN: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

/** Готовый код. */
export interface QrCode {
  /** Сторона в клетках, без белого поля вокруг. */
  size: number
  /** Версия от 1 до 10: полезна для отладки и подписи. */
  version: number
  /** Тёмные клетки по строкам сверху вниз. */
  dark: boolean[][]
}

/** Исход построения. Форма как всюду в ядре: фраза вместо исключения. */
export type QrDone = { ok: true; value: QrCode } | { ok: false; problem: string }

/** Вид картинки. */
export interface QrLook {
  /** Ширина белого поля в клетках. Меньше четырёх камеры читают хуже. */
  quiet?: number
  /** Цвет тёмных клеток. */
  dark?: string
  /** Цвет поля. */
  light?: string
}

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

/**
 * Таблицы поля Галуа из 256 значений. Считаются раз при загрузке
 * модуля: они крошечные, а нужны каждому коду. Стандартный многочлен
 * 0x11d — тот же, что в QR и в Reed–Solomon вообще.
 */
function sow(): void {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x = x << 1
    if ((x & 0x100) !== 0) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

sow()

/** Умножение в поле Галуа. */
function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0

  return EXP[LOG[a] + LOG[b]]
}

/**
 * Байты восстановления для одного блока: остаток от деления на порождающий
 * многочлен. Многочлен строится тут же каждый раз: блоков в наших версиях
 * не больше пяти, и кеш был бы дороже самого счёта.
 */
function guard(block: Uint8Array, count: number): Uint8Array {
  let gen = new Uint8Array([1])
  for (let i = 0; i < count; i++) {
    const next = new Uint8Array(gen.length + 1)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]
      next[j + 1] ^= mul(gen[j], EXP[i])
    }
    gen = next
  }

  const rest = new Uint8Array(block.length + count)
  rest.set(block)
  for (let i = 0; i < block.length; i++) {
    const lead = rest[i]
    if (lead === 0) continue
    for (let j = 1; j < gen.length; j++) rest[i + j] ^= mul(gen[j], lead)
  }

  return rest.slice(block.length)
}

/**
 * Строка в байты UTF-8 своими руками, а не через TextEncoder: ядро обязано
 * работать где угодно, а разница — пятнадцать строк. Обход идёт по знакам,
 * а не по единицам UTF-16: иначе составные знаки распались бы на половинки.
 */
function utf8(text: string): Uint8Array {
  const out: number[] = []

  for (const sign of text) {
    const code = sign.codePointAt(0) ?? 0
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }

  return new Uint8Array(out)
}

/**
 * Сколько байт влезает в версию. Голова — четыре бита режима и длина:
 * восемь бит до девятой версии включительно и шестнадцать с десятой.
 */
function bytesFit(version: number): number {
  const head = version >= 10 ? 20 : 12

  return Math.floor((PLAN[version][0] * 8 - head) / 8)
}

/**
 * Байты → готовая к укладке последовательность: голова, данные, добивка,
 * блоки и их стойкость вперемежку.
 *
 * Чередование — не каприз стандарта: когда часть картинки заслонена
 * бликом или пальцем, потери размазываются по всем блокам понемногу
 * и каждый восстанавливается. Лежали бы подряд — один блок умирал бы
 * целиком, а с ним и весь код.
 */
function weave(bytes: Uint8Array, version: number): Uint8Array {
  const [dataLen, ecLen, group1, size1, group2, size2] = PLAN[version]

  const bits: number[] = []
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }

  push(0b0100, 4)
  push(bytes.length, version >= 10 ? 16 : 8)
  for (const one of bytes) push(one, 8)

  // Хвост: четыре нуля окончания, добивка до целого байта и два
  // условленных байта по очереди — так велит стандарт, чтобы пустое
  // место не выглядело однотонным пятном.
  const room = dataLen * 8
  for (let i = 0; i < 4 && bits.length < room; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const data = new Uint8Array(dataLen)
  for (let i = 0; i < bits.length; i += 8) {
    let one = 0
    for (let j = 0; j < 8; j++) one = (one << 1) | bits[i + j]
    data[i / 8] = one
  }
  for (let i = bits.length / 8, turn = 0; i < dataLen; i++, turn++) {
    data[i] = turn % 2 === 0 ? 0xec : 0x11
  }

  const blocks: Uint8Array[] = []
  const guards: Uint8Array[] = []
  let at = 0
  for (let i = 0; i < group1 + group2; i++) {
    const width = i < group1 ? size1 : size2
    const block = data.slice(at, at + width)
    at += width
    blocks.push(block)
    guards.push(guard(block, ecLen))
  }

  const out = new Uint8Array(dataLen + ecLen * blocks.length)
  let k = 0
  const widest = Math.max(size1, size2)
  for (let i = 0; i < widest; i++) {
    for (const block of blocks) if (i < block.length) out[k++] = block[i]
  }
  for (let i = 0; i < ecLen; i++) {
    for (const one of guards) out[k++] = one[i]
  }

  return out
}

/**
 * Служебные узоры: искатели с каймой, полосы синхронизации, узоры
 * выравнивания, места под сведения о формате и о версии.
 *
 * Отметка fixed нужна дважды: сюда не пишут данные и сюда не важничает
 * маска. Маска по служебным клеткам сломала бы искатели, и код перестал
 * бы находиться камерой вообще.
 */
function frame(grid: Uint8Array, fixed: Uint8Array, size: number, version: number): void {
  const set = (row: number, col: number, dark: boolean) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return
    grid[row * size + col] = dark ? 1 : 0
    fixed[row * size + col] = 1
  }

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  const eyes: Array<[number, number]> = [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ]
  for (const [row, col] of eyes) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const away = Math.max(Math.abs(dx), Math.abs(dy))
        set(row + dy, col + dx, away !== 2 && away !== 4)
      }
    }
  }

  const spots = ALIGN[version]
  for (let i = 0; i < spots.length; i++) {
    for (let j = 0; j < spots.length; j++) {
      const last = spots.length - 1
      const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)
      if (corner) continue

      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(spots[i] + dy, spots[j] + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // Места под сведения о формате занимаются сейчас, а заполняются потом:
  // в них пишется номер выбранной маски, а его ещё нет.
  for (let i = 0; i < 9; i++) {
    set(8, i, false)
    set(i, 8, false)
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false)
    set(size - 1 - i, 8, false)
  }

  // Сведения о версии появляются только с седьмой: до неё читатель
  // угадывает версию по размеру картинки.
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem

    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1
      const far = size - 11 + (i % 3)
      const near = Math.floor(i / 3)
      set(near, far, on)
      set(far, near, on)
    }
  }
}

/**
 * Укладка данных змейкой: столбцами по два справа налево, снизу вверх
 * и обратно. Шестой столбец пропускается целиком — там полоса
 * синхронизации.
 *
 * Если биты кончились раньше места, остаток остаётся светлым: так и должно
 * быть, у некоторых версий в конце нарочно остаются лишние биты.
 */
function fill(grid: Uint8Array, fixed: Uint8Array, size: number, data: Uint8Array): void {
  let at = 0

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5

    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j
        const up = ((right + 1) & 2) === 0
        const row = up ? size - 1 - step : step
        const cell = row * size + col

        if (fixed[cell] === 1) continue
        if (at >= data.length * 8) continue

        grid[cell] = (data[at >>> 3] >>> (7 - (at & 7))) & 1
        at++
      }
    }
  }
}

/** Правило маски по номеру. Столбцы — x, строки — y, как в стандарте. */
function bend(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (col + row) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (col + row) % 3 === 0
    case 4:
      return (Math.floor(col / 3) + Math.floor(row / 2)) % 2 === 0
    case 5:
      return ((col * row) % 2) + ((col * row) % 3) === 0
    case 6:
      return (((col * row) % 2) + ((col * row) % 3)) % 2 === 0
    default:
      return (((col + row) % 2) + ((col * row) % 3)) % 2 === 0
  }
}

/**
 * Накладывает маску на клетки данных. Сама себе обратна: второй вызов
 * с тем же номером возвращает всё как было — на этом держится примерка
 * всех восьми масок на одной сетке.
 */
function hide(grid: Uint8Array, fixed: Uint8Array, size: number, mask: number): void {
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = row * size + col
      if (fixed[cell] === 1) continue
      if (!bend(mask, row, col)) continue
      grid[cell] ^= 1
    }
  }
}

/** Пишет сведения о формате: уровень стойкости и номер маски, дважды. */
function format(grid: Uint8Array, fixed: Uint8Array, size: number, mask: number): void {
  const seed = (LEVEL_BITS << 3) | mask
  let rem = seed
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((seed << 10) | rem) ^ 0x5412

  const set = (row: number, col: number, on: boolean) => {
    grid[row * size + col] = on ? 1 : 0
    fixed[row * size + col] = 1
  }
  const bit = (i: number) => ((bits >>> i) & 1) === 1

  for (let i = 0; i <= 5; i++) set(i, 8, bit(i))
  set(7, 8, bit(6))
  set(8, 8, bit(7))
  set(8, 7, bit(8))
  for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i))

  for (let i = 0; i < 8; i++) set(8, size - 1 - i, bit(i))
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, bit(i))

  // Всегда тёмная клетка под левым нижним искателем.
  set(size - 8, 8, true)
}

/**
 * Штраф полосы — строки или столбца: длинные одноцветные серии
 * и узор, похожий на искатель.
 */
function lineScore(grid: Uint8Array, size: number, index: number, byRow: boolean): number {
  let score = 0
  let run = 1
  let last = -1
  let window = 0

  for (let i = 0; i < size; i++) {
    const one = byRow ? grid[index * size + i] : grid[i * size + index]

    if (one === last) {
      run++
      if (run === 5) score += 3
      else if (run > 5) score += 1
    } else {
      run = 1
      last = one
    }

    // Одиннадцать последних клеток. Узор 1:1:3:1:1 с полем сбоку
    // камера принимает за искатель и сбивается с разметки.
    window = ((window << 1) | one) & 0x7ff
    if (i >= 10 && (window === 0x5d0 || window === 0x05d)) score += 40
  }

  return score
}

/**
 * Насколько картинка неудобна камере. Ста