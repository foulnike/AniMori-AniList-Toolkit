// Глобальные константы: только неизменяемые значения.
// Состояние сессии — паузы и инстанс БД — живёт в своих модулях, не здесь.

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
