// Выписки тайтлов AniList: по чужим номерам MyAnimeList и по своим номерам.
// Первое нужно поиску на кириллице, второе — постерам своего списка.
// Отдельно от anilist-media.ts: тот вырос до предела, а дело здесь самостоятельное.
//
// Просьбы, пришедшие одновременно, уезжают одной пачкой: на главном экране
// выписки спрашивают сразу несколько полок, и каждая раньше брала свой
// запрос, хотя потолок страницы — пятьдесят тайтлов и три полки в него влезают.

import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import type { MediaBrief, ServerEntry } from './anilist-media'

/** Потолок страницы у AniList — пятьдесят записей за запрос. */
const LOOKUP_PAGE_SIZE = 50

/**
 * Сколько ждём соседних просьб, миллисекунды.
 *
 * Полки главного экрана просят выписки не строго одновременно, а вразброс по
 * ближайшим тикам, так что микрозадачей их не соберёшь. Пятьдесят миллисекунд
 * человеку незаметны и в любом случае меньше шага ограничителя темпа,
 * а выигрыш — целые запросы, которые вовсе не уедут.
 */
const MERGE_WINDOW_MS = 50

/**
 * Потолок копления: четыре полные страницы. Список на полтысячи тайтлов
 * ждать окна не должен: ему всё равно ехать многими пачками, и склеивать
 * его с соседями уже незачем.
 */
const MERGE_MAX_IDS = LOOKUP_PAGE_SIZE * 4

/** По какому полю сервер отбирает пачку: чужие номера MAL или свои номера. */
type LookupField = 'idMal_in' | 'id_in'

// Тело запроса одно на два пути: поля выписки совпадают с поиском
// по слову, различается только то, по чему сервер отбирал.
// Ближайшая серия нужна счёту онгоинга: итога у него ещё нет.
// Вид вписан словом ANIME: отбор по номерам чужой вид не исключает, и через
// переменную ошибка вызова тихо вернула бы мангу в свой список.
function lookupQuery(field: LookupField): string {
  return `query ($ids: [Int], $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(${field}: $ids, type: ANIME) {
      id
      idMal
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
}

interface OwnReply {
  status?: string | null
  score?: number | null
  progress?: number | null
}

/** Ближайшая серия: номер и срок выхода в секундах. */
interface AiringReply {
  episode?: number | null
  airingAt?: number | null
}

interface MediaReply {
  id?: number
  idMal?: number | null
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

interface LookupReply {
  Page?: {
    media?: Array<MediaReply | null> | null
  } | null
}

/** Кто ждёт пачку: обещание одного вызова выписок. */
interface Waiter {
  resolve: (found: Map<number, MediaBrief>) => void
  reject: (reason: unknown) => void
}

/** Копящаяся пачка по одному полю отбора. */
interface Batch {
  ids: Set<number>
  waiters: Waiter[]
  timer: number
}

/**
 * Незакрытые пачки: по одной на поле отбора. Смешивать поля нельзя:
 * одни и те же числа у одного поля — номера MAL, у другого — номера AniList.
 */
const batches = new Map<LookupField, Batch>()

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
 *
 * Тома всегда ноль: у аниме их нет, и сервер о них больше не спрашивают.
 */
function ownOrNull(own: OwnReply | null | undefined): ServerEntry | null {
  if (!own) return null

  return {
    status: textOrNull(own.status),
    score10: typeof own.score === 'number' ? own.score : 0,
    progress: typeof own.progress === 'number' ? own.progress : 0,
    volumes: 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
  }
}

/**
 * Ответ сервера о одном тайтле в выписку показа. Без номера — не запись.
 * Вид всегда аниме: сервер спрошен только про него.
 */
function toBrief(item: MediaReply | null): MediaBrief | null {
  if (!item || typeof item.id !== 'number') return null

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
async function lookupBriefs(field: LookupField, wanted: number[]): Promise<MediaBrief[]> {
  const query = lookupQuery(field)
  const found: MediaBrief[] = []

  for (let from = 0; from < wanted.length; from += LOOKUP_PAGE_SIZE) {
    const chunk = wanted.slice(from, from + LOOKUP_PAGE_SIZE)
    const reply = await anilistQuery<LookupReply>(
      query,
      { ids: chunk, perPage: LOOKUP_PAGE_SIZE },
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
 * Закрывает копившуюся пачку и раздаёт ответ всем, кто её ждал.
 *
 * Найденное раздаётся картой, а не списком: каждый ждущий спрашивал своё
 * и собирает порядок сам. Отказ тоже общий: один упавший запрос — отказ
 * всем, иначе полка ждала бы обещания вечно.
 */
async function flushBatch(field: LookupField): Promise<void> {
  const batch = batches.get(field)
  if (!batch) return

  // Снята сразу: просьбы, пришедшие во время запроса, начнут свою пачку,
  // а не дольются в ту, которая уже уехала.
  batches.delete(field)
  window.clearTimeout(batch.timer)

  const wanted = Array.from(batch.ids)

  try {
    const byKey = new Map<number, MediaBrief>()
    for (const brief of await lookupBriefs(field, wanted)) {
      const key = field === 'idMal_in' ? brief.malId : brief.mediaId
      if (key !== null) byKey.set(key, brief)
    }

    for (const waiter of batch.waiters) waiter.resolve(byKey)
  } catch (e) {
    for (const waiter of batch.waiters) waiter.reject(e)
  }
}

/**
 * Ставит номера в общую очередь и ждёт общий ответ.
 *
 * Две полки по четырнадцать тайтлов раньше стоили двух запросов, хотя вместе
 * занимают половину страницы. Теперь запрос один, а повторяющиеся номера
 * уезжают вовсе один раз: пачка — множество.
 */
function askLater(field: LookupField, wanted: number[]): Promise<Map<number, MediaBrief>> {
  return new Promise<Map<number, MediaBrief>>((resolve, reject) => {
    let batch = batches.get(field)

    if (!batch) {
      batch = {
        ids: new Set<number>(),
        waiters: [],
        timer: window.setTimeout(() => {
          void flushBatch(field)
        }, MERGE_WINDOW_MS),
      }
      batches.set(field, batch)
    }

    for (const id of wanted) batch.ids.add(id)
    batch.waiters.push({ resolve, reject })

    // Пачка распухла сверх потолка — едет не дожидаясь окна.
    if (batch.ids.size >= MERGE_MAX_IDS) void flushBatch(field)
  })
}

/**
 * Выписки тайтлов по номерам MAL. Порядок ответа — порядок спрошенных
 * номеров: сортировка поиска живёт у того, кто искал, а сервер о ней не знает.
 */
export async function fetchBriefsByMal(malIds: number[]): Promise<MediaBrief[]> {
  const wanted = cleanIds(malIds)
  if (wanted.length === 0) return []

  const byMal = await askLater('idMal_in', wanted)

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
 *
 * Порядок теперь тоже по списку спрошенного, а не по ответу сервера: пачка
 * общая, и чужие номера в ней сбили бы порядок сервера. Спискам это даже лучше:
 * порядок плиток задаёт сам список, а не ответ сети.
 */
export async function fetchBriefsByIds(mediaIds: number[]): Promise<MediaBrief[]> {
  const wanted = cleanIds(mediaIds)
  if (wanted.length === 0) return []

  const byId = await askLater('id_in', wanted)

  const found: MediaBrief[] = []
  for (const mediaId of wanted) {
    const brief = byId.get(mediaId)
    if (brief) found.push(brief)
  }

  Logger('API', `Выписки по номерам: спросили ${wanted.length}, нашли ${found.length}`)
  return found
}
