// Дерево франшизы: хронология частей с Шикимори одним запросом,
// маппинг номеров MAL в AniList двумя пачками, склад бессрочный.
// Перенос виджета скрипта: там та же хронология рисовалась на чужой
// странице; здесь переходы внутренние, а статусы берутся из своей
// памяти списка — авторизованный запрос ради них не нужен.

import { queryAnilist } from '../api/anilist'
import { fetchShiki } from '../api/shikimori'
import { dbGet, dbSet } from './db'
import { Logger } from '../utils/logger'
import type { FranchiseCacheRecord, MediaType } from './types'

/** Узел дерева франшизы с Шикимори: номер тут — номер MAL. */
interface FranchiseNode {
  id: number
  name: string
  url: string
  year: number | null
  kind: string | null
}

/** Часть франшизы для полки: сопоставленная с каталогом AniList. */
export interface FranchiseWork {
  mediaId: number | null
  malId: number | null
  type: MediaType | null
  name: string
  year: number | null
  kind: string | null
  cover: string | null
  isAdult: boolean
}

interface FranchiseMapEntry {
  id: number
  idMal: number | null
  type: MediaType | null
  isAdult: boolean
  coverImage: { medium: string | null } | null
}

const FRANCHISE_MAP_QUERY = `
query ($ids: [Int], $type: MediaType) {
  Page(page: 1, perPage: 50) {
    media(idMal_in: $ids, type: $type) {
      id
      idMal
      type
      isAdult
      coverImage { medium }
    }
  }
}`

/** Знание этого запуска: дерево спрашивают карточка и полка одновременно. */
const memory = new Map<number, FranchiseWork[] | null>()

/** Незавершённые добычи по номеру тайтла. */
const pending = new Map<number, Promise<FranchiseWork[] | null>>()

/** Читает дерево со склада. Записи без постеров или с частями без
 *  сопоставления — старой формы: считаются промахом и переспрашиваются. */
async function readCache(mediaId: number): Promise<FranchiseWork[] | null> {
  const record = await dbGet<FranchiseCacheRecord>('franchiseCache', mediaId)
  const data = record?.data
  if (!Array.isArray(data) || data.length === 0) return null

  const first = data[0] as Partial<FranchiseWork> | undefined
  if (!first || typeof first.name !== 'string') return null
  if (!('cover' in first) || first.mediaId === undefined || first.mediaId === null) return null

  return data as FranchiseWork[]
}

/** Кладёт дерево на склад. Отсутствие дерева на склад не пишется. */
async function writeCache(mediaId: number, works: FranchiseWork[]): Promise<void> {
  await dbSet('franchiseCache', { id: mediaId, data: works, ts: Date.now() })
}

/** Добывает и собирает дерево: Шикимори по номеру MAL, затем маппинг. */
async function load(
  mediaId: number,
  malId: number,
  type: MediaType,
): Promise<FranchiseWork[] | null> {
  const reply = await fetchShiki<{ nodes?: FranchiseNode[] }>(
    `/api/${type === 'MANGA' ? 'mangas' : 'animes'}/${malId}/franchise`,
  )

  const nodes = Array.isArray(reply.data?.nodes) ? reply.data.nodes : []
  if (nodes.length === 0) {
    memory.set(mediaId, null)
    return null
  }

  // Дерево смешанное: в хронологии аниме встречается манга и наоборот.
  const malIds = [
    ...new Set(nodes.flatMap((n) => (typeof n.id === 'number' && n.id > 0 ? [n.id] : []))),
  ]

  const mappedByMal = new Map<number, FranchiseMapEntry>()
  if (malIds.length > 0) {
    const answers = await Promise.all([
      queryAnilist<{ Page?: { media?: FranchiseMapEntry[] } }>(FRANCHISE_MAP_QUERY, {
        ids: malIds,
        type: 'ANIME',
      }),
      queryAnilist<{ Page?: { media?: FranchiseMapEntry[] } }>(FRANCHISE_MAP_QUERY, {
        ids: malIds,
        type: 'MANGA',
      }),
    ])

    for (const answer of answers) {
      for (const entry of answer.data?.Page?.media ?? []) {
        if (typeof entry.idMal === 'number') mappedByMal.set(entry.idMal, entry)
      }
    }
  }

  const works: FranchiseWork[] = []
  for (const node of nodes) {
    if (typeof node.id !== 'number' || node.id <= 0) continue
    const mapped = mappedByMal.get(node.id)
    // Части только на Шикимори выкидываются: это клипы и реклама,
    // которых в каталоге AniList нет нарочно.
    if (mapped === undefined) continue

    works.push({
      mediaId: mapped.id,
      malId: node.id,
      type: mapped.type,
      name: node.name,
      year: typeof node.year === 'number' ? node.year : null,
      kind: node.kind ?? null,
      cover: mapped.coverImage?.medium ?? null,
      isAdult: mapped.isAdult === true,
    })
  }

  if (works.length <= 1) {
    // Одна часть — это не франшиза, а сам тайтл: полке делать нечего.
    memory.set(mediaId, null)
    return null
  }

  works.sort((a, b) => (a.year ?? 0) - (b.year ?? 0))

  memory.set(mediaId, works)
  await writeCache(mediaId, works)
  return works
}

/**
 * Хронология франшизы тайтла или `null`, когда дерева нет.
 * Ошибки глушатся: отсутствие полки — не поломка карточки.
 */
export async function fetchFranchise(
  mediaId: number,
  malId: number | null,
  type: MediaType,
): Promise<FranchiseWork[] | null> {
  if (malId === null) return null
  if (memory.has(mediaId)) return memory.get(mediaId) ?? null

  const inFlight = pending.get(mediaId)
  if (inFlight) return await inFlight

  const task = (async () => {
    const cached = await readCache(mediaId)
    if (cached !== null) {
      memory.set(mediaId, cached)
      return cached
    }

    return await load(mediaId, malId, type)
  })().catch((e) => {
    Logger('WARN', `Франшиза: дерево тайтла ${mediaId} не добылось`, e)
    return null
  })

  pending.set(mediaId, task)

  try {
    return await task
  } finally {
    pending.delete(mediaId)
  }
}
