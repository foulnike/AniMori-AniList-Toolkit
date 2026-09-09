// Клиент AniList GraphQL: держатель общей паузы по лимиту и разбора ответов.
// Тормоз живёт здесь, а не в очереди: только клиент видит все запросы к AniList сразу.
// Сам запрос собирает мост (пункт 2.3): в десктопе пропуск в разметку не попадает.
//
// ОТСТУП ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК
// Пауза и глубина отступа лежат в хранилище. Прежде они жили только в памяти,
// и это было ровно то поведение, из-за которого вежливый клиент превращается
// в назойливого: программа получала «API выключен», отступала на четверть
// часа, человек закрывал окно, открывал снова — и первым же делом в закрытую
// дверь уходил новый залп запросов. Теперь запуск сначала смотрит, не сам ли
// он назначил себе тишину минуту назад.

import { Bridge, BridgeHttpError, type HttpResponse } from '@/bridge'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import { anilistLimiter, MAX_RATE_RETRIES } from './rate-limit'

/** Идентификатор и ярлык источника в учёте состояния сети. */
export const NET_SOURCE_ANILIST = 'anilist:graphql'
export const NET_LABEL_ANILIST = 'AniList API'

/** Пауза по умолчанию, если сервер не прислал retry-after. */
const DEFAULT_RETRY_MS = 5000

/**
 * Первая пауза после отказа сервера и потолок роста: каждый следующий отказ удваивает её.
 * Жёсткое значение не годится обоим случаям: минутной аварии и отключению API на часы.
 */
const SERVER_FAIL_PAUSE_MS = 30000
const SERVER_FAIL_MAX_PAUSE_MS = 900000

/**
 * Порог ожидания внутри запроса: короткую паузу проще переждать на месте.
 * Длинную нельзя: обещание, висящее пятнадцать минут, выглядит зависанием.
 */
const MAX_INLINE_WAIT_MS = 10000

/** Ключ хранилища для токена. Имя сохранено из монолита ради совместимости. */
const TOKEN_KEY = 'AL_TOKEN'

/**
 * Ключи хранилища для отступа: до какого времени молчим и насколько глубоко
 * уже отступили. Два числа, а не одна запись: они меняются по отдельности
 * и читаются по отдельности, а разбирать половинчатую запись после сбоя
 * записи — лишняя работа на ровном месте.
 */
const PAUSE_KEY = 'AL_PAUSE_UNTIL'
const STREAK_KEY = 'AL_FAIL_STREAK'

/** Unix-время, до которого запросы к AniList приостановлены. */
let alRateLimitPause = 0

/** Сколько отказов сервера подряд. Любой успешный ответ обнуляет. */
let serverFailStreak = 0

/** Копия токена в памяти: заполняется loadAlToken() до первого запроса. */
let alTokenCache = ''

/**
 * Есть ли пропуск у самой оболочки. В десктопе токен лежит в Rust и разметке
 * не виден совсем, так что без этого флажка клиент считал бы, что входа нет.
 */
let shellSigned = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Активна ли сейчас пауза по лимиту AniList.
 * Нужно очереди перевода: она не начинает новую пачку, пока сервер держит паузу.
 */
export function isAniListRateLimited(): boolean {
  return Date.now() < alRateLimitPause
}

/**
 * Сколько миллисекунд осталось до конца паузы.
 * Очередь засыпает ровно до её конца, а не просыпается каждую секунду ради записи в журнал.
 */
export function anilistPauseRemaining(): number {
  return Math.max(0, alRateLimitPause - Date.now())
}

/** Число из хранилища. Чужая запись могла оказаться строкой или мусором. */
function numberFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value

  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }

  return 0
}

/**
 * Пишет текущий отступ в хранилище. Никогда не отклоняется: запись — удобство
 * следующего запуска, а не условие работы этого. Пишется всегда пара целиком,
 * потому что порознь они бессмысленны: пауза без глубины начнёт следующую
 * аварию с тридцати секунд, глубина без паузы отступит там, где идти можно.
 */
function rememberBackOff(): void {
  void Bridge.storage.set(PAUSE_KEY, alRateLimitPause).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_PAUSE_UNTIL', e)
  })
  void Bridge.storage.set(STREAK_KEY, serverFailStreak).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_FAIL_STREAK', e)
  })
}

