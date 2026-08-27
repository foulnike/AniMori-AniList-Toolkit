// Контракт платформы: ЧТО умеет среда, но не КАК.
// Реализация одна — MonkeyBridge.ts, точка входа — index.ts.
// Исполняемого кода здесь один класс ошибки.
// Подсистемы: storage, http, clipboard, shell. Сверх этого ничего.

// ==== storage ====

/**
 * Персистентное хранилище ключ-значение. Асинхронное, хотя GM_setValue синхронен:
 * общий знаменатель по худшему случаю, чтобы вызывающий код не гадал.
 */
export interface IStorage {
  /** Читает значение, подставляя `defaultValue`, если ключа нет. */
  get<T>(key: string, defaultValue: T): Promise<T>
  /** Читает значение без значения по умолчанию: `undefined`, если ключа нет. */
  get<T = unknown>(key: string): Promise<T | undefined>
  /**
   * Записывает значение. К моменту разрешения промиса оно обязано быть записано,
   * а не отложено: иначе настройки теряются при перезагрузке.
   */
  set(key: string, value: unknown): Promise<void>
  /**
   * Дожидается всех записей, начатых до вызова: set() почти никто не ждёт,
   * а перезагрузка страницы обгоняет их. Не отклоняется.
   */
  flush(): Promise<void>
}

// ==== http ====

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
   * GM_xmlhttpRequest. Режим 'omit' поддерживают не все менеджеры: см. MonkeyBridge.
   */
  credentials?: 'omit' | 'include'
}

export interface HttpResponse {
  /** HTTP-код ответа. */
  status: number
  statusText: string
  /** true для 200-299. Ровно то же, что у fetch. */
  ok: boolean
  /** Заголовки ответа. Ключи приведены к нижнему регистру обеими реализациями. */
  headers: Record<string, string>
  /** Тело ответа текстом. Разбор JSON — на стороне вызывающего. */
  text: string
  /** Итоговый адрес после редиректов. */
  url: string
}

/** Причина транспортного сбоя. Код ответа сюда не относится. */
export type HttpErrorKind = 'network' | 'timeout' | 'abort'

/** Единый тип ошибки транспорта для всех платформ. */
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

export interface IHttp {
  /**
   * Выполняет запрос. Код вне 2xx ИСКЛЮЧЕНИЕМ НЕ ЯВЛЯЕТСЯ: клиенты различают
   * 404, soft-block и 429 сами. Отклонение — только BridgeHttpError.
   * Невыполнимый режим credentials реализация обязана записать в журнал.
   */
  request(options: HttpRequestOptions): Promise<HttpResponse>
}

// ==== clipboard ====

export interface IClipboard {
  /** Кладёт текст в буфер обмена. */
  writeText(text: string): Promise<void>
}

// ==== shell ====

/** Операции над самим окном: перезагрузка страницы и внешняя ссылка. */
export interface IShell {
  /**
   * Перезагружает страницу. Промис разрешается после отправки команды:
   * на код после await полагаться нельзя, всё важное ждём ДО вызова.
   */
  reload(): Promise<void>
  /**
   * Открывает адрес в новой вкладке. Только http и https; внутренние переходы
   * сюда не идут.
   */
  openExternal(url: string): Promise<void>
}

// ==== корневой контракт ====

export interface IBridge {
  /** Идентификатор среды. Дублирует __ANIMORI_PLATFORM__, но читаем в журнале. */
  readonly platform: 'userscript'
  readonly storage: IStorage
  readonly http: IHttp
  readonly clipboard: IClipboard
  readonly shell: IShell
}
