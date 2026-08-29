// Поиск тайтлов: свой список и каталог, латиница и кириллица.
// Хозяин выбора пути: экранам не надо знать, кто понимает русское слово.
// Каталог AniList кириллицу не знает, поэтому русское идёт через Шикимори.
//
// Здесь же проходит отбор взрослого: политика одна на все пути каталога,
// решение живёт в core/adult.ts. Экраны получают выдачу уже отобранной.

import { fetchBriefsByMal } from '../api/anilist-lookup'
import { searchMedia, type MediaBrief, type SearchPage } from '../api/anilist-media'
import { hasCyrillic, searchShikimori } from '../api/shikimori-search'
import { Logger } from '../utils/logger'
import { hiddenCount, keepAllowed } from './adult'
import { selectEntries } from './collection-view'
import { peekRussianName, rememberRussianName, warmRussianNames } from './media-title'
import type { SnapshotEntry } from './snapshot'

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

/** Признак взрослого у находки каталога. Одна выжимка на все пути отбора. */
function briefIsAdult(brief: MediaBrief): boolean {
  return brief.isAdult
}

/**
 * Убирает взрослое из страницы находок и правит числа под новый состав.
 *
 * Общее число сервера после отбора обнуляется: оно считало и спрятанное,
 * а «найдено 20» над четырнадцатью плитками — вранье хуже отсутствия числа.
 * Признак следующей страницы остаётся серверным: добор всё равно спрашивают
 * у каталога, и на его страницах отбор пройдёт заново.
 */
function sift(page: SearchPage, word: string): SearchPage {
  const hidden = hiddenCount(page.items, briefIsAdult)
  if (hidden === 0) return page

  const items = keepAllowed(page.items, briefIsAdult) as MediaBrief[]
  Logger('INFO', `Поиск «${word}»: спрятано взрослых ${hidden} из ${page.items.length}`)

  return { items, hasNext: page.hasNext, total: null }
}

/**
 * Поиск по своему списку. Слово сверяется с русским, ромадзи и английским
 * названием. Перед отбором поднимается склад имён: иначе на кириллице
 * нашлось бы только то, что успели показать в этом запуске.
 *
 * Взрослое здесь НЕ отсеивается: своя запись уже своя, и прятать её значит
 * терять свои же данные из вида. Метку 18+ рисует плитка.
 *
 * Отбора по виду больше нет: в коллекции только аниме, а лишнее условие
 * скрыло бы записи старых снимков до их первого обновления с сервера.
 */
export async function searchOwnList(word: string, limit: number): Promise<SnapshotEntry[]> {
  const needle = fold(word)
  if (needle === '') return []

  const all = selectEntries({}, { key: 'updated' }, { limit: OWN_SCAN_LIMIT })

  // Склад имён поднимается только для русского слова: латиница есть в снимке.
  if (hasCyrillic(word)) {
    await warmRussianNames(all.map((entry) => entry.mediaId))
  }

  const found: SnapshotEntry[] = []

  for (const entry of all) {
    const russian = peekRussianName(entry.mediaId)
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
export async function searchCatalog(word: string, page = 1): Promise<SearchPage | null> {
  const asked = word.trim()
  if (asked === '') return { items: [], hasNext: false, total: 0 }

  if (!hasCyrillic(asked)) {
    const found = await searchMedia(asked, page)
    // Отказ сервера остаётся отказом: пустую страницу вместо него подсовывать нельзя.
    return found === null ? null : sift(found, asked)
  }

  // Второй страницы у русского пути нет, поэтому добор возвращает пустоту.
  if (page > 1) return { items: [], hasNext: false, total: null }

  const found = await searchShikimori(asked)
  if (found.length === 0) {
    Logger('API', `Поиск «${asked}»: Шикимори ничего не нашёл`)
    return { items: [], hasNext: false, total: 0 }
  }

  // Русские названия приехали вместе с находками: связь держится по номеру MAL.
  const russianByMal = new Map<number, string>()
  for (const row of found) {
    if (typeof row.russian === 'string' && row.russian !== '') {
      russianByMal.set(row.malId, row.russian)
    }
  }

  const items = await fetchBriefsByMal(found.map((row) => row.malId))

  // Имя уже в руках — ходить за ним в сеть по второму кругу было бы глупо.
  // Запоминается имя и для спрятанного: настройку могут включить, а тайтл
  // тогда уже будет назван по-русски без нового запроса.
  for (const item of items) {
    if (item.malId === null) continue

    const russian = russianByMal.get(item.malId)
    if (russian) rememberRussianName(item.mediaId, russian)
  }

  Logger(
    'API',
    `Поиск «${asked}» через Шикимори: находок ${found.length}, в AniList есть ${items.length}`,
  )

  return sift({ items, hasNext: false, total: items.length }, asked)
}
