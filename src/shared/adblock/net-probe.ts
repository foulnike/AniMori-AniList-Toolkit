// Разведка сетевых источников: кто и куда ходит внутри кадра плеера.
//
// Инструмент сопровождения десктопной сборки, живёт в проекте насовсем вместе
// с NET_PROBE_SCRIPT из src-tauri/src/lib.rs: список рекламных адресов
// в src-tauri/src/adblock.rs — снимок на дату, а рекламные сетки меняют домены.
// Без разведчика обновлять этот список нечем, правила пришлось бы писать наугад.
//
// В юзерскриптную сборку модуль не попадает вовсе: вместо него подставляются заглушки
// из impl.noop.ts (псевдопуть '@adblock-impl' в vite.config.ts). Улов там применять
// нечем — сетевой половины блокировщика в браузере нет и быть не может, — а горячие
// клавиши отбирали бы у браузера Ctrl+Shift+S и Ctrl+Shift+A прямо на anilist.co.
//
// Зачем. Оверлейная реклама появляется внутри чужого iframe, в который наш код не
// имеет права заглянуть. Чтобы блокировать точечно (а не резать наугад и ломать плеер),
// нужен список реальных адресов. Скрипт-разведчик из оболочки стоит во всех вложенных
// кадрах и шлёт сюда сводку; этот модуль её копит, показывает в логгере и отдаёт
// текстом в буфер обмена.
//
// Два ограничения, без которых отчёт тонет в мусоре: сам AniList тянет рекламу
// через полторы сотни бирж, и кадру плеера в улове места не остаётся. Поэтому
// разведчик молчит, пока охота не начата вручную (Ctrl+Shift+S, старт обнуляет
// прошлый улов), а главный кадр не собирается вообще — ни здесь, ни в скрипте
// оболочки: рекламу самого сайта режет CSS-блокировщик.

import { Bridge } from '@/bridge'
import { Logger } from '../../utils/logger'

/** Ключ сводки. Сознательно не пересекается с kodik_player_api из media/player.ts. */
const PROBE_KEY = '__animoriNetProbe'

/** Ключ команды «начать/прекратить сбор», уходит вниз по кадрам. */
const ARM_KEY = '__animoriNetProbeArm'

/** Потолок на случай сетки, которая генерит новый поддомен на каждый запрос. */
const MAX_ENTRIES = 600

/** Ctrl+Shift+S — начать или закончить охоту. */
const HOTKEY_HUNT = 'KeyS'

/** Ctrl+Shift+A — выгрузить отчёт в буфер обмена. */
const HOTKEY_REPORT = 'KeyA'

/**
 * Как часто повторяется команда «собирай».
 *
 * Повтор обязателен: кадр рекламы рождается уже после начала охоты, а команда,
 * отправленная до его появления, до него не долетит. Раз в две секунды достаточно,
 * чтобы поймать кадр в первые мгновения жизни, и слишком редко, чтобы это чувствовалось.
 */
const ARM_INTERVAL_MS = 2000

/** Ограничитель обхода дерева кадров: реклама вкладывается вглубь, но не бесконечно. */
const MAX_FRAME_DEPTH = 6

interface ProbeItem {
  origin: string
  kind: string
  count: number
  sample: string
}

interface ProbeEntry extends ProbeItem {
  /** Адрес кадра, из которого ушёл запрос. */
  frame: string
  /** Когда источник увидели впервые — помогает сопоставить список с моментом показа рекламы. */
  firstSeen: string
}

const entries = new Map<string, ProbeEntry>()
let installed = false
let hunting = false
let armTimer: ReturnType<typeof setInterval> | null = null

/** Адрес кадра без параметров: в них ездят токены и одноразовые ключи. */
function shortFrame(raw: string): string {
  try {
    const u = new URL(raw)
    return u.origin + u.pathname
  } catch {
    return raw
  }
}

function isProbeMessage(data: unknown): data is { frame?: unknown; items?: unknown } {
  return typeof data === 'object' && data !== null && PROBE_KEY in (data as object)
}

/**
 * Рассылает команду всем вложенным кадрам, включая вложенные во вложенные.
 *
 * Обойти дерево можно даже через границу доменов: длина списка кадров и сами кадры
 * доступны всегда, недоступно только их содержимое. Само сообщение — единственный
 * легальный способ достучаться до чужого кадра.
 */
function broadcast(win: Window, value: number, depth: number): void {
  if (depth > MAX_FRAME_DEPTH) return

  let count = 0
  try {
    count = win.length
  } catch {
    return
  }

  for (let i = 0; i < count; i++) {
    let child: Window | null = null
    try {
      child = win[i] as Window
    } catch {
      continue
    }
    if (!child) continue

    try {
      child.postMessage({ [ARM_KEY]: value }, '*')
    } catch {
      /* кадр мог исчезнуть между обходом и отправкой */
    }
    broadcast(child, value, depth + 1)
  }
}

function takeItem(frame: string, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return

  const item = raw as Partial<ProbeItem>
  if (typeof item.origin !== 'string' || typeof item.sample !== 'string') return

  const kind = item.kind === 'open' ? 'open' : 'res'
  const key = `${frame}|${kind}|${item.origin}`
  const known = entries.get(key)

  if (known) {
    known.count = typeof item.count === 'number' ? item.count : known.count
    return
  }

  if (entries.size >= MAX_ENTRIES) return

  entries.set(key, {
    origin: item.origin,
    kind,
    count: typeof item.count === 'number' ? item.count : 1,
    sample: item.sample.slice(0, 300),
    frame,
    firstSeen: new Date().toLocaleTimeString('ru-RU', { hour12: false }),
  })

  // Тип записи обычный INFO, а не собственный: логгер умеет фильтровать только
  // известные ему типы, и записи с выдуманным типом было невозможно отобрать
  // в модалке среди сотен строк.
  //
  // Пишем только первое появление источника: видео едет сотнями сегментов в минуту
  // и вытеснило бы из журнала всё остальное.
  Logger('INFO', `Разведка: новый источник ${item.origin}`, {
    кадр: frame,
    вид: kind === 'open' ? 'попытка открыть окно' : 'запрос',
    пример: item.sample.slice(0, 300),
  })
}

