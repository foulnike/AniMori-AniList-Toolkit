// Дерево франшизы: хронология всех частей одним запросом к Шикимори.
// Номера MAL мапятся на AniList двумя пачками — дерево смешанное, в нём
// бывают и манга, и ранобэ. Склад franchiseCache бессрочный: состав
// франшизы почти не меняется. Статусов из списка здесь нет: они читаются
// из своей памяти коллекции в момент показа.

import { dbGet, dbSet } from './db'
import { anilistQuery } from '../api/anilist'
import { fetchShiki } from '../api/shikimori'
import { Logger } from '../utils/logger'
import type { FranchiseCacheRecord, MediaType } from './types'

/** Часть франшизы в хронологии. */
export interface FranchiseWork {
  /** Номер у AniList; null — тайтла в их каталоге нет. */
  mediaId: number | null
  malId: number | null
  /** Тип из карты AniList; null у несопоставленного. */
  type: MediaType | null
  name: string
  year: number | null
  kind: string | null
  /** Постер из карты AniList; null у несопоставленного. */
  cover: string | null
  /** Метка 18+ из карты AniList; несопоставленное считается безопасным. */
  isAdult: boolean
}

/** Память запуска: по тайтлу дерево спрашивается один раз. */
const memory = new Map<number, FranchiseWork[] | null>()

const FRANCHISE_MAP_QUERY = `
  query ($m: [Int], $t: MediaType) {
    Page {
      media(idMal_in: $m, type: $t) {
        id
        idMal
        type
        isAdult
        coverImage { medium }
      }
    }
  }
`

interface FranchiseNode {
  id?: number | null
  name?: string | null
  year?: number | null
  kind?: string | null
}

interface FranchiseResponse {
  nodes?: FranchiseNode[] | null
}

interface MapMediaItem {
  id?: number | null
  idMal?: number | null
  type?: MediaType | null
  isAdult?: boolean | null
  coverImage?: { medium?: string | null } | null
}

/** Сортировка по году, затем по номеру: части без года уходят в конец. */
function sortNodes(nodes: FranchiseNode[]): FranchiseNode[] {
  return [...nodes].sort((a, b) => {
    const yearA = a.year ?? Number.POSITIVE_INFINITY
    const yearB = b.year ?? Number.POSITIVE_INFINITY
    if (yearA !== yearB) return yearA - yearB
    return (a.id ?? 0) - (b.id ?? 0)
  })
}

/** Карта «MAL id → тайтл AniList» одной пачкой на тип. */
async function fetchMap(
  malIds: number[],
  type: MediaType,
): Promise<Map<number, MapMediaItem>> {
  const map = new Map<number, MapMediaItem>()
  if (malIds.length === 0) return map

  const reply = await anilistQuery<{ Page?: { media?: Array<MapMediaItem | null> | null } }>(
    FRANCHISE_MAP_QUERY,
    { m: malIds, t: type },
  )

  for (const item of reply?.data?.Page?.media ?? []) {
    if (item && typeof item.idMal === 'number') map.set(item.idMal, item)
  }
  return map
}

/**
 * Хронология франшизы тайтла или null, когда дерева нет (один узел —
 * это сам тайтл, рисовать нечего) или источник молчит.
 */
export async function fetchFranchise(
  mediaId: number,
  malId: number | null,
  type: MediaType,
): Promise<FranchiseWork[] | null> {
  if (!malId) return null
  if (memory.has(mediaId)) return memory.get(mediaId) ?? null

  const cached = await dbGet<FranchiseCacheRecord>('franchiseCache', mediaId)
  if (cached && Array.isArray(cached.data)) {
    const first = cached.data[0] as Record<string, unknown> | undefined
    // Записи до появления постеров считаются промахом: дерево спросится заново.
    if (first !== undefined && 'cover' in first) {
      const works = cached.data as FranchiseWork[]
      memory.set(mediaId, works)
      return works
    }
  }

  const reply = await fetchShiki<FranchiseResponse>(
    `/api/${type === 'MANGA' ? 'mangas' : 'animes'}/${malId}/franchise`,
  )
  const nodes = reply.data?.nodes ?? null
  if (!nodes || nodes.length <= 1) {
    memory.set(mediaId, null)
    return null
  }

  const sorted = sortNodes(nodes)
  const malIds = sorted
    .map((node) => node.id)
    .filter((id): id is number => typeof id === 'number')

  // Дерево смешанное: мапим двумя пачками, аниме и мангу.
  const [animeMap, mangaMap] = await Promise.all([
    fetchMap(malIds, 'ANIME'),
    fetchMap(malIds, 'MANGA'),
  ])

  const works: FranchiseWork[] = []
  for (const node of sorted) {
    if (typeof node.id !== 'number' || !node.name) continue

    const mapped = animeMap.get(node.id) ?? mangaMap.get(node.id)
    works.push({
      mediaId: typeof mapped?.id === 'number' ? mapped.id : null,
      malId: node.id,
      type: mapped?.type ?? null,
      name: node.name,
      year: node.year ?? null,
      kind: node.kind ?? null,
      cover: mapped?.coverImage?.medium ?? null,
      isAdult: mapped?.isAdult ?? false,
    })
  }

  if (works.length <= 1) {
    memory.set(mediaId, null)
    return null
  }

  memory.set(mediaId, works)
  await dbSet('franchiseCache', { id: mediaId, data: works, ts: Date.now() })
  Logger('DB', `Франшиза тайтла ${mediaId}: частей ${works.length}`)
  return works
}
