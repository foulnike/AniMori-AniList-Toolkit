// Клиент Kodik. Открытого API для ссылок у службы нет, поэтому цепочка из трёх
// шагов, выверенная руками на живой серии (см. docs/ARCHITECTURE-VIDEO.md):
//
//   1. поиск по номеру Шикимори — озвучки и адреса страниц серий;
//   2. страница серии — подписи d_sign / pd_sign / ref_sign и признаки видео;
//   3. POST /ftor — сами адреса HLS, зашифрованные.
//
// Шифр простой: сдвиг латинских букв по кругу, затем base64. Величина сдвига
// в код не попадает даже подсказкой: служба меняет её без предупреждения,
// а перебор 1..25 стоит доли миллисекунды. Удачный сдвиг живёт до конца
// запуска и всегда пробуется первым.
//
// Сами ссылки не кэшируются нигде: они живут считанные часы, и протухшая
// вместо отказа даёт чёрный экран. Кэшируется только выборка озвучек:
// адреса страниц серий постоянные.
//
// ПРО material_data. Первый шаг заодно просит сводку по тайтлу: русское имя,
// описание и число вышедших серий. Стоит это ноль запросов — поле приезжает
// в том же ответе поиска, который делается перед просмотром и так. Взято оно
// на замену тому, что раньше приходило из манами: датасет теперь собирается
// перечислением каталога Шикимори, и у части тайтлов русского имени в нём
// нет вовсе. Постер и кадры сознательно не берутся: они лежат на i.kodik.biz,
// а новый хост потребовал бы правки прав оболочки ради картинки, которая
// экрану не нужна. И главное: ничего из этой сводки не попадает в файлы
// выпуска датасета и попасть не должно — это подсказка на один запуск,
// а не источник данных.

import { Bridge, type HttpResponse } from '@/bridge'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import type {
  VideoEpisode,
  VideoRequest,
  VideoSource,
  VideoStream,
  VideoTrack,
  VideoVoice,
} from '../core/video'
import { MAX_RATE_RETRIES, kodikLimiter } from './rate-limit'

/** Ключ поиска: он же лежит в открытых плеерах на сайтах-партнёрах. */
const TOKEN = '16f20d024a6fa20700b389c44d9ab159'

const SEARCH_BASE = 'https://kodik-api.com'
const PLAYER_BASE = 'https://kodikplayer.com'

/** Имя источника для учёта доступности: net-health про адреса не знает. */
export const NET_SOURCE_KODIK = 'kodik'
export const NET_LABEL_KODIK = 'Kodik'

/** Страница серии рассчитана на браузер: без этих двух заголовков бывает заглушка. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const REFERER = PLAYER_BASE + '/'

const REQUEST_TIMEOUT_MS = 12000
const RETRY_DELAY_MS = 1500

/** Сколько выборка озвучек живёт в памяти: за одно открытие её спросят трижды. */
const VOICES_MEMORY_MS = 600000

/** Перебор сдвига шифра: все варианты, кроме тождественного. */
const SHIFTS: number[] = Array.from({ length: 25 }, (_, i) => i + 1)

/**
 * Русским именем считается только кириллическое. У службы в title нередко
 * лежит латиница — её экран покажет и без нашей помощи, а вот подменять
 * ею русское имя из датасета нельзя.
 */
const CYRILLIC = /[А-Яа-яЁё]/

/** Запись серии в ответе поиска: с with_episodes_data это объект, без него — строка. */
interface KodikEpisodeData {
  link?: string | null
  title?: string | null
}

type KodikEpisodeValue = string | KodikEpisodeData | null

interface KodikSeason {
  link?: string | null
  episodes?: Record<string, KodikEpisodeValue> | null
}

interface KodikTranslation {
  id?: number | null
  title?: string | null
}

/**
 * Сводка по тайтлу с with_material_data. Полей у службы куда больше, здесь
 * объявлены только те, что действительно читаются: остальные пришлось бы
 * поддерживать без нужды.
 */
interface KodikMaterialData {
  anime_title?: string | null
  title?: string | null
  anime_description?: string | null
  description?: string | null
  episodes_aired?: number | null
  episodes_total?: number | null
}

