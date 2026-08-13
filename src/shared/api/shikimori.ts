// REST-клиент Shikimori: публичные карточки тайтлов с перебором зеркал.
// Трактовка кодов и порядок зеркал живут здесь, а не в мосте: мост знает только про HTTP.
// Куки не шлём: карточкам они не нужны, а 'include' уже давал HTTP 400 из-за размера заголовка.

import { Bridge } from '@/bridge'
import { SHIKI_DOMAINS } from '../core/constants'
import { describeState, getHealth, isTroubled, reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import { MAX_RATE_RETRIES, RateLimitError, shikiLimiter } from './rate-limit'

/** Штрафная пауза после 429. */
const RATE_PAUSE_MS = 5000
/** Таймаут одного зеркала: дольше ждать нет смысла, лучше уйти на следующее. */
const MIRROR_TIMEOUT_MS = 5000

/**
 * Зеркало, ответившее данными последним. Пробуется первым на остаток сеанса.
 * В хранилище не пишется: доступность зависит от сети вокруг, а туннель включают и выключают.
 */
let preferredDomain: string | null = null

/**
 * Имя источника для учёта доступности конкретного зеркала.
 * Имя собирается здесь, а не в net-health: тот модуль по замыслу не знает адресов.
 */
function netId(domain: string): string {
  return `shikimori:${domain}`
}

/**
 * Порядок перебора зеркал для одного запроса: предпочтённый адрес переезжает в начало.
 * Исключать отпавшие нельзя: тайтл, удалённый на одном зеркале, жив на другом.
 */
function mirrorOrder(): string[] {
  const preferred = preferredDomain
  if (!preferred || !SHIKI_DOMAINS.includes(preferred)) return [...SHIKI_DOMAINS]
  return [preferred, ...SHIKI_DOMAINS.filter((d) => d !== preferred)]
}

/**
 * Причина, по которой Shikimori сейчас бесполезен, или null, если жалоб нет.
 * Сводится по И, а не по ИЛИ: пока отвечает хотя бы одно зеркало, данные будут.
 */
export function shikimoriTrouble(): string | null {
  let detail: string | null = null

  for (const domain of SHIKI_DOMAINS) {
    const id = netId(domain)
    if (!isTroubled(id)) return null
    if (detail === null) {
      const state = getHealth(id)?.state
      if (state) detail = describeState(state)
    }
  }

  return detail
}

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

/**
 * Активна ли сейчас пауза по лимиту Shikimori.
 * Очередь перевода проверяет это перед каждой пачкой.
 */
export function isShikimoriRateLimited(): boolean {
  return shikiLimiter.isPaused()
}

/** Ставит паузу вручную (например, 429 увидел поиск персон). */
export function pauseShikimori(ms: number): void {
  shikiLimiter.pause(ms)
}

export interface ShikiResponse<T = unknown> {
  /** null означает "не найдено" либо полный сбой всех зеркал. */
  data: T | null
  /** Домен зеркала, ответившего успешно. */
  domain: string | null
}

/**
 * GET к Shikimori REST с перебором зеркал и повтором при 429.
 * @param path Путь вида `/api/animes/123`, без домена.
 * @param attempt Номер попытки после 429, считая с нуля. Служебный параметр рекурсии.
 */
export async function fetchShiki<T = unknown>(
  path: string,
  attempt = 0,
): Promise<ShikiResponse<T>> {
  Logger('API', `Запрос к Shikimori API: ${path}`)
  let lastNotFound: ShikiResponse<T> | null = null
  let mirrorFailures = 0

  for (const domain of mirrorOrder()) {
    // Замер свой на каждое зеркало и включает ожидание слота: важно время очереди.
    const startedAt = Date.now()

    try {
      // Слот берём перед каждой отправкой: зеркала делят один бюджет, а не имеют по своему.
      await shikiLimiter.acquireSlot()

      const r = await Bridge.http.request({
        method: 'GET',
        url: mirrorUrl(domain, path),
        timeoutMs: MIRROR_TIMEOUT_MS,
        credentials: 'omit',
      })

      // Отчёт до разбора кодов: net-health игнорирует 429, а 404 трактует как «связь есть».
      reportStatus(netId(domain), `Shikimori (${domain})`, r.status, Date.now() - startedAt)

      if (r.status === 429) {
        // Паузу ставим всегда: она притормозит и поиск персон, и очередь перевода.
        shikiLimiter.pause(RATE_PAUSE_MS)

        if (attempt + 1 >= MAX_RATE_RETRIES) {
          Logger('ERROR', `Shikimori: лимит 429 не отпустил, запрос отменён: ${path}`, {
            domain,
            attempts: attempt + 1,
          })
          throw new RateLimitError('Shikimori', path)
        }

        Logger(
          'WARN',
          `Shikimori 429 (${domain}): пауза ${RATE_PAUSE_MS}мс, ` +
            `повтор ${attempt + 2}/${MAX_RATE_RETRIES} — ${path}`,
        )
        // Повтор пойдёт через шлюз и сам дождётся конца паузы.
        return fetchShiki<T>(path, attempt + 1)
      }

      // 404 — возможно удалён по РКН, пробуем следующее зеркало (например .rip).
      // Предпочтённым такое зеркало не становится: связь есть, а данные пришли не оттуда.
      if (r.status === 404) {
        lastNotFound = { data: null, domain }
        continue
      }

      if (r.status !== 200) {
        throw new Error(`Shikimori HTTP ${r.status}`)
      }

      // Отметка ставится до разбора JSON: битое тело — беда ответа, а не адреса.
      if (preferredDomain !== domain) {
        preferredDomain = domain
        Logger('API', `Shikimori: рабочее зеркало на этот сеанс — ${domain}`)
      }

      return { data: JSON.parse(r.text) as T, domain }
    } catch (e) {
      // Исчерпание повторов по 429 — не сбой зеркала: бюджет у них общий.
      if (e instanceof RateLimitError) throw e

      // Сеть, таймаут, неизвестный код или битый JSON — следующее зеркало ещё может ответить.
      mirrorFailures++

      // Отметка снимается сразу: иначе после отключения туннеля запросы стучались бы в мёртвый адрес.
      if (preferredDomain === domain) {
        preferredDomain = null
        Logger('WARN', `Shikimori: зеркало ${domain} больше не предпочтительное`)
      }

      // reportError учитывает только транспорт и таймаут; ответ со статусом уже учтён выше.
      reportError(netId(domain), `Shikimori (${domain})`, e, Date.now() - startedAt)
      Logger('WARN', `Shikimori: зеркало ${domain} не ответило по ${path}`, e)
    }
  }

  if (lastNotFound) {
    // Для вызывающего это штатный исход, но в логе он должен быть виден: перевод не появится.
    Logger('WARN', `Shikimori: данных нет ни на одном зеркале (404): ${path}`)
    return lastNotFound
  }

  Logger('ERROR', `Все зеркала Shikimori недоступны для ${path}`, { mirrorFailures })
  throw new Error(`Все зеркала Shikimori недоступны для ${path}`)
}
