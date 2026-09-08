// Витрина каталога для главной: сезон, тренды, лучшее и подбор по жанрам,
// советы «по мотивам», жанры аниме для профиля вкуса (пункт 3.11)
// и постраничная лента подбора под отбор хозяина.
// Отдельно от anilist-media.ts: тот у потолка, а дело здесь самостоятельное.
//
// ТРИ ПОЛКИ ОДНИМ ЗАПРОСОМ
// Сезон, тренд и лучшее друг от друга не зависят, но провод у них общий:
// клиент держит паузу между запросами и одно окно лимита на всё приложение,
// и три похода подряд стоили секунд ожидания на ровном месте. GraphQL умеет
// несколько выборок за раз через псевдонимы — этим пачка и пользуется.
//
// СКЛАД ДЛЯ ПОЛОК И СПРАВОЧНИКОВ
// Прежде каждый запуск программы начинался с шести запросов: пачка полок,
// справочник тэгов в тысячу семьсот строк, советы, жанры. Через минуту
// хозяин уходил на карточку, возвращался — и всё повторялось заново, потому
// что витрина жила в памяти экрана, а экран пересоздавался.
//
// Теперь у каждой полки и каждого справочника свой срок хранения в
// core/cache-life.ts: тренд живёт два часа, сезон шесть, лучшее сутки,
// справочник тэгов месяц, жанры тайтла — бессрочно. Записи полок личного
// в себе не несут: toBrief всегда ставит ownEntry в null, свои метки витрина
// ставит по памяти списка (3.14). Поэтому склад здесь общий и обезличенный,
// и вопрос «а чей это прогресс» к нему не возникает.
//
// ПАЧКА НЕДЕЛИМА И НА СКЛАДЕ
// Три полки лежат тремя записями, но обновляются вместе: пришёл срок хотя бы
// одной — уходит один запрос и перезаписываются все три. Это дешевле, чем
// три отдельных похода за просроченной, и честнее: сервер всё равно отдаёт
// их одним ответом.
//
// ОТБОР СОБИРАЕТСЯ, А НЕ ПЕРЕЧИСЛЯЕТСЯ
// Запрос ленты складывается из кусков: лишняя переменная в объявлении роняет
// весь запрос, поэтому объявляются ровно те, что вписаны в отбор. Значения
// уходят переменными всегда: имена жанров и тэгов приходят из чужого
// справочника, и склейке в текст запроса тут не место.
//
// В ЛЕНТЕ НЕ БЫВАЕТ АНОНСОВ
// Невышедшее отсекается запросом, а не разбором ответа: смотреть там нечего,
// оценки у него нет, и в ленте оно оседало плотной пробкой. Порядок «Новинки»
// без границы годов состоял из анонсов целиком — START_DATE_DESC честно ставит
// впереди то, что выйдет через год. Полок витрины этого не касается: «Сейчас
// выходит» живёт сезоном и невышедшее ей по делу.

import {
  isFresh,
  isFreshAt,
  LIFE_FEED,
  LIFE_GENRES,
  LIFE_RECS,
  LIFE_SHELF_AIRING,
  LIFE_SHELF_GENRE,
  LIFE_SHELF_TOP,
  LIFE_SHELF_TRENDING,
  LIFE_TAGS,
} from '../core/cache-life'
import { dbGet, dbSet } from '../core/db'
import type { MediaCacheRecord } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import type { MediaBrief } from './anilist-media'
import { once } from './rate-limit'

/** Сколько плиток просит полка: длинный ряд всё равно не листают до конца. */
const SHELF_SIZE = 14

/** Сколько советов просим у семени: после склейки повторов останется меньше. */
const SEED_PAGE = 25

/** Потолок страницы у AniList — пятьдесят записей за запрос. */
const LOOKUP_PAGE_SIZE = 50

