// Копия списка в Google Диске: тут только сеть и разбор ответов. Пропуск
// доступа приходит аргументом — где он хранится и когда продлевается, решает
// core/cloud.ts, а выдаёт его api/google-oauth.ts.
//
// ПОЧЕМУ ДВА АДРЕСА
// У Диска метаданные и тела файлов лежат на разных путях: drive/v3/files
// отвечает за имена, размеры и перечисление, upload/drive/v3/files — за само
// содержимое. Одноразовых ссылок, как у Яндекса, здесь нет: тело уезжает
// и приезжает прямо в запросе, поэтому в разрешениях приложения стоят
// оба адреса Google.
//
// ПОЧЕМУ ФАЙЛ ИЩЕТСЯ ПЕРЕБОРОМ, А НЕ УСЛОВИЕМ ПОИСКА
// Путей в Диске нет вовсе: у файла есть имя и служебный номер, а тело
// берут только по номеру. Значит, перед каждой записью и чтением номер надо
// узнать по имени. Условие поиска потребовало бы прятать апострофы в имени,
// а скрытая папка приложения — наша собственная, и файлов в ней единицы.
// Поэтому папка просто перечисляется, а имя сверяется уже здесь: короче
// и без возни с кавычками.
//
// РАЗМЕР ПРИХОДИТ СТРОКОЙ
// Это не опечатка в ответе, а формат Google для больших чисел. Ниже размер
// приводится к числу один раз, чтобы дальше об этом никто не помнил.
//
// Слота у ограничителя запросов эти вызовы не берут — по той же причине,
// что и клиент Яндекс Диска: один файл на одно действие человека.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'

/** Имена, размеры и перечисление. */
const API = 'https://www.googleapis.com/drive/v3/files'

/** Тела файлов: запись содержимого. */
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'

/** Скрытая папка приложения: чужого в ней не видно, своё не видно чужим. */
export const DRIVE_APP_ROOT = 'appDataFolder'

/** Перечисление и сведения коротки. */
const META_TIMEOUT_MS = 20000

/** Тело копии бывает на несколько мегабайт. */
const BODY_TIMEOUT_MS = 60000

/** Сколько файлов спрашивать за раз: в своей папке их единицы. */
const PAGE_SIZE = '100'

/** Граница частей составной отправки: в теле копии такой строки быть не может. */
const BOUNDARY = 'animori-cloud-part-b9f1c4'

/** Что известно про файл копии. Форма как у клиента Яндекс Диска. */
export interface DriveFileInfo {
  /** Имя файла в скрытой папке. */
  name: string
  /** Размер в байтах. */
  bytes: number
  /** Когда файл меняли, строкой из ответа. */
  modified: string
}

/** Исход обращения к Диску: фраза для человека вместо исключения. */
export type DriveResult<T> = { ok: true; value: T } | { ok: false; problem: string }

/** Файл, как его перечисляет Диск: с номером, по которому берут тело. */
interface DriveEntry extends DriveFileInfo {
  id: string
}

/** Заголовки для запросов о метаданных. */
function headers(access: string): Record<string, string> {
  return { Authorization: `Bearer ${access}`, Accept: 'application/json' }
}

