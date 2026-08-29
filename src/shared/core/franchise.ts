// Дерево франшизы: хронология частей с Шикимори одним запросом,
// маппинг номеров MAL в AniList одной пачкой, склад бессрочный.
// Перенос виджета скрипта: там та же хронология рисовалась на чужой
// странице; здесь переходы внутренние, а статусы берутся из своей
// памяти списка — авторизованный запрос ради них не нужен.
//
// Дерево у Шикимори смешанное: в хронологии аниме лежит и первоисточник
// манги. Показывать его негде: переход вёл бы на пустую карточку, так что
// такие узлы отбрасываются прямо по адресу (/mangas/, /ranobe/).

import { anilistQuery } from '../api/anilist'
import { fetchShiki } from '../api/shikimori'
import { dbGet, dbSet } from './db'
import { Logger } from '../utils/logger'
import type { FranchiseCacheRecord } from './types'

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
  /**
   * Вид тайтла со стороны AniList. Остаток от времён манги: теперь здесь
   * всегда аниме, но поле оставлено строкой ради читателей склада
   * и старых записей, где манга ещё лежит.
   */
  type: string | null
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
  type: string | null
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

/** Адреса узлов, которых у нас больше нет: читать мангу приложение не умеет. */
const FOREIGN_PATHS = ['/mangas', '/ranobe']

/** Узел чужого вида: первоисточник в дереве аниме встречается часто. */
function isForeignNode(url: string): boolean {
  return FOREIGN_PATHS.some((path) => url.startsWith(path))
}

/** Читает дерево со склада. Записи старой формы — без постеров, без полной
 *  даты, с частями без сопоставления или с мангой внутри — считаются
 *  промахом. Проверяется каждая часть, а не первая: иначе старый склад
 *  с клипом или с мангой в середине выживал, а склад у нас бессрочный. */
async function readCache(mediaId: number): Promise<FranchiseWork[] | null> {
  const record = await dbGet<FranchiseCacheRecord>('franchiseCache', mediaId)
  const data = record?.data
  if (!Array.isArray(data) || data.length === 0) return null

  for (const work of data as Array<Partial<FranchiseWork> | undefined>) {
    if (!work || typeof work.name !== 'string') return null
    if (!('cover' in work) || !('date' in work)) return null
    if (work.mediaId === undefined || work.mediaId === null) return null
    if (work.type === 'MANGA') return null
  }

  return data as FranchiseWork[]
}

/** Кладёт дерево на склад. Отсутствие дерева на склад не пишется. */
async function writeCache(mediaId: number, works: FranchiseWork[]): Promise<void> {
  await dbSet('franchiseCache', { id: mediaId, data: works, ts: Date.now() })
}

/**
 * Добывает и собирает дерево: Шикимори по номеру MAL, затем маппинг.
 *
 * Запрос сопоставления теперь один: пространство номеров MAL у аниме
 * и манги раздельное, а манга больше не ищется вовсе.
 */
async function load(mediaId: number, malId: number): Promise<FranchiseWork[] | null> {
  const reply = await fetchShiki<{ nodes?: FranchiseNode[] }>(`/api/animes/${malId}/franchise`)

  const nodes = Array.isArray(reply.data?.nodes) ? reply.data.nodes : []
  if (nodes.length === 0) {
    memory.set(mediaId, null)
    return null
  }

  // Манга и ранобэ из дерева убираются сразу: их незачем искать в каталоге.
  const own = nodes.filter((node) => !isForeignNode(node.url ?? ''))

  const malIds = [
    ...new Set(own.flatMap((n) => (typeof n.id === 'number' && n.id > 0 ? [n.id] : []))),
  ]

  const mapped = new Map<number, FranchiseMapEntry>()
  if (malIds.length > 0) {
    const answer = await anilistQuery<{ Page?: { media?: FranchiseMapEntry[] } }>(
      FRANCHISE_MAP_QUERY,
      { ids: malIds, type: 'ANIME' },
    )

    for (const entry of answer?.data?.Page?.media ?? []) {
      if (typeof entry.idMal === 'number') mapped.set(entry.idMal, entry)
    }
  }

  const works: FranchiseWork[] = []
  for (const node of own) {
    if (typeof node.id !== 'number' || node.id <= 0) continue

    const found = mapped.get(node.id)
    // Части только на Шикимори выкидываются: это клипы и реклама,
    // которых в каталоге AniList нет нарочно.
    if (found === undefined) continue

    works.push({
      mediaId: found.id,
      malId: node.id,
      type: found.type,
      name: node.name,
      year: typeof node.year === 'number' ? node.year : null,
      date: typeof node.date === 'number' && node.date > 0 ? node.date : null,
      kind: node.kind ?? null,
      cover: found.coverImage?.medium ?? null,
      isAdult: found.isAdult === true,
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

    return await load(mediaId, malId)
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