/**
 * Восстанавливает отступ после запуска программы.
 *
 * Если названное время ещё не прошло, пауза встаёт снова — вместе с глубиной
 * отступа, чтобы следующий отказ удвоил уже накопленную паузу, а не начал
 * с тридцати секунд. Если прошло — забываем и то и другое: дверь могла
 * открыться, и проверить это стоит одним запросом, а не десятком.
 *
 * Восстановленная пауза обрезается потолком роста: часы в системе переводят,
 * и запись «молчать до» из далёкого будущего заперла бы программу навсегда.
 */
export async function restoreAniListPause(): Promise<void> {
  try {
    const [storedPause, storedStreak] = await Promise.all([
      Bridge.storage.get<unknown>(PAUSE_KEY, 0),
      Bridge.storage.get<unknown>(STREAK_KEY, 0),
    ])

    const until = numberFrom(storedPause)
    const remaining = until - Date.now()

    if (remaining <= 0) {
      // Запись есть, но срок вышел: чистим, чтобы следующий запуск не читал старьё.
      if (until !== 0 || numberFrom(storedStreak) !== 0) {
        alRateLimitPause = 0
        serverFailStreak = 0
        rememberBackOff()
      }
      return
    }

    const capped = Math.min(remaining, SERVER_FAIL_MAX_PAUSE_MS)
    serverFailStreak = Math.max(0, Math.floor(numberFrom(storedStreak)))
    alRateLimitPause = Date.now() + capped
    anilistLimiter.pause(capped)

    Logger(
      'INFO',
      `AniList: отступ восстановлен, молчим ещё ${Math.round(capped / 1000)}с ` +
        `(отказов подряд до перезапуска: ${serverFailStreak})`,
    )
  } catch (e) {
    // Без восстановления программа работает как прежде: просто менее вежливо.
    Logger('ERROR', 'Ошибка чтения отступа AniList', e)
  }
}

/** Ставит паузу вручную. Существующая более долгая пауза не укорачивается. */
export function pauseAniList(ms: number): void {
  alRateLimitPause = Math.max(alRateLimitPause, Date.now() + ms)
  anilistLimiter.pause(ms)
  rememberBackOff()
}

export interface GraphQLResponse<T = unknown> {
  data?: T
  errors?: unknown
}

/**
 * Готовит клиент к работе: читает токен в память и восстанавливает отступ,
 * если прошлый запуск его назначил. Вызывается один раз на старте, до первого
 * запроса. Ошибка чтения не роняет запуск: без токена работают все публичные
 * запросы, а без записи отступа клиент просто вежлив меньше обычного.
 */
export async function loadAlToken(): Promise<void> {
  try {
    const stored = await Bridge.storage.get<unknown>(TOKEN_KEY, '')
    alTokenCache = typeof stored === 'string' ? stored : ''
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения AL_TOKEN', e)
    alTokenCache = ''
  }

  await restoreAniListPause()
}

/** Сохраняет токен: сначала в память, потом в хранилище. Никогда не отклоняется. */
export function setAlToken(token: string): void {
  alTokenCache = token
  void Bridge.storage.set(TOKEN_KEY, token).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_TOKEN', e)
  })
}

/**
 * Токен AniList из настроек: его вписывают руками на экране настроек.
 * Второго источника нет: чужой сессии у своего окна не бывает.
 */
export function getAlToken(): string | null {
  return alTokenCache || null
}

/**
 * Сообщает клиенту, есть ли пропуск у оболочки. Зовёт единственное место,
 * которое знает про вызовы Rust — src/app/auth/session.ts.
 *
 * Сам токен сюда не передаётся сознательно: пропуск в разметке не должен
 * появляться вообще, а для выбора между подписанным и публичным запросом
 * достаточно знать сам факт.
 */
export function setShellSigned(value: boolean): void {
  if (shellSigned === value) return

  shellSigned = value
  Logger('INFO', `AniList: пропуск в оболочке ${value ? 'есть' : 'снят'}`)
}

/**
 * Есть ли чем подписать запрос. Главный источник — пропуск оболочки;
 * токен из настроек остаётся вторым для тех, кто вписал его руками.
 *
 * Спрашивают те, кому без подписи идти в сеть вовсе незачем: список
 * и очередь правок.
 */
export function canSignAniList(): boolean {
  return shellSigned || getAlToken() !== null
}

