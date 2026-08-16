// Выписки тайтлов AniList по чужим номерам MyAnimeList.
// Нужно для поиска на кириллице: русское слово ищет Шикимори, а живём мы на AniList.
// Отдельно от anilist-media.ts: тот вырос до предела, а дело здесь самостоятельное.

import type { MediaType } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import type { MediaBrief, ServerEntry } from './anilist-media'

/** Потолок страницы у AniList — пятьдесят записей за запрос. */
const LOOKUP_PAGE_SIZE = 50

// Те же поля, что у поиска по слову: выдача на экране одна и та же,
// различается только то, по чему сервер искал.
const BY_MAL_QUERY = `query ($ids: [Int], $type: MediaType, $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(idMal_in: $ids, type: $type) {
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

interface OwnReply {
  status?: string | null
  score?: number | null
  progress?: number | null
  progressVolumes?: number | null
}

interface LookupReply {
  Page?: {
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

/** Целое положительное или `null`: чужие пустоты в нули превращать нельзя. */
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
 * Выписки тайтлов по номерам MAL. Порядок ответа — порядок спрошенных
 * номеров: сортировка поиска живёт у того, кто искал, а сервер о ней не знает.
 * Запрос идёт с ключом: без него не видно, что тайтл уже в своём списке.
 */
export async function fetchBriefsByMal(malIds: number[], type: MediaType): Promise<MediaBrief[]> {
  const wanted = Array.from(new Set(malIds.filter((id) => Number.isFinite(id) && id > 0)))
  if (wanted.length === 0) return []

  const byMal = new Map<number, MediaBrief>()

  for (let from = 0; from < wanted.length; from += LOOKUP_PAGE_SIZE) {
    const chunk = wanted.slice(from, from + LOOKUP_PAGE_SIZE)
    const reply = await anilistQuery<LookupReply>(
      BY_MAL_QUERY,
      { ids: chunk, type, perPage: LOOKUP_PAGE_SIZE },
      true,
    )

    const media = reply.data?.Page?.media
    if (!Array.isArray(media)) {
      // Пачка потеряна, но соседние могут дойти: обрывать обход незачем.
      Logger('WARN', `Выписки по MAL: пустой ответ на пачку из ${chunk.length}`, reply.errors)
      continue
    }

    for (const item of media) {
      if (!item || typeof item.id !== 'number') continue

      const malId = countOrNull(item.idMal)
      if (malId === null) continue

      byMal.set(malId, {
        mediaId: item.id,
        malId,
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
  }

  // Порядок собирается по списку спрошенного: так лучшая находка останется сверху.
  const ordered: MediaBrief[] = []
  for (const malId of wanted) {
    const brief = byMal.get(malId)
    if (brief) ordered.push(brief)
  }

  Logger('API', `Выписки по MAL: спросили ${wanted.length}, нашли ${ordered.length}`)
  return ordered
}
