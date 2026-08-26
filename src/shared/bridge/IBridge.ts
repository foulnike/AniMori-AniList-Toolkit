// Контракт платформы: ЧТО умеет среда, но не КАК.
// Реализация одна — TauriBridge.ts, подставляет её сборка через index.ts.
// Исполняемого кода здесь один класс ошибки: он общий для любой реализации.
// Подсистемы: storage, files, http, anilist, clipboard, shell, proxyDiagnostics. Сверх этого ничего.

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

// ==== files ====

/**
 * Свои файлы приложения в приватном каталоге — второй экземпляр снимка на случай,
 * когда хранилище окна почистили со стороны (пункт 2.5.2).
 *
 * Имя, а не путь: каталог выбирает реализация, и общий код никак не может
 * попросить себе чужое место на диске. Набор имён ограничен оболочкой.
 */
export interface IFiles {
  /**
   * Есть ли в этой среде файлы вообще. В браузере false, и вызывающий может
   * не заводить лишних записей в журнале на каждый снимок.
   */
  readonly available: boolean
  /**
   * Читает файл целиком. Нет файла, нет файлов в среде, не читается — везде null:
   * дубль страховка, и разница между этими случаями вызывающему бесполезна.
   */
  read(name: string): Promise<string | null>
  /**
   * Пишет файл целиком и возвращает, удалось ли. Не отклоняется: запасная
   * копия не вправе ронять сохранение снимка в основное хранилище.
   */
  write(name: string, text: string): Promise<boolean>
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
   * Отправлять ли куки сессии. По умолчанию 'include', только обещание пустое:
   * запрос выполняет Rust, и куки WebView ему не видны (риск 2). Ключ оставлен
   * в контракте: платформа с куками вернёт ему смысл.
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

// ==== anilist ====

/**
 * Запросы к AniList GraphQL. Отдельно от http потому, что адрес и пропуск
 * живут внутри реализации: в десктопе пропуск в разметку не попадает вовсе.
 */
export interface IAniList {
  /**
   * Отправляет готовое тело запроса и возвращает ответ как есть: код вне 2xx
   * исключением не является, 429 и отказы разбирает клиент в api/anilist.ts.
   * Отклонение — BridgeHttpError либо обычная ошибка о невыполненном входе.
   *
   * `useAuth` — просьба подписать запрос пропуском текущего входа. Сам пропуск
   * вызывающему коду не передаётся и из него не принимается.
   */
  query(body: string, useAuth: boolean): Promise<HttpResponse>
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
  /**
   * Идентификатор среды для журнала и текстов. Со сборочным __ANIMORI_PLATFORM__
   * словари намеренно разные: там названа цель сборки ('app'), здесь —
   * оболочка окна. Ветвиться по нему негде, пока значение одно.
   */
  readonly platform: 'tauri'
  readonly storage: IStorage
  /** Пункт 2.5.2: запасная копия снимка файлом. В браузере честная заглушка. */
  readonly files: IFiles
  readonly http: IHttp
  /** Пункт 2.3: запросы к AniList. В десктопе идут из Rust вместе с пропуском. */
  readonly anilist: IAniList
  readonly clipboard: IClipboard
  readonly shell: IShell
  readonly proxyDiagnostics: IProxyDiagnostics
}
