// Клиент Яндекс Диска: только сеть и разбор ответов. Что именно уезжает
// в облако, решает core/cloud-file.ts, а когда и по чьей просьбе — core/cloud.ts.
//
// Диск возит файлы в два шага: сначала у API спрашивается одноразовый адрес,
// затем тело уходит или приходит по нему. Адрес живёт полчаса и ведёт на другой
// хост (uploader*.dst.yandex.net на запись, downloader.disk.yandex.ru на чтение),
// поэтому в разрешениях оболочки перечислены и они, а не только cloud-api.
// Сверено со справочником Disk API: разделы «Загрузить файл», «Скачать файл»,
// «Создать папку» и «Метаинформация» на yandex.com/dev/disk-api.
//
// Пропуск передаётся аргументом и здесь не хранится: хранение — дело настроек,
// а решение отдать пропуск в сеть — дело вызывающего.
//
// Ограничителя частоты здесь нет сознательно: за одно действие человека уходит
// один файл, а не сотня запросов подряд, как у датасета.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'

/** Ресурсы Диска: и метаданные, и создание папки живут на этом адресе. */
const API = 'https://cloud-api.yandex.net/v1/disk/resources'

/** Спросить адрес и метаданные — дело мгновенное; тело копии может быть большим. */
const LINK_TIMEOUT_MS = 20000
const BODY_TIMEOUT_MS = 60000

/** Что Диск знает о файле копии. Показывается человеку, программе не нужно. */
export interface DiskFileInfo {
  name: string
  bytes: number
  /** Время правки в виде ISO 8601, как его отдал Диск, или null. */
  modified: string | null
}

/**
 * Исход обращения к Диску. Отказ — не исключение: сеть, чужой сервер и
 * просроченный пропуск это обычные будни, и экрану нужна фраза для человека,
 * а не стек. Бросается здесь только то, чего быть не может.
 */
export type DiskResult<T> = { ok: true; value: T } | { ok: false; problem: string }

/** Заголовки к API. Пропуск ходит только так: в адресе ему не место. */
function headers(token: string): Record<string, string> {
  return { Authorization: `OAuth ${token}`, Accept: 'application/json' }
}

/**
 * Путь Диска в виде значения параметра. Корень можно писать и как «disk:/x»,
 * и как «/x» — это одно и то же, поэтому вид с косой чертой и берётся:
 * он короче и не путается с двоеточием при кодировании.
 */
function diskPath(path: string): string {
  return encodeURIComponent(path.startsWith('/') ? path : `/${path}`)
}

/**
 * Что сказал Диск своими словами. Ключи ответа перебираются с оглядкой:
 * справочник обещает «описание ошибки в теле», а какой именно ключ там
 * окажется, обещать нельзя, и держаться одного было бы гаданием.
 */
function said(text: string): string {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return ''

    const body = raw as Record<string, unknown>
    for (const key of ['message', 'description', 'error']) {
      const value = body[key]
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    // Не JSON — значит и сказать нечего.
  }
  return ''
}

/**
 * Ответ с кодом ошибки в человеческую фразу. Коды разобраны поимённо не ради
 * полноты: «Диск ответил 507» человеку не говорит ничего, а «не хватает места»
 * говорит всё и сразу подсказывает, что делать.
 */
function problem(status: number, text: string, what: string): string {
  const words = said(text)
  const tail = words === '' ? '' : `: ${words}`

  if (status === 401) return 'Яндекс Диск не принял пропуск: он просрочен или введён с ошибкой'
  if (status === 403) return `Яндекс Диск отказал в доступе${tail}`
  if (status === 404) return `На Яндекс Диске этого нет${tail}`
  if (status === 409) return `Яндекс Диск не может это сделать сейчас${tail}`
  if (status === 413) return 'Копия больше, чем Яндекс Диск принимает одним файлом'
  if (status === 423) return 'Файл копии занят другой работой на Диске: повторите через минуту'
  if (status === 429) return 'Яндекс Диск просит сбавить темп: повторите через минуту'
  if (status === 507) return 'На Яндекс Диске не хватает места для копии'
  if (status >= 500) return `Яндекс Диск ответил ошибкой ${status}: это на их стороне`

  return `${what}: Яндекс Диск ответил ${status}${tail}`
}

/**
 * Сорванный запрос в человеческую фразу. Мост отклоняется только сетевым
 * отказом (см. BridgeHttpError в bridge/IBridge.ts), и различать нечего,
 * кроме молчания по таймауту: советы человеку в этих случаях разные.
 */
function offline(e: unknown, what: string): string {
  const kind =
    typeof e === 'object' && e !== null && 'kind' in e ? (e as { kind: unknown }).kind : ''

  if (kind === 'timeout') return `${what}: Яндекс Диск не ответил вовремя`
  return `${what}: запрос до Яндекс Диска не дошёл — проверьте сеть`
}

/**
 * Одноразовый адрес для тела файла. Диск отвечает объектом Link, и шаблонный
 * адрес мы честно отклоняем: подставлять значения в скобки здесь нечем,
 * а тихо отправить копию по недостроенному адресу хуже отказа.
 */
