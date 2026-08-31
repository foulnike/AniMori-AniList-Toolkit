// Соответствие номеров AniList и MyAnimeList, подробности тайтла, поиск
// и работы студий. Отдельно от anilist-list.ts: там записи пользователя,
// здесь сами тайтлы. Запрос номеров пакетный: поодиночке темп сгорит.

import type { MediaType } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'

/** Сколько тайтлов просим одним запросом. Потолок страницы у AniList — пятьдесят. */
const PAGE_SIZE = 50

/** Сколько находок на странице поиска. Больше одного экрана всё равно не читают. */
export const SEARCH_PAGE_SIZE = 20

/**
 * Сколько работ студии просим за заход. Двадцать семь, а не двадцать, как
 * у поиска: на широком окне сетка постеров встаёт по девять в ряд, и число,
 * не кратное девяти, оставляло последнюю строку рваной. Двадцать семь дают
 * ровно три полных ряда, а на узком окне лишнее просто уходит ниже сгиба.
 */
export const STUDIO_PAGE_SIZE = 27

/** Дедупликация работ студии: сервер может повторить title при выпуске страницы. */
function dedupeBriefs(items: MediaBrief[]): MediaBrief[] {
  const seen = new Set<number>()
  const out: MediaBrief[] = []
  for (const item of items) {
    if (seen.has(item.mediaId)) continue
    seen.add(item.mediaId)
    out.push(item)
  }
  return out
}

/** MAL-соответствия живут весь запуск: один тайтл нужен нескольким виджетам. */
const malMemory = new Map<number, number | null>()
let malInFlight: Promise<void> | null = null

// Вид вписан словом, а не вынесен в переменную: переменная была единственным
// местом, где ошибка вызова привела бы мангу обратно в ответ.
const MAL_QUERY = `query ($ids: [Int], $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(id_in: $ids, type: ANIME) {
      id
      idMal
    }
  }
}`

// Подробности карточки. Запись списка спрашиваем вместе с тайтлом: один
// запрос вместо двух, а сверка с памятью покажет неушедшие правки.
// Баннер и цвет обложки — для крупного вида: без них карточка серая.
// Ближайшая серия — для счёта вышедшего у идущего сезона.
// Пересмотры, даты и комментарий нужны окну правки: оно открывается из карточки
// и своих запросов не делает.
// Глав, томов и прочитанных томов здесь больше нет: аниме их не имеет.
const CARD_QUERY = `query ($id: Int!) {
  Media(id: $id) {
    id
    idMal
    type
    format
    status
    episodes
    duration
    averageScore
    seasonYear
    genres
    isAdult
    siteUrl
    bannerImage
    description(asHtml: false)
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
      extraLarge
      large
      color
    }
    studios {
      edges {
        isMain
        node {
          id
          name
        }
      }
    }
    mediaListEntry {
      status
      score(format: POINT_10_DECIMAL)
      progress
      repeat
      notes
      startedAt {
        year
        month
        day
      }
      completedAt {
        year
        month
        day
      }
    }
  }
}`

// Поиск по слову. Закладка хозяина идёт тем же запросом: в выдаче
// надо сразу видеть, что из найденного уже в своём списке.
// Обложка просится large: в сетке постеров medium заметно мылится.
// Пересмотры, даты и комментарий здесь не спрашиваются: в плитке их не видно,
// а ответ на двадцать находок тяжелеет зазря.
const SEARCH_QUERY = `query ($word: String!, $page: Int!, $perPage: Int!) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      hasNextPage
      total
    }
    media(search: $word, type: ANIME, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
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
      }
      mediaListEntry {
        status
        score(format: POINT_10_DECIMAL)
        progress
      }
    }
  }
}`

// Работы студии для её экрана. Запись хозяина не просится: свои метки
// плитка ставит по памяти, а ответ с mediaListEntry тяжелеет зазря.
const STUDIO_QUERY = `query ($id: Int!, $page: Int!, $perPage: Int!) {
  Studio(id: $id) {
    id
    name
    media(page: $page, perPage: $perPage, sort: POPULARITY_DESC) {
      pageInfo {
        hasNextPage
        total
      }
      nodes {
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
        }
      }
    }
  }
}`

interface MalReply {
  Page?: {
    media?: Array<{ id?: number; idMal?: number | null } | null> | null
  } | null
}

