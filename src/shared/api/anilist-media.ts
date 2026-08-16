// Соответствие номеров AniList и MyAnimeList, подробности тайтла и поиск.
// Отдельно от anilist-list.ts: там записи пользователя, здесь сами тайтлы.
// Запрос номеров пакетный: вся коллекция поодиночке сожгла бы темп целиком.

import type { MediaType } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'

/** Сколько тайтлов просим одним запросом. Потолок страницы у AniList — пятьдесят. */
const PAGE_SIZE = 50

/** Сколько находок на странице поиска. Больше одного экрана всё равно не читают. */
export const SEARCH_PAGE_SIZE = 20

const MAL_QUERY = `query ($ids: [Int], $type: MediaType, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(id_in: $ids, type: $type) {
      id
      idMal
    }
  }
}`

// Подробности карточки. Запись списка спрашиваем вместе с тайтлом: один
// запрос вместо двух, а сверка с памятью покажет неушедшие правки.
const CARD_QUERY = `query ($id: Int!) {
  Media(id: $id) {
    id
    idMal
    type
    format
    status
    episodes
    chapters
    volumes
    duration
    averageScore
    seasonYear
    genres
    isAdult
    siteUrl
    description(asHtml: false)
    title {
      romaji
      english
      native
    }
    coverImage {
      large
    }
    mediaListEntry {
      status
      score(format: POINT_10_DECIMAL)
      progress
      progressVolumes
    }
  }
}`

// Поиск по слову. Закладка хозяина идёт тем же запросом: в выдаче
// надо сразу видеть, что из найденного уже в своём списке.
const SEARCH_QUERY = `query ($word: String!, $type: MediaType, $page: Int!, $perPage: Int!) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      hasNextPage
      total
    }
    media(search: $word, type: $type, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
      id
      idMal
      type
      format
      status
      episodes
      chapters
      seasonYear
      averageScore
      isAdult
      title {
        romaji
        english
        native
      }
      coverImage {
        medium
      }
      mediaListEntry {
        status
        score(format: POINT_10_DECIMAL)
        progress
        progressVolumes
      }
    }
  }
}`

interface MalReply {
  Page?: {
    media?: Array<{ id?: number; idMal?: number | null } | null> | null
  } | null
}

interface OwnReply {
  status?: string | null
  score?: number | null
  progress?: number | null
  progressVolumes?: number | null
}

interface CardReply {
  Media?: {
    id?: number
    idMal?: number | null
    type?: string | null
    format?: string | null
    status?: string | null
    episodes?: number | null
    chapters?: number | null
    volumes?: number | null
    duration?: number | null
    averageScore?: number | null
    seasonYear?: number | null
    genres?: Array<string | null> | null
    isAdult?: boolean | null
    siteUrl?: string | null
    description?: string | null
    title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
    coverImage?: { large?: string | null } | null
    mediaListEntry?: OwnReply | null
  } | null
}

interface SearchReply {
  Page?: {
    pageInfo?: { hasNextPage?: boolean | null; total?: number | null } | null
    media?: Array<{
      id?: number
      idMal?: number | null
      type?: string | null
      format?: string | null
      status?: string | null
      episodes?: number | null
      chapters?: number | null
      seasonYear?: number | null
      averageScore?: number | null
      isAdult?: boolean | null
      title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
      coverImage?: { medium?: string | null } | null
      mediaListEntry?: OwnReply | null
    } | null> | null
  } | null
}

/** Запись списка глазами сервера. Нужна для сверки с нашей памятью. */
export interface ServerEntry {
  status: string | null
  score10: number
  progress: number
  volumes: number
}

/**
 * Подробности тайтла для карточки. В снимке этого нет и не будет:
 * снимок держит состояние списка, а описания и обложки — складское дело.
 */
export interface MediaCard {
  mediaId: number
  malId: number | null
  type: MediaType
  format: string | null
  status: string | null
  episodes: number | null
  chapters: number | null
  volumes: number | null
  duration: number | null
  averageScore: number | null
  seasonYear: number | null
  genres: string[]
  isAdult: boolean
  siteUrl: string | null
  description: string | null
  romaji: string | null
  english: string | null
  native: string | null
  cover: string | null
  /** Запись в списке хозяина или `null`, если тайтл в списке не числится. */
  ownEntry: ServerEntry | null
}

/**
 * Короткая выписка тайтла для выдачи поиска. Отдельный вид от карточки:
 * в строке списка описание и жанры ни к чему, а вес ответа важен.
 */
export interface MediaBrief {
  mediaId: number
  malId: number | null
  type: MediaType
  format: string | null
  status: string | null
  episodes: number | null
  chapters: number | null
  seasonYear: number | null
  averageScore: number | null
  isAdult: boolean
  romaji: string | null
  english: string | null
  native: string | null
  cover: string | null
  ownEntry: ServerEntry | null
}

/** Страница находок. Общего числа у AniList может и не быть — тогда `null`. */
export interface SearchPage {
  items: MediaBrief[]
  hasNext: boolean
  total: number | null
}

/**
 * Номера MAL для набора тайтлов AniList. Ключ соответствия — номер AniList.
 * Тайтлы без номера MAL в ответ не попадают: русского источника для них нет.
 */
