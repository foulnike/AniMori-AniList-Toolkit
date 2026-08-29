// Русские названия и описания тайтлов: память, датасет, склад, затем сеть.
// Хозяин русских карточек: экранам не надо знать, откуда взялось название.
// Сами источники старые: порядок и настройки живут в api/titles.ts.
//
// Путей два, и они не равны. Имя нужно сеткам и полкам сотнями сразу,
// описание — по одному и только при открытии карточки. Пока имя и описание
// приезжали одной записью, сетка тянула описание, которого в ней не видно.
//
// ОТКАЗЫ ДЕРЖАТСЯ ОТДЕЛЬНО, и это главное правило файла. Знаний три: memory —
// что ответила сеть про карточку, names — голые имена, noname — «русского
// имени нет» для пачечных путей. Ответ датасета «имени нет» раньше ложился
// в memory тем же null, что и отказ сети, — и одна прокрутка списка глушила
// открытую карточку того же тайтла целиком.
//
// Датасет — первый источник, но не последняя инстанция: чего в нём нет,
// спрашивается в рантайме. Сетки тратят на это один заход на тайтл за всю
// жизнь установки, отказ ложится на склад. Открытая карточка ходит в сеть
// всегда: один запрос на осознанное нажатие — не та цена, чтобы её копить.

import { CACHE_TIME } from './constants'
import { lookupDatasetName } from './dataset-names'
import { dbGet, dbSet } from './db'
import { fetchMalIds } from '../api/anilist-media'
import { resolveTitle } from '../api/titles'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from './types'

/** Префикс ключа на складе. Цифра — версия формы записи: RU3 — с оценками площадок. */
const KEY_PREFIX = 'RU3_'

/**
 * Префикс склада имён. Отдельная запись, а не поле карточки: имён читаются
 * тысячи за раз, и тащить ради одной строки описание с оценками и голосами
 * дорого. Датасет названий ложится не сюда, а в свой файл: он обновляется
 * выпусками целиком и спрашивается раньше склада — см. core/dataset-names.ts.
 */
const NAME_PREFIX = 'NAME1_'

/**
 * Префикс отрицательных записей: «сеть спрашивали, русского имени нет».
 * Без них каждый запуск бил бы в три источника за теми же четырьмя тысячами
 * тайтлов, которых никто не переводил. Живут вечно, как и всё на складе:
 * появится имя — приедет с датасетом, а датасет спрашивается раньше.
 */
const NONAME_PREFIX = 'NONAME1_'

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
 * Знание этого запуска про карточки. `null` значит «спрашивали сеть, перевода
 * нет»: без этого два виджета на одном экране спросили бы дважды. Ответ
 * датасета сюда не попадает никогда: иначе обход списка решал бы за карточку,
 * которую пользователь откроет через минуту.
 */
const memory = new Map<number, RussianTitle | null>()

/**
 * Русские названия, добытые попутно: их приносит поиск по Шикимори вместе
 * с находкой. Держатся отдельно от карточек: описания и ссылки тут нет,
 * и выдавать голое имя за полную карточку нельзя.
 */
const names = new Map<number, string>()

/**
 * Кому русского имени нет вовсе. Поднимается со склада и переживает запуски.
 * Смотрят сюда только пачечные пути — сетки, полки, прокрутка. Открытая
 * карточка этот набор не спрашивает.
 */
const noname = new Set<number>()

/**
 * Чьи ключи уже искали на складе. Отдельно от памяти: отсутствие на складе
 * не значит «перевода нет», сеть спросить всё ещё стоит, а склад — уже нет.
 */
const asked = new Set<number>()

/** Чьи имена уже искали на складе имён. Склады разные — и отметки разные. */
const askedNames = new Set<number>()

/** Чьи отказы уже искали на складе: чтение пустоты тоже стоит обращения. */
const askedNoname = new Set<number>()

/** Незавершённые добычи: два виджета часто просят один тайтл в один миг. */
const pending = new Map<number, Promise<RussianTitle | null>>()

function cacheKey(mediaId: number): string {
  return `${KEY_PREFIX}${mediaId}`
}

function nameKey(mediaId: number): string {
  return `${NAME_PREFIX}${mediaId}`
}

function nonameKey(mediaId: number): string {
  return `${NONAME_PREFIX}${mediaId}`
}

/** Читает карточку со склада. Протухшая запись считается отсутствующей. */
async function readCache(mediaId: number): Promise<RussianTitle | null> {
  asked.add(mediaId)

  const record = await dbGet<MediaCacheRecord<RussianTitle>>('mediaCache', cacheKey(mediaId))
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  const data = record.data
  return data && typeof data.russian === 'string' && data.russian ? data : null
}

