// Дерево франшизы: хронология частей с Шикимори одним запросом,
// маппинг номеров MAL в AniList двумя пачками, склад бессрочный.
// Перенос виджета скрипта: там та же хронология рисовалась на чужой
// странице; здесь переходы внутренние, а статусы берутся из своей
// памяти списка — авторизованный запрос ради них не нужен.
//
// Пространства номеров MAL у аниме и манги раздельны: манга 33255
// существует отдельно от аниме 33255. Поэтому маппинг ведётся по паре
// «тип + номер», а тип узла читается из его адреса (/animes/, /mangas/).

import { anilistQuery } from '../api/anilist'
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
  /** Полная дата узла, unix-секунды: хронология сортируется по ней. */
  date?: number | null
  kind: string | null
}

/** Часть франшизы для полки: сопоставленная с каталогом AniList. */
export interface FranchiseWork {
  mediaId: number | null
  malId: number | null
  type: MediaType | null
  name: string
  year: number | null
  /** Полная дата части, unix-секунды. */
  date: number | null
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

/** Читает дерево со склада. Записи старой формы — без постеров, без полной
 *  даты или с частями без сопоставления — считаются промахом. Проверяется
 *  каждая часть, а не первая: иначе старый склад с клипом в середине
 *  выживал. */
async function readCache(mediaId: number): Promise<FranchiseWork[] | null> {
  const record = await dbGet<FranchiseCacheRecord>('franchiseCache', mediaId)
  const data = record?.data
  if (!Array.isArray(data) || data.length === 0) return null

  for (const work of data as Array<Partial<FranchiseWork> | undefined>) {
    if (!work || typeof work.name !== 'string') return null
    if (!('cover' in work) || !('date' in work)) return null
    if (work.mediaId === undefined || work.mediaId === null) return null
  }

  return data as FranchiseWork[]
}

/** Кладёт дерево на склад. Отсутствие дерева на склад не пишется. */
async function writeCache(mediaId: number, works: FranchiseWork[]): Promise<void> {
  await dbSet('franchiseCache', { id: mediaId, data: works, ts: Date.now() })
}

/** Пространство номеров MAL по адресу узла: /animes/ и /mangas/ раздельны. */
function nodeType(url: string): MediaType {
  return url.startsWith('/mangas') ? 'MANGA' : 'ANIME'
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

  // Две таблицы по пространствам номеров: голый номер MAL не уникален,
  // и чужая манга с тем же номером перезаписывала сезон аниме.
  const mappedAnime = new Map<number, FranchiseMapEntry>()
  const mappedManga = new Map<number, FranchiseMapEntry>()
  if (malIds.length > 0) {
    const answers = await Promise.all([
      anilistQuery<{ Page?: { media?: FranchiseMapEntry[] } }>(FRANCHISE_MAP_QUERY, {
        ids: malIds,
        type: 'ANIME',
      }),
      anilistQuery<{ Page?: { media?: FranchiseMapEntry[] } }>(FRANCHISE_MAP_QUERY, {
        ids: malIds,
        type: 'MANGA',
      }),
    ])

    for (const entry of answers[0]?.data?.Page?.media ?? []) {
      if (typeof entry.idMal === 'number') mappedAnime.set(entry.idMal, entry)
    }
    for (const entry of answers[1]?.data?.Page?.media ?? []) {
      if (typeof entry.idMal === 'number') mappedManga.set(entry.idMal, entry)
    }
  }

  const works: FranchiseWork[] = []
  for (const node of nodes) {
    if (typeof node.id !== 'number' || node.id <= 0) continue

    const kind = nodeType(node.url ?? '')
    const mapped = (kind === 'MANGA' ? mappedManga : mappedAnime).get(node.id)
    // Части только на Шикимори выкидываются: это клипы и реклама,
    // которых в каталоге AniList нет нарочно.
    if (mapped === undefined) continue

    works.push({
      mediaId: mapped.id,
      malId: node.id,
      type: mapped.type,
      name: node.name,
      year: typeof node.year === 'number' ? node.year : null,
      date: typeof node.date === 'number' && node.date > 0 ? node.date : null,
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

  // Хронология по полной дате: сезоны одного года иначе ехали.
  works.sort((a, b) => (a.date ?? Number.MAX_SAFE_INTEGER) - (b.date ?? Number.MAX_SAFE_INTEGER))

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
