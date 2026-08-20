// Отборы и сортировки по коллекции: только чтение памяти, без копий записей.
// Ни сети, ни хранилища здесь нет: перебирается то, что уже в памяти.
// Менять записи через этот файл нельзя, для того есть хозяин в collection.ts.

import { eachEntry, entryCount } from './collection'
import type { SnapshotEntry } from './snapshot'

/** Условия отбора. Пустой набор пропускает все записи. */
export interface EntryFilter {
  /**
   * Остаток от времён манги, объявленный ради уже записанных вызовов.
   * На отбор не влияет и влиять не должен: записи не хранят вид тайтла
   * со снимка шестой версии, а действующее условие по полю, которого
   * нет ни у одной записи, отбраковывает их все — именно так экран
   * списков однажды показал нули при полной памяти. Снимается вместе
   * с вызовами, которые его ещё передают (пункт 1.4 плана).
   */
  type?: 'ANIME'
  status?: string[]
  minScore?: number
  maxScore?: number
  onlyRated?: boolean
  onlyStarted?: boolean
  updatedAfter?: number
  /**
   * Слово для поиска по названиям из снимка: ромадзи и английское.
   * Регистр не важен. Русских названий в памяти списка нет.
   */
  word?: string
  /** Только взрослое или только остальное. Без условия — всё подряд. */
  isAdult?: boolean
}

/** По какому полю сортировать. Названий в памяти нет, по ним сортирует экран. */
export type SortKey = 'updated' | 'score' | 'progress' | 'mediaId'

/** Направление сортировки. По умолчанию убывание: свежее и лучшее сверху. */
export type SortOrder = 'asc' | 'desc'

/** Правило сортировки. */
export interface EntrySort {
  key: SortKey
  order?: SortOrder
}

/** Страница выдачи: сколько пропустить и сколько взять. */
export interface EntryPage {
  offset?: number
  limit?: number
}

/** Пустой отбор одним образцом: сравнение с ним даёт быстрый путь подсчёта. */
const EMPTY_FILTER: EntryFilter = {}

/** Есть ли слово в названии. Пустое название совпадением не считается. */
function hasWord(title: string | null | undefined, word: string): boolean {
  if (typeof title !== 'string' || title === '') return false
  return title.toLowerCase().includes(word)
}

/**
 * Проверяет одну запись. Отдельная функция: одно и то же условие
 * нужно и перебору, и подсчёту, и странице — расхождение видно как ошибка чисел.
 *
 * Условия по виду тайтла здесь нет нарочно: поле в EntryFilter объявлено
 * ради вызовов, которые его передают, но записи его не хранят.
 */
export function matchesEntry(entry: SnapshotEntry, filter: EntryFilter = EMPTY_FILTER): boolean {
  if (filter.status && filter.status.length > 0) {
    if (entry.status === null || !filter.status.includes(entry.status)) return false
  }

  // Ноль оценкой не считается: так AniList отдаёт «оценки нет».
  if (filter.onlyRated === true && entry.score10 <= 0) return false
  if (filter.onlyStarted === true && entry.progress <= 0) return false

  if (typeof filter.minScore === 'number' && entry.score10 < filter.minScore) return false
  if (typeof filter.maxScore === 'number' && entry.score10 > filter.maxScore) return false
  if (typeof filter.updatedAfter === 'number' && entry.updatedAt < filter.updatedAfter) return false

  if (filter.isAdult !== undefined && entry.isAdult !== filter.isAdult) return false

  if (typeof filter.word === 'string' && filter.word !== '') {
    const word = filter.word.toLowerCase()
    if (!hasWord(entry.romaji, word) && !hasWord(entry.english, word)) return false
  }

  return true
}

/**
 * Ленивый перебор подходящих записей. Массива не создаёт вовсе:
 * вызывающий вправе остановиться на любой записи.
 */
export function* filterEntries(filter: EntryFilter = EMPTY_FILTER): Generator<SnapshotEntry> {
  for (const entry of eachEntry()) {
    if (matchesEntry(entry, filter)) yield entry
  }
}