/** Размер страницы ленты. Берётся с запасом к порции показа: своё,
    скрытое и взрослое выбрасываются после ответа, и ровно порция в запросе
    значила бы вторую страницу на каждое нажатие «Показать ещё». Лишнее
    не пропадает: остаток ждёт в ленте следующего нажатия. */
const FEED_PAGE_SIZE = 40

/** Что в ленте не показывается никогда. Строка уходит в запрос как есть:
    это перечисление сервера, а не наше значение. */
const FEED_SKIP_STATUS = 'NOT_YET_RELEASED'

/**
 * Ключи склада. Цифра — поколение формы записи: сменится состав полей плитки,
 * сменится и цифра, и прежние записи просто перестанут находиться.
 */
const SHELF_PREFIX = 'SHELF1_'
const TAGS_KEY = 'TAGS1_all'
const GENRE_PREFIX = 'GENRE1_'
const RECS_PREFIX = 'RECS1_'

/** Сроки хранения полок по видам. Смысл каждого срока — в cache-life.ts. */
const SHELF_LIFE: Readonly<Record<ShelfKind, number>> = {
  airing: LIFE_SHELF_AIRING,
  trending: LIFE_SHELF_TRENDING,
  top: LIFE_SHELF_TOP,
  genre: LIFE_SHELF_GENRE,
}

/**
 * Сколько страниц ленты помнить в запуске. Лента листается вниз и почти
 * никогда не листается обратно, так что памяти нужно немного; потолок стоит
 * ради долгих сеансов с перебором отборов.
 */
const FEED_MEMORY_MAX = 60

/** Справочник тэгов этого запуска: он один на всё приложение. */
let tagsMemory: CatalogTag[] | null = null

/** Жанры тайтлов, уже поднятые со склада в этом запуске. */
const genreMemory = new Map<number, string[]>()

/** Страницы ленты в памяти запуска вместе со временем добычи. */
const feedMemory = new Map<string, { at: number; page: FeedPage }>()

// Поля плитки без записи хозяина: свои метки витрина ставит по памяти (3.14).
// Вид записи спрашивается не ради показа, а ради отбора: в советах сервера
// аниме и манга лежат вперемешку, и отсеивать её надо по ответу.
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

/** Те же поля куском для запросов с несколькими выборками: три полки
    в одном запросе иначе повторяли бы их трижды. */
const BRIEF_FRAGMENT = `fragment Brief on Media {${BRIEF_FIELDS}
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
// Сам вид вписан словом: полка манги в приложении не бывает, а через
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

/** Три полки каталога за один поход. Псевдонимы обязательны: без них
    сервер увидел бы три одинаковых поля Page и оставил последнее. */
const PACK_QUERY = `${BRIEF_FRAGMENT}