/**
 * Значение заголовка в любом регистре имени.
 * Мост в Rust имена понижает, поэтому обращение по точному имени не годится.
 */
function header(headers: Record<string, string>, name: string): string {
  const direct = headers[name]
  if (direct !== undefined) return direct

  const found = Object.keys(headers).find((key) => key.toLowerCase() === name)
  return found ? (headers[found] ?? '') : ''
}

/** Целое число из заголовка или NaN: сервер присылает их не в каждом ответе. */
function headerNumber(headers: Record<string, string>, name: string): number {
  const raw = header(headers, name)
  return raw ? parseInt(raw, 10) : NaN
}

/**
 * Заголовки, по которым разбирают отказ. 403 у AniList двусмыслен: так отвечал
 * и выключенный API, и защита перед сервером, и запрет по стране.
 *
 * cf-ray и cf-mitigated выдают ответ самой защиты, retry-after — временный
 * запрет с известным сроком, а живой остаток окна лимита говорит, что дело
 * вовсе не в частоте запросов.
 */
const FAILURE_HEADERS: readonly string[] = [
  'cf-ray',
  'cf-mitigated',
  'cf-cache-status',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'server',
]

/**
 * Выписка пришедших заголовков отказа. Отсутствующие не перечисляются:
 * строка «cf-ray: нет» не сообщает ничего, а вот пустая выписка при 403
 * сообщает: отказал не Cloudflare, а само приложение сервера.
 */
function failureDetails(headers: Record<string, string>): Record<string, string> {
  const details: Record<string, string> = {}

  for (const name of FAILURE_HEADERS) {
    const value = header(headers, name)
    if (value !== '') details[name] = value
  }

  return details
}

/**
 * Когда сбрасывается окно лимита, в миллисекундах Unix-времени.
 *
 * Заголовок приходит в двух видах: Unix-время в секундах и «сколько секунд
 * осталось». Прежде читался только первый, и второй превращался в срок
 * пятидесятилетней давности — то есть в «ждать не нужно» ровно тогда,
 * когда ждать и было нужно. Число меньше миллиарда Unix-временем быть
 * не может (тот перевалил миллиард ещё в 2001 году), значит это остаток.
 */
function readResetAt(headers: Record<string, string>): number {
  const reset = headerNumber(headers, 'x-ratelimit-reset')
  if (!Number.isFinite(reset) || reset <= 0) return NaN

  return reset > 1e9 ? reset * 1000 : Date.now() + reset * 1000
}

/**
 * Учит ограничитель по заголовкам ответа: потолок, остаток окна и время сброса.
 * Так возврат штатных 90 после техработ не требует правки и выпуска сборок.
 *
 * Остаток важнее потолка. Потолок говорит, сколько запросов есть у окна
 * вообще; остаток — сколько их есть у нас сейчас, с учётом уже потраченного
 * этой же минутой или другим запуском программы с того же адреса. Темп
 * по остатку растягивает оставшееся ровно до сброса вместо того, чтобы
 * истратить всё залпом и упереться в 429 на середине работы.
 */
function learnRateHeaders(headers: Record<string, string>): void {
  const limit = headerNumber(headers, 'x-ratelimit-limit')
  if (Number.isFinite(limit) && limit > 0) anilistLimiter.applyCeiling(limit)

  const remaining = headerNumber(headers, 'x-ratelimit-remaining')
  if (!Number.isFinite(remaining)) return

  const resetAt = readResetAt(headers)

  if (remaining > 0) {
    if (Number.isFinite(resetAt)) anilistLimiter.applyRemaining(remaining, resetAt)
    return
  }

  // Окно выбрано до конца: ждём сброса, не дожидаясь 429.
  const untilReset = Number.isFinite(resetAt) ? resetAt - Date.now() : NaN
  const wait = Number.isFinite(untilReset) && untilReset > 0 ? untilReset : DEFAULT_RETRY_MS
  anilistLimiter.pause(Math.min(wait + 500, 60000))
}

/**
 * Сколько ждать после 429.
 *
 * Заголовок retry-after приходит в двух видах: числом секунд и датой по HTTP.
 * Разбирались только секунды, а дата превращалась в NaN и молча подменялась
 * дефолтом — то есть сервер называл срок, а мы шли на своих пяти секундах,
 * раньше, чем нас позвали. Именно так вежливый клиент и превращается
 * в источник лишних запросов при аварии.
 */
