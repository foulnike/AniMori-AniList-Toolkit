// Реактивное состояние LoggerModal: буфер записей, фильтр, поиск, группировка.
// Ядро логгера (utils/logger.ts) о UI не знает.
// Буфер ограничен MAX_UI_LOGS: в DOM записей накапливалось до шести тысяч.

import { computed, ref, shallowRef } from 'vue'
import { type LogEntry, scriptLogs } from '@/utils/logger'

export const FILTERS = ['ALL', 'INFO', 'WARN', 'API', 'DB', 'QUEUE', 'ERROR'] as const
export type LogFilter = (typeof FILTERS)[number]

/** Типы, которые склеиваются в группы при filter === 'ALL' и пустом поиске. */
export const GROUPABLE = new Set<string>(['API', 'DB', 'QUEUE'])

/** Кольцевой буфер UI: не более MAX_UI_LOGS записей. */
export const MAX_UI_LOGS = 500

export const isLoggerOpen = ref(false)
export const activeFilter = ref<string>('ALL')
export const searchQuery = ref('')

/** Реактивный буфер записей для компонента. */
export const logEntries = shallowRef<LogEntry[]>([])

/** Копирует scriptLogs в буфер (вызывается при открытии модалки). */
export function syncLogEntries(): void {
  logEntries.value = scriptLogs.slice(-MAX_UI_LOGS)
}

/** Добавляет запись в буфер (вызывается из registerLogSink). */
export function pushLogEntry(entry: LogEntry): void {
  const arr = logEntries.value.slice()
  arr.push(entry)
  if (arr.length > MAX_UI_LOGS) arr.splice(0, arr.length - MAX_UI_LOGS)
  logEntries.value = arr
}

/** Очищает буфер и ядро (кнопка «Очистить»). */
export function clearLogEntries(): void {
  scriptLogs.length = 0
  try {
    sessionStorage.removeItem('animori_logs')
  } catch {
    /* квота */
  }
  logEntries.value = []
}

export interface LogGroup {
  kind: 'group'
  type: string
  time: string
  entries: LogEntry[]
}

export interface LogSingle {
  kind: 'single'
  entry: LogEntry
}

export type DisplayItem = LogSingle | LogGroup

/**
 * Фильтрованные и сгруппированные записи.
 * Группировка — только при activeFilter === 'ALL' и пустом searchQuery.
 */
export const displayItems = computed<DisplayItem[]>(() => {
  const q = searchQuery.value.toLowerCase()
  const f = activeFilter.value

  const filtered = logEntries.value.filter((entry) => {
    if (f !== 'ALL' && f !== entry.type) return false
    if (!q) return true
    let detStr = ''
    try {
      detStr = JSON.stringify(entry.details ?? {}).toLowerCase()
    } catch {
      /* циклическая структура */
    }
    return (
      entry.message.toLowerCase().includes(q) ||
      entry.path.toLowerCase().includes(q) ||
      detStr.includes(q)
    )
  })

  if (f !== 'ALL' || q) {
    return filtered.map<DisplayItem>((entry) => ({ kind: 'single', entry }))
  }

  // В группу склеиваются только соседи подряд: порядок записей важнее плотности.
  const result: DisplayItem[] = []
  for (const entry of filtered) {
    if (!GROUPABLE.has(String(entry.type))) {
      result.push({ kind: 'single', entry })
      continue
    }
    const last = result[result.length - 1]
    if (last && last.kind === 'group' && last.type === entry.type) {
      last.entries.push(entry)
    } else if (last && last.kind === 'single' && last.entry.type === entry.type) {
      result[result.length - 1] = {
        kind: 'group',
        type: entry.type,
        time: entry.time,
        entries: [last.entry, entry],
      }
    } else {
      result.push({ kind: 'single', entry })
    }
  }
  return result
})