/** Нечёткая дата сервера: тройка чисел, любое из которых может быть пустым. */
interface FuzzyReply {
  year?: number | null
  month?: number | null
  day?: number | null
}

/** Ближайшая серия: номер и срок выхода в секундах. */
interface AiringReply {
  episode?: number | null
  airingAt?: number | null
}

interface OwnReply {
  status?: string | null
  score?: number | null
  progress?: number | null
  repeat?: number | null
  notes?: string | null
  startedAt?: FuzzyReply | null
  completedAt?: FuzzyReply | null
}

/** Край связи со студией: основная отмечена у самого края. */
interface StudioEdgeReply {
  isMain?: boolean | null
  node?: { id?: number; name?: string | null } | null
}

/** Выписка тайтла в ответе: одна форма у поиска и у списка работ студии. */
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
  mediaListEntry?: OwnReply | null
}

interface CardReply {
  Media?: {
    id?: number
    idMal?: number | null
    type?: string | null
    format?: string | null
    status?: string | null
    episodes?: number | null
    duration?: number | null
    averageScore?: number | null
    seasonYear?: number | null
    genres?: Array<string | null> | null
    isAdult?: boolean | null
    siteUrl?: string | null
    bannerImage?: string | null
    description?: string | null
    nextAiringEpisode?: AiringReply | null
    title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
    coverImage?: {
      extraLarge?: string | null
      large?: string | null
      color?: string | null
    } | null
    studios?: { edges?: Array<StudioEdgeReply | null> | null } | null
    mediaListEntry?: OwnReply | null
  } | null
}

interface SearchReply {
  Page?: {
    pageInfo?: { hasNextPage?: boolean | null; total?: number | null } | null
    media?: Array<BriefReply | null> | null
  } | null
}

interface StudioReply {
  Studio?: {
    id?: number
    name?: string | null
    media?: {
      pageInfo?: { hasNextPage?: boolean | null; total?: number | null } | null
      nodes?: Array<BriefReply | null> | null
    } | null
  } | null
}

/**
 * Запись списка глазами сервера. Нужна для сверки с нашей памятью.
 *
 * В выдаче поиска новые поля не спрашиваются и приезжают пустыми: это не ошибка,
 * а осознанная экономия веса ответа; правка таких полей идёт только из карточки.
 *
 * Поле томов — остаток от времён манги: сервер о нём больше не спрашивают,
 * и оно всегда ноль. Уйдёт вместе с его читателями в слое показа.
 */
export interface ServerEntry {
  status: string | null
  score10: number
  progress: number
  volumes: number
  repeat: number
  /** Вид ГГГГ-ММ-ДД или null, если дата неполная или её нет. */
  startedAt: string | null
  completedAt: string | null
  notes: string | null
}

/** Студия тайтла: номер нужен переходу к её работам внутри приложения. */
export interface StudioRef {
  studioId: number
  name: string
  /** Основная студия производства по классификации сервера. */
  main: boolean
}

/**
 * Подробности тайтла для карточки. В снимке этого нет и не будет:
 * снимок держит состояние списка, а описания и обложки — складское дело.
 *
 * Главы и тома осталисы в описании пустыми полями: их ещё читает слой
 * показа, а убирать их надо вместе с ним, одним шагом.
 */
export interface MediaCard {
  mediaId: number
  malId: number | null
  type: MediaType
  format: string | null
  status: string | null
  episodes: number | null
  /** Глав у аниме не бывает: всегда null. */
  chapters: number | null
  /** Томов у аниме не бывает: всегда null. */
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
  /** Широкая картинка для верха карточки. Есть далеко не у всех тайтлов. */
  banner: string | null
  /** Основной цвет обложки: подложка и подсветка крупного вида. */
  color: string | null
  /** Номер серии, которая ещё только выйдет. У завершённого его нет. */
  airingEpisode: number | null
  /** Срок выхода той серии в секундах. */
  airingAt: number | null
  /** Студии тайтла, основная первой. */
  studios: StudioRef[]
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
  /** Глав у аниме не бывает: всегда null. */
  chapters: number | null
  seasonYear: number | null
  averageScore: number | null
  isAdult: boolean
  romaji: string | null
  english: string | null
  native: string | null
  cover: string | null
  /** Основной цвет обложки: подложка плитки, пока картинка не приехала. */
  color: string | null
  /** Номер серии, которая ещё только выйдет: вышло на одну меньше. */
  airingEpisode: number | null
  /** Срок выхода той серии в секундах: по нему видно, что облик отстал. */
  airingAt: number | null
  ownEntry: ServerEntry | null
}