query ($perPage: Int!, $season: MediaSeason, $seasonYear: Int) {
  airing: Page(page: 1, perPage: $perPage) {
    media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: [POPULARITY_DESC]) {
      ...Brief
    }
  }
  trending: Page(page: 1, perPage: $perPage) {
    media(type: ANIME, sort: [TRENDING_DESC]) {
      ...Brief
    }
  }
  top: Page(page: 1, perPage: $perPage) {
    media(type: ANIME, sort: [SCORE_DESC]) {
      ...Brief
    }
  }
}`

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

/** Справочник тэгов каталога. Переменных нет вовсе: список один на всех. */
const TAGS_QUERY = `query {
  MediaTagCollection {
    name
    category
    isAdult
    isGeneralSpoiler
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

/** Одна выборка страницы: и у полки, и у каждой доли пачки вид общий. */
interface PageReply {
  pageInfo?: { hasNextPage?: boolean | null } | null
  media?: Array<BriefReply | null> | null
}

interface ShelfReply {
  Page?: PageReply | null
}

type PackReply = Partial<Record<PackKind, PageReply | null>>

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

interface TagReply {
  name?: string | null
  category?: string | null
  isAdult?: boolean | null
  isGeneralSpoiler?: boolean | null
}

interface TagsReply {
  MediaTagCollection?: Array<TagReply | null> | null
}

/** Совет сервера: плитка и вес связи. Вес нужен склейке повторов. */
export interface ServerRec {
  brief: MediaBrief
  rating: number
}

/** Виды полок пачки: три независимые выборки одним походом в сеть. */
export type PackKind = 'airing' | 'trending' | 'top'

/** Пачка полок каталога. Пустая доля значит «эта полка не встанет». */
export type ShelfPack = Record<PackKind, MediaBrief[]>

const PACK_KINDS: readonly PackKind[] = ['airing', 'trending', 'top']

/** Тэг каталога: имя для запроса, раздел для меню, метка взрослого. */
export interface CatalogTag {
  name: string
  category: string
  adult: boolean
}

/** Порядок ленты. Ключи свои: перечисление сервера наружу не выносится. */
export type FeedSort = 'score' | 'popular' | 'trending' | 'new'

const FEED_SORT: Readonly<Record<FeedSort, string>> = {
  score: 'SCORE_DESC',
  popular: 'POPULARITY_DESC',
  trending: 'TRENDING_DESC',
  new: 'START_DATE_DESC',
}

/**
 * Отбор подбора: что показывать в ленте главной.
 * Пустые списки и пустые годы значат «весь каталог».
 */
export interface CatalogPick {
  genres: string[]
  tags: string[]
  formats: string[]
  yearFrom: number | null
  yearTo: number | null
  sort: FeedSort
}

/** Страница ленты: плитки и признак продолжения. */
export interface FeedPage {
  items: MediaBrief[]
  hasNext: boolean
}

/** Отбор по умолчанию: весь каталог по оценке. */
export function emptyPick(): CatalogPick {
  return { genres: [], tags: [], formats: [], yearFrom: null, yearTo: null, sort: 'score' }
}

/**
 * Сужен ли отбор. Порядок сюда не входит сознательно: смена сортировки
 * меняет ленту, но не значит, что хозяин что-то отобрал, и прятать из-за
 * неё полки витрины было бы неожиданно.
 */
export function pickIsSet(pick: CatalogPick): boolean {
  return (
    pick.genres.length > 0 ||
    pick.tags.length > 0 ||
    pick.formats.length > 0 ||
    pick.yearFrom !== null ||
    pick.yearTo !== null
  )
}

/** Ключ отбора для памяти запуска: одинаковый отбор — одна загрузка. */
export function pickKey(pick: CatalogPick): string {
  return [
    pick.genres.slice().sort().join('+'),
    pick.tags.slice().sort().join('+'),
    pick.formats.slice().sort().join('+'),
    pick.yearFrom ?? '',
    pick.yearTo ?? '',
    pick.sort,
  ].join('|')
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
 * Ответ сервера об аниме в плитку показа. Без номера — не запись.
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

/** Плитки из ответа одной выборки. Мусор и манга отсеиваются по пути. */
function toBriefs(media: Array<BriefReply | null> | null | undefined): MediaBrief[] {
  if (!Array.isArray(media)) return []

  const items: MediaBrief[] = []
  for (const item of media) {
    const brief = toBrief(item)
    if (brief) items.push(brief)
  }
  return items
}

/** Текущий сезон года для полки «Сейчас выходит». */
export function currentSeason(): { season: string; seasonYear: number } {
  const now = new Date()
  const month = now.getMonth()
  const season = month <= 2 ? 'WINTER' : month <= 5 ? 'SPRING' : month <= 8 ? 'SUMMER' : 'FALL'
  return { season, seasonYear: now.getFullYear() }
}

/**
 * Ключ полки на складе. У жанровой в ключе сам отбор: «фэнтези» и «фэнтези
 * с драмой» — разные полки, и путать их нельзя. Жанры сортируются, иначе
 * порядок нажатий в меню плодил бы записи об одном и том же.
 */
function shelfKey(kind: ShelfKind, genres?: string[]): string {
  if (kind !== 'genre') return `${SHELF_PREFIX}${kind}`
  return `${SHELF_PREFIX}genre_${(genres ?? []).slice().sort().join('+')}`
}

/** Полка со склада, если она там есть и не просрочена. */
async function readShelf(kind: ShelfKind, genres?: string[]): Promise<MediaBrief[] | null> {
  const key = shelfKey(kind, genres)
  const stored = await dbGet<MediaCacheRecord<MediaBrief[]>>('mediaCache', key)
  if (!stored || !Array.isArray(stored.data) || stored.data.length === 0) return null
  if (!isFresh(key, stored.ts, SHELF_LIFE[kind])) return null

  return stored.data
}

/**
 * Кладёт полку на склад. Пустая не пишется: полка не встала из-за отказа,
 * и запоминать этот отказ на шесть часов было бы худшим из решений.
 */
async function writeShelf(kind: ShelfKind, items: MediaBrief[], genres?: string[]): Promise<void> {
  if (items.length === 0) return

  await dbSet('mediaCache', { key: shelfKey(kind, genres), data: items, ts: Date.now() })
}

/** Сетевой поход за одной полкой. */
async function loadShelf(kind: ShelfKind, genres?: string[]): Promise<MediaBrief[]> {
  const vars: Record<string, unknown> = { perPage: SHELF_SIZE }
  if (kind === 'airing') Object.assign(vars, currentSeason())
  if (kind === 'genre') vars.genres = genres

  const reply = await anilistQuery<ShelfReply>(shelfQuery(kind), vars)
  const media = reply.data?.Page?.media
  if (!Array.isArray(media)) {
    Logger('WARN', `Витрина «${kind}»: сервер ответил пустотой`, reply.errors)
    return []
  }

  const items = toBriefs(media)
  Logger('API', `Витрина «${kind}»: пришло ${items.length}`)

  void writeShelf(kind, items, genres).catch((e) => {
    Logger('WARN', `Витрина «${kind}»: на склад не легла`, e)
  })

  return items
}

/**
 * Полка каталога. Склад, затем сеть; одинаковые вопросы склеиваются.
 * Отказ — пустой массив: полка просто не встанет.
 */
export async function fetchShelf(kind: ShelfKind, genres?: string[]): Promise<MediaBrief[]> {
  if (kind === 'genre' && (genres === undefined || genres.length === 0)) return []

  const stored = await readShelf(kind, genres)
  if (stored) return stored

  return await once(shelfKey(kind, genres), () => loadShelf(kind, genres))
}

/** Пачка со склада — только целиком: неполная витрина хуже свежей. */
async function readPack(): Promise<ShelfPack | null> {
  const [airing, trending, top] = await Promise.all([
    readShelf('airing'),
    readShelf('trending'),
    readShelf('top'),
  ])

  if (!airing || !trending || !top) return null

  return { airing, trending, top }
}

/** Сетевой поход за пачкой и запись всех трёх полок на склад. */
async function loadPack(): Promise<ShelfPack> {
  const vars: Record<string, unknown> = { perPage: SHELF_SIZE, ...currentSeason() }
  const reply = await anilistQuery<PackReply>(PACK_QUERY, vars)

  const pack: ShelfPack = { airing: [], trending: [], top: [] }
  for (const kind of PACK_KINDS) {
    const media = reply.data?.[kind]?.media
    if (!Array.isArray(media)) {
      Logger('WARN', `Витрина «${kind}»: сервер ответил пустотой`, reply.errors)
      continue
    }
    pack[kind] = toBriefs(media)
  }

  Logger(
    'API',
    `Витрина пачкой: сезон ${pack.airing.length}, тренд ${pack.trending.length}, ` +
      `лучшее ${pack.top.length}`,
  )

  void Promise.all(PACK_KINDS.map((kind) => writeShelf(kind, pack[kind]))).catch((e) => {
    Logger('WARN', 'Витрина пачкой: на склад не легла', e)
  })

  return pack
}

/**
 * Сезон, тренд и лучшее одним походом. Отказ роняет всю пачку разом —
 * это и есть плата за один запрос вместо трёх, но полки каталога всё
 * равно приходили или не приходили вместе: провод и лимит у них общие.
 *
 * Со склада пачка отдаётся только целиком: доля просрочена — идём в сеть
 * за всеми тремя, потому что запрос всё равно один.
 */
export async function fetchShelfPack(): Promise<ShelfPack> {
  const stored = await readPack()
  if (stored) return stored

  return await once('shelf-pack', loadPack)
}

/**
 * Запрос страницы ленты под отбор. Объявление переменных собирается вместе
 * с условием: незанятая переменная — ошибка запроса целиком.
 *
 * Год приходит границами нечёткой даты: у AniList это целое вида ГГГГММДД,
 * и «с 2010 года» записывается как 20100000, а «по 2015» — как 20151231.
 */
function feedQuery(pick: CatalogPick, page: number): { query: string; vars: Record<string, unknown> } {
  const decls = ['$page: Int!', '$perPage: Int!']
  const where = ['type: ANIME']
  const vars: Record<string, unknown> = { page, perPage: FEED_PAGE_SIZE }

  if (pick.genres.length > 0) {
    decls.push('$genres: [String]')
    where.push('genre_in: $genres')
    vars.genres = pick.genres
  }

  if (pick.tags.length > 0) {
    decls.push('$tags: [String]')
    where.push('tag_in: $tags')
    vars.tags = pick.tags
  }

  if (pick.formats.length > 0) {
    decls.push('$formats: [MediaFormat]')
    where.push('format_in: $formats')
    vars.formats = pick.formats
  }

  if (pick.yearFrom !== null) {
    decls.push('$from: FuzzyDateInt')
    where.push('startDate_greater: $from')
    vars.from = pick.yearFrom * 10000
  }

  if (pick.yearTo !== null) {
    decls.push('$till: FuzzyDateInt')
    where.push('startDate_lesser: $till')
    vars.till = pick.yearTo * 10000 + 1231
  }

  // Анонсы вон из ленты: у невышедшего нет ни серий, ни оценки, и лента
  // подбора из одних обещаний — это лента, из которой нечего смотреть.
  where.push(`status_not_in: [${FEED_SKIP_STATUS}]`)

  // Порядок по оценке требует самой оценки. Запись без счёта сервер держит
  // не в хвосте, а рядом с сотней, и первые страницы ленты уходили
  // безвестному вперемешку с невышедшим.
  if (pick.sort === 'score') where.push('averageScore_greater: 0')

  // Порядок вписывается словом из закрытого списка: переменной сюда нельзя,
  // сервер ждёт перечисление, а чужая строка в запросе — чужая строка.
  where.push(`sort: [${FEED_SORT[pick.sort]}, ID_DESC]`)

  const query = `${BRIEF_FRAGMENT}

query (${decls.join(', ')}) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      hasNextPage
    }
    media(${where.join(', ')}) {
      ...Brief
    }
  }
}`

  return { query, vars }
}

/** Кладёт страницу ленты в память запуска, придерживая её размер. */
function rememberFeed(key: string, page: FeedPage): void {
  if (page.items.length === 0) return

  // Map помнит порядок вставки, поэтому старейший ключ — первый.
  if (feedMemory.size >= FEED_MEMORY_MAX) {
    const oldest = feedMemory.keys().next()
    if (!oldest.done) feedMemory.delete(oldest.value)
  }

  feedMemory.set(key, { at: Date.now(), page })
}

/** Сетевой поход за страницей ленты. */
async function loadFeed(pick: CatalogPick, page: number, key: string): Promise<FeedPage> {
  const { query, vars } = feedQuery(pick, page)

  const reply = await anilistQuery<ShelfReply>(query, vars)
  const media = reply.data?.Page?.media
  if (!Array.isArray(media)) {
    Logger('WARN', `Лента подбора: пустой ответ на страницу ${page}`, reply.errors)
    return { items: [], hasNext: false }
  }

  const items = toBriefs(media)
  const hasNext = reply.data?.Page?.pageInfo?.hasNextPage === true
  Logger('API', `Лента подбора: страница ${page}, пришло ${items.length}`)

  const result: FeedPage = { items, hasNext }
  rememberFeed(key, result)
  return result
}

/**
 * Страница ленты подбора. Отказ сети наверх не поднимается: лента живёт
 * долго, и одна оборванная страница не повод показывать ошибку вместо
 * уже набранного.
 *
 * Страницы помнятся четверть часа в памяти запуска, а не на складе: отборов
 * и порядков бесконечно много, и склад забился бы записями, которые больше
 * никто не спросит. Четверти часа хватает на то, ради чего это делается —
 * «ушёл на карточку, вернулся, листаю дальше» без повторной загрузки.
 */
export async function fetchFeed(pick: CatalogPick, page: number): Promise<FeedPage> {
  const key = `${pickKey(pick)}|${page}`

  const memo = feedMemory.get(key)
  if (memo && isFreshAt(memo.at, LIFE_FEED)) return memo.page

  return await once(`feed-${key}`, () => loadFeed(pick, page, key))
}

/** Сетевой поход за справочником тэгов и запись его на склад. */
async function loadTags(): Promise<CatalogTag[]> {
  const reply = await anilistQuery<TagsReply>(TAGS_QUERY, {})
  const list = reply.data?.MediaTagCollection
  if (!Array.isArray(list)) {
    Logger('WARN', 'Тэги каталога: сервер ответил пустотой', reply.errors)
    return []
  }

  const tags: CatalogTag[] = []
  for (const item of list) {
    const name = textOrNull(item?.name)
    if (name === null || item?.isGeneralSpoiler === true) continue

    tags.push({
      name,
      category: textOrNull(item?.category) ?? 'Другое',
      adult: item?.isAdult === true,
    })
  }

  tags.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  Logger('API', `Тэги каталога: пришло ${tags.length}`)

  if (tags.length > 0) {
    tagsMemory = tags
    void dbSet('mediaCache', { key: TAGS_KEY, data: tags, ts: Date.now() }).catch((e) => {
      Logger('WARN', 'Тэги каталога: на склад не легли', e)
    })
  }

  return tags
}

/**
 * Справочник тэгов каталога для меню отбора.
 *
 * Тэги-спойлеры выброшены: сам список читается до открытия карточки,
 * и строка вроде «главный герой умирает» в меню отбора — испорченное аниме
 * ещё до выбора. Взрослые остаются с меткой: пускать их в показ решает
 * не справочник, а политика показа взрослого.
 *
 * Полторы тысячи строк не меняются неделями, поэтому справочник живёт
 * на складе месяц. Раньше он приезжал заново на каждый запуск программы,
 * хотя открывают меню отбора далеко не в каждом сеансе.
 */
export async function fetchTags(): Promise<CatalogTag[]> {
  if (tagsMemory) return tagsMemory

  const stored = await dbGet<MediaCacheRecord<CatalogTag[]>>('mediaCache', TAGS_KEY)
  if (
    stored &&
    Array.isArray(stored.data) &&
    stored.data.length > 0 &&
    isFresh(TAGS_KEY, stored.ts, LIFE_TAGS)
  ) {
    tagsMemory = stored.data
    return stored.data
  }

  return await once('tags', loadTags)
}

/** Сетевой поход за советами и запись их на склад. */
async function loadRecs(mediaId: number, key: string): Promise<ServerRec[]> {
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

  // Пустой ответ тоже пишется: у тайтла может не быть ни одной связи,
  // и суточная память об этом дешевле, чем спрашивать снова при каждом
  // пересчёте вкуса. Сутки — не навсегда, голоса за связи ещё наберутся.
  void dbSet('mediaCache', { key, data: found, ts: Date.now() }).catch((e) => {
    Logger('WARN', `Советы для ${mediaId}: на склад не легли`, e)
  })

  return found
}

/**
 * Советы сервера для семени «по мотивам». Мангу отсеивает разбор ответа,
 * поэтому отбор по виду здесь больше не нужен.
 *
 * Связи набираются голосами месяцами, так что сутки хранения ничего
 * не портят, зато перебор семян по любимым записям больше не превращается
 * в очередь запросов при каждом заходе на главную.
 */
export async function fetchRecsFor(mediaId: number): Promise<ServerRec[]> {
  const key = `${RECS_PREFIX}${mediaId}`

  const stored = await dbGet<MediaCacheRecord<ServerRec[]>>('mediaCache', key)
  if (stored && Array.isArray(stored.data) && isFresh(key, stored.ts, LIFE_RECS)) {
    return stored.data
  }

  return await once(key, () => loadRecs(mediaId, key))
}

/** Жанры одного тайтла со склада: они заданы при выпуске и не правятся. */
async function readGenres(mediaId: number): Promise<string[] | null> {
  const key = `${GENRE_PREFIX}${mediaId}`
  const stored = await dbGet<MediaCacheRecord<string[]>>('mediaCache', key)
  if (!stored || !Array.isArray(stored.data)) return null
  if (!isFresh(key, stored.ts, LIFE_GENRES)) return null

  return stored.data
}

/**
 * Жанры аниме пачками: профиль вкуса считается по любимым записям.
 *
 * Спрашивается только то, чего нет на складе. У постоянного хозяина список
 * любимого меняется медленно, так что после первого пересчёта пачек в сети
 * обычно не остаётся вовсе, а прежде тридцать записей стоили запроса
 * при каждом заходе на главную.
 */
export async function fetchGenreMap(ids: number[]): Promise<Map<number, string[]>> {
  const found = new Map<number, string[]>()
  const unique = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))

  const missing: number[] = []
  const stored = await Promise.all(
    unique.map(async (id) => {
      const known = genreMemory.get(id)
      if (known) return { id, genres: known }
      return { id, genres: await readGenres(id) }
    }),
  )

  for (const item of stored) {
    if (item.genres === null) {
      missing.push(item.id)
      continue
    }
    genreMemory.set(item.id, item.genres)
    found.set(item.id, item.genres)
  }

  if (missing.length > 0) {
    Logger('DB', `Жанры: со склада ${found.size}, спросим ${missing.length}`)
  }

  for (let from = 0; from < missing.length; from += LOOKUP_PAGE_SIZE) {
    const chunk = missing.slice(from, from + LOOKUP_PAGE_SIZE)
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

    const ts = Date.now()
    for (const item of media) {
      if (!item || typeof item.id !== 'number' || !Array.isArray(item.genres)) continue
      const genres = item.genres.filter((g): g is string => typeof g === 'string' && g !== '')
      found.set(item.id, genres)
      genreMemory.set(item.id, genres)

      // Бессрочная запись о пустоте закрыла бы вопрос навсегда, а жанры
      // у свежего анонса ещё проставят: пустое живёт только в памяти запуска.
      if (genres.length === 0) continue

      void dbSet('mediaCache', { key: `${GENRE_PREFIX}${item.id}`, data: genres, ts }).catch((e) => {
        Logger('WARN', `Жанры ${item.id}: на склад не легли`, e)
      })
    }
  }

  return found
}

/**
 * Забыть память запуска: справочник тэгов, жанры и страницы ленты.
 * Зовётся при ручной очистке склада — иначе очищенные записи продолжали бы
 * жить в памяти до перезапуска, и кнопка выглядела бы сломанной.
 */
export function forgetCatalogMemory(): void {
  tagsMemory = null
  genreMemory.clear()
  feedMemory.clear()
}
