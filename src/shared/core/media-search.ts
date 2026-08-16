// Поиск тайтлов: свой список и каталог, латиница и кириллица.
// Хозяин выбора пути: экранам не надо знать, кто понимает русское слово.
// Каталог AniList кириллицу не знает, поэтому русское идёт через Шикимори.

import { fetchBriefsByMal } from '../api/anilist-lookup'
import { searchMedia, type SearchPage } from '../api/anilist-media'
import { hasCyrillic, searchShikimori } from '../api/shikimori-search'
import { Logger } from '../utils/logger'
import { selectEntries } from './collection-view'
import { peekRussianTitle, warmRussianTitles } from './media-title'
import type { SnapshotEntry } from './snapshot'
import type { MediaType } from './types'

/**
 * Сколько записей своего списка просматривать за поиск. Потолок взят с запасом:
 * списки бывают на тысячи записей, а отбор идёт в памяти и сети не трогает.
 */
const OWN_SCAN_LIMIT = 20000

/** Одно слово к сравнению: регистр не важен, края обрезаются. */
function fold(text: string): string {
  return text.trim().toLowerCase()
}

/** Есть ли слово в названии. Пустое название ничего не совпадает. */
function fits(title: string | null | undefined, needle: string): boolean {
  return typeof title === 'string' && title !== '' && fold(title).includes(needle)
}

/**
 * Искать ли в каталоге через Шикимори. Вынесено наружу для подписи
 * под выдачей: человеку полезно видеть, чей ответ он читает.
 */
export function isRussianWord(word: string): boolean {
  return hasCyrillic(word)
}

/**
 * Поиск по своему списку. Слово сверяется с русским, ромадзи и английским
 * названием. Перед отбором поднимается склад переводов: иначе на кириллице
 * нашлось бы только то, что успели показать в этом запуске.
 */
export async function searchOwnList(
  word: string,
  type: MediaType,
  limit: number,
): Promise<SnapshotEntry[]> {
  const needle = fold(word)
  if (needle === '') return []

  const all = selectEntries({ type }, { key: 'updated' }, { limit: OWN_SCAN_LIMIT })

  // Склад поднимается только для русского слова: латиница есть в самом снимке.
  if (hasCyrillic(word)) {
    await warmRussianTitles(all.map((entry) => entry.mediaId))
  }

  const found: SnapshotEntry[] = []

  for (const entry of all) {
    const russian = peekRussianTitle(entry.mediaId)?.russian ?? null
    if (!fits(russian, needle) && !fits(entry.romaji, needle) && !fits(entry.english, needle)) {
      continue
    }

    found.push(entry)
    if (found.length >= limit) break
  }

  return found
}

/**
 * Поиск по каталогу. Латиница идёт прямо в AniList, русское слово — в Шикимори,
 * а его находки переводятся в тайтлы AniList одним запросом по номерам MAL.
 *
 * У русского пути второй страницы нет: Шикимори отдаёт двадцать лучших
 * совпадений, и дальше по списку идёт шум, а не ответ на вопрос.
 */
export async function searchCatalog(
  word: string,
  type: MediaType,
  page = 1,
): Promise<SearchPage | null> {
  const asked = word.trim()
  if (asked === '') return { items: [], hasNext: false, total: 0 }

  if (!hasCyrillic(asked)) return await searchMedia(asked, type, page)

  // Второй страницы у русского пути нет, поэтому добор возвращает пустоту.
  if (page > 1) return { items: [], hasNext: false, total: null }

  const found = await searchShikimori(asked, type)
  if (found.length === 0) {
    Logger('API', `Поиск «${asked}»: Шикимори ничего не нашёл`)
    return { items: [], hasNext: false, total: 0 }
  }

  const items = await fetchBriefsByMal(
    found.map((row) => row.malId),
    type,
  )

  Logger(
    'API',
    `Поиск «${asked}» через Шикимори: находок ${found.length}, в AniList есть ${items.length}`,
  )

  return { items, hasNext: false, total: items.length }
}
