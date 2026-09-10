// Клиент Aniliberty (anilibria.top): открытый API без ключа и без шифрования.
// Адреса HLS лежат прямо в ответе полями hls_480/hls_720/hls_1080, подписи на них
// нет и срока годности у них тоже нет — поэтому expiresAt здесь всегда null.
//
// Чужих номеров служба не знает: ни AniList, ни MAL, ни Шикимори. Единственный
// путь к релизу — поиск по названию, а чтобы он не приводил в чужой сезон,
// совпадение требуется точное после нормализации, а год служит разводящим
// признаком. Найденный номер релиза кладётся в mediaCache и больше не ищется.
//
// ПОЧЕМУ ЗДЕСЬ НЕТ ВОПРОСА О НАЛИЧИИ
// askPresence здесь был и убран намеренно. Метка доступности спрашивает дорогие
// источники по правилу «дорогое вторым»: тайтл достаётся поштучной службе только
// после того, как оптовая о нём высказалась, а высказавшись «да», снимает тайтл
// с очереди совсем. Значит Aniliberty спрашивали ровно про то, чего нет у Kodik,
// — а у Kodik есть почти всё, что есть у Aniliberty, и наоборот неверно. Вопрос
// задавался там, где ответ заведомо отрицательный: вся цена, нулевая отдача.
//
// Вреда было больше, чем расхода. Метка «нет» ставится только когда высказались
// все адресуемые источники, поэтому каждый отказ Kodik ждал ещё и поиска по имени
// здесь, а молчание службы уводило тайтл в тишину на десять минут вовсе без метки.
//
// Источником для плеера служба остаётся полностью: другая озвучка, другой путь
// на случай, когда Kodik недоступен, и спрашивают её один раз — по прямому
// действию человека, а не сеткой на полторы сотни постеров. Редкий тайтл, который
// есть здесь и которого нет у Kodik, останется без метки, но откроется в плеере:
// это молчание, а не ложь, и такой размен здесь предпочтителен.
//
// Склад ALIB1_ остаётся при плеере: совпадение бессрочно, промах на сутки.

import { Bridge, type HttpResponse } from '@/bridge'
import { LIFE_ALIB_MATCH, LIFE_ALIB_MISS, isFresh } from '../core/cache-life'
import { dbGet, dbSet } from '../core/db'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from '../core/types'
import type {
  VideoEpisode,
  VideoRequest,
  VideoSource,
  VideoStream,
  VideoTrack,
  VideoVoice,
} from '../core/video'
import { anilibertyLimiter } from './rate-limit'

/** Адреса собраны конкатенацией: литерал схемы в шаблонной строке ломался. */
const API_BASE = 'https://anilibria.top/api/v1'
const SITE_BASE = 'https://anilibria.top'

/** Имя источника для учёта доступности: net-health про адреса не знает. */
export const NET_SOURCE_ANILIBERTY = 'aniliberty'
export const NET_LABEL_ANILIBERTY = 'AniLiberty'

/**
 * Пауза ограничителю после 429. Джиттер разводит одновременные карточки.
 * Повтора после паузы здесь нет: при MAX_RATE_RETRIES = 1 рекурсия была недостижима,
 * а мёртвый код обещает поведение, которого нет. Повторами распоряжается вызывающий:
 * плеер переспросит следующим названием.
 */
const RATE_PAUSE_MS = 1500
const REQUEST_TIMEOUT_MS = 10000

/** Сколько релиз живёт в памяти: за одно открытие экран спросит его трижды. */
const RELEASE_MEMORY_MS = 600000

/**
 * Сколько названий пробуем в поиске: романдзи и ещё одно запасное. Второе имя
 * стоит одного запроса и спасает от «ничего не нашлось» — а платит за него
 * человек, который сам открыл плеер, а не полка из полутора сотен плиток.
 */
const SEARCH_TRIES = 2

interface AniName {
  main?: string | null
  english?: string | null
  alternative?: string | null
}

interface AniSkip {
  start?: number | null
  stop?: number | null
}

interface AniEpisode {
  id?: string
  name?: string | null
  ordinal?: number | null
  duration?: number | null
  opening?: AniSkip | null
  ending?: AniSkip | null
  hls_480?: string | null
  hls_720?: string | null
  hls_1080?: string | null
}

interface AniRelease {
  id?: number
  alias?: string | null
  year?: number | null
  name?: AniName | null
  episodes?: Array<AniEpisode | null> | null
}

/** Ответ поиска: либо голый список, либо он же в обёртке data. */
type AniSearchResponse = AniRelease[] | { data?: AniRelease[] | null }

/** Что ложится в склад: только соответствие тайтла релизу, без самих ссылок. */
interface AniMatchRecord {
  release: string | null
}

