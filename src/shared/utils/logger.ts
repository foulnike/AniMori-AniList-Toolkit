// Ядро журнала: запись, буфер в памяти и глобальные перехватчики ошибок.
//
// UI сюда не входит: ядро не должно знать о модалке, связь идёт через
// подписку registerLogSink().
//
// Буфер один и кольцевой: LOG_CAPACITY записей суммарно на все виды,
// согласованно с потолком показа в модалке журнала. В браузере
// переход между страницами обнулял массив, в оболочке окно живёт сутками.
// Вытеснение не слепое: ERROR держится, пока в буфере есть что-то ещё — иначе ошибки
// теряются ровно при обвале, который сам же заливает журнал записями API и QUEUE.
//
// Настройки асинхронны, поэтому settings.enableLogger не спрашивается на верхнем
// уровне модуля: импорты выполняются до start() в app/main.ts, там всегда лежал бы
// дефолт true и логи сессии восстанавливались бы даже при выключенном логгере.
//
// Запись в sessionStorage пакетная: синхронный JSON.stringify по сотням объектов
// на каждую запись тормозил то, что логирует.

import { settings } from '@/core/settings'

export type LogType = 'INFO' | 'WARN' | 'ERROR' | 'DB' | 'API' | 'QUEUE'

export interface LogEntry {
  id: number
  time: string
  /** URL-контекст (window.location.pathname на момент записи). */
  path: string
  type: LogType | string
  message: string
  details: unknown
  stack: string
}

/** Сколько записей всего живёт в памяти: буфер один на все виды записей. */
export const LOG_CAPACITY = 500

/** Сколько последних записей переживает переход между страницами (квота sessionStorage). */
const SESSION_KEEP = 200

/** Пауза между записями в sessionStorage. */
const FLUSH_DELAY_MS = 1000

export let scriptLogs: LogEntry[] = []

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushHooksInstalled = false

/**
 * Освобождает место под новую запись, если буфер полон.
 *
 * Сначала ищем самую старую запись НЕ типа ERROR — их и вытесняем. Поиск идёт только
 * в момент реального переполнения и обычно заканчивается на первом же элементе:
 * поток журнала — это API, DB и QUEUE, а ошибки в нём редки. Если буфер целиком состоит
 * из ошибок, вытесняется самая старая из них: расти дальше буфер не имеет права
 * ни при каких условиях.
 */
function makeRoom(): void {
  while (scriptLogs.length >= LOG_CAPACITY) {
    const victim = scriptLogs.findIndex((x) => x.type !== 'ERROR')
    scriptLogs.splice(victim >= 0 ? victim : 0, 1)
  }
}

/** Сбрасывает хвост логов в sessionStorage прямо сейчас. */
function flushSessionLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    sessionStorage.setItem('animori_logs', JSON.stringify(scriptLogs.slice(-SESSION_KEEP)))
  } catch {
    /* квота исчерпана — игнор */
  }
}

/**
 * Планирует запись. Повторные вызовы в пределах окна ничего не стоят.
 * При уходе со страницы хвост дописывается принудительно: без этого последние
 * секунды лога — ровно те, где обычно и лежит причина сбоя — терялись бы.
 */
function scheduleSessionFlush(): void {
  if (!flushHooksInstalled) {
    flushHooksInstalled = true
    window.addEventListener('pagehide', flushSessionLogs)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSessionLogs()
    })
  }
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushSessionLogs()
  }, FLUSH_DELAY_MS)
}

/**
 * Восстановление логов из sessionStorage.
 *
 * Вызывается только после загрузки настроек и только при включённом логгере.
 * sessionStorage через мост НЕ идёт: это память вкладки, а не настройки приложения,
 * и в WebView Tauri она работает штатно.
 *
 * Восстановленный хвост обрезается по вместимости: SESSION_KEEP меньше LOG_CAPACITY,
 * но полагаться на это соотношение нельзя — в хранилище может лежать запись,
 * сделанная прежней версией скрипта с другими лимитами.
 */
function restoreSessionLogs(): void {
  try {
    const savedLogs = sessionStorage.getItem('animori_logs')
    if (savedLogs) {
      const parsed = JSON.parse(savedLogs) as LogEntry[]
      scriptLogs = parsed.slice(-LOG_CAPACITY)
    }
  } catch (e) {
    // Logger может быть не готов — прямой console.warn.
    console.warn('[AniMori] Не удалось восстановить логи сессии', e)
  }
}

/** Подписчик UI: модалка получает записи, пока открыта. */
let logSink: ((entry: LogEntry) => void) | null = null

export function registerLogSink(sink: ((entry: LogEntry) => void) | null): void {
  logSink = sink
}

export function Logger(type: LogType | string, message: string, details: unknown = null): void {
  if (!settings.enableLogger) return

  let parsedDetails = details
  if (details instanceof Error) {
    parsedDetails = { name: details.name, message: details.message, stack: details.stack }
  }

  const d = new Date()
  const time = `${d.toLocaleTimeString('ru-RU', { hour12: false })}.${String(
    d.getMilliseconds(),
  ).padStart(3, '0')}`
  const path = window.location.pathname
  const stackLines = (new Error().stack ?? '').split('\n')
  const stack = stackLines.length > 2 ? stackLines.slice(2).join('\n') : ''

  const entry: LogEntry = {
    id: Date.now() + Math.random(),
    time,
    path,
    type,
    message,
    details: parsedDetails,
    stack,
  }

  makeRoom()
  scriptLogs.push(entry)

  scheduleSessionFlush()

  if (logSink) logSink(entry)
  if (type === 'ERROR') console.error(`[AniMori ERROR] ${message}`, details || '')
  else if (type === 'WARN') console.warn(`[AniMori WARN] ${message}`, details || '')
}

/**
 * Глобальные перехватчики ошибок. Ставятся из start() в app/main.ts сразу после
 * чтения настроек: импорт модуля сайд-эффектов не имеет, а до настроек
 * неизвестно, включён ли журнал вообще.
 *
 * Прежде их не звал никто, и всё, что вылетало мимо try/catch, до журнала
 * не доезжало. Отсев чужого источника снят целиком: в окне приложения
 * чужого кода нет, а путь своего бандла отсев как раз и не узнавал.
 *
 * Здесь же восстанавливаются ��аписи прошлой сессии: оба действия зависят
 * от одного флага и оба требуют уже загруженных настроек.
 */
export function installGlobalErrorHandlers(): void {
  if (!settings.enableLogger) return

  restoreSessionLogs()

  window.addEventListener('error', (e: ErrorEvent) => {
    Logger('ERROR', `Uncaught Error: ${e.message}`, {
      file: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error?.stack,
    })
  })

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    Logger(
      'ERROR',
      `Unhandled Promise Rejection: ${e.reason}`,
      typeof e.reason === 'object' ? e.reason : { reason: e.reason },
    )
  })
}

/**
 * Вызывает fn (async ок), логируя ошибки в Logger('ERROR').
 * Пример: await safeCall(() => anilistQuery(query, vars, true), 'anilistQuery/Viewer')
 */
export async function safeCall<T>(
  fn: () => T | Promise<T>,
  context: string,
  { silent = false }: { silent?: boolean } = {},
): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e)
    Logger('ERROR', `Ошибка в ${context}: ${msg}`, e)
    if (!silent) throw e
    return undefined
  }
}
