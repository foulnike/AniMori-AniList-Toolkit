// Русские названия и описания тайтлов: память, склад, затем сеть.
// Хозяин русских карточек: экранам не надо знать, откуда взялось название.
// Сами источники старые: порядок и настройки живут в api/titles.ts.

import { CACHE_TIME } from './constants'
import { dbGet, dbSet } from './db'
import { fetchMalIds } from '../api/anilist-media'
import { resolveTitle } from '../api/titles'
import { Logger } from '../utils/logger'
import type { ShikiCacheRecord } from './types'

/** Префикс ключа на складе. Цифра — версия формы записи: RU3 — с оценками площадок. */
const KEY_PREFIX = 'RU3_'

/** Готовая русская карточка тайтла. */
export interface RussianTitle {
  russian: string
  description: string | null
  url: string
  /** Имя источника для подписи под описанием. */
  sourceName: string
  /** Оценка MAL из зеркала Шикимори, шкала 0..10. */
  score: number | null
  /** Распределение голосов Шикимори для их собственной средней. */
  rates: Array<{ name: string; value: number }> | null
}

/**
 * Знание этого запуска. `null` значит «спрашивали, перевода нет»:
 * без этого каждая прокрутка списка снова била бы в сеть за тем же отказом.
 */
const memory = new Map<number, RussianTitle | null>()

/**
 * Русские названия, добытые попутно: их приносит поиск по Шикимори вместе
 * с находкой. Держатся отдельно от карточек: описания и ссылки тут нет,
 * и выдавать голое имя за полную карточку нельзя.
 */
const names = new Map<number, string>()

/**
 * Чьи ключи уже искали на складе. Отдельно от памяти: отсутствие на складе
 * не значит «перевода нет», сеть спросить всё ещё стоит, а склад — уже нет.
 */
const asked = new Set<number>()

/** Незавершённые добычи: два виджета часто просят один тайтл в один миг. */
const pending = new Map<number, Promise<RussianTitle | null>>()

function cacheKey(mediaId: number): string {
  return `${KEY_PREFIX}${mediaId}`
}

/** Читает карточку со склада. Протухшая запись считается отсутствующей. */
async function readCache(mediaId: number): Promise<RussianTitle | null> {
  asked.add(mediaId)

  const record = await dbGet<ShikiCacheRecord<RussianTitle>>('shikiCache', cacheKey(mediaId))
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  const data = record.data
  return data && typeof data.russian === 'string' && data.russian ? data : null
}

/** Кладёт карточку на склад. Отсутствие перевода на склад не пишется. */
async function writeCache(mediaId: number, data: RussianTitle): Promise<void> {
  await dbSet('shikiCache', { key: cacheKey(mediaId), data, ts: Date.now() })
}

/** Добывает карточку из сети по уже известному номеру MAL. */
async function fetchByMal(mediaId: number, malId: number): Promise<RussianTitle | null> {
  const resolved = await resolveTitle(malId, 'ANIME')

  if (!resolved || !resolved.russian) {
    memory.set(mediaId, null)
    return null
  }

  const card: RussianTitle = {
    russian: resolved.russian,
    description: resolved.description,
    url: resolved.url,
    sourceName: resolved.sourceName,
    score: resolved.score,
    rates: resolved.rates,
  }

  memory.set(mediaId, card)
  await writeCache(mediaId, card)
  return card
}

/** Полный путь для одного тайтла: склад, соответствие MAL, источники. */
async function loadOne(mediaId: number): Promise<RussianTitle | null> {
  const cached = await readCache(mediaId)
  if (cached) {
    memory.set(mediaId, cached)
    return cached
  }

  const malId = (await fetchMalIds([mediaId], 'ANIME')).get(mediaId)
  if (!malId) {
    memory.set(mediaId, null)
    return null
  }

  return await fetchByMal(mediaId, malId)
}

/**
 * Русская карточка тайтла или `null`, если перевода нет.
 * Повторные вызовы пока идёт добыча ждут тот же ответ, а не шлют свой запрос.
 *
 * Аргумент вида игнорируется: остаток от времён манги.
 */