export async function fetchMalIds(ids: number[], type: MediaType): Promise<Map<number, number>> {
  const found = new Map<number, number>()
  const unique = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))

  for (let from = 0; from < unique.length; from += PAGE_SIZE) {
    const chunk = unique.slice(from, from + PAGE_SIZE)
    const reply = await anilistQuery<MalReply>(MAL_QUERY, {
      ids: chunk,
      type,
      perPage: PAGE_SIZE,
    })

    const media = reply.data?.Page?.media
    if (!Array.isArray(media)) {
      // Пачка потеряна, но соседние могут дойти: обрывать обход смысла нет.
      Logger('WARN', `Соответствия MAL: пустой ответ на пачку из ${chunk.length}`)
      continue
    }

    for (const item of media) {
      if (!item || typeof item.id !== 'number') continue
      if (typeof item.idMal === 'number' && item.idMal > 0) found.set(item.id, item.idMal)
    }
  }

  if (unique.length > 0) {
    Logger('API', `Соответствия MAL: спросили ${unique.length}, нашли ${found.size}`)
  }

  return found
}

/** Целое неотрицательное или `null`: чужие пустоты в числа превращать нельзя. */
function countOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Запись хозяина из ответа сервера. Пустота значит «тайтла в списке нет». */
function ownOrNull(own: OwnReply | null | undefined): ServerEntry | null {
  if (!own) return null

  return {
    status: textOrNull(own.status),
    score10: typeof own.score === 'number' ? own.score : 0,
    progress: typeof own.progress === 'number' ? own.progress : 0,
    volumes: typeof own.progressVolumes === 'number' ? own.progressVolumes : 0,
  }
}

/**
 * Подробности одного тайтла и запись хозяина в нём. Запрос идёт с ключом:
 * без входа сервер отдаст тайтл, но про запись ответит пустотой.
 */
export async function fetchMediaCard(mediaId: number): Promise<MediaCard | null> {
  const reply = await anilistQuery<CardReply>(CARD_QUERY, { id: mediaId }, true)

  const media = reply.data?.Media
  if (!media || typeof media.id !== 'number') {
    Logger('WARN', `Карточка ${mediaId}: сервер тайтл не назвал`, reply.errors)
    return null
  }

  return {
    mediaId: media.id,
    malId: countOrNull(media.idMal),
    // Тип решает всё дальше: и подписи, и раздел русского источника.
    type: media.type === 'MANGA' ? 'MANGA' : 'ANIME',
    format: textOrNull(media.format),
    status: textOrNull(media.status),
    episodes: countOrNull(media.episodes),
    chapters: countOrNull(media.chapters),
    volumes: countOrNull(media.volumes),
    duration: countOrNull(media.duration),
    averageScore: countOrNull(media.averageScore),
    seasonYear: countOrNull(media.seasonYear),
    genres: Array.isArray(media.genres)
      ? media.genres.filter((genre): genre is string => typeof genre === 'string' && genre !== '')
      : [],
    isAdult: media.isAdult === true,
    siteUrl: textOrNull(media.siteUrl),
    description: textOrNull(media.description),
    romaji: textOrNull(media.title?.romaji),
    english: textOrNull(media.title?.english),
    native: textOrNull(media.title?.native),
    cover: textOrNull(media.coverImage?.large),
    ownEntry: ownOrNull(media.mediaListEntry),
  }
}

/**
 * Поиск тайтлов по слову. Запрос с ключом, иначе в выдаче не будет видно,
 * что тайтл уже в списке. Пустое слово сеть не тревожит.
 */
export async function searchMedia(
  word: string,
  type: MediaType,
  page = 1,
): Promise<SearchPage | null> {
  const asked = word.trim()
  if (asked === '') return { items: [], hasNext: false, total: 0 }

  const reply = await anilistQuery<SearchReply>(
    SEARCH_QUERY,
    { word: asked, type, page, perPage: SEARCH_PAGE_SIZE },
    true,
  )

  const found = reply.data?.Page
  if (!found || !Array.isArray(found.media)) {
    Logger('WARN', `Поиск «${asked}»: сервер ответил пустотой`, reply.errors)
    return null
  }

  const items: MediaBrief[] = []
  for (const item of found.media) {
    if (!item || typeof item.id !== 'number') continue

    items.push({
      mediaId: item.id,
      malId: countOrNull(item.idMal),
      type: item.type === 'MANGA' ? 'MANGA' : 'ANIME',
      format: textOrNull(item.format),
      status: textOrNull(item.status),
      episodes: countOrNull(item.episodes),
      chapters: countOrNull(item.chapters),
      seasonYear: countOrNull(item.seasonYear),
      averageScore: countOrNull(item.averageScore),
      isAdult: item.isAdult === true,
      romaji: textOrNull(item.title?.romaji),
      english: textOrNull(item.title?.english),
      native: textOrNull(item.title?.native),
      cover: textOrNull(item.coverImage?.medium),
      ownEntry: ownOrNull(item.mediaListEntry),
    })
  }

  Logger('API', `Поиск «${asked}»: страница ${page}, нашлось ${items.length}`)

  return {
    items,
    hasNext: found.pageInfo?.hasNextPage === true,
    total: countOrNull(found.pageInfo?.total),
  }
}