async function linkFor(
  token: string,
  kind: 'upload' | 'download',
  path: string,
  extra: string,
  what: string,
): Promise<DiskResult<string>> {
  const url = `${API}/${kind}?path=${diskPath(path)}${extra}`

  try {
    const res = await Bridge.http.request({
      url,
      headers: headers(token),
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }

    let raw: unknown
    try {
      raw = JSON.parse(res.text)
    } catch {
      return { ok: false, problem: `${what}: Яндекс Диск ответил не по форме` }
    }

    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, problem: `${what}: Яндекс Диск ответил не по форме` }
    }

    const link = raw as { href?: unknown; templated?: unknown }
    if (link.templated === true) {
      return { ok: false, problem: `${what}: Диск прислал шаблон адреса вместо адреса` }
    }
    if (typeof link.href !== 'string' || link.href === '') {
      return { ok: false, problem: `${what}: Диск не прислал адрес файла` }
    }

    return { ok: true, value: link.href }
  } catch (e) {
    Logger('WARN', `Яндекс Диск: адрес для ${kind} не получен`, e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Проверка пропуска. Спрашиваются метаданные корня — самый дешёвый запрос,
 * который отвечает на единственный нужный вопрос: пустит ли Диск с этим
 * пропуском вообще. Зовётся, когда человек только что его вставил.
 */
export async function checkAccess(token: string): Promise<DiskResult<true>> {
  const what = 'Проверка пропуска'

  if (token.trim() === '') return { ok: false, problem: 'Пропуск Яндекс Диска не введён' }

  try {
    const res = await Bridge.http.request({
      url: `${API}?path=${diskPath('/')}&fields=name`,
      headers: headers(token),
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }

    Logger('API', 'Яндекс Диск: пропуск принят')
    return { ok: true, value: true }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: проверка пропуска не удалась', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Сведения о файле или null, если файла нет. Отсутствие копии — законный
 * ответ, а не отказ: так выглядит Диск до первого сохранения, и экрану
 * нужно сказать «копии ещё нет», а не показать ошибку.
 */
export async function statFile(
  token: string,
  path: string,
): Promise<DiskResult<DiskFileInfo | null>> {
  const what = 'Сведения о копии'

  try {
    const res = await Bridge.http.request({
      url: `${API}?path=${diskPath(path)}&fields=name,size,modified,type`,
      headers: headers(token),
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (res.status === 404) return { ok: true, value: null }
    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }

    let raw: unknown
    try {
      raw = JSON.parse(res.text)
    } catch {
      return { ok: false, problem: `${what}: Яндекс Диск ответил не по форме` }
    }

    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, problem: `${what}: Яндекс Диск ответил не по форме` }
    }

    const item = raw as { name?: unknown; size?: unknown; modified?: unknown; type?: unknown }

    return {
      ok: true,
      value: {
        name: typeof item.name === 'string' ? item.name : '',
        bytes: typeof item.size === 'number' ? item.size : 0,
        modified: typeof item.modified === 'string' ? item.modified : null,
      },
    }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: сведения о файле не получены', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Заводит папку копии, если её нет. Уже существующая папка — не беда, а
 * обычное дело со второго сохранения, поэтому любой отказ проверяется
 * повторным вопросом «а она там есть?»: полагаться на конкретный код
 * ответа для «уже создана» значило бы гадать.
 */
export async function ensureFolder(token: string, path: string): Promise<DiskResult<true>> {
  const what = 'Папка копии'

  try {
    const res = await Bridge.http.request({
      method: 'PUT',
      url: `${API}?path=${diskPath(path)}`,
      headers: headers(token),
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (res.ok) return { ok: true, value: true }

    const already = await statFile(token, path)
    if (already.ok && already.value !== null) return { ok: true, value: true }

    return { ok: false, problem: problem(res.status, res.text, what) }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: папка копии не создана', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Кладёт текст файлом. Пишется с перезаписью: копия одна, и держать рядом
 * второй файл с тем же смыслом означало бы гадать при чтении, какой из них
 * свежее. Тело уходит по одноразовому адресу, и пропуск для этого шага
 * Диску не нужен — он уже зашит в самом адресе.
 */
export async function uploadText(
  token: string,
  path: string,
  text: string,
): Promise<DiskResult<true>> {
  const what = 'Сохранение копии'

  const link = await linkFor(token, 'upload', path, '&overwrite=true', what)
  if (!link.ok) return link

  try {
    const res = await Bridge.http.request({
      method: 'PUT',
      url: link.value,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: text,
      timeoutMs: BODY_TIMEOUT_MS,
      credentials: 'omit',
    })

    // 201 — файл на месте, 202 — принят и вот-вот ляжет. Второе для нас
    // такой же успех: копия у Диска, а не у нас в памяти.
    if (res.status === 201 || res.status === 202) {
      Logger('API', `Яндекс Диск: копия сохранена (${text.length} знаков)`)
      return { ok: true, value: true }
    }

    return { ok: false, problem: problem(res.status, res.text, what) }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: тело копии не ушло', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Забирает текст файла. Пропуск на втором шаге обязателен: в отличие от
 * записи, адрес на чтение сам по себе доступа не даёт — так велит справочник.
 */
export async function downloadText(token: string, path: string): Promise<DiskResult<string>> {
  const what = 'Чтение копии'

  const link = await linkFor(token, 'download', path, '', what)
  if (!link.ok) return link

  try {
    const res = await Bridge.http.request({
      url: link.value,
      headers: headers(token),
      timeoutMs: BODY_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }

    Logger('API', `Яндекс Диск: копия прочитана (${res.text.length} знаков)`)
    return { ok: true, value: res.text }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: тело копии не пришло', e)
    return { ok: false, problem: offline(e, what) }
  }
}
