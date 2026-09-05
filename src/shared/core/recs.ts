// Рекомендации главной (пункт 3.11): профиль вкуса по любимым жанрам,
// советы «по мотивам», бесконечная лента подбора, отбор показанного
// и список «не интересует».
// Кэш живёт в памяти запуска: пересчёт на каждый запуск — решение реестра.
//
// ПАЧКА ВМЕСТО ТРЁХ ПОХОДОВ
// Сезон, тренд и лучшее спрашиваются одним запросом и раздаются трём полкам
// из общего обещания. Раньше это были три захода подряд через общую паузу
// клиента, и витрина собиралась ступеньками по несколько секунд.
//
// ЛЕНТА ОТДАЁТ РОВНУЮ ПОРЦИЮ
// Своё, скрытое и взрослое выбрасываются после ответа сервера, и страница
// из сорока аниме у человека с большим списком легко тает до трёх.
// Поэтому «Показать ещё» просит не страницу, а нужное число плиток.
//
// И ровно нужное: набранное сверх порции ждёт в остатке ленты, а не едет
// в сетку случайным хвостом. Сетка раскладывает плитки по рядам, и лишние
// три-пять штук оставляли нижний ряд недобранным всю ленту насквозь.

import { Bridge } from '@/bridge'
import type { MediaBrief } from '../api/anilist-media'
import {
  fetchFeed,
  fetchGenreMap,
  fetchRecsFor,
  fetchShelf,
  fetchShelfPack,
  fetchTags,
  type CatalogPick,
  type CatalogTag,
  type FeedPage,
  type PackKind,
  type ShelfKind,
  type ShelfPack,
} from '../api/anilist-catalog'
import { Logger } from '../utils/logger'
import { keepAllowed } from './adult'
import { getEntry } from './collection'
import { selectEntries } from './collection-view'

/** Сколько любимых записей участвуют в профиле вкуса. */
const TASTE_DEPTH = 30

/** Сколько жанров вкуса идёт в подбор: один шумит, четыре размывают. */
const TASTE_GENRES = 2

/** Сколько семян «по мотивам» опрашивается за запуск. */
const SEED_COUNT = 2

/** Из скольких любимых выбираются семена: каждый запуск другая пара. */
const SEED_POOL = 8

/** Оценка, с которой запись считается любимой. */
const LOVED_SCORE = 8

/** Сколько страниц берётся за один «Показать ещё». Потолок обязателен:
    узкий отбор вроде «меха до 1990» иначе уведёт в десятки запросов подряд. */
const FEED_TRIES = 3

/** Ключ хранилища скрытого. Пользовательские данные, а не настройка. */
const HIDE_KEY = 'am_recs_hidden'

/** Потолок списка скрытого: без него годы «не интересует» раздуют запись. */
const HIDE_LIMIT = 500

/** Скрытые номера. Пустота до подъёма значит «ещё не читали». */
let hidden: Set<number> | null = null

/** Посчитанное за запуск: переключение вкладки не дёргает сеть снова. */
const done = new Map<string, Promise<MediaBrief[]>>()

/** Профиль вкуса запуска. null значит «ещё не считали», пустота — «считали, нету». */
let taste: string[] | null = null

/** Общее обещание пачки полок: три полки ждут один и тот же ответ. */
let packRun: Promise<ShelfPack> | null = null

/** Справочник тэгов запуска: меню отбора открывают много раз за сеанс. */
let tagsRun: Promise<CatalogTag[]> | null = null

/** Поднимает список скрытого из хранилища один раз за запуск. */
async function loadHidden(): Promise<Set<number>> {
  if (hidden !== null) return hidden

  try {
    const stored = await Bridge.storage.get<number[]>(HIDE_KEY, [])
    hidden = new Set(Array.isArray(stored) ? stored.filter((id) => Number.isFinite(id)) : [])
  } catch (e) {
    // Без списка скрытого витрина работает: просто покажет всё.
    Logger('WARN', 'Рекомендации: скрытое не поднялось', e)
    hidden = new Set()
  }

  return hidden
}