interface KodikResult {
  id?: string | null
  type?: string | null
  link?: string | null
  translation?: KodikTranslation | null
  episodes_count?: number | null
  seasons?: Record<string, KodikSeason | null> | null
  material_data?: KodikMaterialData | null
}

interface KodikSearchResponse {
  results?: KodikResult[] | null
}

/** Ответ /ftor: карта высота → список адресов, где нужен первый. */
interface FtorLink {
  src?: string | null
}

interface FtorResponse {
  links?: Record<string, FtorLink[] | null> | null
}

/** Серия после разбора поиска: номер и адрес её страницы. */
interface KodikEpisodeRow {
  number: number
  link: string
  title?: string
}

/** Озвучка после разбора: у службы она и есть отдельная запись поиска. */
interface KodikVoiceRow {
  id: string
  label: string
  episodes: KodikEpisodeRow[]
}

/**
 * Сводка по тайтлу наружу. Любое поле вправе быть null: служба заполняет
 * material_data как придётся, и отсутствие имени — обычное дело, а не сбой.
 */
export interface KodikMaterial {
  russianTitle: string | null
  description: string | null
  episodesAired: number | null
  episodesTotal: number | null
}

/** Что даёт один ответ поиска: озвучки и сводка приезжают вместе. */
interface KodikFound {
  voices: KodikVoiceRow[]
  material: KodikMaterial | null
}

/** Подписи и признаки со страницы серии — всё, что нужно для /ftor. */
interface PageFields {
  d: string
  dSign: string
  pd: string
  pdSign: string
  ref: string
  refSign: string
  type: string
  hash: string
  id: string
}

const foundMemory = new Map<number, { at: number; found: KodikFound }>()
const pendingFound = new Map<number, Promise<KodikFound>>()

/** Удачный сдвиг прошлого разбора. Ноль — ещё ни разу не встречался. */
let knownShift = 0

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Общая отправка. Никогда не отклоняется: любая неудача — null и запись
 * в журнал. Коды вне 2xx мост исключением не считает, разбираем сами.
 */
async function send(
  options: { method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: string },
  note: string,
  attempt = 0,
): Promise<HttpResponse | null> {
  let res: HttpResponse
  // Замер идёт вместе с ожиданием слота: важно, сколько ждал экран.
  const startedAt = Date.now()
  try {
    await kodikLimiter.acquireSlot()

    res = await Bridge.http.request({
      method: options.method,
      url: options.url,
      headers: options.headers,
      body: options.body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      credentials: 'omit',
    })
  } catch (e) {
    // Сюда приходит только транспортный сбой, таймаут или отмена.
    Logger('ERROR', `Kodik: сеть не дала ответ (${note})`, e)
    reportError(NET_SOURCE_KODIK, NET_LABEL_KODIK, e, Date.now() - startedAt)
    return null
  }

  reportStatus(NET_SOURCE_KODIK, NET_LABEL_KODIK, res.status, Date.now() - startedAt)

  if (res.status === 429) {
    const waitMs = RETRY_DELAY_MS + Math.floor(Math.random() * 500)
    kodikLimiter.pause(waitMs)

    if (attempt + 1 >= MAX_RATE_RETRIES) {
      Logger('ERROR', `Kodik: лимит 429 не отпустил (${note})`, { attempts: attempt + 1 })
      return null
    }

    Logger('WARN', `Kodik 429: пауза ${waitMs}мс, повтор ${attempt + 2}/${MAX_RATE_RETRIES}`)
    return send(options, note, attempt + 1)
  }

  if (res.status !== 200) {
    Logger('ERROR', `Kodik: HTTP ${res.status} (${note})`)
    return null
  }

  return res
}

function parseJson<T>(text: string, note: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch (e) {
    Logger('ERROR', `Kodik: ответ не разобрался (${note})`, e)
    return null
  }
}

/** Адреса у службы приходят без схемы: //kodikplayer.com/seria/... */
function absolute(link: string): string {
  if (link.startsWith('//')) return 'https:' + link
  if (link.startsWith('/')) return PLAYER_BASE + link
  return link
}

