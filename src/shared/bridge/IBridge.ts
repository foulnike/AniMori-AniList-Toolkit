// Контракт платформы: ЧТО умеет среда, но не КАК.
// Реализации — MonkeyBridge.ts и TauriBridge.ts, выбор между ними — index.ts.
// Исполняемого кода здесь один класс ошибки: обе реализации бросают одно и то же.
// Подсистемы: storage, http, clipboard, shell, proxyDiagnostics. Сверх этого ничего.

// ==== storage ====

/**
 * Персистентное хранилище ключ-значение. Асинхронный всегда, включая браузер:
 * приводим к общему знаменателю по худшему случаю (риск 1 из docs/DECISIONS.md).
 */
export interface IStorage {
  /** Читает значение, подставляя `defaultValue`, если ключа нет. */
  get<T>(key: string, defaultValue: T): Promise<T>
  /** Читает значение без значения по умолчанию: `undefined`, если ключа нет. */
  get<T = unknown>(key: string): Promise<T | undefined>
  /**
   * Записывает значение. К моменту разрешения промиса оно обязано быть на диске,
   * а не в отложенной записи: иначе настройки теряются при перезагрузке (дефект 4.5).
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
  /** Абсолютный адрес. Относительные пути не поддерживаются: в Tauri нет origin. */
  url: string
  headers?: Record<string, string>
  /** Тело запроса. Сериализацию выполняет вызывающий код. */
  body?: string
  /** Таймаут в миллисекундах на весь запрос. */
  timeoutMs?: number
  /**
   * Отправлять ли куки сессии. По умолчанию 'include' — так ведёт себя
   * GM_xmlhttpRequest. В Tauri запрос идёт из Rust и куки WebView не видит (риск 2).
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

/**
 * Операции над самим окном. Сюда идёт только то, что WebView не умеет сам
 * или что в десктопе отказывает без участия оболочки.
 */
export interface IShell {
  /**
   * Перезагружает страницу. Промис разрешается после отправки команды:
   * на код после await полагаться нельзя, всё важное ждём ДО вызова.
   */
  reload(): Promise<void>
  /**
   * Открывает адрес в браузере пользователя: в WebView2 target="_blank" молча
   * отбрасывается. Только http и https; внутренние переходы сюда не идут.
   */
  openExternal(url: string): Promise<void>
  /**
   * Шаг назад по истории: в окне оболочки нет ни тулбара, ни акселераторов.
   * Если идти некуда, вызов ничего не делает и ошибкой не считается.
   */
  back(): Promise<void>
  /** Шаг вперёд по истории. Всё сказанное про back() верно и здесь. */
  forward(): Promise<void>
  /**
   * Переключает полноэкранный режим окна и возвращает НОВОЕ состояние: спрашивать
   * его отдельно значило бы второй переход в оболочку на каждое нажатие.
   * В браузере всегда false: полным экраном там распоряжается сам браузер.
   */
  toggleFullscreen(): Promise<boolean>
}

// ==== proxy diagnostics ====

/**
 * Чем закончилась попытка применить прокси к окну: выключен, негоден, не ответил,
 * передан движку. `applied` не обещает, что трафик ходит.
 */
export type ProxyOutcome = 'off' | 'invalid' | 'unreachable' | 'applied'

/**
 * Как окно живёт с авторизацией у прокси. `accepted` косвенный: кода ошибки
 * в событии нет, и принятие видно лишь по отсутствию повторного запроса.
 */
export type ProxyAuth = 'none' | 'pending' | 'accepted' | 'rejected'

/** Что случилось с прокси при запуске приложения плюс живой исход авторизации. */
export interface ProxyStatus {
  outcome: ProxyOutcome
  /** Адрес вида `http://127.0.0.1:8080`. Пустая строка, если выключен или негоден. */
  server: string
  /** Задан ли логин. Сам логин и пароль сюда НЕ попадают. */
  hasCredentials: boolean
  /** Собирается на момент вызова: авторизация случается позже снимка запуска. */
  auth: ProxyAuth
}

/** Результат ручной проверки адреса, сохранённого в настройках ПРЯМО СЕЙЧАС. */
export interface ProxyProbe {
  /** Здесь `applied` читается как «адрес годен и отвечает». */
  outcome: ProxyOutcome
  server: string
  reachable: boolean
  /** Сколько миллисекунд заняло соединение. При отказе — время до отказа. */
  latencyMs: number
}

/**
 * Состояние прокси. Живёт в мосту, а не в карточке настроек: invoke по инварианту 1
 * допустим только здесь. В браузерной сборке честно отвечает `off`.
 */
export interface IProxyDiagnostics {
  /**
   * Чем закончилось применение прокси при запуске. Неизменно всё, кроме `auth`:
   * адрес движок читает один раз, а авторизация меняется по ходу сеанса.
   */
  status(): Promise<ProxyStatus>
  /**
   * Проверяет СОХРАНЁННЫЙ адрес соединением — то есть то, что заработает после
   * перезапуска, а не то, через что ходит окно сейчас.
   * Недоступный прокси — не ошибка, а результат с reachable: false.
   */
  probe(): Promise<ProxyProbe>
  /**
   * Сообщает оболочке, что страница ожила. Нужен сторожу из proxy_guard.rs.
   * Вызывать один раз, сразу как появился корень разметки. Не отклоняется.
   */
  markPageReady(): Promise<void>
}

// ==== корневой контракт ====

export interface IBridge {
  /** Идентификатор среды. Дублирует __ANIMORI_PLATFORM__, но читаем в журнале. */
  readonly platform: 'userscript' | 'tauri'
  readonly storage: IStorage
  readonly http: IHttp
  readonly clipboard: IClipboard
  readonly shell: IShell
  readonly proxyDiagnostics: IProxyDiagnostics
}