/** Разобранное тело ответа или null, если ответ не JSON. */
function parsed(text: string): Record<string, unknown> | null {
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

/**
 * Что сказал Диск своими словами. Отказ приходит вложенным —
 * { error: { code, message } }, — и человеку нужна именно message.
 * Отказ самого входа устроен иначе, поэтому проверяются оба вида.
 */
function said(text: string): string {
  const at = parsed(text)
  if (at === null) return ''

  const inner = at['error']
  if (typeof inner === 'string') {
    const why = word(at, 'error_description')
    return why !== '' ? why : inner
  }

  if (typeof inner === 'object' && inner !== null) {
    const message = (inner as Record<string, unknown>)['message']
    if (typeof message === 'string') return message
  }

  return ''
}

/** Ответ с кодом ошибки в человеческую фразу. */
function problem(status: number, text: string, what: string): string {
  const words = said(text)
  const tail = words === '' ? '' : `: ${words}`

  if (status === 401) return `${what}: пропуск Google не принят — войдите заново`
  if (status === 403) {
    return `${what}: Google отказал в доступе — возможно, исчерпана дневная норма${tail}`
  }
  if (status === 404) return `${what}: файла копии в облаке нет`
  if (status === 429) return `${what}: Google просит подождать — повторите через минуту`
  if (status >= 500) return `${what}: Google ответил ошибкой ${status} — это на их стороне`

  return `${what}: Google ответил ${status}${tail}`
}

/**
 * Сорванный запрос в человеческую фразу. Мост отклоняется только сетевым
 * отказом, и различать нечего, кроме молчания по таймауту.
 */
function offline(e: unknown, what: string): string {
  const kind =
    typeof e === 'object' && e !== null && 'kind' in e ? (e as { kind: unknown }).kind : ''

  if (kind === 'timeout') return `${what}: Google не ответил вовремя`
  return `${what}: запрос до Google не дошёл — проверьте сеть`
}

/** Размер из ответа: приходит строкой, а у пустого файла не приходит вовсе. */
function bytesOf(from: Record<string, unknown>): number {
  const raw = from['size']
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw

  if (typeof raw === 'string' && raw.trim() !== '') {
    const size = Number(raw)
    return Number.isFinite(size) ? size : 0
  }

  return 0
}

/** Перечисляет скрытую папку приложения. */
async function listFiles(access: string, what: string): Promise<DriveResult<DriveEntry[]>> {
  const query = new URLSearchParams({
    spaces: DRIVE_APP_ROOT,
    fields: 'files(id,name,size,modifiedTime)',
    pageSize: PAGE_SIZE,
  })

  try {
    const res = await Bridge.http.request({
      method: 'GET',
      url: `${API}?${query.toString()}`,
      headers: headers(access),
      timeoutMs: META_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (res.status < 200 || res.status > 299) {
      return { ok: false, problem: problem(res.status, res.text, what) }
    }

    const at = parsed(res.text)
    const raw = at === null ? null : at['files']
    if (!Array.isArray(raw)) return { ok: false, problem: `${what}: Google ответил не по форме` }

    const files: DriveEntry[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const one = item as Record<string, unknown>
      const id = word(one, 'id')
      const name = word(one, 'name')
      if (id === '' || name === '') continue
      files.push({ id, name, bytes: bytesOf(one), modified: word(one, 'modifiedTime') })
    }

    return { ok: true, value: files }
  } catch (e) {
    Logger('WARN', 'Google Диск: папка приложения не перечислена', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/** Находит файл копии по имени. Отсутствие файла — не ошибка. */
async function entryFor(
  access: string,
  name: string,
  what: string,
): Promise<DriveResult<DriveEntry | null>> {
  const list = await listFiles(access, what)
  if (!list.ok) return list

  const found = list.value.find((one) => one.name === name)
  return { ok: true, value: found === undefined ? null : found }
}

/**
 * Проверяет, что пропуск годен и папка приложения доступна. Перечисление —
 * самый безобидный вопрос: ничего не создаёт и ничего не меняет.
 */
export async function checkAccess(access: string): Promise<DriveResult<true>> {
  const list = await listFiles(access, 'Проверка доступа к Google Диску')
  if (!list.ok) return { ok: false, problem: list.problem }

  Logger('API', `Google Диск: папка приложения доступна, файлов ${list.value.length}`)
  return { ok: true, value: true }
}

/** Сведения о файле копии или null, если копии в облаке нет. */
export async function statFile(
  access: string,
  name: string,
): Promise<DriveResult<DriveFileInfo | null>> {
  const found = await entryFor(access, name, 'Сведения о копии в Google Диске')
  if (!found.ok) return found
  if (found.value === null) return { ok: true, value: null }

  const one = found.value
  return { ok: true, value: { name: one.name, bytes: one.bytes, modified: one.modified } }
}

/**
 * Пишет копию. Если файл уже есть, меняется только его тело: номер и место
 * остаются теми же. Иначе в папке развелись бы двойники с одним именем —
 * Диск это разрешает, а человек потом не поймёт, какая копия его.
 */
export async function uploadText(
  access: string,
  name: string,
  text: string,
): Promise<DriveResult<true>> {
  const what = 'Запись копии в Google Диск'

  const found = await entryFor(access, name, what)
  if (!found.ok) return { ok: false, problem: found.problem }

  const fresh = found.value === null

  // Новому файлу нужны имя и папка, и они едут отдельной частью рядом
  // с телом. Готовому файлу хватит одного тела.
  const url = fresh
    ? `${UPLOAD_API}?uploadType=multipart&fields=id`
    : `${UPLOAD_API}/${found.value === null ? '' : found.value.id}?uploadType=media&fields=id`

  const shape = JSON.stringify({ name, parents: [DRIVE_APP_ROOT] })
  const body = fresh
    ? `--${BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${shape}\r\n` +
      `--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${BOUNDARY}--`
    : text

  const sending = fresh
    ? { ...headers(access), 'Content-Type': `multipart/related; boundary=${BOUNDARY}` }
    : { ...headers(access), 'Content-Type': 'application/json' }

  try {
    const res = await Bridge.http.request({
      method: fresh ? 'POST' : 'PATCH',
      url,
      headers: sending,
      body,
      timeoutMs: BODY_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (res.status < 200 || res.status > 299) {
      return { ok: false, problem: problem(res.status, res.text, what) }
    }

    Logger('API', fresh ? 'Google Диск: копия создана' : 'Google Диск: копия обновлена')
    return { ok: true, value: true }
  } catch (e) {
    Logger('WARN', 'Google Диск: копия не записана', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Читает копию целиком. Отсутствие файла — честный отказ: читать нечего,
 * и молча возвращать пустоту нельзя, иначе она сойдёт за пустой список.
 */
export async function downloadText(access: string, name: string): Promise<DriveResult<string>> {
  const what = 'Чтение копии из Google Диска'

  const found = await entryFor(access, name, what)
  if (!found.ok) return { ok: false, problem: found.problem }
  if (found.value === null) return { ok: false, problem: `${what}: копии в облаке нет` }

  try {
    const res = await Bridge.http.request({
      method: 'GET',
      // Тело просят без Accept: тут ждут сам файл, а не ответ JSON.
      url: `${API}/${found.value.id}?alt=media`,
      headers: { Authorization: `Bearer ${access}` },
      timeoutMs: BODY_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (res.status < 200 || res.status > 299) {
      return { ok: false, problem: problem(res.status, res.text, what) }
    }

    Logger('API', `Google Диск: копия прочитана, знаков ${res.text.length}`)
    return { ok: true, value: res.text }
  } catch (e) {
    Logger('WARN', 'Google Диск: копия не прочитана', e)
    return { ok: false, problem: offline(e, what) }
  }
}