function onMessage(event: MessageEvent): void {
  if (!hunting) return
  if (!isProbeMessage(event.data)) return

  const data = event.data
  const frame = shortFrame(typeof data.frame === 'string' ? data.frame : String(event.origin))
  if (!Array.isArray(data.items)) return

  for (const item of data.items) takeItem(frame, item)
}

/** Начало охоты: чистый лист и команда всем кадрам собирать. */
export function startNetProbeHunt(): void {
  entries.clear()
  hunting = true

  broadcast(window, 1, 0)
  if (!armTimer) armTimer = setInterval(() => broadcast(window, 1, 0), ARM_INTERVAL_MS)

  Logger('INFO', 'Разведка: охота начата, прошлый улов очищен (Ctrl+Shift+S — стоп)')
}

/** Конец охоты: кадры перестают собирать, улов остаётся до следующего старта. */
export function stopNetProbeHunt(): void {
  hunting = false

  if (armTimer) {
    clearInterval(armTimer)
    armTimer = null
  }
  broadcast(window, 0, 0)

  Logger('INFO', `Разведка: охота закончена, источников поймано ${entries.size}`)
}

/** Идёт ли сбор прямо сейчас. */
export function isNetProbeHunting(): boolean {
  return hunting
}

/**
 * Готовый к отправке текст отчёта. Группировка по кадрам: строки из кадра
 * плеера и строки с самого сайта путать нельзя — блокировать будем только первые.
 */
export function buildNetProbeReport(): string {
  if (entries.size === 0) {
    return 'Разведка: улов пуст. Охота начинается по Ctrl+Shift+S, до этого сбор не идёт.'
  }

  const byFrame = new Map<string, ProbeEntry[]>()
  for (const entry of entries.values()) {
    const list = byFrame.get(entry.frame)
    if (list) list.push(entry)
    else byFrame.set(entry.frame, [entry])
  }

  const lines: string[] = [
    `AniMori: разведка сетевых источников, ${new Date().toLocaleString('ru-RU')}`,
    `Всего источников: ${entries.size}${hunting ? ' (охота идёт)' : ''}`,
    '',
  ]

  for (const [frame, list] of byFrame) {
    lines.push(`Кадр: ${frame}`)
    list.sort((a, b) => b.count - a.count)
    for (const entry of list) {
      const mark = entry.kind === 'open' ? ' [окно]' : ''
      lines.push(`  ${entry.origin}${mark} — ${entry.count} шт., с ${entry.firstSeen}`)
      lines.push(`    пример: ${entry.sample}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** Сколько источников уже поймано. */
export function getNetProbeCount(): number {
  return entries.size
}

/** Выгрузка отчёта в буфер обмена. */
export async function copyNetProbeReport(): Promise<void> {
  const report = buildNetProbeReport()
  try {
    await Bridge.clipboard.writeText(report)
    Logger('INFO', `Разведка: отчёт скопирован в буфер обмена (источников: ${entries.size})`)
  } catch (e) {
    // Буфер мог быть недоступен — отчёт всё равно остаётся в журнале целиком,
    // откуда его можно скопировать руками.
    Logger('ERROR', 'Разведка: не удалось записать в буфер обмена', e)
  }
  Logger('INFO', 'Разведка: полный отчёт', { отчёт: report })
}

function onKeyDown(e: KeyboardEvent): void {
  if (!e.ctrlKey || !e.shiftKey || e.altKey) return

  if (e.code === HOTKEY_HUNT) {
    e.preventDefault()
    if (hunting) stopNetProbeHunt()
    else startNetProbeHunt()
    return
  }

  if (e.code === HOTKEY_REPORT) {
    e.preventDefault()
    void copyNetProbeReport()
  }
}

/**
 * Запуск. Слушатели ставятся сразу, но сбор не идёт: разведчики в кадрах молчат,
 * пока не придёт команда. Простой стоит два слушателя и пустую Map.
 *
 * Настройкой модуль сознательно НЕ управляется: это инструмент сопровождения
 * десктопной сборки, а не функция продукта, и тумблер в панели настроек ему не нужен.
 *
 * Проверка платформы — страховка. Штатно юзерскриптная сборка этот файл вообще
 * не включает (алиас '@adblock-impl' ведёт на impl.noop.ts), но прямой импорт
 * в обход алиаса поставил бы в браузере два слушателя, один из которых отбирает
 * у него Ctrl+Shift+S и Ctrl+Shift+A через preventDefault.
 */
export function initNetProbe(): void {
  if (Bridge.platform !== 'tauri') return
  if (installed) return
  installed = true

  window.addEventListener('message', onMessage)
  window.addEventListener('keydown', onKeyDown)

  Logger(
    'INFO',
    'Разведка сетевых источников готова: Ctrl+Shift+S — старт/стоп охоты, Ctrl+Shift+A — отчёт в буфер обмена',
  )
}

/** Остановка — для полного разбора приложения. */
export function destroyNetProbe(): void {
  if (!installed) return
  installed = false

  if (armTimer) {
    clearInterval(armTimer)
    armTimer = null
  }
  hunting = false

  window.removeEventListener('message', onMessage)
  window.removeEventListener('keydown', onKeyDown)
}