function readRetryAfter(headers: Record<string, string>): number {
  const raw = header(headers, 'retry-after').trim()
  if (raw === '') return DEFAULT_RETRY_MS

  // Вид «секунды». Number, а не parseInt: «120abc» — это не срок, а мусор,
  // и принимать его за две минуты хуже, чем не понять вовсе.
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000

  // Вид «дата»: срок считается от неё, а не от текущего мгновения.
  const until = Date.parse(raw)
  if (Number.isFinite(until)) {
    const wait = until - Date.now()
    // Названный срок уже прошёл: идти можно, но не в тот же миг — часы
    // у нас и у сервера расходятся, а второй 429 обойдётся дороже паузы.
    return wait > 0 ? wait : DEFAULT_RETRY_MS
  }

  return DEFAULT_RETRY_MS
}

/**
 * Отказ ли это со стороны сервера, после которого надо отступить.
 * 403 включён сознательно: именно им AniList отвечал, когда выключал API целиком.
 */
function isServerFailure(status: number): boolean {
  return status === 403 || status === 408 || status >= 500
}

/**
 * Ставит растущую паузу после отказа сервера и возвращает её длину.
 * Журналится только вход в отступ: при лежачем API каждый отказ вытеснял из журнала всё.
 */
function backOffAfterServerFailure(status: number): number {
  const wasIdle = !isAniListRateLimited()

  serverFailStreak++
  const pause = Math.min(
    SERVER_FAIL_PAUSE_MS * Math.pow(2, serverFailStreak - 1),
    SERVER_FAIL_MAX_PAUSE_MS,
  )
  pauseAniList(pause)

  if (wasIdle) {
    Logger(
      'ERROR',
      `AniList отвечает ${status}: запросы приостановлены на ${Math.round(pause / 1000)}с ` +
        `(отказов подряд: ${serverFailStreak})`,
    )
  }

  return pause
}

/**
 * GraphQL-запрос к AniList с паузой после 429 и ограниченным числом повторов.
 * @param useAuth Подписывать ли запрос пропуском; сам пропуск подставляет мост.
 *   Без пропуска просьба понижается до публичного запроса: работа без входа
 *   важнее полей, которые сервер отдаёт только своему хозяину.
 * @param attempt Служебный счётчик повторов после 429. Снаружи не передаётся.
 */