/** Прячет аниме из рекомендаций насовсем. Запись идёт вдогонку за памятью. */
export async function hideRec(mediaId: number): Promise<void> {
  const known = await loadHidden()
  known.add(mediaId)

  // Старые вытесняются: древнее «не интересует» давно неактуально.
  const list = Array.from(known).slice(-HIDE_LIMIT)
  hidden = new Set(list)

  try {
    await Bridge.storage.set(HIDE_KEY, list)
  } catch (e) {
    Logger('WARN', 'Рекомендации: скрытое не записалось', e)
  }
}

/** Любимые жанры хозяина: взвешены оценкой, плоский счёт хвалил бы мусор. */
async function tasteGenres(): Promise<string[]> {
  if (taste !== null) return taste

  let genres: string[] = []
  const loved = selectEntries(
    { onlyRated: true, minScore: LOVED_SCORE },
    { key: 'score' },
    { limit: TASTE_DEPTH },
  )

  if (loved.length > 0) {
    try {
      const map = await fetchGenreMap(loved.map((entry) => entry.mediaId))
      const weight = new Map<string, number>()
      for (const entry of loved) {
        for (const genre of map.get(entry.mediaId) ?? []) {
          weight.set(genre, (weight.get(genre) ?? 0) + entry.score10)
        }
      }
      genres = Array.from(weight.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, TASTE_GENRES)
        .map(([name]) => name)
    } catch (e) {
      Logger('WARN', 'Рекомендации: жанры вкуса не доехали', e)
    }
  }

  taste = genres
  return genres
}

/** Семена «по мотивам»: пара из любимых, каждый запуск другая. */
function pickSeeds(): number[] {
  const loved = selectEntries(
    { onlyRated: true, minScore: LOVED_SCORE },
    { key: 'score' },
    { limit: SEED_POOL },
  )
  return loved
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, SEED_COUNT)
    .map((entry) => entry.mediaId)
}

/** Что не показываем: своё, скрытое и взрослое при выключенном показе. */
async function visible(briefs: MediaBrief[]): Promise<MediaBrief[]> {
  const hiddenSet = await loadHidden()
  return keepAllowed(
    briefs.filter(
      (brief) => getEntry(brief.mediaId) === undefined && !hiddenSet.has(brief.mediaId),
    ),
    (brief) => brief.isAdult,
  ).slice()
}

/** Полка через кэш запуска: ключ зовёт одну и ту же загрузку лишь раз. */
function cached(key: string, load: () => Promise<MediaBrief[]>): Promise<MediaBrief[]> {
  const known = done.get(key)
  if (known !== undefined) return known

  const promise = load()
  done.set(key, promise)
  return promise
}

/**
 * Пачка полок каталога одним запросом. Провал сбрасывает обещание: витрина
 * пересобирается при возврате на главную, и после обрыва сети вторая попытка
 * обязана уйти в сеть, а не вернуть запомненную пустоту.
 */
function loadPack(): Promise<ShelfPack> {
  if (packRun !== null) return packRun

  packRun = fetchShelfPack().catch((e: unknown) => {
    Logger('WARN', 'Рекомендации: пачка полок не доехала', e)
    packRun = null
    return { airing: [], trending: [], top: [] }
  })

  return packRun
}

/** Одна полка из пачки с применённым отбором показа. */
export function packShelf(kind: PackKind): Promise<MediaBrief[]> {
  return cached(`pack:${kind}`, async () => visible((await loadPack())[kind]))
}

/** Полка каталога с применённым отбором. Отказ сети — пустая полка. */
export function recShelf(kind: ShelfKind, genres?: string[]): Promise<MediaBrief[]> {
  return cached(`${kind}:${(genres ?? []).join(',')}`, async () => {
    try {
      return await visible(await fetchShelf(kind, genres))
    } catch (e) {
      Logger('WARN', `Рекомендации: полка «${kind}» не доехала`, e)
      return []
    }
  })
}

/** Подбор «под ваш вкус» по любимым жанрам. Без оценок 8+ полки нет. */
export function tasteShelf(): Promise<MediaBrief[]> {
  return cached('taste', async () => {
    const genres = await tasteGenres()
    if (genres.length === 0) return []
    return recShelf('genre', genres)
  })
}

/**
 * Советы «по мотивам»: повторы склеиваются суммой весов.
 *
 * Семена спрашиваются разом: друг от друга они не зависят, а очередью
 * и темпом ведает клиент AniList. Отказ одного семени не роняет полку:
 * советы второго сами по себе уже полка.
 */
