// Вход в Google с устройства: только сеть и разбор ответов. Где хранить
// выданное и когда обновлять — дело core/cloud.ts, что возить с этим
// пропуском — дело api/google-drive.ts.
//
// Почему вообще вход С УСТРОЙСТВА, а не вставленный руками пропуск,
// как у Яндекс Диска: у Google вставлять нечего. Пропуск доступа там
// живёт час и выдаётся только программе, а долгого пропуска для человека
// не существует вовсе. Зато есть поток для телевизоров и приставок: программа
// показывает короткий код, человек подтверждает его где угодно — хоть с телефона, —
// а программа терпеливо спрашивает, не подтверждено ли уже. Никакого своего
// окна входа, никакого перехвата адреса возврата и никакого местного порта,
// который на телевизоре всё равно не набрать.
//
// ОБЛАСТЬ РОВНО НА СВОЮ ПАПКУ, НО С ОПОЗНАНИЕМ
// Из Диска просится одна drive.appdata — скрытая папка приложения, и больше
// ничего: ни чужих файлов, ни перечисления Диска. Справочник Google разрешает
// входу с устройства ровно две области Диска — appdata и file, — и первая как
// раз наш случай: вторая даёт право на файлы, которые человек выбрал сам,
// а нам нужен один служебный файл, который выбирать незачем.
//
// Рядом с ней приходится ставить email и profile. Это не сбор сведений,
// а требование потока: к области любого API вход с устройства просит
// добавлять опознание человека, и на одинокую drive.appdata Google отвечает
// «Invalid device flow scope» — отказом на область, которую сам же разрешает.
// Читать имя и почту всё равно нечем: опросник о человеке здесь не зовётся
// ни разу, пропуск уходит только на Диск, и в настройках человеку
// показывается именно папка. Если правило переменится обратно, вторая
// попытка ниже спросит одну папку без опознания.
//
// КЛЮЧИ КЛИЕНТА ПЕРЕДАЮТСЯ АРГУМЕНТАМИ
// Здесь не читаются ни настройки, ни хранилище — ровно как в клиенте Диска.
// Решение отдать ключи в сеть принимает вызывающий, а не этот модуль.
//
// Ошибки разбираются по слову в теле ответа, а не по коду HTTP: в этом потоке
// ожидание подтверждения тоже приходит ошибкой, и коды у неё разные
// в разных версиях справочника, а слово authorization_pending одно и то же.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'

/** Где берётся код для устройства. */
const DEVICE_URL = 'https://oauth2.googleapis.com/device/code'

/** Где код обменивается на пропуск и где пропуск продлевается. */
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Где выданное отзывается обратно. */
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/**
 * Область скрытой папки приложения. Публичная: её показывают человеку
 * в настройках, чтобы было видно, что именно у него спросили.
 */
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'

/**
 * Что просится у входа с устройства, по порядку. Сначала папка вместе
 * с опознанием — так требует справочник, — а если и это не принято,
 * одна папка: вдруг правило переменится обратно.
 */
const SCOPE_TRIES: readonly string[] = [`email profile ${GOOGLE_SCOPE}`, GOOGLE_SCOPE]

/**
 * Подсказка на случай, когда не принята ни одна область. Своими словами
 * Google называет область, но не причину, а причина лежит не в коде: либо
 * клиент создан не того вида, либо Диск в проекте не включён.
 */
const SCOPE_HINT =
  'Google не принял область доступа. Проверьте в консоли облака две вещи: ' +
  'вид клиента должен быть «Телевизоры и устройства с ограниченным вводом», ' +
  'а Google Drive API — включён в том же проекте'

/** Шаги входа короткие: тел тут нет, только короткие ответы JSON. */
const STEP_TIMEOUT_MS = 20000

/** Сколько ждать между вопросами, если Google промолчал о темпе. */
const DEFAULT_INTERVAL_MS = 5000

/** Насколько замедляться по просьбе slow_down. */
const SLOWER_STEP_MS = 5000

