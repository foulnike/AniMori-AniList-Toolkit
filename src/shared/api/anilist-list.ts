// Список пользователя с AniList: кто мы и что у нас в коллекции.
// Живёт отдельно от anilist.ts: там темп, паузы и разбор отказов, и файл уже велик.
// Наружу отдаётся плоский массив записей без деления на списки сайта.

import type { MediaType } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'

/** Кто вошёл. Коллекция запрашивается по номеру пользователя, а не по пропуску. */
export interface ViewerInfo {
  id: number
  name: string
}

/** Запись списка в сыром виде. Названий и картинок здесь нет: их даёт склад. */
export interface RawListEntry {
  mediaId: number
  status: string | null
  /** Шкала 0..10 с десятыми долями: запрошена явно, независимо от настроек сайта. */
  score: number
  progress: number
  updatedAt: number
  /** Взрослый тайтл по мнению AniList. Отбор — забота экранов, не этого слоя. */
  isAdult: boolean
}

const VIEWER_QUERY = `query {
  Viewer {
    id
    name
  }
}`

/**
 * Шкала оценки задана в запросе, а не взята из настроек пользователя.
 * Иначе одна и та же запись приходила бы то как 85, то как 8.5.
 *
 * Признак взрослого берётся здесь же: отдельный запрос за ним означал бы
 * второй обход всей коллекции пачками по пятьдесят тайтлов.
 */
const LIST_QUERY = `query ($userId: Int, $type: MediaType) {
  MediaListCollection(userId: $userId, type: $type) {
    lists {
      entries {
        mediaId
        status
        score(format: POINT_10_DECIMAL)
        progress
        updatedAt
        media {
          isAdult
        }
      }
    }
  }
}`

interface ViewerReply {
  Viewer?: { id?: number; name?: string } | null
}

interface ListReply {
  MediaListCollection?: {
    lists?: Array<{ entries?: unknown } | null> | null
  } | null
}

/** Число из ответа или подставка: отсутствующая оценка приходит нулём или null. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Признак взрослого из вложенного тайтла. Молчание сервера трактуется как «нет»:
 * скрыть лишнее хуже, чем показать, — пользователь не найдёт свою же запись.
 */
function readAdult(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return (value as Record<string, unknown>).isAdult === true
}

/**
 * Годна ли запись списка. Без номера тайтла запись бесполезна:
 * ни показать, ни слить с правкой её всё равно не получится.
 */
function toEntry(value: unknown): RawListEntry | null {
  if (typeof value !== 'object' || value === null) return null

  const raw = value as Record<string, unknown>
  const mediaId = raw.mediaId
  if (typeof mediaId !== 'number' || !Number.isFinite(mediaId)) return null

  return {
    mediaId,
    status: typeof raw.status === 'string' ? raw.status : null,
    score: num(raw.score, 0),
    progress: num(raw.progress, 0),
    updatedAt: num(raw.updatedAt, 0) * 1000,
    isAdult: readAdult(raw.media),
  }
}

/**
 * Кто сейчас вошёл. Отсутствие ответа ошибкой не считается: без входа
 * приложение работает, просто без своего списка.
 */
export async function fetchViewer(): Promise<ViewerInfo | null> {
  const reply = await anilistQuery<ViewerReply>(VIEWER_QUERY, {}, true)
  const viewer = reply.data?.Viewer

  if (!viewer || typeof viewer.id !== 'number') {
    Logger('WARN', 'AniList: вход не выполнен или пропуск не принят')
    return null
  }

  return { id: viewer.id, name: typeof viewer.name === 'string' ? viewer.name : '' }
}

/**
 * Вся коллекция одним запросом. Один тайтл может лежать в нескольких
 * своих подборках сразу, поэтому дубли схлопываются по номеру тайтла.
 */
export async function fetchUserList(userId: number, type: MediaType): Promise<RawListEntry[]> {
  const reply = await anilistQuery<ListReply>(LIST_QUERY, { userId, type }, true)
  const lists = reply.data?.MediaListCollection?.lists ?? []

  const byMedia = new Map<number, RawListEntry>()
  let skipped = 0

  for (const list of lists) {
    const entries = list?.entries
    if (!Array.isArray(entries)) continue

    for (const item of entries) {
      const entry = toEntry(item)
      if (!entry) {
        skipped++
        continue
      }

      // При дубле остаётся более свежая запись, а не последняя встреченная.
      const known = byMedia.get(entry.mediaId)
      if (!known || known.updatedAt <= entry.updatedAt) byMedia.set(entry.mediaId, entry)
    }
  }

  if (skipped > 0) Logger('WARN', `Список AniList: пропущено битых записей ${skipped}`)
  Logger('API', `Список AniList (${type}): записей ${byMedia.size}`)

  return Array.from(byMedia.values())
}
