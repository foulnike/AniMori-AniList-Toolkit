// Поиск тайтлов по русскому слову у Shikimori: даёт номера MAL для выписки из AniList.
// Отдельно от shikimori.ts: тот отвечает за транспорт, зеркала и темп, здесь — сам запрос.
// Каталог AniList кириллицу не понимает, поэтому русское слово ищется только тут.
//
// ПОВТОР ОДНОГО СЛОВА В СЕТЬ НЕ ЕДЕТ
//
// За вечер одно и то же слово спрашивают по многу раз: стёрли и вернули букву,
// ушли на карточку и вернулись, переключили экран туда-обратно. Каждый такой
// возврат был отдельным походом к Шикимори за уже полученным ответом.
// Находки держатся в памяти запуска четверть часа — столько же, сколько живёт
// страница поиска у AniList, — и повтор отвечает даром. На диск это не ложится:
// подборка «что нашлось по слову» стареет быстрее, чем успела бы пригодиться.

import { LIFE_SEARCH } from '../core/cache-life'
import { Logger } from '../utils/logger'
import { fetchShiki } from './shikimori'

/** Сколько находок просить у Шикимори за раз: больше на одну страницу не нужно. */
export const SHIKI_SEARCH_LIMIT = 20

/** Сколько разных слов помнить. Переполнение вытесняет самое давнее. */
const MEMORY_MAX = 30

/** Строка ответа поиска. Полей у Шикимори много, нам хватает номера и имён. */
interface ShikiSearchRow {
  id?: number
  name?: string | null
  russian?: string | null
}

/** Одна находка Шикимори. Номер здесь — номер MyAnimeList, они совпадают. */
export interface ShikiFound {
  malId: number
  russian: string | null
  name: string | null
}

/** Память находок: приведённое слово → что нашлось и когда. */
const memory = new Map<string, { at: number; found: ShikiFound[] }>()

/**
 * Есть ли в слове кириллица. По этому признаку выбирается путь поиска:
 * русское слово идёт в Шикимори, латиница — прямо в каталог AniList.
 */
export function hasCyrillic(word: string): boolean {
  return /[\u0400-\u04FF]/.test(word)
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Одно написание слова на все сравнения: регистр не важен, края обрезаются,
 * вереница пробелов внутри сводится к одному. Иначе «наруто» и «Наруто »
 * были бы разными вопросами, и память прошла бы мимо них обоих.
 */
function fold(word: string): string {
  return word.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Кладёт находки в память и держит её в оговорённом размере. */
function remember(key: string, found: ShikiFound[]): void {
  // Повторная запись переставляет слово в конец: вытесняется то, к чему
  // давно не возвращались, а не то, что спросили первым за вечер.
  memory.delete(key)
  memory.set(key, { at: Date.now(), found })

  while (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next()
    if (oldest.done) break

    memory.delete(oldest.value)
  }
}

/**
 * Забывает найденное по словам. Нужно ручной чистке склада: человек нажал
 * «очистить» и вправе считать, что прошлые ответы источника забыты.
 */
export function forgetShikiSearch(): void {
  memory.clear()
}

/**
 * Ищет тайтлы по слову у Шикимори. Порядок находок сохраняется:
 * первым идёт то, что источник считает наиболее подходящим.
 *
 * Повтор того же слова в пределах четверти часа отвечает из памяти запуска
 * и сеть не трогает вовсе.
 *
 * Взрослое из выдачи не вырезается: отбор по этому признаку — дело
 * пункта 3.8, и решать за пользователя здесь неуместно.
 *
 * Раздел всегда аниме: других приложение не открывает.
 */
export async function searchShikimori(word: string): Promise<ShikiFound[]> {
  const asked = word.trim()
  if (asked === '') return []

  const key = fold(asked)
  const kept = memory.get(key)

  if (kept && Date.now() - kept.at < LIFE_SEARCH) {
    Logger('API', `Поиск у Шикимори «${asked}»: ответ из памяти, находок ${kept.found.length}`)

    // Наружу уходит копия списка: перестановки на стороне зовущего
    // не должны портить то, чем ответим следующему.
    return kept.found.slice()
  }

  // Раздел вписан словом: у Шикимори аниме и манга — разные разделы,
  // и номер из чужого раздела увёл бы выписку совсем не туда.
  const path =
    `/api/animes?search=${encodeURIComponent(asked)}` +
    `&limit=${SHIKI_SEARCH_LIMIT}&censored=false`

  const reply = await fetchShiki<ShikiSearchRow[]>(path)
  const rows = Array.isArray(reply.data) ? reply.data : []
  const found: ShikiFound[] = []

  for (const row of rows) {
    if (!row || typeof row.id !== 'number' || row.id <= 0) continue

    found.push({
      malId: row.id,
      russian: textOrNull(row.russian),
      name: textOrNull(row.name),
    })
  }

  remember(key, found)

  Logger('API', `Поиск у Шикимори «${asked}»: нашлось ${found.length}`)
  return found
}
