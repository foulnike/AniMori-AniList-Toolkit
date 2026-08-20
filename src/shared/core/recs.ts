// Рекомендации главной (пункт 3.11): профиль вкуса по любимым жанрам,
// советы «по мотивам», отбор показанного и список «не интересует».
// Кэш живёт в памяти запуска: пересчёт на каждый запуск — решение реестра.

import { Bridge } from '@/bridge'
import type { MediaBrief } from '../api/anilist-media'
import { fetchGenreMap, fetchRecsFor, fetchShelf, type ShelfKind } from '../api/anilist-catalog'
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

/** Прячет тайтл из рекомендаций насовсем. Запись идёт вдогонку за памятью. */
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
      const map = await fetchGenreMap(
        loved.map((entry) => entry.mediaId),
        'ANIME',
      )
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
 * Полка каталога с применённым отбором. Отказ сети — пустая полка.
 *
 * Аргумент вида игнорируется и в ключ кэша не идёт: иначе одна и та же
 * полка считалась бы дважды, пока одни вызовы его передают, а другие нет.
 */
export function recShelf(
  kind: ShelfKind,
  _type?: string,
  genres?: string[],
): Promise<MediaBrief[]> {
  return cached(`${kind}:${(genres ?? []).join(',')}`, async () => {
    try {
      return await visible(await fetchShelf(kind, 'ANIME', genres))
    } catch (e) {
      Logger('WARN', `Рекомендации: полка «${kind}» не доехала`, e)
      return []
    }
  })
}

/** Подбор «под ваш вкус» по любимым жанрам. Без оценок 8+ полки нет. */
export function tasteShelf(_type?: string): Promise<MediaBrief[]> {
  return cached('taste', async () => {
    const genres = await tasteGenres()
    if (genres.length === 0) return []
    return recShelf('genre', undefined, genres)
  })
}

/** Советы «по мотивам»: повторы склеиваются суммой весов. */
export function motifShelf(_type?: string): Promise<MediaBrief[]> {
  return cached('motif', async () => {
    const seeds = pickSeeds()
    if (seeds.length === 0) return []

    const weight = new Map<number, { brief: MediaBrief; rating: number }>()
    for (const seed of seeds) {
      try {
        for (const rec of await fetchRecsFor(seed, 'ANIME')) {
          const known = weight.get(rec.brief.mediaId)
          if (known !== undefined) known.rating += rec.rating
          else weight.set(rec.brief.mediaId, { brief: rec.brief, rating: rec.rating })
        }
      } catch (e) {
        Logger('WARN', `Рекомендации: советы для ${seed} не доехали`, e)
      }
    }

    return visible(
      Array.from(weight.values())
        .sort((a, b) => b.rating - a.rating)
        .map((rec) => rec.brief),
    )
  })
}