/** Страница находок. Общего числа у AniList может и не быть — тогда `null`. */
export interface SearchPage {
  items: MediaBrief[]
  hasNext: boolean
  total: number | null
}

/** Страница работ студии для её экрана. */
export interface StudioPage {
  name: string
  items: MediaBrief[]
  hasNext: boolean
  total: number | null
  /** Сколько уникальных работ показано после текущей страницы. */
  known: number
}

/**
 * Номера MAL для набора тайтлов AniList. Ключ соответствия — номер AniList.
 * Тайтлы без номера MAL в ответ не попадают: русского источника для них нет.
 */
export async function fetchMalIds(ids: number[]): Promise<Map<number, number>> {
  const unique = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))
  const found = new Map<number, number>()
  const unknown = unique.filter((id) => !malMemory.has(id))

  if (unknown.length > 0) {
    if (malInFlight) await malInFlight

    const remaining = unique.filter((id) => !malMemory.has(id))
    if (remaining.length > 0) {
      malInFlight = (async () => {
        for (let from = 0; from < remaining.length; from += PAGE_SIZE) {
          const chunk = remaining.slice(from, from + PAGE_SIZE)
          const reply = await anilistQuery<MalReply>(MAL_QUERY, {
            ids: chunk,
            perPage: PAGE_SIZE,
          })

          const media = reply.data?.Page?.media
          if (!Array.isArray(media)) {
            Logger('WARN', `Соответствия MAL: пустой ответ на пачку из ${chunk.length}`)
            continue
          }

          const seen = new Set<number>()
          for (const item of media) {
            if (!item || typeof item.id !== 'number') continue
            seen.add(item.id)
            malMemory.set(
              item.id,
              typeof item.idMal === 'number' && item.idMal > 0 ? item.idMal : null,
            )
          }
          for (const id of chunk) {
            if (!seen.has(id)) malMemory.set(id, null)
          }
        }
      })()
      try {
        await malInFlight
      } finally {
        malInFlight = null
      }
    }
  }

  for (const id of unique) {
    const malId = malMemory.get(id)
    if (malId !== null && malId !== undefined) found.set(id, malId)
  }

  if (unique.length > 0) {
    Logger('API', `Соответствия MAL: спросили ${unique.length}, нашли ${found.size}`)
  }

  return found
}

/** Запоминает уже полученную пару из подробной карточки. */
function rememberMalId(mediaId: number, malId: number | null): void {
  if (mediaId > 0) malMemory.set(mediaId, malId)
}

/** Целое неотрицательное или `null`: чужие пустоты в числа превращать нельзя. */
function countOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Две цифры для даты. Свой помощник дешевле втягивания библиотеки дат. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Нечёткая дата сервера в вид ГГГГ-ММ-ДД. Неполная дата считается отсутствующей:
 * поле даты в окне правки ждёт ровно такой вид, а «только год» показать негде.
 */
function readFuzzy(date: FuzzyReply | null | undefined): string | null {
  if (!date) return null

  const { year, month, day } = date
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return null
  if (year <= 0 || month <= 0 || day <= 0) return null

  return `${year}-${pad(month)}-${pad(day)}`
}

/**
 * Запись хозяина из ответа сервера. Пустота значит «тайтла в списке нет».
 * Тома всегда ноль: у аниме их нет, и сервер о них больше не спрашивают.
 */
function ownOrNull(own: OwnReply | null | undefined): ServerEntry | null {
  if (!own) return null

  return {
    status: textOrNull(own.status),
    score10: typeof own.score === 'number' ? own.score : 0,
    progress: typeof own.progress === 'number' ? own.progress : 0,
    volumes: 0,
    repeat: typeof own.repeat === 'number' ? own.repeat : 0,
    startedAt: readFuzzy(own.startedAt),
    completedAt: readFuzzy(own.completedAt),
    notes: textOrNull(own.notes),
  }
}

