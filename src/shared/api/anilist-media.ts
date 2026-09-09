// Соответствие номеров AniList и MyAnimeList, подробности тайтла, поиск
// и работы студий. Отдельно от anilist-list.ts: там записи пользователя,
// здесь сами тайтлы. Запрос номеров пакетный: поодиночке темп сгорит.
//
// У сети соответствие номеров спрашивается последним: сначала память запуска,
// потом своя запись списка и карта выпуска animori-data на диске, потом склад
// IndexedDB. Пара номеров у тайтла не меняется никогда, а спрашивалась она
// пачками по пятьдесят при каждом запуске заново.
//
// СКЛАД ДЛЯ КАРТОЧКИ И ПАМЯТЬ ДЛЯ ВЫДАЧИ
//
// Карточка и поиск больше не спрашивают запись списка (mediaListEntry).
// Правда о списке живёт в памяти коллекции: список односторонний, правки
// никуда не уезжают, и показ давно берёт состояние оттуда, а ответ сервера
// служил ему запасом. Запас этот был хуже отсутствия: он показывал закладку
// тому, кто вошёл, но список не перенёс, — а первая же правка заводила поверх
// пустую запись, и показанный статус пропадал на глазах.
//
// Без личной записи ответ одинаков для всех, и его можно класть на склад.
// Карточка завершённого лежит неделю, идущего — сутки, но не дольше объявленного
// выхода следующей серии: счёт вышедшего иначе отстал бы ровно там, где он нужен.
// Выдача поиска помнится четверть часа в памяти запуска, а на диск ей нельзя:
// слов бесконечно много, а вчерашняя выдача сегодня уже не та.

import {
  isFresh,
  isFreshAt,
  LIFE_CARD_AIRING,
  LIFE_CARD_FINISHED,
  LIFE_SEARCH,
} from '../core/cache-life'
import { datasetMalId, initDatasetNames } from '../core/dataset-names'
import { dbGet, dbSet } from '../core/db'
import type { MalCacheRecord, MediaCacheRecord, MediaType } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import { once } from './rate-limit'

/** Сколько тайтлов просим одним запросом. Потолок страницы у AniList — пятьдесят. */
const PAGE_SIZE = 50

/**
 * Сколько находок на странице поиска. Двадцать семь, а не двадцать: на широком
 * окне сетка постеров встаёт по девять в ряд, и число, не кратное девяти,
 * оставляло последнюю строку рваной — две картинки и пустота до края экрана.
 * Двадцать семь дают ровно три полных ряда, а на узком окне лишнее просто
 * уходит ниже сгиба.
 */
export const SEARCH_PAGE_SIZE = 27

/**
 * Потолок общего числа находок у AniList.
 *
 * Число в ответе — не подсчёт, а оценка сверху: на любом слове, где нашлось
 * больше одной страницы, сервер отдаёт ровно пять тысяч. Счётчик над двадцатью
 * постерами показывал именно его и выглядел откровенным враньём. Упёршееся
 * в потолок число наружу уходит пустотой: пусть выдача считает по себе.
 */
const SEARCH_TOTAL_CAP = 5000

/**
 * Сколько работ студии просим за заход. Двадцать семь по той же причине, что
 * и у поиска: девять постеров в ряд на широком окне, три полных ряда за заход.
 */
export const STUDIO_PAGE_SIZE = 27

/** Ключ карточки на складе. Цифра в префиксе — версия вида записи. */
const CARD_PREFIX = 'MED3_'

/**
 * Сколько страниц выдачи держим в памяти запуска. Шестьдесят — это десяток
 * слов с их страницами: набирать больше за четверть часа человек не успевает,
 * а потолок нужен, чтобы долгий сеанс поиска не рос в памяти без края.
 */
const SEARCH_MEMORY_MAX = 60

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

/** Страница выдачи и час, когда она пришла. */
interface SearchMemo {
  at: number
  page: SearchPage
}