/** Сколько записей проходит отбор. Считает перебором, без промежуточного массива. */
export function countEntries(filter: EntryFilter = EMPTY_FILTER): number {
  if (filter === EMPTY_FILTER) return entryCount()

  let found = 0
  for (const entry of eachEntry()) {
    if (matchesEntry(entry, filter)) found += 1
  }
  return found
}

/** Сравнение двух записей по возрастанию выбранного поля. */
function compare(a: SnapshotEntry, b: SnapshotEntry, key: SortKey): number {
  if (key === 'score') return a.score10 - b.score10
  if (key === 'progress') return a.progress - b.progress
  if (key === 'mediaId') return a.mediaId - b.mediaId
  return a.updatedAt - b.updatedAt
}

/**
 * Отобранные записи одним массивом ссылок, при надобности отсортированные
 * и урезанные до страницы. Ссылки, а не копии: правка видна через них сразу.
 */
export function selectEntries(
  filter: EntryFilter = EMPTY_FILTER,
  sort?: EntrySort,
  page?: EntryPage,
): SnapshotEntry[] {
  const found: SnapshotEntry[] = []
  for (const entry of eachEntry()) {
    if (matchesEntry(entry, filter)) found.push(entry)
  }

  if (sort) {
    const sign = sort.order === 'asc' ? 1 : -1
    found.sort((a, b) => sign * compare(a, b, sort.key))
  }

  const offset = page?.offset ?? 0
  const limit = page?.limit
  if (offset === 0 && limit === undefined) return found

  return found.slice(offset, limit === undefined ? undefined : offset + limit)
}

/** Первая подходящая запись или undefined. Перебор останавливается на находке. */
export function findEntry(filter: EntryFilter): SnapshotEntry | undefined {
  for (const entry of eachEntry()) {
    if (matchesEntry(entry, filter)) return entry
  }
  return undefined
}

/**
 * Сколько записей в каждом статусе. Экран списков рисует этим числа
 * у закладок. Запись без статуса попадает в UNKNOWN, а не теряется.
 *
 * Отбор обязательно тот же, что у строк: иначе число у закладки
 * считало бы записи, которых на этом экране не увидеть.
 */
export function countByStatus(filter: EntryFilter = EMPTY_FILTER): Map<string, number> {
  const totals = new Map<string, number>()
  for (const entry of eachEntry()) {
    if (!matchesEntry(entry, filter)) continue
    const key = entry.status ?? 'UNKNOWN'
    totals.set(key, (totals.get(key) ?? 0) + 1)
  }
  return totals
}

/** Средняя оценка по выставленным, два знака после запятой. Без оценок — ноль. */
export function averageScore(filter: EntryFilter = EMPTY_FILTER): number {
  let sum = 0
  let rated = 0

  for (const entry of eachEntry()) {
    if (entry.score10 <= 0) continue
    if (!matchesEntry(entry, filter)) continue
    sum += entry.score10
    rated += 1
  }

  return rated === 0 ? 0 : Math.round((sum / rated) * 100) / 100
}

/** Сумма просмотренных серий по отбору. Нужна сводке на экране настроек. */
export function totalProgress(filter: EntryFilter = EMPTY_FILTER): number {
  let total = 0
  for (const entry of eachEntry()) {
    if (matchesEntry(entry, filter)) total += entry.progress
  }
  return total
}

/**
 * Сумма прочитанных томов по отбору.
 *
 * Остаток от времён манги: новые записи томов не знают вовсе, а старые
 * снимки ещё помнят. Поле читается через ноль нарочно: следующим шагом
 * оно станет необязательным в снимке, и сборка должна выжить оба раза.
 */
export function totalVolumes(filter: EntryFilter = EMPTY_FILTER): number {
  let total = 0
  for (const entry of eachEntry()) {
    if (matchesEntry(entry, filter)) total += entry.volumes ?? 0
  }
  return total
}