/** Тело form-urlencoded своими руками: URLSearchParams в общем слое не объявлен. */
function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

/** Непустая строка или null: у службы пустое поле и отсутствие поля равнозначны. */
function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Положительное число или null: нули у службы означают «неизвестно». */
function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Сводка из material_data. Собирается по всем записям поиска, а не по первой:
 * тайтл у них один, а поле у одной озвучки бывает пустым, у соседней — полным.
 * Каждое поле берётся у первой записи, где оно есть; имя, кроме того, обязано
 * быть кириллическим.
 */
function toMaterial(results: KodikResult[]): KodikMaterial | null {
  const found: KodikMaterial = {
    russianTitle: null,
    description: null,
    episodesAired: null,
    episodesTotal: null,
  }

  for (const item of results) {
    const data = item.material_data
    if (!data) continue

    if (found.russianTitle === null) {
      const name = textOrNull(data.anime_title) ?? textOrNull(data.title)
      if (name !== null && CYRILLIC.test(name)) found.russianTitle = name
    }

    found.description ??=
      textOrNull(data.anime_description) ?? textOrNull(data.description)
    found.episodesAired ??= countOrNull(data.episodes_aired)
    found.episodesTotal ??= countOrNull(data.episodes_total)
  }

  const empty =
    found.russianTitle === null &&
    found.description === null &&
    found.episodesAired === null &&
    found.episodesTotal === null

  return empty ? null : found
}

/**
 * Значение var со страницы. Пустая строка — законное значение, а не отсутствие:
 * страница, открытая без ссылающейся стороны, кладёт var ref = "" и подпись
 * ставит ровно на пустой строке. Поэтому [^"']* : с плюсом «пусто» неотличимо
 * от «переменной нет вовсе», и цепочка обрывалась на ровном месте.
 */
function pickVar(html: string, name: string): string | null {
  const found = new RegExp(`var\\s+${name}\\s*=\\s*["']([^"']*)["']`).exec(html)
  return found?.[1] ?? null
}

function pickInfo(html: string, name: string): string | null {
  const found = new RegExp(`vInfo\\.${name}\\s*=\\s*["']([^"']+)["']`).exec(html)
  return found?.[1] ?? null
}

/**
 * Собирает подписи со страницы. Признаки видео берутся из vInfo, а если его
 * переименуют — из самого адреса страницы: он те же три значения и несёт.
 *
 * Обязательны только подписи и признаки. Сами domain, pd и ref вправе быть
 * пустыми: страница подписывает то, что в себя положила, пустую строку в том
 * числе, и /ftor такую пару принимает.
 */
function readPage(html: string, pageUrl: string): PageFields | null {
  const path = /\/(video|seria|serial)\/(\d+)\/([0-9a-z]+)/i.exec(pageUrl)

  const fields: PageFields = {
    d: pickVar(html, 'domain') ?? pickVar(html, 'd') ?? '',
    dSign: pickVar(html, 'd_sign') ?? '',
    pd: pickVar(html, 'pd') ?? '',
    pdSign: pickVar(html, 'pd_sign') ?? '',
    ref: pickVar(html, 'ref') ?? '',
    refSign: pickVar(html, 'ref_sign') ?? '',
    type: pickInfo(html, 'type') ?? path?.[1] ?? '',
    id: pickInfo(html, 'id') ?? path?.[2] ?? '',
    hash: pickInfo(html, 'hash') ?? path?.[3] ?? '',
  }

  const needed: Array<keyof PageFields> = ['dSign', 'pdSign', 'refSign', 'type', 'id', 'hash']
  const empty = needed.filter((key) => fields[key] === '')

  if (empty.length > 0) {
    Logger('ERROR', `Kodik: на странице серии нет полей: ${empty.join(', ')}`, {
      length: html.length,
    })
    return null
  }

  return fields
}

/** Сдвиг латинских букв по кругу внутри своего регистра. */
function shiftLetters(text: string, by: number): string {
  return text.replace(/[a-zA-Z]/g, (letter) => {
    const limit = letter <= 'Z' ? 90 : 122
    const next = letter.charCodeAt(0) + by
    return String.fromCharCode(limit >= next ? next : next - 26)
  })
}