/** Выдача поиска на четверть часа. Только память: на диск ей нельзя. */
const searchMemory = new Map<string, SearchMemo>()

/**
 * Очередь сетевых обходов за соответствиями: один обход за раз на всё приложение.
 *
 * Прежний одиночный флаг проверялся и присваивался в разных тиках, так что два
 * одновременных вызова успевали увидеть пустоту оба и уходили в сеть с
 * пересекающимися пачками. Здесь второй обход честно ждёт первого, а дождавшись
 * — пересчитывает остаток: добытое соседом второй раз не спрашивается.
 */
let malChain: Promise<void> = Promise.resolve()

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

// Подробности карточки. Записи списка здесь больше нет: её знает память
// коллекции, а без неё ответ одинаков для всех и годится на склад.
// Баннер и цвет обложки — для крупного вида: без них карточка серая.
// Ближайшая серия — для счёта вышедшего у идущего сезона и для срока хранения.
// Глав, томов и прочитанных томов здесь нет: аниме их не имеет.
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
  }
}`

// Поиск по слову. Закладка хозяина не просится: свои метки выдача ставит
// по памяти коллекции, а ответ с mediaListEntry тяжелеет зазря и запирает
// выдачу на одного человека — такую страницу не положишь в общую память.
// Обложка просится large: в сетке постеров medium заметно мылится.
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
    }
  }
}`

// Работы студии для её экрана. Запись хозяина не просится по той же причине,
// что и в поиске: свои метки плитка ставит по памяти.
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

/** Ближайшая серия: номер и срок выхода в секундах. */
interface AiringReply {
  episode?: number | null
  airingAt?: number | null
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
 * Запись списка глазами сервера. Вид сохранён ради слоя показа, который ещё
 * читает поле ownEntry, но сервер о записи больше не спрашивается: правда
 * о списке одна и живёт в памяти коллекции. Поле и этот вид уйдут вместе,
 * одним проходом по экранам.
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
 * Главы и тома остались в описании пустыми полями: их ещё читает слой
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
  /** Всегда null: состояние списка показ берёт из памяти коллекции. */
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
  /** Всегда null: свои метки плитка ставит по памяти коллекции. */
  ownEntry: ServerEntry | null
}

/**
 * Страница находок. Общее число бывает неизвестно — тогда `null`: у поиска
 * сервер отдаёт оценку с потолком, и врать ею счётчику нельзя.
 */
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
 *
 * Четыре ступени, и сеть — последняя. Память запуска бесплатна; своя запись
 * списка и карта выпуска лежат на диске и покрывают две трети всего, что
 * приложение вообще спрашивает; склад помнит то, что когда-то было добыто
 * сетью, и переживает перезапуск. До этой лестницы каждый холодный старт
 * заново выкупал у AniList пары номеров, которые не меняются никогда.
 */
export async function fetchMalIds(ids: number[]): Promise<Map<number, number>> {
  const unique = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))
  const found = new Map<number, number>()
  if (unique.length === 0) return found

  // Ступень первая: память запуска.
  const askDisk = unique.filter((id) => !malMemory.has(id))

  // Ступень вторая: своя запись списка и обратная карта выпуска. Обе на диске,
  // и подъём датасета ждётся один раз на всю пачку, а не на каждый номер.
  let fromDataset = 0
  if (askDisk.length > 0) {
    await initDatasetNames()
    for (const id of askDisk) {
      const malId = datasetMalId(id)
      if (malId === null) continue
      malMemory.set(id, malId)
      fromDataset++
    }
  }

  // Ступень третья: склад. Там лежит добытое сетью в прошлые запуски.
  const askStore = askDisk.filter((id) => !malMemory.has(id))
  let fromStore = 0
  if (askStore.length > 0) {
    const stored = await Promise.all(
      askStore.map(async (id) => {
        const record = await dbGet<MalCacheRecord>('malCache', id)
        const malId = record?.data?.idMal
        return { id, malId: typeof malId === 'number' && malId > 0 ? malId : null }
      }),
    )

    for (const item of stored) {
      if (item.malId === null) continue
      malMemory.set(item.id, item.malId)
      fromStore++
    }
  }

  // Ступень четвёртая: сеть — только за тем, чего не нашлось нигде.
  const askNet = askStore.filter((id) => !malMemory.has(id))
  if (askNet.length > 0) await askServerForMal(askNet)

  for (const id of unique) {
    const malId = malMemory.get(id)
    if (malId !== null && malId !== undefined) found.set(id, malId)
  }

  // Журнал называет цену ответа поимённо: строка, где у сети спрошен ноль,
  // и есть то, ради чего лестница написана.
  Logger(
    'API',
    `Соответствия MAL: спросили ${unique.length}, из выпуска ${fromDataset}, ` +
      `со склада ${fromStore}, у сети ${askNet.length}, нашли ${found.size}`,
  )

  return found
}

