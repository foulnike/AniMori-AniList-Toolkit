// Учёт доступности источников: исходы запросов от api/* — интерфейсу и тосту.
// Здесь НЕТ имён хостов и суждений о блокировках: такой список устаревает за неделю.
// Модуль ядра: не знает ни про Vue, ни про DOM, подписка — обычные коллбэки.

import { BridgeHttpError } from '@/bridge'
import { Logger } from '../utils/logger'

/**
 * Состояние источника. Разница `unreachable` и `forbidden` прикладная: совет
 * про VPN уместен только в первом случае, во втором туннель скорее навредит.
 */
export type NetState = 'unknown' | 'ok' | 'unreachable' | 'forbidden' | 'serverError'

/** Запись об одном источнике. `label` задаёт сам клиент — он же виден в таблице. */
export interface NetSourceHealth {
  id: string
  label: string
  state: NetState
  /** Когда состояние стало таким. Не обновляется при повторе того же исхода. */
  since: number
  /** Когда источник отвечал в последний раз, в любом смысле. */
  lastSeenAt: number
  /** Сколько неудач подряд. Любой успех обнуляет. */
  failStreak: number
  /** Код последнего ответа, если ответ вообще был. */
  lastStatus?: number
  /** Время последнего запроса в миллисекундах, если вызывающий его замерил. */
  lastLatencyMs?: number
  /** Короткая причина для таблицы: `timeout`, `network`, `HTTP 403` и так далее. */
  lastDetail?: string
}

/**
 * Сколько неудач подряд — повод говорить с пользователем.
 * Одна ошибка ничего не значит: сеть моргнула, сервис перезагрузился.
 */
export const FAIL_STREAK_THRESHOLD = 2

/**
 * Окно, в котором недоступность разных источников считается одним событием.
 * Отказ одного — дело его виджета; два за минуту — разговор про сеть в целом.
 */
export const OUTAGE_WINDOW_MS = 60000

/** Сколько разных недоступных источников в окне считается общей бедой. */
export const OUTAGE_SOURCE_THRESHOLD = 2

const sources = new Map<string, NetSourceHealth>()

type Listener = (snapshot: NetSourceHealth[]) => void
const listeners = new Set<Listener>()

function ensure(id: string, label: string): NetSourceHealth {
  const existing = sources.get(id)
  if (existing) {
    // Метка может уточниться позже: клиент отчитался раньше проверки сети.
    if (label && existing.label !== label) existing.label = label
    return existing
  }

  const created: NetSourceHealth = {
    id,
    label: label || id,
    state: 'unknown',
    since: Date.now(),
    lastSeenAt: 0,
    failStreak: 0,
  }
  sources.set(id, created)
  return created
}

function notify(): void {
  if (listeners.size === 0) return
  const snapshot = listHealth()
  listeners.forEach((listener) => {
    try {
      listener(snapshot)
    } catch (e) {
      // Один сломанный подписчик не должен ломать учёт и остальных подписчиков.
      Logger('ERROR', 'Подписчик net-health упал', e)
    }
  })
}

/**
 * Применяет исход к записи источника.
 * В журнал пишется только СМЕНА состояния: иначе перебор карточек его забьёт.
 */
function apply(
  id: string,
  label: string,
  state: Exclude<NetState, 'unknown'>,
  detail?: string,
  status?: number,
  latencyMs?: number,
): void {
  const record = ensure(id, label)
  const previous = record.state

  record.lastSeenAt = Date.now()
  record.lastDetail = detail
  record.lastStatus = status
  record.lastLatencyMs = latencyMs

  if (state === 'ok') record.failStreak = 0
  else record.failStreak += 1

  if (previous !== state) {
    record.state = state
    record.since = Date.now()

    if (state === 'ok') {
      if (previous !== 'unknown') {
        Logger('INFO', `Сеть: ${record.label} снова отвечает`)
      }
    } else {
      Logger('WARN', `Сеть: ${record.label} — ${describeState(state)}`, {
        detail: detail ?? null,
        status: status ?? null,
      })
    }
  }

  notify()
}

