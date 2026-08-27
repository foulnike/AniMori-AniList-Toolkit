// Реализация IBridge поверх API менеджера юзерскриптов — единственное место с GM_*.
// Прикладной логики здесь нет: ограничитель, зеркала и повторы живут в src/api/.

import {
  BridgeHttpError,
  type HttpRequestOptions,
  type HttpResponse,
  type IBridge,
  type IClipboard,
  type IHttp,
  type IShell,
  type IStorage,
} from './IBridge'

// ==== storage ====

// GM_getValue синхронен, а контракт асинхронен. Проверка по arguments.length:
// вызов с явным undefined в дефолте отличается от вызова без дефолта.
function storageGet<T>(key: string, defaultValue: T): Promise<T>
function storageGet<T = unknown>(key: string): Promise<T | undefined>
function storageGet<T>(key: string, defaultValue?: T): Promise<T | undefined> {
  if (arguments.length >= 2) {
    return Promise.resolve(GM_getValue<T>(key, defaultValue as T))
  }
  return Promise.resolve(GM_getValue(key) as T | undefined)
}

const monkeyStorage: IStorage = {
  get: storageGet,
  set(key: string, value: unknown): Promise<void> {
    GM_setValue(key, value)
    return Promise.resolve()
  },

  flush(): Promise<void> {
    // Ждать нечего: GM_setValue завершает запись до возврата управления.
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
 * игнорируется и куки всё равно уйдут; молчать об этом контракт запрещает.
 */
function supportsAnonymous(): boolean {
  const handler = typeof GM_info === 'object' ? (GM_info?.scriptHandler ?? '') : ''
  return handler === 'Tampermonkey' || handler === 'Violentmonkey'
}

const monkeyHttp: IHttp = {
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
            // Код вне 2xx — НЕ ошибка: см. комментарий к IHttp.request.
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

const monkeyClipboard: IClipboard = {
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

const monkeyShell: IShell = {
  reload(): Promise<void> {
    // Промис разрешён только ради единого контракта: код после этой строки
    // умрёт вместе со страницей.
    location.reload()
    return Promise.resolve()
  },

  openExternal(url: string): Promise<void> {
    // Новая вкладка — штатное поведение браузера. GM_openInTab НЕ берём: потребовал
    // бы нового @grant в шапке. noopener обязателен: иначе страница получит window.opener.
    window.open(url, '_blank', 'noopener')
    return Promise.resolve()
  },
}

// ==== сборка ====

export const monkeyBridge: IBridge = {
  platform: 'userscript',
  storage: monkeyStorage,
  http: monkeyHttp,
  clipboard: monkeyClipboard,
  shell: monkeyShell,
}

// Имя platformBridge — шов для '@bridge-impl': под ним index.ts и берёт мост.
// Реализация здесь одна, но шов оставлен сознательно: он ничего не стоит.
export { monkeyBridge as platformBridge }
