// Формы данных AniList и Shikimori: единственный источник правды для api/ и core/db.ts.
// Описаны только нужные нам поля, остальное из ответов сознательно не перечисляется.
// Знак вопроса у поля стоит там, где внешний API реально не гарантирует значение.

/**
 * Вид тайтла в терминах AniList.
 *
 * Приложение мангу больше не спрашивает: вид вписан в запросы словом
 * ANIME, а не переменной. Тип остался в формах ответа AniList и в сравнении
 * списков Shikimori, где манговые записи есть. Сузить его до 'ANIME' —
 * пункт 1.4 в docs/ROADMAP.md: это правка кода, а не комментария.
 */
export type MediaType = 'ANIME' | 'MANGA'

/** Статусы в терминах Shikimori — к ним нормализуются и записи AniList. */
export type ShikiStatus =
  'watching' | 'rewatching' | 'planned' | 'completed' | 'on_hold' | 'dropped'

export interface AniListMediaTitle {
  romaji?: string | null
  english?: string | null
}

export interface AniListRelationEdge {
  /** 'SEQUEL' | 'PREQUEL' | 'PARENT' | ... */
  relationType: string
  node: { idMal: number | null }
}

/** Урезанный Media из AniList GraphQL (MediaListCollection.entries[].media). */
export interface AniListMediaLite {
  idMal: number | null
  title?: AniListMediaTitle
  relations?: { edges: AniListRelationEdge[] }
}

/**
 * Полный Media из AniList GraphQL (рендер виджетов страницы тайтла).
 * Вид тайтла в форме остался: его отдаёт сам ответ AniList.
 */
export interface AniListMedia {
  id: number
  type: MediaType
  idMal: number | null
  seasonYear?: number | null
  /** Шкала 0..100. */
  averageScore?: number | null
  title?: AniListMediaTitle
  mediaListEntry?: { status: string | null; progress?: number }
}

/**
 * Общая часть нормализованных записей сканера дельты (ключ — malId).
 * Сравнение списков идёт целиком, вместе с манговыми записями Shikimori.
 */
export interface CmpEntryBase {
  malId: number
  title: string
  status: ShikiStatus | null
  /** Оценка 0..10. */
  score10: number
  progress: number
  /** Прочитано томов. У аниме всегда ноль: поле для манговых списков Shikimori. */
  volumes: number
  rewatches: number
  notes: string
}

/** Запись списка AniList после нормализации. */
export interface CmpAniListEntry extends CmpEntryBase {
  /** idMal связанных тайтлов. */
  relations: number[]
}

/** Запись списка Shikimori после нормализации. */
export type CmpShikiEntry = CmpEntryBase

/** Нормализованная запись любого источника. */
export type CmpListEntry = CmpAniListEntry | CmpShikiEntry

/** Урезанный тайтл Shikimori из `${type}_rates`. */
export interface ShikiMediaLite {
  /** Равен MyAnimeList ID. */
  id: number
  russian?: string | null
  name?: string | null
}

/** Карточка тайтла Shikimori (GET /api/animes|mangas/:id), только нужные поля. */
export interface ShikiMedia {
  id: number
  russian?: string | null
  name?: string | null
  url?: string | null
  /** Зеркало Shikimori, с которого пришёл ответ. */
  domain?: string | null
  description?: string | null
  /** Шкала 0..10. */
  score?: number | null
  /** Гистограмма оценок. */
  rates_scores_stats?: Array<{ name: string; value: number }>
}

/**
 * Имена сторов кэша для dbGet/dbSet.
 *
 * `mediaCache` — настоящее имя склада карточек: там давно лежат не только
 * данные Shikimori, но и обложки с AniList, темы с AnimeThemes и оценки площадок.
 *
 * `shikiCache` — устаревший псевдоним того же стора. Оставлен сознательно:
 * вызовов dbGet/dbSet десятки, они разбросаны по всему приложению,
 * и переименовать их одним заходом — значит поломать то, что не проверить.
 * db.ts переводит псевдоним в физическое имя сам.
 */
export type CacheStoreName = 'mediaCache' | 'shikiCache' | 'malCache' | 'franchiseCache'

/**
 * Запись в `mediaCache` (keyPath 'key'): карточки тайтлов/персонажей/персонала/тем.
 * Форма одна, различаются префикс ключа и `data`.
 *
 * Имя типа осталось старым из-за числа импортов; для нового кода есть
 * псевдоним MediaCacheRecord ниже.
 */
export interface ShikiCacheRecord<T = unknown> {
  /** Составной ключ вида "ПРЕФИКС_id", например "FULL_123". */
  key: string
  data: T
  /** Unix-таймстамп записи (протухание по CACHE_TIME). */
  ts: number
}

/** То же самое под верным именем: пишите в новом коде его. */
export type MediaCacheRecord<T = unknown> = ShikiCacheRecord<T>

/** Запись в `malCache` (keyPath 'id'): AniList ID -> AniListMedia. */
export interface MalCacheRecord {
  id: number
  data: AniListMedia
}

/** Запись в `franchiseCache` (keyPath 'id'). Зарезервирован под дерево франшизы. */
export interface FranchiseCacheRecord {
  id: number
  data: unknown
  ts?: number
}

export type CacheRecord = ShikiCacheRecord | MalCacheRecord | FranchiseCacheRecord

/**
 * Снимок БД для инспектора настроек.
 *
 * Поле на каждый вид записи, а не одна сумма: показанный ноль при живом кэше
 * — это не «пусто», а забытый счётчик, и отличить одно от другого можно только
 * поимённо. Ровно так молчали сначала темы, потом русские названия.
 */
export interface DbStats {
  media: number
  characters: number
  staff: number
  themes: number
  /** Русские названия и описания: префикс RU3_ (core/media-title.ts). */
  russianTitles: number
  /** Обложки, цвета и счёт частей: префикс LOOK2_ (core/media-looks.ts). */
  looks: number
  /** Оценки площадок: префикс RATE1_ (core/ratings.ts). */
  ratings: number
  malMappings: number
  /** Записи склада франшиз: у него свой ключ-число, а не префикс. */
  franchises: number
  /**
   * Записи с незнакомым префиксом. Считается сознательно: новый вид записи
   * иначе снова стал бы невидимым, а здесь он выйдет числом в остатке.
   */
  other: number
  totalCacheRecords: number
  estimatedSize: string
}

export interface DbStatsError {
  error: string
}
