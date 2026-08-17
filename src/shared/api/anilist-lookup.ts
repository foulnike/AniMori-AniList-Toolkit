// Выписки тайтлов AniList: по чужим номерам MyAnimeList и по своим номерам.
// Первое нужно поиску на кириллице, второе — постерам своего списка.
// Отдельно от anilist-media.ts: тот вырос до предела, а дело здесь самостоятельное.

import type { MediaType } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import type { MediaBrief, ServerEntry } from './anilist-media'

/** Потолок страницы у AniList — пятьдесят записей за запрос. */
const LOOKUP_PAGE_SIZE = 50

/** По какому полю сервер отбирает пачку: чужие номера MAL или свои номера. */
type LookupField = 'idMal_in' | 'id_in'

// Тело запроса одно на два пути: поля выписки совпадают с поиском
// по слову, различается только то, по чему сервер отбирал.
// Ближайшая серия нужна счёту онгоинга: итога у него ещё нет.
function lookupQuery(field: LookupField): string {
  return `query ($ids: [Int], $type: MediaType, $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(${field}: $ids, type: $type) {
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
}

interface OwnReply {
  status?: string | null
  score?: number | null
  progress?: number | null
  progressVolumes?: number | null
}

/** Ближайшая серия: номер и срок выхода в секундах. */
interface AiringReply {
  episode?: number | null
  airingAt?: number | null
}

interface MediaReply {
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
  nextAiringEpisode?: AiringReply | null
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
  coverImage?: { large?: string | null; medium?: string | null; color?: string | null } | null
  mediaListEntry?: OwnReply | null
}

interface LookupReply {
  Page?: {
    media?: Array<MediaReply | null> | null
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

/**
 * Запись хозяина из ответа сервера. Пустота значит «тайтла в списке нет».
 *
 * Пересмотры, даты и комментарий у сервера здесь не спрашиваются и приезжают
 * пустыми: выписки идут пачками по пятьдесят тайтлов ради обложек и вида,
 * а правда по записи живёт в снимке и в карточке тайтла.
 */
function ownOrNull(own: OwnReply | null | undefined): ServerEntry | null {
  if (!own) return null

  return {
    status: textOrNull(own.status),
    score10: typeof own.score === 'number' ? own.score : 0,
    progress: typeof own.progress === 'number' ? own.progress : 0,
    volumes: typeof own.progressVolumes === 'number' ? own.progressVolumes : 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
  }
}

/** Ответ сервера о одном тайтле в выписку показа. Без номера — не запись. */
function toBrief(item: MediaReply | null): MediaBrief | null {
  if (!item || typeof item.id !== 'number') return null

  return {
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
    airingEpisode: countOrNull(item.nextAiringEpisode?.episode),
    airingAt: countOrNull(item.nextAiringEpisode?.airingAt),
    romaji: textOrNull(item.title?.romaji),
    english: textOrNull(item.title?.english),
    native: textOrNull(item.title?.native),
    cover: textOrNull(item.coverImage?.large) ?? textOrNull(item.coverImage?.medium),
    color: textOrNull(item.coverImage?.color),
    ownEntry: ownOrNull(item.mediaListEntry),
  }
}

/** Список без повторов и без мусора: серверу отправлять его и так пачками. */
function cleanIds(ids: number[]): number[] {
  return Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))
}

/**
 * Обход пачками по выбранному полю отбора. Запрос идёт с ключом:
 * без него не видно, что тайтл уже в своём списке.
 */
async function lookupBriefs(
  field: LookupField,
  wanted: number[],
  type: MediaType,
): Promise<MediaBrief[]> {
  const query = lookupQuery(field)
  const found: MediaBrief[] = []

  for (let from = 0; from < wanted.length; from += LOOKUP_PAGE_SIZE) {
    const chunk = wanted.slice(from, from + LOOKUP_PAGE_SIZE)
    const reply = await anilistQuery<LookupReply>(
      query,
      { ids: chunk, type, perPage: LOOKUP_PAGE_SIZE },
      true,
    )

    const media = reply.data?.Page?.media
    if (!Array.isArray(media)) {
      // Пачка потеряна, но соседние могут дойти: обрывать обход незачем.
      Logger('WARN', `Выписки: пустой ответ на пачку из ${chunk.length}`, reply.errors)
      continue
    }

    for (const item of media) {
      const brief = toBrief(item)
      if (brief) found.push(brief)
    }
  }

  return found
}

/**
 * Выписки тайтлов по номерам MAL. Порядок ответа — порядок спрошенных
 * номеров: сортировка поиска живёт у того, кто искал, а сервер о ней не знает.
 */
export async function fetchBriefsByMal(malIds: number[], type: MediaType): Promise<MediaBrief[]> {
  const wanted = cleanIds(malIds)
  if (wanted.length === 0) return []

  const byMal = new Map<number, MediaBrief>()
  for (const brief of await lookupBriefs('idMal_in', wanted, type)) {
    if (brief.malId !== null) byMal.set(brief.malId, brief)
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

/**
 * Выписки тайтлов по своим номерам AniList. Нужно спискам: снимок держит
 * только состояние записей, а обложки и вид приходят сюда пачками.
 */
export async function fetchBriefsByIds(mediaIds: number[], type: MediaType): Promise<MediaBrief[]> {
  const wanted = cleanIds(mediaIds)
  if (wanted.length === 0) return []

  const found = await lookupBriefs('id_in', wanted, type)

  Logger('API', `Выписки по номерам: спросили ${wanted.length}, нашли ${found.length}`)
  return found
}