/**
 * Исход обращения к Google. Форма та же, что у клиента Диска, и по той же
 * причине: экрану нужна фраза для человека, а не исключение в журнале.
 */
export type GoogleResult<T> = { ok: true; value: T } | { ok: false; problem: string }

/** Что показывать человеку, пока он подтверждает вход на другом устройстве. */
export interface DeviceStart {
  /** Служебный код устройства. Человеку его не показывают. */
  deviceCode: string
  /** Короткий код вида ABCD-EFGH — его и надо показать крупно. */
  userCode: string
  /** Страница подтверждения без кода: её диктуют вслух. */
  verifyUrl: string
  /**
   * Та же страница с вписанным кодом — то, что уезжает в QR. Если Google
   * прислал готовый адрес, берётся он; иначе код вписывается в адрес сами.
   * Даже если страница когда-нибудь перестанет подставлять код сама,
   * хуже не станет: код рядом с QR виден всегда, и его можно ввести руками.
   */
  verifyUrlWithCode: string
  /** Когда код перестанет годиться, в миллисекундах эпохи. */
  expiresAt: number
  /** Как часто можно спрашивать о подтверждении. */
  intervalMs: number
}

/** Что выдал Google после подтверждения. */
export interface GoogleKeys {
  /**
   * Пропуск продления. Пустая строка возможна и законна: при повторном
   * входе Google иногда его не присылает. Старый в таком случае годен
   * и затирать его пустотой нельзя — это решает core/cloud.ts.
   */
  refresh: string
  /** Пропуск доступа: живёт около часа. */
  access: string
  /** Когда пропуск доступа стухнет, в миллисекундах эпохи. */
  accessUntil: number
}

/**
 * Чем кончился один вопрос «подтвердили уже?». Отдельный тип, а не отказ
 * словами, потому что ожидание — не ошибка: так этот поток и работает
 * большую часть времени.
 */
export type DeviceStep =
  | { state: 'waiting' }
  | { state: 'slower'; intervalMs: number }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'done'; keys: GoogleKeys }

/** Тело запроса в виде, который ждёт OAuth: поля формы, а не JSON. */
function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

/** Заголовки для тех же запросов. Пропуска в них нет: он идёт телом. */
const FORM_HEADERS: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
}

/** Разобранное тело ответа или null, если ответ не JSON. */
function body(text: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return null
    return raw as Record<string, unknown>
  } catch {
    return null
  }
}

/** Строковое поле ответа или пустота. */
function word(from: Record<string, unknown> | null, key: string): string {
  if (from === null) return ''
  const value = from[key]
  return typeof value === 'string' ? value : ''
}

