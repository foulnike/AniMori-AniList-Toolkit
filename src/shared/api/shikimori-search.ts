// Поиск тайтлов по русскому слову у Shikimori: даёт номера MAL для выписки из AniList.
// Отдельно от shikimori.ts: тот отвечает за транспорт, зеркала и темп, здесь — сам запрос.
// Каталог AniList кириллицу не понимает, поэтому русское слово ищется только тут.

import { Logger } from '../utils/logger'
import { fetchShiki } from './shikimori'

/** Сколько находок просить у Шикимори за раз: больше на одну страницу не нужно. */
export const SHIKI_SEARCH_LIMIT = 20

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
 * Ищет тайтлы по слову у Шикимори. Порядок находок сохраняется:
 * первым идёт то, что источник считает наиболее подходящим.
 *
 * Взрослое из выдачи не вырезается: отбор по этому признаку — дело
 * пункта 3.8, и решать за пользователя здесь неуместно.
 *
 * Раздел всегда аниме: других приложение не открывает.
 */
export async function searchShikimori(word: string): Promise<ShikiFound[]> {
  const asked = word.trim()
  if (asked === '') return []

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

  Logger('API', `Поиск у Шикимори «${asked}»: нашлось ${found.length}`)
  return found
}
