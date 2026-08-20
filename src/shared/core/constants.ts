// Глобальные константы: только неизменяемые значения и регэкспы переводчика.
// Состояние сессии — паузы, инстанс БД, словарь — живёт в своих модулях, не здесь.

export const IS_SHIKI = window.location.hostname.includes('shikimori')
export const IS_ANILIST = window.location.hostname.includes('anilist.co')

/**
 * Класс-иммунитет: всё, что внутри, переводчик не трогает (РИСК №4).
 * Имя живёт в ядре: его ставит монтировщик Vue, а читает переводчик.
 */
export const NO_TRANSLATE_CLASS = 'am-notr'

/** Словарь перевода интерфейса. */
export const DICT_URL =
  'https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/dictionary.json'

/** `.rip` — фоллбэк для удалённых по РКН. */
export const SHIKI_DOMAINS: readonly string[] = ['shikimori.io', 'shikimori.rip']

/** anime365 (smotret-anime) — фоллбэк для тайтлов/описаний. */
export const ANIME365_DOMAINS: readonly string[] = ['smotret-anime.online', 'anime365.ru']
// Своего интервала у anime365 нет: темп един для всех и задан в api/rate-limit.ts.
/** подряд-сбоев -> отключение источника на сессию */
export const ANIME365_FAIL_LIMIT = 5

/**
 * Срок хранения кэша: бессрочно. Склад лежит на своём диске,
 * а чистится только руками из настроек через clearCache().
 */
export const CACHE_TIME = Number.POSITIVE_INFINITY

// IndexedDB
export const DB_NAME = 'AniMoriSuperDB'
/**
 * Версия схемы. Шестая переносит склад карточек из shikiCache в mediaCache:
 * имя почти год врало, в сторе лежат и обложки AniList, и темы AnimeThemes.
 * Поднятие версии — единственный способ запустить миграцию из core/db.ts.
 */
export const DB_VERSION = 6

// Локализация для парсера дат и времени.
export const monthsFull: Record<string, string> = {
  Jan: 'января',
  Feb: 'февраля',
  Mar: 'марта',
  Apr: 'апреля',
  May: 'мая',
  Jun: 'июня',
  Jul: 'июля',
  Aug: 'августа',
  Sep: 'сентября',
  Oct: 'октября',
  Nov: 'ноября',
  Dec: 'декабря',
}

export const days: Record<string, string> = {
  Mon: 'Пн',
  Tue: 'Вт',
  Wed: 'Ср',
  Thu: 'Чт',
  Fri: 'Пт',
  Sat: 'Сб',
  Sun: 'Вс',
}

export const seasons: Record<string, string> = {
  Winter: 'Зима',
  Spring: 'Весна',
  Summer: 'Лето',
  Fall: 'Осень',
}

// Регэкспы перевода: роли, даты, время.
// rxRoleEps, rxRoleOP и rxRoleED имеют флаг /g и общий lastIndex: только через .replace().
// Главы и тома в rxAct, rxLabel и rxUnit остаются сознательно: это переводчик
// юзерскрипта, а он работает и на манговых страницах AniList.
export const rxRole = /^(.+?)\s*\((.+)\)$/
export const rxRoleEps = /\beps?\b/gi
export const rxRoleOP = /\bOP\b/gi
export const rxRoleED = /\bED\b/gi
export const rxRanking = /^#(\d+)\s+(highest\s+rated|most\s+popular)\s+(.+)$/i
export const rxTimeComplex = /^(\d+\s+\w+)(?:,\s*|\s+)(\d+\s+\w+)$/i
export const rxHeight = /^(?:Height:\s+)?([\d\s.,\-–—]+)\s*cm(?:\s*\((.*?)\))?$/i
export const rxLiked = /^(\d+)\s+out\s+of\s+(\d+)\s+(?:users?\s+)?liked\s+this\s+review$/i
export const rxDateFull =
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})$/i
export const rxBday = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:,)?\s+(\d{1,4})$/i
export const rxSeason = /^(Winter|Spring|Summer|Fall)\s+(\d{4})$/i
export const rxAct = /^(Watched|Rewatched|Read|Reread)\s+(episode|chapter)\s+([\d\s\-–—]+)\s+of$/i
export const rxLabel =
  /^(Format|Status|Country|Chapters|Score|Count|Hours Watched|Mean Score|Chapters Read|Episodes|Released|Started|Amount|Progress|Finish Date|Birthday|Height|Age|Gender|Blood Type|Blood type|Occupation|Affiliation|Grade):\s*(.*)$/i
export const rxUnit =
  /^(\d+)\s+(day|hour|hr|minute|min|mins|sec|episode|chapter|volume|reply|user)s?$/i
export const rxRecent = /^(\d+)\s+recently\s+(watched|read)$/i
export const rxReviewBy = /^a\s+review\s+by\s+(.+)$/i
export const rxDayDate =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})$/i
export const rxAgo = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i
export const rxAiringEp =
  /^Ep\s+(\d+)\s+airing\s+in\s+(\d+)\s+(second|minute|min|hour|day|week|month)s?$/i
export const rxAiringOnly = /^Airing\s+in\s+(\d+)\s+(second|minute|min|hour|day|week|month)s?$/i
export const rxListAdded =
  /^(.+?)\s+added\s+to\s+(completed|watching|planning|dropped|paused|reading)\s+list$/i
export const rxListUpdated = /^(.+?)\s+list\s+entry\s+updated$/i

/** Палитра для пользовательских внешних ссылок (триплеты "r,g,b"). */
export const CL_COLORS: readonly string[] = [
  '61,180,242',
  '243,139,168',
  '183,148,244',
  '166,227,161',
  '246,193,119',
  '224,82,100',
]
