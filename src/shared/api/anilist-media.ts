// Соответствие номеров AniList и MyAnimeList: русские источники знают только MAL.
// Отдельно от anilist-list.ts: там записи пользователя, здесь сами тайтлы.
// Запрос пакетный: вся коллекция поодиночке сожгла бы темп целиком.

import type { MediaType } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'

/** Сколько тайтлов просим одним запросом. Потолок страницы у AniList — пятьдесят. */
const PAGE_SIZE = 50

const MAL_QUERY = `query ($ids: [Int], $type: MediaType, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(id_in: $ids, type: $type) {
      id
      idMal
    }
  }
}`

interface MalReply {
  Page?: {
    media?: Array<{ id?: number; idMal?: number | null } | null> | null
  } | null
}

/**
 * Номера MAL для набора тайтлов AniList. Ключ соответствия — номер AniList.
 * Тайтлы без номера MAL в ответ не попадают: русского источника для них нет.
 */
export async function fetchMalIds(ids: number[], type: MediaType): Promise<Map<number, number>> {
  const found = new Map<number, number>()
  const unique = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))

  for (let from = 0; from < unique.length; from += PAGE_SIZE) {
    const chunk = unique.slice(from, from + PAGE_SIZE)
    const reply = await anilistQuery<MalReply>(MAL_QUERY, {
      ids: chunk,
      type,
      perPage: PAGE_SIZE,
    })

    const media = reply.data?.Page?.media
    if (!Array.isArray(media)) {
      // Пачка потеряна, но соседние могут дойти: обрывать обход смысла нет.
      Logger('WARN', `Соответствия MAL: пустой ответ на пачку из ${chunk.length}`)
      continue
    }

    for (const item of media) {
      if (!item || typeof item.id !== 'number') continue
      if (typeof item.idMal === 'number' && item.idMal > 0) found.set(item.id, item.idMal)
    }
  }

  if (unique.length > 0) {
    Logger('API', `Соответствия MAL: спросили ${unique.length}, нашли ${found.size}`)
  }

  return found
}