/**
 * Сетевой обход за соответствиями, пачками по пятьдесят. Идёт по одному
 * на всё приложение: очередь дешевле, чем две пачки с пересечением.
 */
function askServerForMal(wanted: number[]): Promise<void> {
  const ask = async (): Promise<void> => {
    // Пока ждали очереди, соседний обход мог добыть часть номеров сам.
    const remaining = wanted.filter((id) => !malMemory.has(id))
    if (remaining.length === 0) return

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
        rememberMalId(item.id, typeof item.idMal === 'number' && item.idMal > 0 ? item.idMal : null)
      }
      // Тайтл, о котором сервер промолчал, номера MAL не имеет: в памяти
      // запуска это помнится, чтобы не спрашивать снова.
      for (const id of chunk) {
        if (!seen.has(id)) malMemory.set(id, null)
      }
    }
  }

  // Хвост очереди берётся и на успехе, и на отказе: упавший обход не имеет
  // права запереть за собой всех остальных.
  const next = malChain.then(ask, ask)
  malChain = next.catch(() => undefined)
  return next
}

/**
 * Запоминает уже полученную пару: в памяти запуска и, если номер есть, на складе.
 *
 * Отрицательный ответ на диск не ложится сознательно: у новинки номера MAL
 * может ещё не быть, а завтра он появится. Вечное «нет» на складе означало бы,
 * что русского имени у тайтла не будет уже никогда.
 */
function rememberMalId(mediaId: number, malId: number | null): void {
  if (mediaId <= 0) return

  malMemory.set(mediaId, malId)
  if (malId === null) return

  void rememberOnDisk(mediaId, malId).catch((e) => {
    Logger('WARN', `Соответствие MAL ${mediaId}: на склад не легло`, e)
  })
}

/**
 * Кладёт пару номеров на склад. Форма записи полная ради типа стора, но
 * значение в ней одно — номер MAL: остальное карточка спросит сама, когда
 * её откроют, и врать складом о ней незачем.
 */
async function rememberOnDisk(mediaId: number, malId: number): Promise<void> {
  const record: MalCacheRecord = {
    id: mediaId,
    data: { id: mediaId, type: 'ANIME', idMal: malId },
  }

  await dbSet('malCache', record)
}

/** Ключ карточки на складе. */
function cardKey(mediaId: number): string {
  return `${CARD_PREFIX}${mediaId}`
}

/**
 * Срок хранения карточки по её же статусу. У завершённого и закрытого меняться
 * нечему — неделя; у идущего и у анонса прибавляются серии и даты — сутки.
 */
function cardLife(status: string | null): number {
  return status === 'FINISHED' || status === 'CANCELLED' ? LIFE_CARD_FINISHED : LIFE_CARD_AIRING
}

/**
 * Годна ли запись склада.
 *
 * Кроме срока смотрим на объявленный выход серии: если он уже наступил, на
 * складе лежит вчерашний счёт вышедшего. Именно этот счёт человек и открывает
 * карточку проверять, так что здесь суточный срок ошибается ровно в тот день,
 * когда ошибаться нельзя.
 */