/** Свой base64: atob в общем слое не объявлен, а подключать DOM ради одной строки незачем. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function fromBase64(text: string): string | null {
  let bits = 0
  let acc = 0
  let out = ''

  for (const letter of text) {
    if (letter === '=') break

    const value = B64.indexOf(letter)
    if (value < 0) return null

    acc = (acc << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((acc >> bits) & 255)
    }
  }

  return out
}

/**
 * Расшифровывает адрес из /ftor. Изредка служба отдаёт его открытым — так же
 * решает и чужой плеер: если в строке есть //, она уже адрес.
 */
function decodeLink(src: string): string | null {
  if (src.includes('//')) return src

  const order = knownShift > 0 ? [knownShift, ...SHIFTS.filter((k) => k !== knownShift)] : SHIFTS

  for (const by of order) {
    const plain = fromBase64(shiftLetters(src, by))
    if (plain === null || !plain.includes('.m3u8')) continue
    if (!plain.startsWith('//') && !plain.startsWith('http')) continue

    if (by !== knownShift) {
      Logger('API', `Kodik: сдвиг шифра сейчас ${by}`)
      knownShift = by
    }
    return plain
  }

  return null
}

/**
 * Срок годности из самого адреса: подпись вида :2026090118/ — час смерти
 * по Гринвичу. Замерено до конца: ссылка с меткой 18 отдавала поток
 * в 20:59:43 МСК и ответила 403 в 21:00:13, то есть ровно в 18:00 UTC.
 * Жила она около четырёх часов, но верить надо метке, а не длительности:
 * час выдачи в неё округляется вверх, и запас у разных ссылок разный.
 *
 * Нет подписи — null: пусть лучше плеер споткнётся об отказ CDN, чем мы
 * придумаем срок.
 */
function expiryOf(url: string): number | null {
  const found = /:(\d{10})\//.exec(url)
  const stamp = found?.[1]
  if (stamp === undefined) return null

  const year = Number(stamp.slice(0, 4))
  const month = Number(stamp.slice(4, 6))
  const day = Number(stamp.slice(6, 8))
  const hour = Number(stamp.slice(8, 10))
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null

  return Date.UTC(year, month - 1, day, hour)
}

/**
 * Дорожки из ответа /ftor. Один и тот же адрес часто лежит под двумя высотами
 * сразу: на замере 480 и 720 вели на один файл 480.mp4. Две кнопки на один фаил —
 * обман, поэтому адреса сворачиваются, а высотой берётся меньшая из заявленных.
 */
function toTracks(links: Record<string, FtorLink[] | null> | null | undefined): VideoTrack[] {
  const byUrl = new Map<string, number>()

  for (const [key, list] of Object.entries(links ?? {})) {
    const height = Number.parseInt(key, 10)
    const src = list?.[0]?.src
    if (!Number.isFinite(height) || typeof src !== 'string' || src === '') continue

    const plain = decodeLink(src)
    if (plain === null) {
      Logger('WARN', `Kodik: адрес ${key}p не расшифровался ни одним сдвигом`)
      continue
    }

    const url = absolute(plain)
    const known = byUrl.get(url)
    if (known === undefined || height < known) byUrl.set(url, height)
  }

  return [...byUrl.entries()]
    .map(([url, height]) => ({ height, url }))
    .sort((a, b) => b.height - a.height)
}

/** Серии одной записи поиска: сезоны по порядку, фильм — одной серией. */
function episodesOf(item: KodikResult): KodikEpisodeRow[] {
  const rows: KodikEpisodeRow[] = []
  const seasons = Object.entries(item.seasons ?? {}).sort(
    (a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10),
  )

  for (const [, season] of seasons) {
    for (const [key, value] of Object.entries(season?.episodes ?? {})) {
      const number = Number.parseInt(key, 10)
      const link = typeof value === 'string' ? value : (value?.link ?? '')
      const title = typeof value === 'string' ? null : (value?.title ?? null)
      if (!Number.isFinite(number) || link === '') continue
      if (rows.some((row) => row.number === number)) continue

      rows.push({ number, link, ...(title ? { title } : {}) })
    }
  }

  // Фильм сезонов не имеет вовсе: его адрес лежит в самой записи.
  if (rows.length === 0 && typeof item.link === 'string' && item.link !== '') {
    rows.push({ number: 1, link: item.link })
  }

  return rows.sort((a, b) => a.number - b.number)
}