/** Кладёт карточку на склад. Отсутствие перевода на склад карточек не пишется. */
async function writeCache(mediaId: number, data: RussianTitle): Promise<void> {
  await dbSet('mediaCache', { key: cacheKey(mediaId), data, ts: Date.now() })
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

/**
 * Спрашивали ли уже сеть об этом тайтле и получали ли отказ.
 * Читается один раз за запуск: ответ склада от прокрутки не меняется.
 */
async function readNoname(mediaId: number): Promise<boolean> {
  if (noname.has(mediaId)) return true
  if (askedNoname.has(mediaId)) return false

  askedNoname.add(mediaId)

  const record = await dbGet<MediaCacheRecord<number>>('mediaCache', nonameKey(mediaId))
  if (!record || typeof record.ts !== 'number') return false
  if (Date.now() - record.ts > CACHE_TIME) return false

  noname.add(mediaId)
  return true
}

/**
 * Запоминает отказ сети навсегда. Именно сети: ответ датасета сюда не пишется,
 * иначе первая же прокрутка навечно закрыла бы тайтлу путь в рантайм.
 */
async function writeNoname(mediaId: number): Promise<void> {
  noname.add(mediaId)
  askedNoname.add(mediaId)

  await dbSet('mediaCache', { key: nonameKey(mediaId), data: 1, ts: Date.now() })
}

/** Добывает карточку из сети по уже известному номеру MAL. */
async function fetchByMal(mediaId: number, malId: number): Promise<RussianTitle | null> {
  const resolved = await resolveTitle(malId)

  if (!resolved || !resolved.russian) {
    // Сеть спрошена и ответила отказом — вот это в память класть можно:
    // открытая карточка через секунду спросит тех же и услышит то же.
    memory.set(mediaId, null)

    // Следующему запуску знание пригодится: сетки за этим тайтлом больше
    // не пойдут, а открытая карточка по-прежнему попробует.
    await writeNoname(mediaId)
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

  const malId = (await fetchMalIds([mediaId])).get(mediaId)
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
 * Путь открытой карточки, и потому единственный, кто не спрашивает
 * отрицательные записи: ни отсутствие имени в датасете, ни прошлый отказ сети
 * не повод оставить открытую карточку без описания и ссылки.
 */
export async function getRussianTitle(mediaId: number): Promise<RussianTitle | null> {
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
 * Поднимает в память имена, известные без сети: датасет, затем склады.
 * Сеть не трогается вовсе. Нужно поиску по своему списку: искать на
 * кириллице надо по всей коллекции, а не только по той сотне строк,
 * которую успели показать.
 *
 * Датасет отвечает первым, склад имён вторым, склад карточек третьим:
 * у давнего пользователя имена лежат только внутри карточек, а у нового —
 * в своих записях. Одного источника мало.
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
      // Датасет первым: он полнее складов и читается из памяти запуска.
      const fromDataset = await lookupDatasetName(mediaId)
      if (fromDataset.kind === 'name') {
        names.set(mediaId, fromDataset.name)
        warmed++
        continue
      }
      if (fromDataset.kind === 'none') {
        // Память не трогаем: здесь решается вопрос поиска по кириллице,
        // а не судьба открытой карточки. Сети тут нет вовсе.
        noname.add(mediaId)
        continue
      }

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

  if (warmed > 0) Logger('DB', `Русские имена: без сети поднято ${warmed}`)
  return warmed
}

/**
 * Готовит имена для видимого куска списка. Датасет спрашивается первым,
 * склад имён вторым, склад карточек третьим: у давнего пользователя имена
 * лежат только внутри карточек, и без третьего чтения сеть спросили бы
 * о том, что уже есть.
 *
 * Датасет отвечает «имени нет» — это не приговор, а повод спросить рантайм
 * один раз и запомнить ответ навсегда: выпуск собран из трёх источников,
 * но спрошенных в другой день, и один тайтл из десятка всё-таки находится.
 *
 * Соответствия MAL берутся пачкой, источники опрашиваются по очереди.
 */
export async function prefetchRussianNames(mediaIds: number[]): Promise<number> {
  const unknown: number[] = []
  let skipped = 0

  for (const mediaId of mediaIds) {
    if (memory.has(mediaId) || names.has(mediaId)) continue

    // Датасет — раньше складов: он свежее и полнее их обоих, а отвечает
    // из памяти, не трогая ни диск, ни сеть.
    const fromDataset = await lookupDatasetName(mediaId)
    if (fromDataset.kind === 'name') {
      names.set(mediaId, fromDataset.name)
      continue
    }

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

    // Отрицательная запись спрашивается последней: имя могло приехать
    // на склад позже отказа — например, попутно с поиском.
    if (await readNoname(mediaId)) {
      skipped++
      continue
    }

    unknown.push(mediaId)
  }

  if (unknown.length === 0) {
    if (skipped > 0) Logger('DB', `Русские имена: ${skipped} без перевода, сеть не трогаем`)
    return 0
  }

  const malIds = await fetchMalIds(unknown)
  let added = 0

  for (const mediaId of unknown) {
    const malId = malIds.get(mediaId)
    if (!malId) {
      // Номера MAL нет — спрашивать источники не по чему. Знание на склад,
      // но не в память: пачечный путь не решает за открытую карточку.
      await writeNoname(mediaId)
      continue
    }

    try {
      if (await fetchByMal(mediaId, malId)) added++
    } catch (e) {
      // Один упавший тайтл не повод бросать остальной экран без названий.
      Logger('WARN', `Русское имя: тайтл ${mediaId} пропущен`, e)
    }
  }

  const tail = skipped > 0 ? `, пропущено ${skipped}` : ''
  Logger('INFO', `Русские имена: добыто ${added} из ${unknown.length}${tail}`)
  return added
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
  noname.clear()
  asked.clear()
  askedNames.clear()
  askedNoname.clear()
  pending.clear()
}
