// Что просмотр помнит между запусками: где остановились и что выбрали.
//
// Почему не поле в core/settings: настройку человек ставит руками и ждёт
// от неё постоянства, а метка просмотра пишется сама всю серию. В общем
// ключе одна неудачная запись уносила бы заодно и настройки.
//
// Почему одна запись на всё, а не ключ на серию: у хранилища каждое
// обращение идёт через мост, и полсотни ключей одного тайтла вылились бы
// в полсотни вызовов на один открытый плеер.
//
// Что сюда не попадает: громкость и скорость. Их меняют под одну серию
// и под одну комнату, и вернувшаяся через неделю двойная скорость читается
// поломкой, а не заботой.
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

/** Ключ хранилища. Всё просмотренное лежит в нём одним объектом. */
const STORE_KEY = 'am_watch_marks'

/** Сколько ждать перед записью: серия идёт долго, спешить некуда. */
const WRITE_DELAY_MS = 4000

/** Сколько серий помним. Дальше вытесняются самые давние. */
const MARK_LIMIT = 600

/** Сколько тайтлов помнят выбор озвучки и серии. */
const PICK_LIMIT = 200

/** Меньше этого за просмотр не считаем: заставка — не место остановки. */
const MIN_SEC = 15

/**
 * Хвост серии считается досмотренным. Без этого отступа «продолжить» возвращало
 * бы на титры той же серии вместо следующей.
 */
const TAIL_SEC = 90

/** Что помним про одну серию. */
export interface WatchMark {
  /** Секунда остановки. */
  at: number
  /** Длина серии по самому кадру; 0 — источник её так и не назвал. */
  full: number
  /** Когда записали: по этому полю вытесняются давние метки. */
  when: number
}

/** Что человек выбрал у тайтла в прошлый раз. */
export interface WatchPick {
  voiceKey: string
  episode: number
  height: number
  when: number
}

interface Keep {
  marks: Record<string, WatchMark>
  picks: Record<string, WatchPick>
}

const keep: Keep = { marks: {}, picks: {} }

/** Чтение одно на весь запуск: второй плеер берёт уже прочитанное. */
let reading: Promise<void> | null = null

let writeTimer = 0

function readMarks(raw: unknown): Record<string, WatchMark> {
  const out: Record<string, WatchMark> = {}
  if (typeof raw !== 'object' || raw === null) return out

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue

    const row = value as Record<string, unknown>
    const at = typeof row.at === 'number' ? row.at : -1
    if (at < 0) continue

    out[key] = {
      at,
      full: typeof row.full === 'number' ? row.full : 0,
      when: typeof row.when === 'number' ? row.when : 0,
    }
  }

  return out
}

function readPicks(raw: unknown): Record<string, WatchPick> {
  const out: Record<string, WatchPick> = {}
  if (typeof raw !== 'object' || raw === null) return out

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue

    const row = value as Record<string, unknown>
    const voiceKey = typeof row.voiceKey === 'string' ? row.voiceKey : ''
    if (voiceKey === '') continue

    out[key] = {
      voiceKey,
      episode: typeof row.episode === 'number' ? row.episode : 0,
      height: typeof row.height === 'number' ? row.height : 0,
      when: typeof row.when === 'number' ? row.when : 0,
    }
  }

  return out
}

async function read(): Promise<void> {
  try {
    const raw = await Bridge.storage.get<unknown>(STORE_KEY, null)
    if (typeof raw !== 'object' || raw === null) return

    const box = raw as Record<string, unknown>
    Object.assign(keep.marks, readMarks(box.marks))
    Object.assign(keep.picks, readPicks(box.picks))
  } catch (e) {
    // Без меток плеер работает, просто начинает серию с нуля.
    Logger('WARN', 'Просмотр: метки не прочитались', e)
  }
}

/**
 * Готовность меток. Ждать её обязан тот, кто собирается читать: само чтение
 * синхронное, но до первого ответа хранилища оно честно вернёт пустоту.
 */
export function whenWatchReady(): Promise<void> {
  reading ??= read()
  return reading
}

async function write(): Promise<void> {
  try {
    await Bridge.storage.set(STORE_KEY, { marks: keep.marks, picks: keep.picks })
  } catch (e) {
    Logger('WARN', 'Просмотр: метки не записались', e)
  }
}

/** Откладывает запись. Повторный зов срок не продлевает: иначе идущая серия
 * откладывала бы её вечно и на диск не попало бы ничего. */
function schedule(): void {
  if (writeTimer !== 0) return

  writeTimer = window.setTimeout(() => {
    writeTimer = 0
    void write()
  }, WRITE_DELAY_MS)
}

/** Записать немедля: уход с экрана отложенной записи не дождётся. */
export function flushWatchKeep(): void {
  if (writeTimer !== 0) {
    window.clearTimeout(writeTimer)
    writeTimer = 0
  }

  void write()
}

/** Вытесняет давние записи: список не должен расти вечно. */
function trim(rows: Record<string, { when: number }>, limit: number): void {
  const keys = Object.keys(rows)
  if (keys.length <= limit) return

  const old = keys
    .sort((a, b) => (rows[b]?.when ?? 0) - (rows[a]?.when ?? 0))
    .slice(limit)

  for (const key of old) delete rows[key]
}

/** Ключ места остановки: у каждой озвучки свой тайминг и свои врезки. */
export function spotKey(mediaId: number, voiceKey: string, episode: number): string {
  return `${mediaId}|${voiceKey}|${episode}`
}

/** Секунда, с которой продолжать. Ноль — смотреть с начала. */
export function peekSpot(key: string): number {
  const mark = keep.marks[key]
  if (mark === undefined) return 0
  if (mark.full > 0 && mark.at >= mark.full - TAIL_SEC) return 0

  return mark.at
}

/** Доля просмотренного от 0 до 1. Без известной длины доли нет. */
export function peekShare(key: string): number {
  const mark = keep.marks[key]
  if (mark === undefined || mark.full <= 0) return 0

  return Math.min(1, Math.max(0, mark.at / mark.full))
}

/** Запоминает место остановки. Первые секунды не считаются за просмотр. */
export function rememberSpot(key: string, seconds: number, full: number): void {
  if (key === '') return

  if (seconds < MIN_SEC) {
    forgetSpot(key)
    return
  }

  keep.marks[key] = {
    at: Math.floor(seconds),
    full: full > 0 ? Math.floor(full) : 0,
    when: Date.now(),
  }

  trim(keep.marks, MARK_LIMIT)
  schedule()
}

export function forgetSpot(key: string): void {
  if (keep.marks[key] === undefined) return

  delete keep.marks[key]
  schedule()
}

/** Что смотрели у этого тайтла в прошлый раз. */
export function peekPick(mediaId: number): WatchPick | null {
  return keep.picks[String(mediaId)] ?? null
}

export function rememberPick(
  mediaId: number,
  voiceKey: string,
  episode: number,
  height: number,
): void {
  if (mediaId === 0 || voiceKey === '') return

  keep.picks[String(mediaId)] = { voiceKey, episode, height, when: Date.now() }
  trim(keep.picks, PICK_LIMIT)
  schedule()
}