const releaseMemory = new Map<string, { at: number; release: AniRelease }>()
const pendingRelease = new Map<string, Promise<AniRelease | null>>()
const pendingMatch = new Map<number, Promise<AniRelease | null>>()

/** Ключ склада соответствия. */
function matchKey(anilistId: number): string {
  return `ALIB1_${anilistId}`
}

/**
 * Годна ли запись соответствия. Найденный релиз бессрочен, промах — на сутки:
 * сегодня озвучки нет, завтра есть. Сроки живут в core/cache-life.ts, потому что
 * там же разброс по ключу: иначе вся полка протухла бы одновременно.
 */
function matchFresh(key: string, record: MediaCacheRecord<AniMatchRecord>): boolean {
  const life = record.data.release ? LIFE_ALIB_MATCH : LIFE_ALIB_MISS
  return isFresh(key, record.ts, life)
}

/** Общий запрос к API. Никогда не отклоняется: любая неудача — null и запись в журнал. */
async function apiGet<T>(path: string, note: string): Promise<T | null> {
  let res: HttpResponse
  // Замер идёт вместе с ожиданием слота: важно, сколько ждал экран, а не сервер.
  const startedAt = Date.now()
  try {
    await anilibertyLimiter.acquireSlot()

    res = await Bridge.http.request({
      method: 'GET',
      url: API_BASE + path,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
  } catch (e) {
    // Сюда приходит только транспортный сбой, таймаут или отмена.
    Logger('ERROR', `Aniliberty: сеть не дала ответ (${note})`, e)
    reportError(NET_SOURCE_ANILIBERTY, NET_LABEL_ANILIBERTY, e, Date.now() - startedAt)
    return null
  }

  reportStatus(NET_SOURCE_ANILIBERTY, NET_LABEL_ANILIBERTY, res.status, Date.now() - startedAt)

  // Код вне 2xx мост исключением не считает, поэтому статусы разбираем сами.
  if (res.status === 429) {
    const waitMs = RATE_PAUSE_MS + Math.floor(Math.random() * 500)
    anilibertyLimiter.pause(waitMs)

    Logger('ERROR', `Aniliberty: лимит 429, пауза ${waitMs}мс (${note})`)
    return null
  }

  // 404 у поиска и релиза значит «такого нет» — это ответ, а не ошибка.
  if (res.status === 404) return null

  if (res.status !== 200) {
    Logger('ERROR', `Aniliberty: HTTP ${res.status} (${note})`)
    return null
  }

  try {
    return JSON.parse(res.text) as T
  } catch (e) {
    Logger('ERROR', `Aniliberty: ответ не разобрался (${note})`, e)
    return null
  }
}

/** Название без знаков и регистра: только буквы, цифры и одинарные пробелы. */
function plain(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function releaseNames(release: AniRelease): string[] {
  const name = release.name ?? {}
  return [name.main, name.english, name.alternative].filter((s): s is string => !!s)
}

function releaseKey(release: AniRelease): string {
  return release.id ? String(release.id) : (release.alias ?? '')
}

/** Совпадает ли релиз с тайтлом. Год — разводящий признак для одноимённых сезонов. */
function matches(release: AniRelease, wanted: string[], year?: number): boolean {
  const names = releaseNames(release).map(plain)
  if (!wanted.some((w) => names.includes(w))) return false
  if (year && release.year && Math.abs(release.year - year) > 1) return false
  return true
}

/** Релиз целиком по номеру или псевдониму. Десять минут живёт в памяти. */
async function loadRelease(idOrAlias: string): Promise<AniRelease | null> {
  if (!idOrAlias) return null

  const known = releaseMemory.get(idOrAlias)
  if (known && Date.now() - known.at < RELEASE_MEMORY_MS) return known.release

  const pending = pendingRelease.get(idOrAlias)
  if (pending) return pending

  const task = apiGet<AniRelease>(
    '/anime/releases/' + encodeURIComponent(idOrAlias),
    'релиз ' + idOrAlias,
  )
  pendingRelease.set(idOrAlias, task)

  try {
    const release = await task
    if (release?.id) releaseMemory.set(idOrAlias, { at: Date.now(), release })
    return release
  } finally {
    pendingRelease.delete(idOrAlias)
  }
}

/** Ищет релиз по названиям. Первое точное совпадение и есть ответ. */
async function searchRelease(req: VideoRequest): Promise<AniRelease | null> {
  const wanted = req.titles.map(plain).filter(Boolean)
  if (wanted.length === 0) return null

  for (const title of req.titles.slice(0, SEARCH_TRIES)) {
    const found = await apiGet<AniSearchResponse>(
      '/app/search/releases?query=' + encodeURIComponent(title),
      'поиск ' + title,
    )
    const list = Array.isArray(found) ? found : (found?.data ?? [])
    const hit = list.find((r) => r && matches(r, wanted, req.year))
    if (hit) return hit
  }

  return null
}

/** Соответствие «наш тайтл → релиз»: сначала склад, потом поиск. */
async function findRelease(req: VideoRequest): Promise<AniRelease | null> {
  const pending = pendingMatch.get(req.anilistId)
  if (pending) return pending

  const task = findReleaseUncached(req)
  pendingMatch.set(req.anilistId, task)

  try {
    return await task
  } finally {
    pendingMatch.delete(req.anilistId)
  }
}

async function findReleaseUncached(req: VideoRequest): Promise<AniRelease | null> {
  const cacheKey = matchKey(req.anilistId)
  const cached = await dbGet<MediaCacheRecord<AniMatchRecord>>('mediaCache', cacheKey)

  if (cached && matchFresh(cacheKey, cached)) {
    const found = cached.data.release
    return found ? loadRelease(found) : null
  }

  Logger('API', `Запрос Aniliberty для AniList ID: ${req.anilistId}`)

  const hit = await searchRelease(req)
  const key = hit ? releaseKey(hit) : ''
  void dbSet('mediaCache', { key: cacheKey, data: { release: key || null }, ts: Date.now() })

  if (!hit) return null

  // Поиск отдаёт карточку без эпизодов, поэтому релиз читается целиком.
  return loadRelease(key)
}

/** Часть ссылок приходит путём без хоста — доставляем его сами. */
function absolute(link: string | null | undefined): string | null {
  if (!link) return null
  if (link.startsWith('http://') || link.startsWith('https://')) return link
  if (link.startsWith('//')) return 'https:' + link
  return SITE_BASE + (link.startsWith('/') ? '' : '/') + link
}

function toTracks(raw: AniEpisode): VideoTrack[] {
  const rows: Array<[number, string | null | undefined]> = [
    [1080, raw.hls_1080],
    [720, raw.hls_720],
    [480, raw.hls_480],
  ]

  const tracks: VideoTrack[] = []
  for (const [height, link] of rows) {
    const url = absolute(link)
    if (url) tracks.push({ height, url })
  }
  return tracks
}

function toSkip(
  raw: AniSkip | null | undefined,
): { startSec: number; stopSec: number } | undefined {
  const start = raw?.start
  const stop = raw?.stop
  if (typeof start !== 'number' || typeof stop !== 'number' || stop <= start) return undefined
  return { startSec: start, stopSec: stop }
}

function playableEpisodes(release: AniRelease | null): AniEpisode[] {
  return (release?.episodes ?? []).filter(
    (e): e is AniEpisode => !!e && typeof e.ordinal === 'number' && toTracks(e).length > 0,
  )
}

/**
 * Источник целиком. В реестр он попадает из api/video-sources.ts, а не отсюда.
 *
 * askPresence не объявлен намеренно — см. шапку файла. Метка доступности
 * такой источник не спрашивает вовсе и в решении «нет видео» его не учитывает.
 */
export const anilibertySource: VideoSource = {
  id: 'aniliberty',
  label: NET_LABEL_ANILIBERTY,

  async listVoices(req: VideoRequest): Promise<VideoVoice[]> {
    const release = await findRelease(req)
    const episodes = playableEpisodes(release)
    if (!release || episodes.length === 0) return []

    // Озвучка у службы всегда одна — своя собственная.
    return [{ id: releaseKey(release), label: NET_LABEL_ANILIBERTY, episodes: episodes.length }]
  },

  async listEpisodes(_req: VideoRequest, voiceId: string): Promise<VideoEpisode[]> {
    const release = await loadRelease(voiceId)
    return playableEpisodes(release).map((raw) => ({
      number: raw.ordinal as number,
      title: raw.name ?? undefined,
      durationSec: typeof raw.duration === 'number' ? raw.duration : undefined,
      opening: toSkip(raw.opening),
      ending: toSkip(raw.ending),
    }))
  },

  async resolve(_req: VideoRequest, voiceId: string, episode: number): Promise<VideoStream | null> {
    const release = await loadRelease(voiceId)
    const raw = playableEpisodes(release).find((e) => e.ordinal === episode)
    if (!raw) {
      Logger('WARN', `Aniliberty: в релизе ${voiceId} нет эпизода ${episode}`)
      return null
    }

    const tracks = toTracks(raw)
    const preferred = tracks[0]
    if (!preferred) return null

    // Срока годности у ссылок нет: они без подписи и живут, пока жив релиз.
    return { source: 'aniliberty', tracks, preferred, expiresAt: null }
  },
}

/** Только для проверок и кнопки очистки кэша: память сама себя не чистит. */
export function forgetAnilibertyReleases(): void {
  releaseMemory.clear()
}