/** Студии из ответа: безымянные и битые отброшены, основная едет первой. */
function readStudios(edges: Array<StudioEdgeReply | null> | null | undefined): StudioRef[] {
  if (!Array.isArray(edges)) return []

  const studios: StudioRef[] = []
  for (const edge of edges) {
    if (!edge?.node || typeof edge.node.id !== 'number') continue
    const name = textOrNull(edge.node.name)
    if (name === null) continue
    studios.push({ studioId: edge.node.id, name, main: edge.isMain === true })
  }

  studios.sort((a, b) => Number(b.main) - Number(a.main))
  return studios
}

/** Выписка сервера в объект показа или `null`, если запись битая. */
function briefOrNull(item: BriefReply | null | undefined): MediaBrief | null {
  if (!item || typeof item.id !== 'number') return null

  return {
    mediaId: item.id,
    malId: countOrNull(item.idMal),
    // Сервер спрошен только про аниме, так что читать вид ответа незачем.
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
    ownEntry: ownOrNull(item.mediaListEntry),
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

  rememberMalId(media.id, countOrNull(media.idMal))

  return {
    mediaId: media.id,
    malId: countOrNull(media.idMal),
    // Вид всегда аниме: другие разделы приложение больше не открывает.
    type: 'ANIME',
    format: textOrNull(media.format),
    status: textOrNull(media.status),
    episodes: countOrNull(media.episodes),
    chapters: null,
    volumes: null,
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
    // Крупный размер первым: карточка показывает обложку большой.
    cover: textOrNull(media.coverImage?.extraLarge) ?? textOrNull(media.coverImage?.large),
    banner: textOrNull(media.bannerImage),
    color: textOrNull(media.coverImage?.color),
    airingEpisode: countOrNull(media.nextAiringEpisode?.episode),
    airingAt: countOrNull(media.nextAiringEpisode?.airingAt),
    studios: readStudios(media.studios?.edges),
    ownEntry: ownOrNull(media.mediaListEntry),
  }
}

/**
 * Поиск тайтлов по слову. Запрос с ключом, иначе в выдаче не будет видно,
 * что тайтл уже в списке. Пустое слово сеть не тревожит.
 */
export async function searchMedia(word: string, page = 1): Promise<SearchPage | null> {
  const asked = word.trim()
  if (asked === '') return { items: [], hasNext: false, total: 0 }

  const reply = await anilistQuery<SearchReply>(
    SEARCH_QUERY,
    { word: asked, page, perPage: SEARCH_PAGE_SIZE },
    true,
  )

  const found = reply.data?.Page
  if (!found || !Array.isArray(found.media)) {
    Logger('WARN', `Поиск «${asked}»: сервер ответил пустотой`, reply.errors)
    return null
  }

  const items: MediaBrief[] = []
  for (const item of found.media) {
    const brief = briefOrNull(item)
    if (brief) items.push(brief)
  }

  Logger('API', `Поиск «${asked}»: страница ${page}, нашлось ${items.length}`)

  return {
    items,
    hasNext: found.pageInfo?.hasNextPage === true,
    total: countOrNull(found.pageInfo?.total),
  }
}

/** Работы студии по популярности, страницами. Подпись не нужна: всё публичное. */
export async function fetchStudioWorks(
  studioId: number,
  page = 1,
  previous: ReadonlyArray<MediaBrief> = [],
): Promise<StudioPage | null> {
  const reply = await anilistQuery<StudioReply>(STUDIO_QUERY, {
    id: studioId,
    page,
    perPage: STUDIO_PAGE_SIZE,
  })

  const studio = reply.data?.Studio
  if (!studio || typeof studio.id !== 'number') {
    Logger('WARN', `Студия ${studioId}: сервер её не назвал`, reply.errors)
    return null
  }

  const knownIds = new Set<number>(previous.map((item) => item.mediaId))
  const items: MediaBrief[] = []
  const nodes = studio.media?.nodes
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const brief = briefOrNull(node)
      if (!brief || knownIds.has(brief.mediaId)) continue
      knownIds.add(brief.mediaId)
      items.push(brief)
    }
  }

  const total = countOrNull(studio.media?.pageInfo?.total)
  const unique = dedupeBriefs(items)
  const known = previous.length + unique.length

  Logger('API', `Студия ${studioId}: страница ${page}, новых работ ${items.length}`)

  return {
    name: textOrNull(studio.name) ?? `Студия #${studioId}`,
    items: unique,
    hasNext: studio.media?.pageInfo?.hasNextPage === true && unique.length > 0,
    total,
    known,
  }
}