export async function anilistQuery<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  useAuth = false,
  attempt = 0,
): Promise<GraphQLResponse<T>> {
  const remaining = anilistPauseRemaining()
  if (remaining > 0) {
    // Длинную паузу не высиживаем внутри вызова — см. MAX_INLINE_WAIT_MS.
    if (remaining > MAX_INLINE_WAIT_MS) {
      throw new Error(`AniList недоступен, повтор через ${Math.ceil(remaining / 1000)}с`)
    }
    await sleep(remaining + Math.floor(Math.random() * 500))
  }

  // Подписать нечем: мост на такую просьбу отказывает целиком, и запрос,
  // которому пропуск был нужен лишь для своей закладки, не ушёл бы вовсе.
  const signed = useAuth && canSignAniList()
  if (useAuth && !signed) {
    Logger('API', 'AniList: вход не выполнен, запрос идёт без подписи')
  }

  Logger('API', 'GraphQL запрос (AniList)', {
    query: query.substring(0, 100) + '...',
    variables,
    useAuth: signed,
  })

  // Разрешение на отправку: сам темп знает только ограничитель.
  await anilistLimiter.acquireSlot()

  const startTime = performance.now()
  const startedAt = Date.now()

  let res: HttpResponse
  try {
    // Адрес, заголовки и пропуск — забота моста: в десктопе запрос идёт из Rust.
    res = await Bridge.anilist.query(JSON.stringify({ query, variables }), signed)
  } catch (e) {
    // Отказ не от сети, а от самого моста: например, пропуск стёрли между
    // проверкой и отправкой. Паузу ставить нельзя — она глушит и публичные
    // запросы, а сервер тут ни при чём.
    if (!(e instanceof BridgeHttpError)) {
      Logger('ERROR', 'AniList: мост отклонил запрос', e)
      throw e instanceof Error ? e : new Error(String(e))
    }

    // Сеть упала — тот же отступ, иначе очередь крутит пачки вхолостую всё время без сети.
    reportError(NET_SOURCE_ANILIST, NET_LABEL_ANILIST, e, Date.now() - startedAt)
    backOffAfterServerFailure(0)
    Logger('ERROR', 'AniList Network Error', e)
    throw new Error('AniList Network Error')
  }

  // Учёт состояния до разбора кодов: факт ответа важен сам по себе.
  reportStatus(NET_SOURCE_ANILIST, NET_LABEL_ANILIST, res.status, Date.now() - startedAt)

  // Потолок, остаток окна и время сброса читаются из любого ответа, включая ошибки.
  learnRateHeaders(res.headers)

  if (res.status === 429) {
    const waitTime = readRetryAfter(res.headers)

    // Пауза ставится через общий вход: он же кладёт её в хранилище, чтобы
    // перезапуск во время лимита не начинал с чистого листа.
    pauseAniList(waitTime + 500)

    // Потолок был завышен: урезаем его и не верим росту ближайшие минуты.
    anilistLimiter.reduceCeiling()

    // Пауза ставится даже при исчерпанных повторах: остальные вызовы не должны добивать сервер.
    if (attempt >= MAX_RATE_RETRIES) {
      Logger('ERROR', `AniList Rate Limit 429: повторы исчерпаны (${MAX_RATE_RETRIES})`, res)
      throw new Error('AniList Rate Limit: повторы исчерпаны')
    }

    // Назначенный срок длиннее порога — не высиживаем его внутри вызова.
    // Пауза уже стоит: следующий заход подождёт её сам и уйдёт вовремя,
    // а висящее полминуты обещание для человека выглядит зависанием.
    if (waitTime > MAX_INLINE_WAIT_MS) {
      const seconds = Math.ceil(waitTime / 1000)
      Logger('ERROR', `AniList Rate Limit 429: сервер назвал ${seconds}с — ждём вне запроса`, res)
      throw new Error(`AniList Rate Limit: повтор через ${seconds}с`)
    }

    Logger(
      'ERROR',
      `AniList Rate Limit 429! Ожидание ${waitTime}ms (повтор ${attempt + 1} из ${MAX_RATE_RETRIES})`,
      res,
    )
    await sleep(waitTime + 500 + Math.floor(Math.random() * 500))
    return anilistQuery<T>(query, variables, useAuth, attempt + 1)
  }

  if (res.status !== 200) {
    // Сервер лежит или закрылся — отступаем, а не пробуем снова через полсекунды.
    if (isServerFailure(res.status)) {
      // Выписка до отступа и при каждом отказе, а не только при входе в него:
      // именно различия между отказами и говорят, что происходит. Затопить журнал
      // выписки не могут: после отступа следующий запрос уйдёт не раньше
      // чем через полминуты.
      Logger('ERROR', `AniList ${res.status}: заголовки отказа`, failureDetails(res.headers))

      const pause = backOffAfterServerFailure(res.status)
      throw new Error(`AniList недоступен (${res.status}), пауза ${Math.round(pause / 1000)}с`)
    }

    Logger('ERROR', `AniList API Error HTTP ${res.status}`, res.text)
    throw new Error(`Error ${res.status}`)
  }

  // Сервер ответил — серия отказов прервана, следующая авария начнёт с 30 секунд.
  // Запись в хранилище обновляется тут же: иначе завтрашний запуск отступил бы
  // от вчерашней аварии, о которой сегодня уже никто не помнит.
  if (serverFailStreak > 0) {
    Logger('INFO', `AniList снова отвечает (отказов подряд было: ${serverFailStreak})`)
    serverFailStreak = 0
    rememberBackOff()
  }

  const timeTaken = Math.round(performance.now() - startTime)
  Logger('API', `[DONE] GraphQL запрос (AniList) выполнен за ${timeTaken}ms`)

  // Раньше битый JSON падал внутри onload и обещание не завершалось никогда.
  let payload: GraphQLResponse<T>
  try {
    payload = JSON.parse(res.text) as GraphQLResponse<T>
  } catch (e) {
    Logger('ERROR', 'AniList: не удалось разобрать ответ', e)
    throw new Error('AniList: некорректный ответ сервера')
  }

  if (payload.errors) {
    const message = JSON.stringify(payload.errors)
    Logger('ERROR', 'AniList GraphQL Error', payload.errors)
    throw new Error(`AniList GraphQL Error: ${message}`)
  }

  return payload
}
