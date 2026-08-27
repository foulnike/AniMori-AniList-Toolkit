// Ручной прогон по адресам скрипта с записью итога в core/net-health.ts.
// Идентификаторы источников заданы литералами и обязаны совпадать с клиентами.
// Новый адрес добавляем только тот, до которого дотягивается @connect из шапки.

import { Bridge } from '@/bridge'
import { anime365Limiter, animeThemesLimiter, shikiLimiter } from '../../api/rate-limit'
import { ANIME365_DOMAINS, DICT_URL, SHIKI_DOMAINS } from '../../core/constants'
import { reportError, reportStatus } from '../../core/net-health'
import { Logger } from '../../utils/logger'

/** Предел ожидания одного адреса. Дольше держать пользователя незачем. */
const PROBE_TIMEOUT_MS = 8000

/** Минимальный интервал между прогонами: проверка бьёт по чужим API. */
const MIN_INTERVAL_MS = 30000

/**
 * Адреса, которые остаются в списках зеркал, но вручную не проверяются.
 * Их отказ ожидаем и в отчёте был бы только шумом.
 */
const PROBE_SKIP_DOMAINS = ['anime365.ru']

/**
 * Токен Kodik, выданный владельцу проекта по запросу.
 * Тот же, что в features/media/player.ts (там не экспортирован).
 */
const KODIK_TOKEN = '16f20d024a6fa20700b389c44d9ab159'

type LimiterKey = 'shiki' | 'anime365' | 'animethemes'

interface NetProbe {
  /** Совпадает с идентификатором источника в соответствующем клиенте. */
  id: string
  label: string
  url: string
  method: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  credentials: 'omit' | 'include'
  limiter?: LimiterKey
}

/** Строка отчёта для интерфейса. */
export interface NetCheckRow {
  id: string
  label: string
  /** HTTP-код или 0, если ответа не было вовсе. */
  status: number
  latencyMs: number
  ok: boolean
  detail: string
}

