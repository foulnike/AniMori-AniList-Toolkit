// Витрина каталога для главной: сезон, тренды, лучшее и подбор по жанрам,
// советы «по мотивам» и жанры тайтлов для профиля вкуса (пункт 3.11).
// Отдельно от anilist-media.ts: тот у потолка, а дело здесь самостоятельное.

import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import type { MediaBrief } from './anilist-media'

/** Сколько плиток просит полка: длинный ряд всё равно не листают до конца. */
const SHELF_SIZE = 14

/** Сколько советов просим у семени: после склейки повторов останется меньше. */
const SEED_PAGE = 25

/** Потолок страницы у AniList — пятьдесят записей за запрос. */
const LOOKUP_PAGE_SIZE = 50

// Поля плитки без записи хозяина: свои метки витрина ставит по памяти (3.14).
// Вид тайтла спрашивается не ради показа, а ради отбора: в советах сервера
// анимеи и манга лежат вперемешку, и отсеивать её надо по ответу.
const BRIEF_FIELDS = `
      id
      idMal
      type
      format
      status
      episodes
      seasonYear
      averageScore
      isAdult
      nextAiringEpisode {
        episode
        airingAt
      }
      title {
        romaji
        english
        native
      }
      coverImage {
        large
        medium
        color
      }`

/** Виды полок витрины: отбор и порядок зашиты в запрос, а не в вызов. */
export type ShelfKind = 'airing' | 'trending' | 'top' | 'genre'

const SHELF_WHERE: Record<ShelfKind, string> = {
  airing: 'season: $season, seasonYear: $seasonYear, sort: [POPULARITY_DESC]',
  trending: 'sort: [TRENDING_DESC]',
  top: 'sort: [SCORE_DESC]',
  genre: 'genre_in: $genres, sort: [SCORE_DESC]',
}

// Лишняя переменная в объявлении роняет весь запрос: собирается своя под вид.
// Сам вид тайтла вписан словом: полка манги в приложении не бывает, а через
// переменную ошибка вызова тихо вернула бы её на главную.
function shelfQuery(kind: ShelfKind): string {
  let extra = ''
  if (kind === 'airing') extra = ', $season: MediaSeason, $seasonYear: Int'
  if (kind === 'genre') extra = ', $genres: [String]'

  return `query ($perPage: Int!${extra}) {
  Page(page: 1, perPage: $perPage) {
    media(type: ANIME, ${SHELF_WHERE[kind]}) {
${BRIEF_FIELDS}
    }
  }
}`
}

const RECS_QUERY = `query ($id: Int!, $perPage: Int!) {
  Media(id: $id) {
    recommendations(sort: RATING_DESC, page: 1, perPage: $perPage) {
      edges {
        node {
          rating
          mediaRecommendation {
${BRIEF_FIELDS}
          }
        }
      }
    }
  }
}`

const GENRE_QUERY = `query ($ids: [Int], $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(id_in: $ids, type: ANIME) {
      id
      genres
    }
  }
}`

/** Ближайшая серия: номер и срок выхода в секундах. */
interface AiringReply {
  episode?: number | null
  airingAt?: number | null
}

interface BriefReply {
  id?: number
  idMal?: number | null
  type?: string | null
  format?: string | null
  status?: string | null
  episodes?: number | null
  seasonYear?: number | null
  averageScore?: number | null
  isAdult?: boolean | null
  nextAiringEpisode?: AiringReply | null
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
  coverImage?: { large?: string | null; medium?: string | null; color?: string | null } | null
}

interface ShelfReply {
  Page?: { media?: Array<BriefReply | null> | null } | null
}

interface RecsReply {
  Media?: {
    recommendations?: {
      edges?: Array<{
        node?: { rating?: number | null; mediaRecommendation?: BriefReply | null } | null
      } | null> | null
    } | null
  } | null
}

interface GenreReply {
  Page?: {
    media?: Array<{ id?: number; genres?: Array<string | null> | null } | null> | null
  } | null
}

/** Совет сервера: плитка и вес связи. Вес нужен склейке повторов. */
export interface ServerRec {
  brief: MediaBrief
  rating: number
}

/** Целое положительное или `null`: чужие пустоты в нули превращать нельзя. */
function countOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Ответ сервера о тайтле в плитку показа. Без номера — не запись.
 *
 * Манга отбрасывается здесь, а не у вызывающего: полки спрашивают аниме сами,
 * но советы сервера мешают виды, и один пропущенный отбор снова привёл бы
 * мангу на главную. Число глав больше не читается: у аниме его не бывает.
 */
