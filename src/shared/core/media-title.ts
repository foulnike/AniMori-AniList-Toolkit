// Русские названия и описания тайтлов: память, склад, затем сеть.
// Хозяин русских карточек: экранам не надо знать, откуда взялось название.
// Сами источники старые: порядок и настройки живут в api/titles.ts.

import { CACHE_TIME } from './constants'
import { dbGet, dbSet } from './db'
import { fetchMalIds } from '../api/anilist-media'
import { resolveTitle } from '../api/titles'
import { Logger } from '../utils/logger'
import type { MediaType, ShikiCacheRecord } from './types'

/** Префикс ключа на складе. Цифра — версия формы записи, а не номер источника. */
const KEY_PREFIX = 'RU1_'

/** Готовая русская карточка тайтла. */
export interface RussianTitle {
  russian: string
  description: string | null
  url: string
  /** Имя источника для подписи под описанием. */
  sourceName: string
}

/**
 * Знание этого запуска. `null` значит «спрашивали, перевода нет»:
 * без этого каждая прокрутка списка снова била бы в сеть за тем же отказом.
 */
const memory = new Map<number, RussianTitle | null>()

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
async function fetchByMal(
  mediaId: number,
  malId: number,
  type: MediaType,
): Promise<RussianTitle | null> {
  const resolved = await resolveTitle(malId, type)

  if (!resolved || !resolved.russian) {
    memory.set(mediaId, null)
    return null
  }

  const card: RussianTitle = {
    russian: resolved.russian,
    description: resolved.description,
    url: resolved.url,
    sourceName: resolved.sourceName,
  }

  memory.set(mediaId, card)
  await writeCache(mediaId, card)
  return card
}

/** Полный путь для одного тайтла: склад, соответствие MAL, источники. */
async function loadOne(mediaId: number, type: MediaType): Promise<RussianTitle | null> {
  const cached = await readCache(mediaId)
  if (cached) {
    memory.set(mediaId, cached)
    return cached
  }

  const malId = (await fetchMalIds([mediaId], type)).get(mediaId)
  if (!malId) {
    memory.set(mediaId, null)
    return null
  }

  return await fetchByMal(mediaId, malId, type)
}

/**
 * Русская карточка тайтла или `null`, если перевода нет.
 * Повторные вызовы пока идёт добыча ждут тот же ответ, а не шлют свой запрос.
 */
export async function getRussianTitle(
  mediaId: number,
  type: MediaType = 'ANIME',
): Promise<RussianTitle | null> {
  if (memory.has(mediaId)) return memory.get(mediaId) ?? null

  const inFlight = pending.get(mediaId)
  if (inFlight) return await inFlight

  const task = loadOne(mediaId, type).catch((e) => {
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
 */
export async function prefetchRussianTitles(
  mediaIds: number[],
  type: MediaType = 'ANIME',
): Promise<number> {
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

  const malIds = await fetchMalIds(unknown, type)
  let added = 0

  for (const mediaId of unknown) {
    const malId = malIds.get(mediaId)
    if (!malId) {
      memory.set(mediaId, null)
      continue
    }

    try {
      if (await fetchByMal(mediaId, malId, type)) added++
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

/** Забывает знание запуска. Склад не трогается: его чистят из настроек. */
export function forgetRussianTitles(): void {
  memory.clear()
  asked.clear()
  pending.clear()
}