/** Числовое поле ответа или подставленное значение. */
function count(from: Record<string, unknown> | null, key: string, instead: number): number {
  if (from === null) return instead
  const value = from[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : instead
}

/**
 * Что сказал Google своими словами. Сначала пояснение, потом само слово
 * ошибки: первое написано для людей, второе — для программ.
 */
function said(text: string): string {
  const at = body(text)
  const why = word(at, 'error_description')
  if (why !== '') return why
  return word(at, 'error')
}

/** Ответ с кодом ошибки в человеческую фразу. */
function problem(status: number, text: string, what: string): string {
  const words = said(text)
  const tail = words === '' ? '' : `: ${words}`

  if (status === 400) return `${what}: Google не принял запрос${tail}`
  if (status === 401) {
    return `${what}: Google не узнал клиента — проверьте его ключи${tail}`
  }
  if (status === 403) return `${what}: Google отказал в доступе${tail}`
  if (status === 429) return 'Вход в Google: слишком частые вопросы, повторите через минуту'
  if (status >= 500) return `${what}: Google ответил ошибкой ${status} — это на их стороне`

  return `${what}: Google ответил ${status}${tail}`
}

/**
 * Сорванный запрос в человеческую фразу. Мост отклоняется только сетевым
 * отказом (BridgeHttpError в bridge/IBridge.ts), и различать нечего, кроме
 * молчания по таймауту.
 */
function offline(e: unknown, what: string): string {
  const kind =
    typeof e === 'object' && e !== null && 'kind' in e ? (e as { kind: unknown }).kind : ''

  if (kind === 'timeout') return `${what}: Google не ответил вовремя`
  return `${what}: запрос до Google не дошёл — проверьте сеть`
}

/**
 * Страница подтверждения с вписанным кодом. Нужна только QR: человек
 * наводит телефон и попадает сразу на страницу с готовым кодом, а не набирает
 * восемь знаков с пульта.
 */
function withCode(url: string, code: string): string {
  if (url === '' || code === '') return url
  const glue = url.includes('?') ? '&' : '?'
  return `${url}${glue}user_code=${encodeURIComponent(code)}`
}

/** Общий шаг: POST формой и ответ текстом. */
async function post(
  url: string,
  fields: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const res = await Bridge.http.request({
    method: 'POST',
    url,
    headers: FORM_HEADERS,
    body: form(fields),
    timeoutMs: STEP_TIMEOUT_MS,
    credentials: 'omit',
  })

  return { status: res.status, text: res.text }
}

/**
 * Просит код для устройства. Первый шаг входа: после него на экране
 * появляются QR и короткий код, а программа начинает ждать.
 *
 * Области перебираются по списку и только при отказе именно на область:
 * любая другая беда — не повод спрашивать снова, иначе одна и та же поломка
 * будет стучаться к Google дважды за каждый вход.
 */
export async function startDeviceLogin(client: string): Promise<GoogleResult<DeviceStart>> {
  const what = 'Начало входа в Google'

  if (client.trim() === '') {
    return { ok: false, problem: 'Не задан клиент Google: входить нечем' }
  }

  try {
    for (const scope of SCOPE_TRIES) {
      const res = await post(DEVICE_URL, { client_id: client.trim(), scope })

      if (res.status < 200 || res.status > 299) {
        if (word(body(res.text), 'error') === 'invalid_scope') {
          Logger('WARN', `Вход в Google: область «${scope}» не принята`, said(res.text))
          continue
        }

        return { ok: false, problem: problem(res.status, res.text, what) }
      }

      const at = body(res.text)
      const deviceCode = word(at, 'device_code')
      const userCode = word(at, 'user_code')
      const verifyUrl = word(at, 'verification_url') || word(at, 'verification_uri')

      if (deviceCode === '' || userCode === '' || verifyUrl === '') {
        return { ok: false, problem: `${what}: Google ответил не по форме` }
      }

      const ready = word(at, 'verification_url_complete') || word(at, 'verification_uri_complete')
      const seconds = count(at, 'expires_in', 1800)
      const interval = count(at, 'interval', DEFAULT_INTERVAL_MS / 1000)

      Logger('API', 'Вход в Google: код для устройства получен')

      return {
        ok: true,
        value: {
          deviceCode,
          userCode,
          verifyUrl,
          verifyUrlWithCode: ready !== '' ? ready : withCode(verifyUrl, userCode),
          expiresAt: Date.now() + seconds * 1000,
          intervalMs: Math.max(interval * 1000, DEFAULT_INTERVAL_MS),
        },
      }
    }

    Logger('WARN', 'Вход в Google: ни одна область доступа не принята')
    return { ok: false, problem: `${what}: ${SCOPE_HINT}` }
  } catch (e) {
    Logger('WARN', 'Вход в Google: код для устройства не получен', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Спрашивает один раз, подтверждён ли вход. Цикл и паузы — снаружи:
 * здесь нет ни таймеров, ни отмены, а человек вправе закрыть окно
 * посередине входа, и ждать его после этого нельзя.
 */
export async function pollDeviceLogin(
  client: string,
  secret: string,
  deviceCode: string,
): Promise<GoogleResult<DeviceStep>> {
  const what = 'Ожидание входа в Google'

  try {
    const res = await post(TOKEN_URL, {
      client_id: client.trim(),
      client_secret: secret.trim(),
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })

    const at = body(res.text)
    const error = word(at, 'error')

    // Ожидание и просьба сбавить темп приходят теми же кодами, что и отказы,
    // поэтому сначала слово, а только потом код ответа.
    if (error === 'authorization_pending') return { ok: true, value: { state: 'waiting' } }
    if (error === 'slow_down') {
      return { ok: true, value: { state: 'slower', intervalMs: SLOWER_STEP_MS } }
    }
    if (error === 'access_denied') return { ok: true, value: { state: 'denied' } }
    if (error === 'expired_token') return { ok: true, value: { state: 'expired' } }

    if (res.status < 200 || res.status > 299) {
      return { ok: false, problem: problem(res.status, res.text, what) }
    }

    const access = word(at, 'access_token')
    if (access === '') return { ok: false, problem: `${what}: Google не прислал пропуск` }

    Logger('API', 'Вход в Google подтверждён')

    return {
      ok: true,
      value: {
        state: 'done',
        keys: {
          refresh: word(at, 'refresh_token'),
          access,
          accessUntil: Date.now() + count(at, 'expires_in', 3600) * 1000,
        },
      },
    }
  } catch (e) {
    Logger('WARN', 'Вход в Google: вопрос о подтверждении не дошёл', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Меняет пропуск продления на свежий пропуск доступа.
 *
 * Отдельный отказ на invalid_grant нарочно: это единственный случай, когда
 * человеку надо входить заново, а не ждать и не проверять сеть: пропуск
 * отозван или истёк. Общая фраза про ошибку запроса тут ничего не подсказывает.
 */
export async function refreshAccess(
  client: string,
  secret: string,
  refresh: string,
): Promise<GoogleResult<{ access: string; accessUntil: number }>> {
  const what = 'Продление пропуска Google'

  if (refresh.trim() === '') return { ok: false, problem: 'Вход в Google не пройден' }

  try {
    const res = await post(TOKEN_URL, {
      client_id: client.trim(),
      client_secret: secret.trim(),
      refresh_token: refresh.trim(),
      grant_type: 'refresh_token',
    })

    const at = body(res.text)

    if (word(at, 'error') === 'invalid_grant') {
      return {
        ok: false,
        problem: 'Google больше не признаёт вход: пройдите вход заново',
      }
    }

    if (res.status < 200 || res.status > 299) {
      return { ok: false, problem: problem(res.status, res.text, what) }
    }

    const access = word(at, 'access_token')
    if (access === '') return { ok: false, problem: `${what}: Google не прислал пропуск` }

    return {
      ok: true,
      value: { access, accessUntil: Date.now() + count(at, 'expires_in', 3600) * 1000 },
    }
  } catch (e) {
    Logger('WARN', 'Google: пропуск не продлён', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Отзывает выданное обратно. Зовётся, когда человек выходит из облака:
 * чистить только своё хранилище и оставлять живой пропуск у Google было бы
 * невежливо: человек ждёт, что доступ отозван везде.
 *
 * Неудача отзыва не должна мешать выходу: вызывающий стирает ключи
 * у себя в любом случае — иначе пропавшая сеть держала бы человека вошедшим
 * против его воли.
 */
export async function revokeAccess(token: string): Promise<GoogleResult<true>> {
  const what = 'Выход из Google'

  if (token.trim() === '') return { ok: true, value: true }

  try {
    const res = await post(REVOKE_URL, { token: token.trim() })

    if (res.status < 200 || res.status > 299) {
      return { ok: false, problem: problem(res.status, res.text, what) }
    }

    Logger('API', 'Google: доступ отозван')
    return { ok: true, value: true }
  } catch (e) {
    Logger('WARN', 'Google: отзыв доступа не дошёл', e)
    return { ok: false, problem: offline(e, what) }
  }
}
