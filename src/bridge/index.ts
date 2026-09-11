// Единственная дверь к API менеджера юзерскриптов: все вызовы GM_* живут здесь.
//
// Почему один файл, а не контракт с реализацией: реализация осталась одна.
// Пока рядом стоял TauriBridge, интерфейсы держали две реализации в согласии;
// с уходом десктопа они стали описанием самих себя в соседнем файле.
//
// Прикладной логики здесь нет: ограничитель, зеркала и повторы живут в src/api/.
// Ни одна возможность не вызывает GM_* напрямую: список разрешённых грантов
// обязан читаться в одном месте, иначе новый грант просочится незамеченным,
// а он стоит повторного вопроса разрешений у всех пользователей.

// ==== типы http ====

export type HttpMethod = 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE' | 'PATCH'

export interface HttpRequestOptions {
  /** По умолчанию 'GET'. */
  method?: HttpMethod
  /** Абсолютный адрес. Относительные пути не поддерживаются. */
  url: string
  headers?: Record<string, string>
  /** Тело запроса. Сериализацию выполняет вызывающий код. */
  body?: string
  /** Таймаут в миллисекундах на весь запрос. */
  timeoutMs?: number
  /**
   * Отправлять ли куки сессии. По умолчанию 'include' — так ведёт себя
   * GM_xmlhttpRequest. Режим 'omit' поддерживают не все менеджеры: см. supportsAnonymous().
   */
  credentials?: 'omit' | 'include'
}

export interface HttpResponse {
  /** HTTP-код ответа. */
  status: number
  statusText: string
  /** true для 200-299. Ровно то же, что у fetch. */
  ok: boolean
  /** Заголовки ответа. Ключи приведены к нижнему регистру. */
  headers: Record<string, string>
  /** Тело ответа текстом. Разбор JSON — на стороне вызывающего. */
  text: string
  /** Итоговый адрес после редиректов. */
  url: string
}

/** Причина транспортного сбоя. Код ответа сюда не относится. */
export type HttpErrorKind = 'network' | 'timeout' | 'abort'

/** Единый тип ошибки транспорта. По нему различает сбои core/net-health.ts. */
export class BridgeHttpError extends Error {
  readonly kind: HttpErrorKind
  readonly url: string

  constructor(kind: HttpErrorKind, url: string, message?: string) {
    super(message ?? `Bridge HTTP ${kind} error: ${url}`)
    this.name = 'BridgeHttpError'
    this.kind = kind
    this.url = url
  }
}

// ==== storage ====

// GM_getValue синхронен, а наружу хранилище асинхронное: потребители не должны
// зависеть от того, что запись успевает до возврата управления.
// Проверка по arguments.length: вызов с явным undefined в дефолте отличается
// от вызова без дефолта.
function storageGet<T>(key: string, defaultValue: T): Promise<T>
function storageGet<T = unknown>(key: string): Promise<T | undefined>
function storageGet<T>(key: string, defaultValue?: T): Promise<T | undefined> {
  if (arguments.length >= 2) {
    return Promise.resolve(GM_getValue<T>(key, defaultValue as T))
  }
  return Promise.resolve(GM_getValue(key) as T | undefined)
}

const storage = {
  get: storageGet,

  set(key: string, value: unknown): Promise<void> {
    GM_setValue(key, value)
    return Promise.resolve()
  },

  /**
   * Дожидается всех начатых записей. Ждать нечего: GM_setValue завершает
   * запись до возврата управления. Метод оставлен ради reload.ts: там он
   * выражает намерение «не уходить со страницы с незаписанной настройкой».
   */
  flush(): Promise<void> {
    return Promise.resolve()
  },
}

// ==== http ====

/**
 * Разбирает сырую строку responseHeaders в объект с ключами в нижнем регистре.
 * GM_xmlhttpRequest отдаёт их одной строкой, а клиентам нужен объект: по имени
 * читаются retry-after и остаток окна лимита.
 */
