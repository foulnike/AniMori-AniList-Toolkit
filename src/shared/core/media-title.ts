// Русские названия и описания тайтлов: память, склад, затем сеть.
// Хозяин русских карточек: экранам не надо знать, откуда взялось название.
// Сами источники старые: порядок и настройки живут в api/titles.ts.
//
// Путей два, и они не равны. Имя нужно сеткам и полкам сотнями сразу,
// описание — по одному и только при открытии карточки. Пока имя и описание
// приезжали одной записью, сетка тянула описание, которого в ней не видно.

import { CACHE_TIME } from './constants'
import { dbGet, dbSet } from './db'
import { fetchMalIds } from '../api/anilist-media'
import { resolveTitle } from '../api/titles'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord, ShikiCacheRecord } from './types'

/** Префикс ключа на складе. Цифра — версия формы записи: RU3 — с оценками площадок. */
const KEY_PREFIX = 'RU3_'

/**
 * Префикс склада имён. Отдельная запись, а не поле карточки: имён читаются
 * тысячи за раз, и тащить ради одной строки описание с оценками и голосами
 * дорого. Готовый датасет названий ложится сюда же: карточек в нём нет.
 */
const NAME_PREFIX = 'NAME1_'

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

/** Чьи имена уже искали на складе имён. Склады разные — и отметки разные. */
const askedNames = new Set<number>()

/** Незавершённые добычи: два виджета часто просят один тайтл в один миг. */
const pending = new Map<number, Promise<RussianTitle | null>>()

function cacheKey(mediaId: number): string {
  return `${KEY_PREFIX}${mediaId}`
}

function nameKey(mediaId: number): string {
  return `${NAME_PREFIX}${mediaId}`
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

/** Читает имя со склада имён. Протухшая запись считается отсутствующей. */
async function readNameCache(mediaId: number): Promise<string | null> {
  askedNames.add(mediaId)

  const record = await dbGet<MediaCacheRecord<string>>('mediaCache', nameKey(mediaId))
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  return typeof record.data === 'string' && record.data !== '' ? record.data : null
}

/** Кладёт имя на склад имён. Пустое имя записью не считается. */
async function writeNameCache(mediaId: number, russian: string): Promise<void> {
  if (russian === '') return

  await dbSet('mediaCache', { key: nameKey(mediaId), data: russian, ts: Date.now() })
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

  // Один ответ наполняет оба склада: имя понадобится сетке, описание —
  // открытой карточке, и спрашивать источник о том же дважды незачем.
  await Promise.all([writeCache(mediaId, card), writeNameCache(mediaId, card.russian)])
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
 * Русское имя тайтла или `null`, если перевода нет. Путь сеток и полок:
 * описание, ссылка и оценки строке не нужны и отдельным запросом не берутся.
 *
 * Сеть остаётся последней ступенью и приносит полную карточку: источник
 * отдаёт имя и описание одним ответом, и выбрасывать полученное, чтобы
 * спросить его снова при открытии карточки, было бы расточительством.
 */
export async function getRussianName(mediaId: number): Promise<string | null> {
  // Память отвечает и за отказ: `null` там значит «спрашивали, перевода нет».
  if (memory.has(mediaId) || names.has(mediaId)) return peekRussianName(mediaId)

  const stored = askedNames.has(mediaId) ? null : await readNameCache(mediaId)
  if (stored !== null) {
    names.set(mediaId, stored)
    return stored
  }

  const card = await getRussianTitle(mediaId)
  if (card === null) return null

  // Карточка могла прийти со склада карточек, где имя лежит внутри неё:
  // своя запись переживёт её и достанется следующему запуску даром.
  await writeNameCache(mediaId, card.russian)
  return card.russian
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
 * Поднимает в память имена, которые уже лежат на складах. Сеть не трогается
 * вовсе. Нужно поиску по своему списку: искать на кириллице надо по всей
 * коллекции, а не только по той сотне строк, которую успели показать.
 *
 * Склад имён спрашивается первым, склад карточек — вторым: у давнего
 * пользователя имена лежат только внутри карточек, а после датасета — только
 * в своих записях. Одного склада мало ни сейчас, ни потом.
 *
 * Обратно в свою запись имя здесь не переносится: строк в коллекции тысячи,
 * и тысяча записей на одно нажатие клавиши дороже второго чтения. Перенос
 * делает prefetchRussianNames на видимом куске.
 */
export async function warmRussianNames(mediaIds: number[]): Promise<number> {
  let warmed = 0

  for (const mediaId of mediaIds) {
    if (memory.has(mediaId) || names.has(mediaId)) continue

    try {
      // Склады спрашиваются по одному разу за запуск: чтений тут тысячи.
      const stored = askedNames.has(mediaId) ? null : await readNameCache(mediaId)
      if (stored !== null) {
        names.set(mediaId, stored)
        warmed++
        continue
      }

      const cached = asked.has(mediaId) ? null : await readCache(mediaId)
      if (!cached) continue

      memory.set(mediaId, cached)
      warmed++
    } catch (e) {
      // Склад мог не открыться: без него поиск обеднеет, но работать обязан.
      Logger('WARN', `Русские имена: склад не ответил по тайтлу ${mediaId}`, e)
      return warmed
    }
  }

  if (warmed > 0) Logger('DB', `Русские имена: со склада поднято ${warmed}`)
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
 * Готовит имена для видимого куска списка. Склад имён спрашивается первым,
 * склад карточек — вторым: у давнего пользователя имена лежат только внутри
 * карточек, и без второго чтения сеть спросили бы о том, что уже есть.
 *
 * Соответствия MAL берутся пачкой, а источники опрашиваются по очереди:
 * веер запросов сразу упирается в темп.
 */
export async function prefetchRussianNames(mediaIds: number[]): Promise<number> {
  const unknown: number[] = []

  for (const mediaId of mediaIds) {
    if (memory.has(mediaId) || names.has(mediaId)) continue

    // Склад спрашивается один раз за запуск: прокрутка возвращается к тем же
    // строкам, а от повторного чтения ответ склада не меняется.
    const stored = askedNames.has(mediaId) ? null : await readNameCache(mediaId)
    if (stored !== null) {
      names.set(mediaId, stored)
      continue
    }

    const cached = asked.has(mediaId) ? null : await readCache(mediaId)
    if (cached) {
      memory.set(mediaId, cached)

      // Имя переносится в свою запись: следующий запуск возьмёт строку,
      // не поднимая описание с оценками и голосами.
      await writeNameCache(mediaId, cached.russian)
      continue
    }

    unknown.push(mediaId)
  }

  if (unknown.length === 0) return 0

  const malIds = await fetchMalIds(unknown)
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
      Logger('WARN', `Русское имя: тайтл ${mediaId} пропущен`, e)
    }
  }

  Logger('INFO', `Русские имена: добыто ${added} из ${unknown.length}`)
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
  askedNames.clear()
  pending.clear()
}