function buildProbes(): NetProbe[] {
  const probes: NetProbe[] = [
    {
      id: 'anilist:graphql',
      label: 'AniList API',
      url: 'https://graphql.anilist.co',
      method: 'POST',
      // Самый дешёвый валидный запрос: GET здесь всегда 404, поэтому только POST.
      body: JSON.stringify({ query: 'query{Media(id:1){id}}' }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Куки AniList к API прикладывать нельзя: с ними приходит 403.
      credentials: 'omit',
    },
  ]

  for (const domain of SHIKI_DOMAINS) {
    if (PROBE_SKIP_DOMAINS.includes(domain)) continue
    probes.push({
      id: 'shikimori:' + domain,
      label: 'Shikimori (' + domain + ')',
      url: 'https://' + domain + '/api/animes/20',
      method: 'GET',
      credentials: 'omit',
      limiter: 'shiki',
    })
  }

  for (const domain of ANIME365_DOMAINS) {
    if (PROBE_SKIP_DOMAINS.includes(domain)) continue
    probes.push({
      id: 'anime365:' + domain,
      label: 'anime365 (' + domain + ')',
      url: 'https://' + domain + '/api/series?limit=1',
      method: 'GET',
      credentials: 'omit',
      limiter: 'anime365',
    })
  }

  // Адрес видео v.animethemes.moe не проверяется: файлы тем мы не тянем.
  probes.push(
    {
      id: 'animethemes',
      label: 'AnimeThemes',
      // Квадратные скобки в имени параметра обязательно в percent-encoding.
      url: 'https://api.animethemes.moe/anime?page%5Bsize%5D=1',
      method: 'GET',
      credentials: 'omit',
      limiter: 'animethemes',
    },
    {
      id: 'kodik:api',
      label: 'Kodik API',
      url: 'https://kodik-api.com/search?token=' + KODIK_TOKEN + '&shikimori_id=20',
      method: 'GET',
      credentials: 'omit',
    },
    {
      id: 'dictionary',
      label: 'Словарь (GitHub)',
      url: DICT_URL,
      method: 'GET',
      credentials: 'omit',
    },
  )

  return probes
}

async function acquire(limiter: LimiterKey | undefined): Promise<void> {
  if (limiter === 'shiki') return shikiLimiter.acquireSlot()
  if (limiter === 'anime365') return anime365Limiter.acquireSlot()
  if (limiter === 'animethemes') return animeThemesLimiter.acquireSlot()
}

/** Человеческая расшифровка кода ответа для строки отчёта. */
function describeStatus(status: number): string {
  if (status >= 200 && status < 400) return 'отвечает'
  // 404 у graphql.anilist.co — нормальный ответ живого сервиса.
  if (status === 404) return 'отвечает, адрес пустой'
  if (status === 401) return 'нужна авторизация'
  if (status === 403 || status === 451) return 'не пускает'
  if (status === 429) return 'лимит запросов'
  if (status >= 500) return 'сбой на стороне сервиса'
  return 'неожиданный ответ'
}

/**
 * Короткая причина провала без адреса; полный текст ошибки пишет net-health.
 * Вид ошибки берётся через kind: тип ошибки моста живёт в слое bridge.
 */
function describeFailure(error: unknown): string {
  const kind = (error as { kind?: string } | null | undefined)?.kind
  if (kind === 'timeout') return 'не ответил за ' + String(PROBE_TIMEOUT_MS / 1000) + ' с'
  if (kind === 'abort') return 'запрос прерван'
  if (kind === 'network') return 'соединение не установлено'
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 48 ? message.slice(0, 45) + '…' : message
}

function isGoodStatus(status: number): boolean {
  return (status >= 200 && status < 400) || status === 404 || status === 401 || status === 429
}

let lastRunAt = 0
let running = false

/** Сколько миллисекунд осталось до следующего разрешённого прогона. */
export function netCheckCooldownRemaining(now = Date.now()): number {
  const left = lastRunAt + MIN_INTERVAL_MS - now
  return left > 0 ? left : 0
}

export function canRunNetCheck(now = Date.now()): boolean {
  return !running && netCheckCooldownRemaining(now) === 0
}

export function isNetCheckRunning(): boolean {
  return running
}

/**
 * Прогоняет проверку по всем адресам, которыми пользуется скрипт.
 * onRow вызывается после каждой строки, чтобы интерфейс заполнялся по ходу дела.
 */
export async function runNetCheck(onRow?: (row: NetCheckRow) => void): Promise<NetCheckRow[]> {
  if (running) return []
  running = true
  lastRunAt = Date.now()

  const rows: NetCheckRow[] = []

  try {
    for (const probe of buildProbes()) {
      await acquire(probe.limiter)

      // Отсчёт только после слота: ожидание очереди — не задержка сети.
      const startedAt = Date.now()
      let row: NetCheckRow

      try {
        const res = await Bridge.http.request({
          method: probe.method,
          url: probe.url,
          headers: probe.headers,
          body: probe.body,
          credentials: probe.credentials,
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        const latencyMs = Date.now() - startedAt
        reportStatus(probe.id, probe.label, res.status, latencyMs)
        row = {
          id: probe.id,
          label: probe.label,
          status: res.status,
          latencyMs,
          ok: isGoodStatus(res.status),
          detail: describeStatus(res.status),
        }
      } catch (e) {
        const latencyMs = Date.now() - startedAt
        reportError(probe.id, probe.label, e, latencyMs)
        row = {
          id: probe.id,
          label: probe.label,
          status: 0,
          latencyMs,
          ok: false,
          detail: describeFailure(e),
        }
      }

      rows.push(row)
      if (onRow) onRow(row)
    }

    const bad = rows.filter((r) => !r.ok).map((r) => r.label)
    Logger(
      bad.length > 0 ? 'WARN' : 'INFO',
      bad.length > 0
        ? 'Проверка сети: не отвечают — ' + bad.join(', ')
        : 'Проверка сети: все источники отвечают',
      { checked: rows.length },
    )
  } finally {
    running = false
    lastRunAt = Date.now()
  }

  return rows
}