export function parseRawHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out

  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    // Пустые строки и строка статуса без двоеточия пропускаются.
    if (separator <= 0) continue

    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (!name) continue

    // Повторяющиеся заголовки склеиваем через запятую — как Headers.
    const existing = out[name]
    out[name] = existing === undefined ? value : `${existing}, ${value}`
  }

  return out
}

/** Предупреждаем об игнорируемом анонимном режиме один раз за сессию. */
let anonymousWarningShown = false

/**
 * Поддерживает ли менеджер анонимные запросы. В Greasemonkey 4 поле anonymous
 * игнорируется и куки всё равно уйдут; молчать об этом нельзя.
 */
function supportsAnonymous(): boolean {
  const handler = typeof GM_info === 'object' ? (GM_info?.scriptHandler ?? '') : ''
  return handler === 'Tampermonkey' || handler === 'Violentmonkey'
}

const http = {
  /**
   * Выполняет запрос. Код вне 2xx ИСКЛЮЧЕНИЕМ НЕ ЯВЛЯЕТСЯ: клиенты различают
   * 404, soft-block и 429 сами. Отклонение — только BridgeHttpError.
   */
  request(options: HttpRequestOptions): Promise<HttpResponse> {
    const { url, method = 'GET', headers, body, timeoutMs, credentials = 'include' } = options

    return new Promise<HttpResponse>((resolve, reject) => {
      const details: GMXhrDetails = {
        method,
        url,
        onload: (res) => {
          resolve({
            status: res.status,
            statusText: res.statusText,
            ok: res.status >= 200 && res.status < 300,
            headers: parseRawHeaders(res.responseHeaders ?? ''),
            text: res.responseText,
            url: res.finalUrl || url,
          })
        },
        onerror: () => reject(new BridgeHttpError('network', url)),
        ontimeout: () => reject(new BridgeHttpError('timeout', url)),
        onabort: () => reject(new BridgeHttpError('abort', url)),
      }

      if (headers) details.headers = headers
      if (body !== undefined) details.data = body
      if (timeoutMs !== undefined) details.timeout = timeoutMs

      if (credentials === 'omit') {
        if (supportsAnonymous()) {
          details.anonymous = true
        } else if (!anonymousWarningShown) {
          anonymousWarningShown = true
          // Логгер здесь недоступен: он читает настройки, а те ходят через мост —
          // получилась бы циклическая зависимость.
          console.warn(
            '[AniMori] Менеджер юзерскриптов не поддерживает анонимные запросы: ' +
              'credentials "omit" выполнен как "include", куки будут отправлены.',
          )
        }
      }

      GM_xmlhttpRequest(details)
    })
  },
}

// ==== clipboard ====

const clipboard = {
  async writeText(text: string): Promise<void> {
    // GM_setClipboard первый: он не требует фокуса, а navigator.clipboard падает
    // на неактивной вкладке и без жеста пользователя.
    try {
      GM_setClipboard(text)
      return
    } catch (e) {
      console.warn('[AniMori] GM_setClipboard недоступен, пробуем navigator.clipboard', e)
    }

    await navigator.clipboard.writeText(text)
  },
}

// ==== shell ====

const shell = {
  /**
   * Перезагружает страницу. На код после await полагаться нельзя:
   * вся важная работа делается ДО вызова, см. features/ui/reload.ts.
   */
  reload(): Promise<void> {
    location.reload()
    return Promise.resolve()
  },

  /**
   * Открывает адрес в новой вкладке. GM_openInTab НЕ берём: потребовал бы
   * нового @grant в шапке. noopener обязателен: иначе страница получит window.opener.
   */
  openExternal(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener')
    return Promise.resolve()
  },
}

// ==== сборка ====

/**
 * То, что скрипт вправе просить у среды, и ничего сверх этого.
 * Пополнять список разделов без нужды не стоит: каждый новый — это новое
 * право, запрошенное у пользователя.
 */
export const Bridge = {
  storage,
  http,
  clipboard,
  shell,
}