function cardUsable(key: string, record: MediaCacheRecord<MediaCard>): boolean {
  const card = record.data
  if (!card || typeof card.mediaId !== 'number' || card.mediaId <= 0) return false

  const airingAt = card.airingAt
  if (typeof airingAt === 'number' && airingAt > 0 && Date.now() >= airingAt * 1000) return false

  return isFresh(key, record.ts, cardLife(card.status))
}

/** Карточка со склада или null. Отказ склада — промах, а не поломка показа. */
async function readCard(mediaId: number): Promise<MediaCard | null> {
  const key = cardKey(mediaId)

  try {
    const record = await dbGet<MediaCacheRecord<MediaCard>>('mediaCache', key)
    if (!record || !cardUsable(key, record)) return null

    return record.data
  } catch (e) {
    Logger('WARN', `Карточка ${mediaId}: склад не прочитался`, e)
    return null
  }
}

/** Кладёт карточку на склад. Промах записи показу не мешает. */
async function writeCard(card: MediaCard): Promise<void> {
  try {
    const record: MediaCacheRecord<MediaCard> = {
      key: cardKey(card.mediaId),
      data: card,
      ts: Date.now(),
    }

    await dbSet('mediaCache', record)
  } catch (e) {
    Logger('WARN', `Карточка ${card.mediaId}: на склад не легла`, e)
  }
}

/** Целое неотрицательное или `null`: чужие пустоты в числа превращать нельзя. */
function countOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}

/**
 * Общее число находок, которому можно верить.
 *
 * На последней странице оно считается по себе и точно: сколько страниц прошло
 * плюс сколько пришло сейчас. Пока страницы не кончились, берётся ответ
 * сервера, и только если он не упёрся в свой потолок; иначе — пустота,
 * и подпись над выдачей скажет «столько-то и ещё».
 */
function searchTotal(
  total: number | null | undefined,
  page: number,
  got: number,
  hasNext: boolean,
): number | null {
  if (!hasNext) return (page - 1) * SEARCH_PAGE_SIZE + got

  const num = countOrNull(total)
  return num !== null && num < SEARCH_TOTAL_CAP ? num : null
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
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
    // Состояние списка приходит не отсюда: его знает память коллекции.
    ownEntry: null,
  }
}

/**
 * Подробности одного тайтла: склад, затем сеть. Запрос идёт без ключа —
 * личного в ответе больше ничего нет, а значит и ключ ни к чему.
 *
 * «Главная → тайтл → назад → тот же тайтл» стоило двух запросов, теперь ноль:
 * возврат к уже открытому тайтлу сети не касается.
 */
export async function fetchMediaCard(mediaId: number): Promise<MediaCard | null> {
  if (!Number.isFinite(mediaId) || mediaId <= 0) return null

  const stored = await readCard(mediaId)
  if (stored !== null) {
    // Пара номеров со склада тоже годится: она не меняется никогда.
    rememberMalId(stored.mediaId, stored.malId)
    Logger('DB', `Карточка ${mediaId}: со склада, без запроса`)
    return stored
  }

  // Два экрана открывают один тайтл разом на возврате назад и по ссылке
  // франшизы: второй ждёт первого, а не шлёт свой запрос.
  return once(cardKey(mediaId), () => loadCard(mediaId))
}

/** Сетевая часть карточки: ответ, разбор и запись на склад. */
async function loadCard(mediaId: number): Promise<MediaCard | null> {
  const reply = await anilistQuery<CardReply>(CARD_QUERY, { id: mediaId })

  const media = reply.data?.Media
  if (!media || typeof media.id !== 'number') {
    Logger('WARN', `Карточка ${mediaId}: сервер тайтл не назвал`, reply.errors)
    return null
  }

  // Пара номеров досталась бесплатно вместе с карточкой: пусть переживёт
  // запуск и снимет с сети один вопрос из пачки в следующий раз.
  rememberMalId(media.id, countOrNull(media.idMal))

  const card: MediaCard = {
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
    // Состояние списка приходит не отсюда: его знает память коллекции.
    ownEntry: null,
  }

  // Показ карточку не ждёт: запись на склад идёт своим ходом.
  void writeCard(card)

  return card
}