export function motifShelf(): Promise<MediaBrief[]> {
  return cached('motif', async () => {
    const seeds = pickSeeds()
    if (seeds.length === 0) return []

    const packs = await Promise.all(
      seeds.map(async (seed) => {
        try {
          return await fetchRecsFor(seed)
        } catch (e) {
          Logger('WARN', `Рекомендации: советы для ${seed} не доехали`, e)
          return []
        }
      }),
    )

    const weight = new Map<number, { brief: MediaBrief; rating: number }>()
    for (const recs of packs) {
      for (const rec of recs) {
        const known = weight.get(rec.brief.mediaId)
        if (known !== undefined) known.rating += rec.rating
        else weight.set(rec.brief.mediaId, { brief: rec.brief, rating: rec.rating })
      }
    }

    return visible(
      Array.from(weight.values())
        .sort((a, b) => b.rating - a.rating)
        .map((rec) => rec.brief),
    )
  })
}

/**
 * Справочник тэгов для меню отбора. Провал сбрасывает обещание: меню
 * без тэгов бесполезно, и второе открытие должно попробовать снова.
 */
export function tagChoices(): Promise<CatalogTag[]> {
  if (tagsRun !== null) return tagsRun

  tagsRun = fetchTags().catch((e: unknown) => {
    Logger('WARN', 'Рекомендации: справочник тэгов не доехал', e)
    tagsRun = null
    return []
  })

  return tagsRun
}

/**
 * Состояние ленты подбора: где остановились и кого уже отдавали.
 * Живёт у вызывающего, а не в ядре: лент бывает несколько, и чужой экран
 * не должен листать чужую.
 */
export interface FeedRun {
  pick: CatalogPick
  page: number
  /** Каталог кончился и остаток роздан: кнопка «Показать ещё» больше не нужна. */
  done: boolean
  /** Страницы сервера исчерпаны. Отдельно от `done`: остаток ещё может лежать. */
  over: boolean
  seen: Set<number>
  /** Набранное сверх порции: следующее нажатие начинает с него, а не с сети. */
  rest: MediaBrief[]
}

/** Новая лента под отбор. Страницы ещё не брали. */
export function newFeed(pick: CatalogPick): FeedRun {
  return { pick, page: 0, done: false, over: false, seen: new Set(), rest: [] }
}

/**
 * Следующая порция ленты: ровно `want` плиток, пока каталог не кончился.
 *
 * Ровно — это не придирка: порция подобрана под целое число рядов сетки,
 * и случайный хвост сверх неё оставлял нижний ряд наполовину пустым.
 * Лишнее не выбрасывается и не спрашивается вторично: оно ждёт в остатке
 * ленты, и следующее нажатие часто обходится вовсе без сети.
 *
 * Пустой ответ при `done === false` — не конец ленты, а неудачный заход:
 * кнопка остаётся, и следующее нажатие продолжит с той же страницы.
 */
export async function feedMore(run: FeedRun, want: number): Promise<MediaBrief[]> {
  // Остаток прежнего захода идёт вперед сети: он уже отобран и проверен.
  const out: MediaBrief[] = run.rest.splice(0, want)

  for (let attempt = 0; attempt < FEED_TRIES && !run.over && out.length < want; attempt++) {
    const page = run.page + 1

    let reply: FeedPage
    try {
      reply = await fetchFeed(run.pick, page)
    } catch (e) {
      // Отказ сети не закрывает ленту: страница не засчитана, берём её же потом.
      Logger('WARN', `Лента подбора: страница ${page} не доехала`, e)
      break
    }

    run.page = page
    if (!reply.hasNext) run.over = true

    for (const brief of await visible(reply.items)) {
      if (run.seen.has(brief.mediaId)) continue
      run.seen.add(brief.mediaId)

      // Сверх порции — в остаток. В виденные оно уже записано: иначе
      // следующая страница привезла бы то же вторым плитками.
      if (out.length < want) out.push(brief)
      else run.rest.push(brief)
    }
  }

  // Лента закрывается только когда кончился и каталог, и остаток.
  run.done = run.over && run.rest.length === 0
  return out
}