function toBrief(item: BriefReply | null | undefined): MediaBrief | null {
  if (!item || typeof item.id !== 'number') return null
  if (item.type === 'MANGA') return null

  return {
    mediaId: item.id,
    malId: countOrNull(item.idMal),
    type: 'ANIME',
    format: textOrNull(item.format),
    status: textOrNull(item.status),
    episodes: countOrNull(item.episodes),
    chapters: null,
    seasonYear: countOrNull(item.seasonYear),
    averageScore: countOrNull(item.averageScore),
    isAdult: item.isAdult === true,
    romaji: textOrNull(item.title?.romaji),
    english: textOrNull(item.title?.english),
    native: textOrNull(item.title?.native),
    cover: textOrNull(item.coverImage?.large) ?? textOrNull(item.coverImage?.medium),
    color: textOrNull(item.coverImage?.color),
    airingEpisode: countOrNull(item.nextAiringEpisode?.episode),
    airingAt: countOrNull(item.nextAiringEpisode?.airingAt),
    ownEntry: null,
  }
}

/** Текущий сезон года для полки «Сейчас выходит». */
export function currentSeason(): { season: string; seasonYear: number } {
  const now = new Date()
  const month = now.getMonth()
  const season = month <= 2 ? 'WINTER' : month <= 5 ? 'SPRING' : month <= 8 ? 'SUMMER' : 'FALL'
  return { season, seasonYear: now.getFullYear() }
}

/**
 * Полка каталога одним запросом. Отказ — пустой массив: полка просто не встанет.
 *
 * Аргумент вида игнорируется: вид вписан в запрос словом. Параметр стоит
 * в середине и уйдёт вместе с вызовами в ядре.
 */
export async function fetchShelf(
  kind: ShelfKind,
  _type: string | undefined,
  genres?: string[],
): Promise<MediaBrief[]> {
  if (kind === 'genre' && (genres === undefined || genres.length === 0)) return []

  const vars: Record<string, unknown> = { perPage: SHELF_SIZE }
  if (kind === 'airing') Object.assign(vars, currentSeason())
  if (kind === 'genre') vars.genres = genres

  const reply = await anilistQuery<ShelfReply>(shelfQuery(kind), vars)
  const media = reply.data?.Page?.media
  if (!Array.isArray(media)) {
    Logger('WARN', `Витрина «${kind}»: сервер ответил пустотой`, reply.errors)
    return []
  }

  const items: MediaBrief[] = []
  for (const item of media) {
    const brief = toBrief(item)
    if (brief) items.push(brief)
  }

  Logger('API', `Витрина «${kind}»: пришло ${items.length}`)
  return items
}

/**
 * Советы сервера для семени «по мотивам». Мангу отсеивает разбор ответа,
 * поэтому отбор по виду здесь больше не нужен.
 */
export async function fetchRecsFor(mediaId: number, _type?: string): Promise<ServerRec[]> {
  const reply = await anilistQuery<RecsReply>(RECS_QUERY, { id: mediaId, perPage: SEED_PAGE })
  const edges = reply.data?.Media?.recommendations?.edges
  if (!Array.isArray(edges)) {
    Logger('WARN', `Советы для ${mediaId}: сервер ответил пустотой`, reply.errors)
    return []
  }

  const found: ServerRec[] = []
  for (const edge of edges) {
    const node = edge?.node
    const brief = toBrief(node?.mediaRecommendation)
    if (brief === null) continue
    found.push({ brief, rating: typeof node?.rating === 'number' ? node.rating : 0 })
  }

  Logger('API', `Советы для ${mediaId}: пришло ${found.length}`)
  return found
}

/**
 * Жанры тайтлов пачками: профиль вкуса считается по любимым записям.
 * Аргумент вида игнорируется: в запросе стоит слово ANIME.
 */
export async function fetchGenreMap(
  ids: number[],
  _type?: string,
): Promise<Map<number, string[]>> {
  const found = new Map<number, string[]>()
  const unique = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))

  for (let from = 0; from < unique.length; from += LOOKUP_PAGE_SIZE) {
    const chunk = unique.slice(from, from + LOOKUP_PAGE_SIZE)
    const reply = await anilistQuery<GenreReply>(GENRE_QUERY, {
      ids: chunk,
      perPage: LOOKUP_PAGE_SIZE,
    })

    const media = reply.data?.Page?.media
    if (!Array.isArray(media)) {
      // Пачка потеряна, но соседние могут дойти: обрывать обход незачем.
      Logger('WARN', `Жанры: пустой ответ на пачку из ${chunk.length}`, reply.errors)
      continue
    }

    for (const item of media) {
      if (!item || typeof item.id !== 'number' || !Array.isArray(item.genres)) continue
      const genres = item.genres.filter((g): g is string => typeof g === 'string' && g !== '')
      found.set(item.id, genres)
    }
  }

  return found
}