export async function getRussianTitle(
  mediaId: number,
  _type?: string,
): Promise<RussianTitle | null> {
  if (memory.has(mediaId)) return memory.get(mediaId) ?? null

  const inFlight = pending.get(mediaId)
  if (inFlight) return await inFlight

  const task = loadOne(mediaId).catch((e) => {
    // Сбой не запоминается в памяти: сеть вернётся — спросим снова.
    Logger('WARN', `Русское название: добыть не вышло (тайтл ${mediaId})`, e)
    return null
  })

  pending.set(mediaId, task)

  try {
    return await task
  } finally {
    pending.delete(mediaId)
  }
}

/**
 * Запоминает русское название, доставшееся даром вместе с чужим ответом.
 * Сети это не стоит ничего, и выдача поиска выходит на русском сразу,
 * а не через двадцать запросов за тем, что уже было в руках.
 */
export function rememberRussianName(mediaId: number, russian: string): void {
  const clean = russian.trim()
  if (clean === '') return

  names.set(mediaId, clean)
}

/**
 * Поднимает в память то, что уже лежит на складе. Сеть не трогается вовсе.
 * Нужно поиску по своему списку: искать на кириллице надо по всей коллекции,
 * а не только по той сотне строк, которую успели показать.
 */
export async function warmRussianTitles(mediaIds: number[]): Promise<number> {
  let warmed = 0

  for (const mediaId of mediaIds) {
    // Склад спрашивается один раз за запуск: чтений тут тысячи, и второй проход лишний.
    if (memory.has(mediaId) || asked.has(mediaId)) continue

    try {
      const cached = await readCache(mediaId)
      if (!cached) continue

      memory.set(mediaId, cached)
      warmed++
    } catch (e) {
      // Склад мог не открыться: без него поиск обеднеет, но работать обязан.
      Logger('WARN', `Русские названия: склад не ответил по тайтлу ${mediaId}`, e)
      return warmed
    }
  }

  if (warmed > 0) Logger('DB', `Русские названия: со склада поднято ${warmed}`)
  return warmed
}

/**
 * Готовит карточки для видимого куска списка. Соответствия MAL берутся пачкой,
 * а сами источники опрашиваются по очереди: веер запросов сразу упирается в темп.
 *
 * Аргумент вида игнорируется: остаток от времён манги.
 */
export async function prefetchRussianTitles(mediaIds: number[], _type?: string): Promise<number> {
  const unknown: number[] = []

  for (const mediaId of mediaIds) {
    if (memory.has(mediaId)) continue

    const cached = await readCache(mediaId)
    if (cached) {
      memory.set(mediaId, cached)
      continue
    }

    unknown.push(mediaId)
  }

  if (unknown.length === 0) return 0

  const malIds = await fetchMalIds(unknown, 'ANIME')
  let added = 0

  for (const mediaId of unknown) {
    const malId = malIds.get(mediaId)
    if (!malId) {
      memory.set(mediaId, null)
      continue
    }

    try {
      if (await fetchByMal(mediaId, malId)) added++
    } catch (e) {
      // Один упавший тайтл не повод бросать остальной экран без названий.
      Logger('WARN', `Русское название: тайтл ${mediaId} пропущен`, e)
    }
  }

  Logger('INFO', `Русские названия: добыто ${added} из ${unknown.length}`)
  return added
}

/**
 * Что уже известно прямо сейчас, без ожидания.
 * Для отрисовки строки списка: нет перевода — показываем латиницу.
 */
export function peekRussianTitle(mediaId: number): RussianTitle | null {
  return memory.get(mediaId) ?? null
}

/**
 * Русское название, известное прямо сейчас: из полной карточки или попутное.
 * Строкам списка и выдачи большего и не надо.
 */
export function peekRussianName(mediaId: number): string | null {
  return memory.get(mediaId)?.russian ?? names.get(mediaId) ?? null
}

/** Забывает знание запуска. Склад не трогается: его чистят из настроек. */
export function forgetRussianTitles(): void {
  memory.clear()
  names.clear()
  asked.clear()
  pending.clear()
}