/** Собирает озвучки из ответа поиска: запись на каждую озвучку своя. */
function toVoices(results: KodikResult[]): KodikVoiceRow[] {
  const rows = new Map<string, KodikVoiceRow>()

  for (const item of results) {
    const id = item.translation?.id
    const key = typeof id === 'number' ? String(id) : (item.translation?.title ?? '')
    if (key === '') continue

    const episodes = episodesOf(item)
    if (episodes.length === 0) {
      Logger('WARN', `Kodik: у записи ${item.id ?? key} нет ни одного адреса серии`)
      continue
    }

    const known = rows.get(key)
    const row = known ?? {
      id: key,
      label: item.translation?.title ?? `Озвучка ${key}`,
      episodes: [],
    }

    for (const episode of episodes) {
      if (!row.episodes.some((e) => e.number === episode.number)) row.episodes.push(episode)
    }

    row.episodes.sort((a, b) => a.number - b.number)
    rows.set(key, row)
  }

  // Самые полные озвучки выше: выбирать из пяти легче, когда первая годная.
  return [...rows.values()].sort((a, b) => b.episodes.length - a.episodes.length)
}

/**
 * Ответ поиска по номеру Шикимори. Десять минут живёт в памяти целиком:
 * озвучки и сводка приезжают одним ответом, и разделять их значило бы
 * спрашивать службу дважды об одном.
 */
async function loadFound(shikimoriId: number): Promise<KodikFound> {
  const known = foundMemory.get(shikimoriId)
  if (known && Date.now() - known.at < VOICES_MEMORY_MS) return known.found

  const pending = pendingFound.get(shikimoriId)
  if (pending) return pending

  const task = loadFoundUncached(shikimoriId)
  pendingFound.set(shikimoriId, task)

  try {
    const found = await task
    foundMemory.set(shikimoriId, { at: Date.now(), found })
    return found
  } finally {
    pendingFound.delete(shikimoriId)
  }
}

async function loadFoundUncached(shikimoriId: number): Promise<KodikFound> {
  Logger('API', `Запрос Kodik для Shikimori ID: ${shikimoriId}`)

  const query = [
    'token=' + TOKEN,
    'shikimori_id=' + String(shikimoriId),
    'with_seasons=true',
    'with_episodes=true',
    'with_episodes_data=true',
    'with_material_data=true',
  ].join('&')

  const res = await send({ method: 'GET', url: `${SEARCH_BASE}/search?${query}` }, 'поиск')
  if (res === null) return { voices: [], material: null }

  const found = parseJson<KodikSearchResponse>(res.text, 'поиск')
  const results = found?.results ?? []

  return { voices: toVoices(results), material: toMaterial(results) }
}

/** Озвучки по номеру Шикимори: та же память, что и у сводки. */
async function loadVoices(shikimoriId: number): Promise<KodikVoiceRow[]> {
  const found = await loadFound(shikimoriId)
  return found.voices
}

/**
 * Сводка по тайтлу. Своих запросов не делает: либо отдаёт уже полученное,
 * либо тянет тот же поиск, что нужен для озвучек. Null — служба тайтл
 * не знает или material_data не заполнила; это не сбой.
 */
export async function kodikMaterial(shikimoriId: number): Promise<KodikMaterial | null> {
  if (!Number.isFinite(shikimoriId) || shikimoriId <= 0) return null

  const found = await loadFound(shikimoriId)
  return found.material
}

