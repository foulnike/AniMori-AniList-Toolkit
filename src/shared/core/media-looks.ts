// Облик тайтла для сетки постеров: обложка, цвет и счёт частей.
// Снимок списка картинок не держит, поэтому вид живёт отдельно: память, склад, сеть.
// Хозяин обликов: экранам не надо знать, пришла обложка со склада или из сети.

import { CACHE_TIME } from './constants'
import { dbGet, dbSet } from './db'
import { fetchBriefsByIds } from '../api/anilist-lookup'
import type { MediaBrief } from '../api/anilist-media'
import { Logger } from '../utils/logger'
import type { MediaType, ShikiCacheRecord } from './types'

/** Префикс ключа на складе. Цифра — версия формы записи, а не номер источника. */
const KEY_PREFIX = 'LOOK2_'

/** По скольку тайтлов спрашиваем за раз: потолок страницы у AniList. */
const LOOK_CHUNK = 50

/**
 * Внешность тайтла. Названия здесь запасные: русские имена и описания
 * держит media-title, а здесь то, без чего плитка не рисуется.
 */
export interface MediaLook {
  cover: string | null
  color: string | null
  format: string | null
  seasonYear: number | null
  episodes: number | null
  chapters: number | null
  averageScore: number | null
  romaji: string | null
  english: string | null
  /** Номер серии, которая ещё только выйдет. У завершённого его нет. */
  airingEpisode: number | null
  /** Срок выхода той серии в секундах: по нему видно, что облик отстал. */
  airingAt: number | null
}

/** Знание этого запуска. `null` значит «спрашивали, сервер тайтла не знает». */
const memory = new Map<number, MediaLook | null>()

/**
 * Чьи ключи уже искали на складе. Отсутствие на складе не значит «облика нет»:
 * сеть спросить всё ещё стоит, а склад второй раз — уже нет.
 */
const asked = new Set<number>()

function cacheKey(mediaId: number): string {
  return `${KEY_PREFIX}${mediaId}`
}

/**
 * Сколько частей уже вышло. У манги это главы, у аниме — серии.
 *
 * У онгоинга объявленного итога часто нет вовсе, зато известен номер
 * ближайшей серии: вышло ровно на одну меньше. Без этого счёта
 * полоса у идущего сезона всегда стояла на нуле.
 */
export function partsOut(
  look: {
    episodes: number | null
    chapters: number | null
    airingEpisode: number | null
  } | null,
  type: MediaType,
): number | null {
  if (look === null) return null
  if (type === 'MANGA') return look.chapters

  const aired = look.airingEpisode === null ? null : look.airingEpisode - 1
  if (aired !== null && aired > 0) return aired

  return look.episodes
}

/**
 * Отстал ли облик от сетки выхода. Хранение бессрочное, поэтому у онгоинга
 * старение считается не по времени записи, а по сроку ближайшей серии.
 */
function airedOut(look: MediaLook): boolean {
  return look.airingAt !== null && look.airingAt * 1000 <= Date.now()
}

/** Читает облик со склада. Протухшая запись считается отсутствующей. */
async function readCache(mediaId: number): Promise<MediaLook | null> {
  asked.add(mediaId)

  const record = await dbGet<ShikiCacheRecord<MediaLook>>('shikiCache', cacheKey(mediaId))
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  const data = record.data
  if (!data || typeof data !== 'object') return null

  // Серия уже вышла: счёт в записи отстал, облик берётся из сети заново.
  if (airedOut(data)) return null

  return data
}

/** Кладёт облик на склад. Сама картинка не хранится — только её адрес. */
async function writeCache(mediaId: number, look: MediaLook): Promise<void> {
  await dbSet('shikiCache', { key: cacheKey(mediaId), data: look, ts: Date.now() })
}

/** Выписка сервера в облик: из ответа берётся только видимое глазу. */
function fromBrief(brief: MediaBrief): MediaLook {
  return {
    cover: brief.cover,
    color: brief.color,
    format: brief.format,
    seasonYear: brief.seasonYear,
    episodes: brief.episodes,
    chapters: brief.chapters,
    averageScore: brief.averageScore,
    romaji: brief.romaji,
    english: brief.english,
    airingEpisode: brief.airingEpisode,
    airingAt: brief.airingAt,
  }
}

/** Что известно прямо сейчас, без ожидания. Разметка ждать не умеет. */
export function peekLook(mediaId: number): MediaLook | null {
  return memory.get(mediaId) ?? null
}

/**
 * Запоминает облик, доставшийся даром вместе с находкой поиска.
 * Сети это не стоит ничего, а списки потом получат обложку без запроса.
 */
export function rememberBrief(brief: MediaBrief): void {
  const look = fromBrief(brief)
  memory.set(brief.mediaId, look)

  // Склад пишется вдогонку: ждать его ради отрисовки незачем.
  void writeCache(brief.mediaId, look).catch((e) => {
    Logger('WARN', `Облик: тайтл ${brief.mediaId} на склад не лёг`, e)
  })
}

/**
 * Готовит облик для показанного куска списка: сначала склад, потом сеть.
 * Сотня строк стоит двух запросов, а второй заход в ту же закладку — ни одного.
 */
export async function warmLooks(mediaIds: number[], type: MediaType): Promise<number> {
  const unknown: number[] = []

  for (const mediaId of mediaIds) {
    const known = memory.get(mediaId)

    // У онгоинга знание запуска тоже устаревает: окно живёт днями.
    if (known !== undefined && !(known !== null && airedOut(known))) continue

    if (!asked.has(mediaId)) {
      try {
        const cached = await readCache(mediaId)
        if (cached) {
          memory.set(mediaId, cached)
          continue
        }
      } catch (e) {
        // Склад мог не открыться: без него облик возьмём из сети.
        Logger('WARN', `Облик: склад не ответил по тайтлу ${mediaId}`, e)
      }
    }

    unknown.push(mediaId)
  }

  if (unknown.length === 0) return 0

  let added = 0

  for (let from = 0; from < unknown.length; from += LOOK_CHUNK) {
    const chunk = unknown.slice(from, from + LOOK_CHUNK)

    let briefs: MediaBrief[]
    try {
      briefs = await fetchBriefsByIds(chunk, type)
    } catch (e) {
      // Отказ сети не запоминаем: повторный заход на экран спросит снова.
      Logger('WARN', `Облик: пачка из ${chunk.length} не доехала`, e)
      break
    }

    const seen = new Set<number>()

    for (const brief of briefs) {
      const look = fromBrief(brief)
      memory.set(brief.mediaId, look)
      seen.add(brief.mediaId)
      added++
      await writeCache(brief.mediaId, look)
    }

    // Чего сервер не назвал в ответе на свою же пачку — того он не знает.
    for (const mediaId of chunk) {
      if (!seen.has(mediaId)) memory.set(mediaId, null)
    }
  }

  if (added > 0) Logger('INFO', `Облик: добыто ${added} из ${unknown.length}`)
  return added
}

/** Забывает знание запуска. Склад не трогается: его чистят из настроек. */
export function forgetLooks(): void {
  memory.clear()
  asked.clear()
}