/** Ключ страницы выдачи. Регистр слова не различается: «Наруто» и «наруто» — одно. */
function searchKey(word: string, page: number): string {
  return `${word.toLowerCase()}|${page}`
}

/** Страница выдачи из памяти запуска или null. */
function readSearch(key: string): SearchPage | null {
  const memo = searchMemory.get(key)
  if (!memo || !isFreshAt(memo.at, LIFE_SEARCH)) return null

  return memo.page
}

/**
 * Помнит страницу выдачи. Пустая выдача помнится наравне с полной: «ничего
 * не нашлось» — такой же ответ, и переспрашивать его тем же словом незачем.
 */
function writeSearch(key: string, page: SearchPage): void {
  searchMemory.set(key, { at: Date.now(), page })
  if (searchMemory.size <= SEARCH_MEMORY_MAX) return

  // Map хранит порядок вставки, так что первый ключ — самый давний.
  const oldest = searchMemory.keys().next().value
  if (oldest !== undefined) searchMemory.delete(oldest)
}

/**
 * Поиск тайтлов по слову. Сначала память запуска, потом сеть. Пустое слово
 * сеть не тревожит.
 *
 * Память здесь важнее, чем кажется: набрать слово, открыть находку и вернуться
 * назад — обычный ход, и он стоил повторной страницы выдачи каждый раз.
 */
export async function searchMedia(word: string, page = 1): Promise<SearchPage | null> {
  const asked = word.trim()
  if (asked === '') return { items: [], hasNext: false, total: 0 }

  const key = searchKey(asked, page)
  const remembered = readSearch(key)
  if (remembered !== null) {
    Logger('DB', `Поиск «${asked}»: страница ${page} из памяти, без запроса`)
    return remembered
  }

  return once(`search-${key}`, () => loadSearch(asked, page, key))
}

/** Сетевая часть поиска: ответ, разбор и память страницы. */
async function loadSearch(asked: string, page: number, key: string): Promise<SearchPage | null> {
  const reply = await anilistQuery<SearchReply>(SEARCH_QUERY, {
    word: asked,
    page,
    perPage: SEARCH_PAGE_SIZE,
  })

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

  const hasNext = found.pageInfo?.hasNextPage === true

  Logger('API', `Поиск «${asked}»: страница ${page}, нашлось ${items.length}`)

  const result: SearchPage = {
    items,
    hasNext,
    total: searchTotal(found.pageInfo?.total, page, items.length, hasNext),
  }

  writeSearch(key, result)

  return result
}

/**
 * Работы студии по популярности, страницами. Подпись не нужна: всё публичное.
 *
 * Склейка одинаковых заходов идёт по номеру студии, странице и числу уже
 * показанных работ: при равных трёх ответ будет тем же, а разные наборы
 * показанного дают разный подсчёт известного и склеиваться не должны.
 */
export async function fetchStudioWorks(
  studioId: number,
  page = 1,
  previous: ReadonlyArray<MediaBrief> = [],
): Promise<StudioPage | null> {
  return once(`studio-${studioId}|${page}|${previous.length}`, () =>
    loadStudioWorks(studioId, page, previous),
  )
}

/** Сетевая часть работ студии. */
async function loadStudioWorks(
  studioId: number,
  page: number,
  previous: ReadonlyArray<MediaBrief>,
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

/**
 * Забывает память запуска: пары номеров и страницы выдачи. Нужна ручной
 * очистке склада — иначе очищенный склад тут же перекрывался бы памятью,
 * и человек не увидел бы никакой разницы.
 */
export function forgetMediaMemory(): void {
  malMemory.clear()
  searchMemory.clear()
}