/** Подписи со страницы серии. Запрашивается в последний момент и не кэшируется. */
async function loadPageFields(pageUrl: string): Promise<PageFields | null> {
  const res = await send(
    { method: 'GET', url: pageUrl, headers: { 'User-Agent': UA, Referer: REFERER } },
    'страница серии',
  )
  if (res === null) return null

  return readPage(res.text, pageUrl)
}

/** Сами адреса: подписи едут тем же видом, что их отправляет сам плеер. */
async function askFtor(pageUrl: string, fields: PageFields): Promise<VideoTrack[]> {
  const body = formBody({
    d: fields.d,
    d_sign: fields.dSign,
    pd: fields.pd,
    pd_sign: fields.pdSign,
    ref: fields.ref,
    ref_sign: fields.refSign,
    bad_user: 'false',
    cdn_is_working: 'true',
    type: fields.type,
    hash: fields.hash,
    id: fields.id,
  })

  const res = await send(
    {
      method: 'POST',
      url: PLAYER_BASE + '/ftor',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
        Referer: pageUrl,
      },
      body,
    },
    'ссылки',
  )
  if (res === null) return []

  const found = parseJson<FtorResponse>(res.text, 'ссылки')
  const tracks = toTracks(found?.links)

  // Отказ подписи и пустой ответ извне выглядят одинаково: пишем различимое.
  if (tracks.length === 0) {
    Logger('WARN', 'Kodik: /ftor ответил без пригодных адресов', {
      length: res.text.length,
      keys: Object.keys(found?.links ?? {}),
    })
  }

  return tracks
}

/** Источник целиком. В реестр он попадает из api/video-sources.ts, а не отсюда. */
export const kodikSource: VideoSource = {
  id: 'kodik',
  label: NET_LABEL_KODIK,

  async listVoices(req: VideoRequest): Promise<VideoVoice[]> {
    // Вход у службы только по номеру Шикимори: поиск по названию уводит в чужой сезон.
    const id = req.shikimoriId
    if (id === null || id <= 0) {
      Logger('WARN', `Kodik: у тайтла ${req.anilistId} нет номера Шикимори`)
      return []
    }

    const rows = await loadVoices(id)
    return rows.map((row) => ({ id: row.id, label: row.label, episodes: row.episodes.length }))
  },

  async listEpisodes(req: VideoRequest, voiceId: string): Promise<VideoEpisode[]> {
    const id = req.shikimoriId
    if (id === null || id <= 0) return []

    const rows = await loadVoices(id)
    const row = rows.find((r) => r.id === voiceId)

    // Отрезки заставки и титров служба держит на странице серии, а не в поиске:
    // читать их сейчас значило бы скачать страницу каждой серии заранее.
    return (row?.episodes ?? []).map((episode) => ({
      number: episode.number,
      ...(episode.title ? { title: episode.title } : {}),
    }))
  },

  async resolve(req: VideoRequest, voiceId: string, episode: number): Promise<VideoStream | null> {
    const id = req.shikimoriId
    if (id === null || id <= 0) return null

    const rows = await loadVoices(id)
    const row = rows.find((r) => r.id === voiceId)
    const found = row?.episodes.find((e) => e.number === episode)

    if (!found) {
      Logger('WARN', `Kodik: у озвучки ${voiceId} нет серии ${episode}`)
      return null
    }

    const pageUrl = absolute(found.link)

    try {
      const fields = await loadPageFields(pageUrl)
      if (fields === null) return null

      const tracks = await askFtor(pageUrl, fields)
      const preferred = tracks[0]
      if (preferred === undefined) {
        Logger('WARN', `Kodik: ответ по серии ${episode} без ни одного годного адреса`)
        return null
      }

      return { source: 'kodik', tracks, preferred, expiresAt: expiryOf(preferred.url) }
    } catch (e) {
      // Цепочка длинная, и любой её шаг вправе рассыпаться: молча не уйдёт.
      Logger('ERROR', `Kodik: цепочка серии ${episode} не прошла: ${describe(e)}`, e)
      return null
    }
  },
}

/** Только для проверок и кнопки очистки кэша: память сама себя не чистит. */
export function forgetKodikVoices(): void {
  foundMemory.clear()
  pendingFound.clear()
  knownShift = 0
}
