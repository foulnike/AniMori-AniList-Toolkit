// Транспорт приватных эндпоинтов Shikimori: списки из профиля пользователя.
// Отдельно от shikimori.ts: там шлюз темпа и свой 404, здесь 404 — «страниц больше нет».
// РИСК №2 из docs/DECISIONS.md решается здесь и только здесь.

import { Bridge } from '@/bridge'
import { SHIKI_DOMAINS } from '../core/constants'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'

/**
 * Списки тянутся страницами по 1000 записей, поэтому потолок выше зеркального.
 * Уходить отсюда некуда, а обрыв на середине означает неполный перенос.
 */
const TIMEOUT_MS = 20000

/** Предупреждение об анонимном доступе показывается один раз за сессию. */
let anonymousNoticeShown = false

/** Идентификатор зеркала в учёте состояния сети. Совпадает с api/shikimori.ts намеренно. */
function netId(domain: string): string {
  return `shikimori:${domain}`
}

/**
 * Уходят ли запросы без куки сессии. В приложении — всегда: запрос выполняет
 * Rust, и куки WebView ему не видны (риск 2 из docs/DECISIONS.md). Прежде здесь
 * стояло сравнение с платформой надстройки, истинное при любом её значении.
 *
 * Функция, а не константа: платформа с куками вернётся сюда одной правкой.
 */
export function isAnonymousShikiAccess(): boolean {
  return true
}

/**
 * Текст отказа в доступе. Причина всегда одна: списки читаются анонимно,
 * а скрытый профиль сервер анониму не отдаёт. Короткое «Профиль скрыт.»
 * гнало бы в настройки приватности вместо настоящей причины.
 */
export function hiddenProfileMessage(): string {
  return (
    'Профиль скрыт либо недоступен анонимно. В десктопной версии списки читаются без ' +
    'входа в аккаунт, поэтому профиль Shikimori должен быть открыт (публичен).'
  )
}

export interface ShikiUserResponse<T> {
  /** HTTP-код ответа. Разбирается вызывающим кодом: 404, 403, 429 значат разное. */
  status: number
  /** true для 200-299, как у fetch. */
  ok: boolean
  /** Разобранный JSON либо null: тело пустое, не разобралось или ответ не успешен. */
  data: T | null
}

/**
 * GET к пользовательскому эндпоинту. Код вне 2xx исключением НЕ считается: 404, 403
 * и 429 значат разное, а отклонение промиса — сбой транспорта на всех зеркалах сразу.
 * @param path Путь, начинающийся со слэша. Домен подставляется сам.
 */
export async function shikiUserGet<T>(path: string): Promise<ShikiUserResponse<T>> {
  if (!anonymousNoticeShown) {
    anonymousNoticeShown = true
    Logger(
      'WARN',
      'Shikimori: запросы к спискам уходят анонимно, куки сессии недоступны. ' +
        'Профиль должен быть открыт, иначе сервер ответит отказом.',
    )
  }

  // Куки сессии из Rust не видны, поэтому запрос уходит без них.
  const credentials = 'omit' as const
  let lastError: unknown = null

  for (const domain of SHIKI_DOMAINS) {
    const url = 'https://' + domain + path
    const label = `Shikimori (${domain})`
    const startedAt = Date.now()

    let status: number
    let ok: boolean
    let text: string

    try {
      const res = await Bridge.http.request({
        method: 'GET',
        url,
        headers: { Accept: 'application/json' },
        credentials,
        timeoutMs: TIMEOUT_MS,
      })
      status = res.status
      ok = res.ok
      text = res.text
      reportStatus(netId(domain), label, status, Date.now() - startedAt)
    } catch (e) {
      // Сюда попадает только транспорт: на следующем зеркале блокировки может не быть.
      reportError(netId(domain), label, e, Date.now() - startedAt)
      lastError = e
      Logger('WARN', 'Shikimori: домен ' + domain + ' не ответил, пробую следующее зеркало', e)
      continue
    }

    if (!ok) return { status, ok, data: null }

    try {
      return { status, ok, data: JSON.parse(text) as T }
    } catch (e) {
      // Битое тело равнозначно пустому ответу: раньше оно обрывало весь перенос.
      Logger('ERROR', 'Shikimori: не удалось разобрать ответ ' + path, e)
      return { status, ok, data: null }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Shikimori: ни одно зеркало не ответило.')
}