/** Человеческое название состояния. Используется и в журнале, и в таблице проверки. */
export function describeState(state: NetState): string {
  switch (state) {
    case 'ok':
      return 'ответил'
    case 'unreachable':
      return 'не отвечает'
    case 'forbidden':
      return 'отклонил запрос'
    case 'serverError':
      return 'ошибка на стороне сервиса'
    default:
      return 'не проверялся'
  }
}

/**
 * Сообщает об ответе с кодом. Классификация собрана по замерам:
 *
 *   403 и 451 — сервис на связи, но не пускает; про VPN здесь говорить нельзя.
 *   5xx — чужая поломка, сеть пользователя ни при чём.
 *   404 — ОТВЕТ, то есть связь есть: живой graphql.anilist.co даёт его на GET.
 *   429 — лимит темпа, им занимается api/rate-limit.ts; успехом считать его тоже
 *   нельзя, иначе он сбросит чужой счётчик неудач.
 *   401 — истёкший токен; у него своё сообщение и своё лечение.
 *
 * Последние два случая не меняют состояние вовсе: вызов просто игнорируется.
 */
export function reportStatus(id: string, label: string, status: number, latencyMs?: number): void {
  if (status === 401 || status === 429) return

  if (status === 403 || status === 451) {
    apply(id, label, 'forbidden', `HTTP ${status}`, status, latencyMs)
    return
  }

  if (status >= 500) {
    apply(id, label, 'serverError', `HTTP ${status}`, status, latencyMs)
    return
  }

  apply(id, label, 'ok', `HTTP ${status}`, status, latencyMs)
}

/**
 * Сообщает о транспортном сбое. Отмена (`abort`) игнорируется: это наше
 * собственное поведение при SPA-навигации, а не отказ сети.
 */
export function reportError(id: string, label: string, error: unknown, latencyMs?: number): void {
  if (error instanceof BridgeHttpError) {
    if (error.kind === 'abort') return
    apply(id, label, 'unreachable', error.kind, undefined, latencyMs)
    return
  }

  // Не ошибка транспорта — значит, ответ был, а сломался разбор. Состояние не трогаем.
}

/** Явный успешный отчёт без кода ответа — для случаев вроде кэша или кадра. */
export function reportOk(id: string, label: string, latencyMs?: number): void {
  apply(id, label, 'ok', undefined, undefined, latencyMs)
}

/** Состояние одного источника или `undefined`, если о нём ещё никто не отчитывался. */
export function getHealth(id: string): NetSourceHealth | undefined {
  const record = sources.get(id)
  return record ? { ...record } : undefined
}

/** Копия всего состояния. Копия, а не ссылки: интерфейс не должен править учёт. */
export function listHealth(): NetSourceHealth[] {
  return Array.from(sources.values(), (record) => ({ ...record }))
}

/** Пора ли говорить про конкретный источник: спрашивает виджет вместо показа пустоты. */
export function isTroubled(id: string): boolean {
  const record = sources.get(id)
  if (!record) return false
  return (
    record.state !== 'ok' &&
    record.state !== 'unknown' &&
    record.failStreak >= FAIL_STREAK_THRESHOLD
  )
}

/**
 * Похоже ли на общую беду с сетью. Считаются только `unreachable`: два сервиса
 * могут не пускать по совершенно разным причинам, и VPN тут ни при чём.
 */
export function looksLikeOutage(now = Date.now()): boolean {
  let count = 0
  sources.forEach((record) => {
    if (record.state !== 'unreachable') return
    if (record.failStreak < FAIL_STREAK_THRESHOLD) return
    if (now - record.lastSeenAt > OUTAGE_WINDOW_MS) return
    count += 1
  })
  return count >= OUTAGE_SOURCE_THRESHOLD
}

/** Метки источников, из-за которых сработал `looksLikeOutage`. Для текста тоста. */
export function troubledLabels(now = Date.now()): string[] {
  const labels: string[] = []
  sources.forEach((record) => {
    if (record.state === 'ok' || record.state === 'unknown') return
    if (record.failStreak < FAIL_STREAK_THRESHOLD) return
    if (now - record.lastSeenAt > OUTAGE_WINDOW_MS) return
    labels.push(record.label)
  })
  return labels
}

/**
 * Подписка на изменения. Возвращает функцию отказа — её обязан вызвать тот,
 * кто подписался, в своём registerShutdownTask, иначе коллбэк переживёт компонент.
 */
export function subscribeNetHealth(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
