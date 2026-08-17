// Клиент AniList GraphQL: держатель общей паузы по лимиту и разбора ответов.
// Тормоз живёт здесь, а не в очереди: только клиент видит все запросы к AniList сразу.
// Сам запрос собирает мост (пункт 2.3): в десктопе пропуск в разметку не попадает.

import { Bridge, BridgeHttpError, type HttpResponse } from '@/bridge'
import { IS_ANILIST } from '../core/constants'
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

/** Ставит паузу вручную. Существующая более долгая пауза не укорачивается. */
export function pauseAniList(ms: number): void {
  alRateLimitPause = Math.max(alRateLimitPause, Date.now() + ms)
  anilistLimiter.pause(ms)
}

export interface GraphQLResponse<T = unknown> {
  data?: T
  errors?: unknown
}

/**
 * Читает токен из хранилища в память. Вызывается один раз на старте, до первого запроса.
 * Ошибка чтения не роняет запуск: без токена работают все публичные запросы.
 */
export async function loadAlToken(): Promise<void> {
  try {
    const stored = await Bridge.storage.get<unknown>(TOKEN_KEY, '')
    alTokenCache = typeof stored === 'string' ? stored : ''
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения AL_TOKEN', e)
    alTokenCache = ''
  }
}

/**
 * Токен ровно в том виде, в каком его сохранил пользователь, без подстановки из Vuex.
 * Нужен полям ввода: там нельзя показывать сессионный токен сайта как «сохранённый».
 */
export function getStoredAlToken(): string {
  return alTokenCache
}

/** Сохраняет токен: сначала в память, потом в хранилище. Никогда не отклоняется. */
export function setAlToken(token: string): void {
  alTokenCache = token
  void Bridge.storage.set(TOKEN_KEY, token).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_TOKEN', e)
  })
}

/** Токен AniList: из настроек, либо (на anilist.co) из Vuex у залогиненного пользователя. */
export function getAlToken(): string | null {
  if (alTokenCache) return alTokenCache

  if (IS_ANILIST) {
    try {
      const vuex = JSON.parse(localStorage.getItem('vuex') ?? 'null') as {
        auth?: { token?: string }
      } | null
      if (vuex?.auth?.token) return vuex.auth.token
    } catch (e) {
      Logger('ERROR', 'Ошибка чтения Vuex хранилища AniList', e)
    }
  }
  return null
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
 * Есть ли чем подписать запрос. Два источника и оба нужны: свой токен
 * в скрипте и пропуск оболочки в настольном приложении.
 *
 * Спрашивают те, кому без подписи идти в сеть вовсе незачем: список
 * и очередь правок.
 */
export function canSignAniList(): boolean {
  return shellSigned || getAlToken() !== null
}

/**
 * Отдаёт мосту токен, найденный только в Vuex: подписывает запрос теперь мост,
 * а сессию сайта он сам не видит и без этого ответил бы «вход не выполнен».
 */
function shareVuexToken(): void {
  if (alTokenCache) return

  const token = getAlToken()
  if (!token) return

  setAlToken(token)
  Logger('INFO', 'AniList: токен сессии сайта сохранён для запросов через мост')
}

/**
 * Значение заголовка в любом регистре имени.
 * Мост в Rust понижает имена, а скриптовый отдаёт так, как пришло от браузера.
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
 * Учит ограничитель по заголовкам ответа: потолок и остаток окна.
 * Так возврат штатных 90 после техработ не требует правки и выпуска сборок.
 */
function learnRateHeaders(headers: Record<string, string>): void {
  const limit = headerNumber(headers, 'x-ratelimit-limit')
  if (Number.isFinite(limit) && limit > 0) anilistLimiter.applyCeiling(limit)

  const remaining = headerNumber(headers, 'x-ratelimit-remaining')
  if (!Number.isFinite(remaining) || remaining > 0) return

  // Окно выбрано до конца: ждём сброса, не дожидаясь 429.
  const reset = headerNumber(headers, 'x-ratelimit-reset')
  const untilReset = Number.isFinite(reset) ? reset * 1000 - Date.now() : NaN
  const wait = Number.isFinite(untilReset) && untilReset > 0 ? untilReset : DEFAULT_RETRY_MS
  anilistLimiter.pause(Math.min(wait + 500, 60000))
}

/** Сколько ждать после 429: заголовок retry-after в секундах либо дефолт. */
function readRetryAfter(headers: Record<string, string>): number {
  const seconds = headerNumber(headers, 'retry-after')
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS
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

  if (signed) shareVuexToken()

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

  // Потолок и остаток окна читаются из любого ответа, включая ошибки.
  learnRateHeaders(res.headers)

  if (res.status === 429) {
    const waitTime = readRetryAfter(res.headers)
    alRateLimitPause = Date.now() + waitTime + 500
    anilistLimiter.pause(waitTime + 500)

    // Потолок был завышен: урезаем его и не верим росту ближайшие минуты.
    anilistLimiter.reduceCeiling()

    // Пауза ставится даже при исчерпанных повторах: остальные вызовы не должны добивать сервер.
    if (attempt >= MAX_RATE_RETRIES) {
      Logger('ERROR', `AniList Rate Limit 429: повторы исчерпаны (${MAX_RATE_RETRIES})`, res)
      throw new Error('AniList Rate Limit: повторы исчерпаны')
    }

    Logger(
      'ERROR',
      `AniList Rate Limit 429! Ожидание ${waitTime}ms (попытка ${attempt + 1} из ${MAX_RATE_RETRIES})`,
      res,
    )
    await sleep(waitTime + 500 + Math.floor(Math.random() * 500))
    return anilistQuery<T>(query, variables, useAuth, attempt + 1)
  }

  if (res.status !== 200) {
    // Сервер лежит или закрылся — отступаем, а не пробуем снова через полсекунды.
    if (isServerFailure(res.status)) {
      const pause = backOffAfterServerFailure(res.status)
      throw new Error(`AniList недоступен (${res.status}), пауза ${Math.round(pause / 1000)}с`)
    }

    Logger('ERROR', `AniList API Error HTTP ${res.status}`, res.text)
    throw new Error(`Error ${res.status}`)
  }

  // Сервер ответил — серия отказов прервана, следующая авария начнёт с 30 секунд.
  if (serverFailStreak > 0) {
    Logger('INFO', `AniList снова отвечает (отказов подряд было: ${serverFailStreak})`)
    serverFailStreak = 0
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
