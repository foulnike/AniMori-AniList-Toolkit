// Перенос списков и избранного Shikimori → AniList: сеть и сравнение записей, без DOM.
// Прогресс уходит наружу через onProgress, адрес и транспорт выбирает api/shikimori-user.ts.
// В оболочке запрос анонимен: закрытый профиль не выгрузится, отказ доступа — отдельная ветка.

import { anilistQuery } from '../../api/anilist'
import { hiddenProfileMessage, shikiUserGet } from '../../api/shikimori-user'
import { Logger } from '../../utils/logger'

export type ShikiStatus =
  | 'planned'
  | 'watching'
  | 'reading'
  | 'completed'
  | 'on_hold'
  | 'dropped'
  | 'rewatching'
  | 'rereading'
export type AniListStatus =
  'PLANNING' | 'CURRENT' | 'COMPLETED' | 'PAUSED' | 'DROPPED' | 'REPEATING'
export type ScoreFormat = 'POINT_100' | 'POINT_10_DECIMAL' | 'POINT_10' | 'POINT_5' | 'POINT_3'
export type MediaType = 'anime' | 'manga'
export type AniListMediaType = 'ANIME' | 'MANGA'

/** Куда уходит текст прогресса: подпись кнопки, модалка или лог — решает вызывающий. */
export type ProgressFn = (text: string) => void

export interface FuzzyDate {
  year?: number
  month?: number
  day?: number
}

export interface ShikiUserRate {
  id: number
  target_id: number
  status: ShikiStatus
  score: number
  episodes?: number
  chapters?: number
  volumes?: number
  rewatches: number
  text: string
  created_at?: string
  updated_at?: string
  target?: { id: number }
}

export interface ShikiFavItem {
  id: number
  name: string
  russian?: string
}

export interface ShikiFavorites {
  animes?: ShikiFavItem[]
  mangas?: ShikiFavItem[]
  characters?: ShikiFavItem[]
  people?: ShikiFavItem[]
  seyu?: ShikiFavItem[]
  mangakas?: ShikiFavItem[]
  producers?: ShikiFavItem[]
}

export interface AniListUser {
  id: number
  name: string
  mediaListOptions: {
    scoreFormat: ScoreFormat
  }
}

export interface AniListEntry {
  mediaId: number
  status: AniListStatus
  score: number
  progress: number
  progressVolumes?: number
  repeat: number
  notes?: string
  startedAt?: FuzzyDate
  completedAt?: FuzzyDate
}

export interface ExistingFavorites {
  anime: Set<number>
  manga: Set<number>
  characters: Set<number>
  staff: Set<number>
}

export interface HistoryDates {
  start: Date | null
  end: Date | null
}

/** Счётчик неудачных мутаций за один прогон, общий на модуль. */
let syncFailures = 0

export function resetSyncFailures(): void {
  syncFailures = 0
}

export function getSyncFailures(): number {
  return syncFailures
}

export const mapStatusShikiToAL: Record<ShikiStatus, AniListStatus> = {
  planned: 'PLANNING',
  watching: 'CURRENT',
  reading: 'CURRENT',
  completed: 'COMPLETED',
  on_hold: 'PAUSED',
  dropped: 'DROPPED',
  rewatching: 'REPEATING',
  rereading: 'REPEATING',
}

export function convertScoreShikiToAL(score: number, format: ScoreFormat): number {
  if (!score) return 0
  switch (format) {
    case 'POINT_100':
    case 'POINT_10_DECIMAL':
      return score * 10
    case 'POINT_10':
      return score
    case 'POINT_5':
      return Math.round(score / 2)
    case 'POINT_3':
      return score >= 8 ? 3 : score >= 5 ? 2 : 1
    default:
      return score
  }
}

export function fuzzyEquals(fd1?: FuzzyDate, fd2?: FuzzyDate): boolean {
  const empty1 = !fd1 || (!fd1.year && !fd1.month && !fd1.day)
  const empty2 = !fd2 || (!fd2.year && !fd2.month && !fd2.day)
  if (empty1 && empty2) return true
  if (empty1 || empty2) return false
  return fd1.year === fd2.year && fd1.month === fd2.month && fd1.day === fd2.day
}

export function makeFuzzyDate(d?: string | Date): FuzzyDate | undefined {
  if (!d) return undefined
  const date = new Date(d)
  if (isNaN(date.getTime())) return undefined
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchShikiUserId(username: string): Promise<number> {
  const res = await shikiUserGet<{ id: number }>(`/api/users/${encodeURIComponent(username)}`)
  if (res.status === 401 || res.status === 403) throw new Error(hiddenProfileMessage())
  if (!res.ok || !res.data) throw new Error('Пользователь Shikimori не найден.')
  return res.data.id
}

/**
 * Постраничная выгрузка списка пользователя.
 * 429 повторяется до трёх раз: иначе просьба подождать выглядит как конец списка.
 */
export async function fetchShikimoriListV2(
  userId: number,
  type: MediaType,
): Promise<ShikiUserRate[]> {
  let page = 1
  const all: ShikiUserRate[] = []
  const seen = new Set<number>()
  const targetType = type === 'anime' ? 'Anime' : 'Manga'
  Logger('INFO', `Скачивание списка ${type} с Shikimori v2...`)

  let rateLimitRetries = 0

  while (true) {
    const path = `/api/v2/user_rates?user_id=${userId}&target_type=${targetType}&limit=1000&page=${page}`
    const res = await shikiUserGet<ShikiUserRate[]>(path)

    if (!res.ok) {
      if (res.status === 404) break
      if (res.status === 401 || res.status === 403) throw new Error(hiddenProfileMessage())
      if (res.status === 429) {
        if (rateLimitRetries >= 3) {
          Logger('ERROR', `Список ${type}: Shikimori держит лимит, страница ${page} не получена`)
          break
        }
        rateLimitRetries++
        await sleep(2000)
        continue
      }
      break
    }

    rateLimitRetries = 0
    const data = res.data
    if (!data || data.length === 0) break

    let added = 0
    for (const item of data) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        all.push(item)
        added++
      }
    }
    if (added === 0) break
    page++
    await sleep(500)
  }
  return all
}

export async function fetchShikiHistoryDates(
  userId: number,
  onProgress?: ProgressFn,
): Promise<Record<string, HistoryDates>> {
  let page = 1
  const datesMap: Record<string, { starts: number[]; ends: number[] }> = {}
  while (true) {
    onProgress?.(`Анализ таймингов (стр. ${page})...`)
    try {
      const res = await shikiUserGet<
        Array<{
          target?: { id: number }
          target_type?: string
          created_at: string
          description?: string
        }>
      >(`/api/users/${userId}/history?limit=100&page=${page}`)

      if (!res.ok) {
        if (res.status === 429) {
          await sleep(2000)
          continue
        }
        break
      }
      const data = res.data
      if (!data || data.length === 0) break

      data.forEach((item) => {
        if (!item.target) return
        const targetType = item.target_type?.toLowerCase()
        if (targetType !== 'anime' && targetType !== 'manga') return
        const id = `${targetType}:${item.target.id}`
        const dateObj = new Date(item.created_at)
        const desc = (item.description || '').toLowerCase()

        if (!datesMap[id]) datesMap[id] = { starts: [], ends: [] }
        if (
          desc === 'просмотрено' ||
          desc === 'прочитано' ||
          desc === 'пересмотрено' ||
          desc === 'перечитано'
        ) {
          datesMap[id].ends.push(dateObj.getTime())
        } else if (
          desc.includes('смотрю') ||
          desc.includes('читаю') ||
          desc.includes('просмотрен') ||
          desc.includes('прочитан') ||
          desc.includes('эпизод') ||
          desc.includes('глав') ||
          desc.includes('пересматр') ||
          desc.includes('перечитыв')
        ) {
          datesMap[id].starts.push(dateObj.getTime())
        }
      })

      if (data.length < 100) break
      page++
      await sleep(350)
    } catch (e) {
      Logger('ERROR', `fetchShikiHistoryDates: сбой на странице ${page}, обработка прервана`, e)
      break
    }
  }

  const finalMap: Record<string, HistoryDates> = {}
  for (const id in datesMap) {
    const entry = datesMap[id]
    if (!entry) continue
    const starts = entry.starts
    const ends = entry.ends
    const start = starts.length > 0 ? new Date(Math.min(...starts)) : null
    const end = ends.length > 0 ? new Date(Math.max(...ends)) : null
    finalMap[id] = { start, end }
  }
  return finalMap
}

export async function fetchShikimoriFavorites(
  usernameOrId: string | number,
): Promise<ShikiFavorites | null> {
  const endpoints = [
    `/api/users/${usernameOrId}/favorites`,
    `/api/users/${usernameOrId}/favourites`,
  ]
  for (const ep of endpoints) {
    try {
      const res = await shikiUserGet<ShikiFavorites>(ep)
      if (res.ok && res.data) return res.data
    } catch (e) {
      Logger('WARN', `fetchShikimoriFavorites: сбой запроса ${ep}`, e)
    }
  }
  return null
}

export async function getAnilistIds(
  malIds: number[],
  type: AniListMediaType,
): Promise<Record<number, number>> {
  if (!malIds || malIds.length === 0) return {}
  const map: Record<number, number> = {}
  for (let i = 0; i < malIds.length; i += 50) {
    const chunk = malIds.slice(i, i + 50)
    const query =
      'query($m:[Int],$t:MediaType){Page(page:1,perPage:50){media(idMal_in:$m,type:$t){id idMal}}}'
    const res = await anilistQuery<{
      Page?: { media?: Array<{ id: number; idMal: number }> }
    }>(query, { m: chunk, t: type })
    if (res?.data?.Page?.media) {
      res.data.Page.media.forEach((m) => (map[m.idMal] = m.id))
    }
    await sleep(700)
  }
  return map
}

/**
 * Читает текущий список на AniList — основа для пропуска совпадающих записей.
 * Запрос идёт с токеном: анонимный MediaListCollection пуст при закрытых списках.
 */
export async function getExistingAnilistList(
  alUserId: number,
  type: AniListMediaType,
  onProgress?: ProgressFn,
): Promise<Record<number, AniListEntry>> {
  const map: Record<number, AniListEntry> = {}
  onProgress?.(`Загрузка AL списка (${type})...`)
  const query =
    'query($u:Int!,$t:MediaType){MediaListCollection(userId:$u,type:$t){lists{entries{mediaId status score progress progressVolumes repeat notes startedAt { year month day } completedAt { year month day }}}}}'
  const res = await anilistQuery<{
    MediaListCollection?: {
      lists?: Array<{
        entries: Array<{
          mediaId: number
          status: AniListStatus
          score: number
          progress: number
          progressVolumes?: number
          repeat: number
          notes?: string
          startedAt?: FuzzyDate
          completedAt?: FuzzyDate
        }>
      }>
    }
  }>(query, { u: alUserId, t: type }, true)
  const lists = res?.data?.MediaListCollection?.lists || []
  lists.forEach((list) =>
    list.entries.forEach((m) => {
      map[m.mediaId] = m as AniListEntry
    }),
  )
  const known = Object.keys(map).length
  Logger(
    known > 0 ? 'INFO' : 'WARN',
    `Текущий список AniList (${type}): получено ${known} записей` +
      (known > 0 ? '' : ' — сравнивать не с чем, будет перенесён весь список'),
  )
  await sleep(600)
  return map
}

export async function getExistingAnilistFavorites(
  alUserId: number,
  onProgress?: ProgressFn,
): Promise<ExistingFavorites> {
  const existing: ExistingFavorites = {
    anime: new Set(),
    manga: new Set(),
    characters: new Set(),
    staff: new Set(),
  }
  const fetchFav = async (type: string, targetSet: Set<number>) => {
    let page = 1
    let hasNextPage = true
    onProgress?.(`Загрузка Fav AL (${type})...`)
    while (hasNextPage) {
      const query = `query($u:Int!,$p:Int!){User(id:$u){favourites{${type}(page:$p){pageInfo{hasNextPage}nodes{id}}}}}`
      const res = await anilistQuery<{
        User?: {
          favourites?: {
            [key: string]: {
              pageInfo: { hasNextPage: boolean }
              nodes: Array<{ id: number }>
            }
          }
        }
      }>(query, { u: alUserId, p: page }, true)
      const data = res?.data?.User?.favourites?.[type]
      if (!data) break
      data.nodes.forEach((n) => targetSet.add(n.id))
      hasNextPage = data.pageInfo.hasNextPage
      page++
      await sleep(600)
    }
    Logger('INFO', `Текущее избранное AniList (${type}): ${targetSet.size} шт.`)
  }
  await fetchFav('anime', existing.anime)
  await fetchFav('manga', existing.manga)
  await fetchFav('characters', existing.characters)
  await fetchFav('staff', existing.staff)
  return existing
}

export async function getAnilistIdByName(
  name: string,
  type: 'CHARACTER' | 'STAFF',
): Promise<number | null> {
  const field = type === 'CHARACTER' ? 'characters' : 'staff'
  const query = `query($s:String){Page(page:1,perPage:1){${field}(search:$s){id}}}`
  try {
    const res = await anilistQuery<{
      Page?: { [key: string]: Array<{ id: number }> }
    }>(query, { s: name })
    const arr = res?.data?.Page?.[field]
    const firstItem = arr?.[0]
    if (firstItem) return firstItem.id
  } catch (e) {
    Logger('WARN', `getAnilistIdByName: сбой поиска "${name}" (${type})`, e)
  }
  return null
}

export async function syncShikiToAlList(
  shikiItems: ShikiUserRate[],
  type: MediaType,
  alUser: AniListUser,
  historyDates: Record<string, HistoryDates> | null,
  onProgress?: ProgressFn,
): Promise<void> {
  if (!shikiItems || shikiItems.length === 0) return
  const alType: AniListMediaType = type === 'anime' ? 'ANIME' : 'MANGA'
  const valids = shikiItems.filter((i) => i && i.target_id)
  if (valids.length === 0) return

  onProgress?.(`Сверка ID (${type})...`)
  const idMap = await getAnilistIds(
    valids.map((i) => i.target_id),
    alType,
  )
  const exList = await getExistingAnilistList(alUser.id, alType, onProgress)

  // Статистика прогона: отличает «пропуск работает» от «сравнивать не с чем».
  let skipped = 0
  let updated = 0
  let noId = 0

  let count = 0
  for (const item of valids) {
    count++
    onProgress?.(`Shiki ➜ AL (${type}): ${count}/${valids.length}`)

    const alId = idMap[item.target_id]
    if (!alId) {
      noId++
      if (count % 50 === 0) await sleep(10)
      continue
    }

    const status = mapStatusShikiToAL[item.status] || 'PLANNING'
    const scoreRaw = convertScoreShikiToAL(item.score, alUser.mediaListOptions.scoreFormat)
    const progress = (type === 'anime' ? item.episodes : item.chapters) || 0
    const progressVolumes = (type === 'manga' ? item.volumes : 0) || 0
    const repeat = item.rewatches || 0

    let notes = item.text && item.text.trim().length > 0 ? item.text.trim() : undefined
    if (notes) {
      notes = notes
        .replace(/\[b\](.*?)\[\/b\]/gi, '**$1**')
        .replace(/\[i\](.*?)\[\/i\]/gi, '*$1*')
        .replace(/\[s\](.*?)\[\/s\]/gi, '~~$1~~')
        .replace(/\[spoiler(?:=[^\]]+)?\]([\s\S]*?)\[\/spoiler\]/gi, '~!$1!~')
        .replace(/\[url=(.+?)\](.*?)\[\/url\]/gi, '[$2]($1)')
    }

    let startedAt: FuzzyDate | undefined
    let completedAt: FuzzyDate | undefined
    const historyKey = `${type}:${item.target_id}`
    if (historyDates && historyDates[historyKey]) {
      const dates = historyDates[historyKey]
      if (dates?.start) startedAt = makeFuzzyDate(dates.start || undefined)
      if (dates?.end) completedAt = makeFuzzyDate(dates.end || undefined)
    }
    if (!startedAt && item.status !== 'planned' && item.created_at)
      startedAt = makeFuzzyDate(item.created_at)
    if (!completedAt && item.status === 'completed' && item.updated_at)
      completedAt = makeFuzzyDate(item.updated_at)

    const ex = exList[alId]
    if (ex) {
      let alRawScore = Math.round(ex.score || 0)
      if (alUser.mediaListOptions.scoreFormat === 'POINT_10_DECIMAL')
        alRawScore = Math.round((ex.score || 0) * 10)
      let isSame =
        ex.status === status &&
        alRawScore === scoreRaw &&
        (ex.progress || 0) === progress &&
        (ex.repeat || 0) === repeat &&
        fuzzyEquals(ex.startedAt, startedAt) &&
        fuzzyEquals(ex.completedAt, completedAt)
      if (type === 'manga') isSame = isSame && (ex.progressVolumes || 0) === progressVolumes
      if (notes !== undefined) isSame = isSame && (ex.notes ? ex.notes.trim() : undefined) === notes

      if (isSame) {
        skipped++
        if (count % 50 === 0) await sleep(10)
        continue
      }
    }

    const variables: Record<string, unknown> = { mediaId: alId, status, scoreRaw, progress, repeat }
    if (type === 'manga') variables.progressVolumes = progressVolumes
    if (notes !== undefined) variables.notes = notes
    if (startedAt) variables.startedAt = startedAt
    if (completedAt) variables.completedAt = completedAt

    const mutationVars: string[] = []
    const mutationArgs: string[] = []
    for (const key of Object.keys(variables)) {
      const typeStr =
        key === 'status'
          ? 'MediaListStatus'
          : key === 'notes'
            ? 'String'
            : key === 'startedAt' || key === 'completedAt'
              ? 'FuzzyDateInput'
              : 'Int'
      mutationVars.push(`$${key}:${typeStr}`)
      mutationArgs.push(`${key}:$${key}`)
    }
    const mutation = `mutation(${mutationVars.join(',')}){SaveMediaListEntry(${mutationArgs.join(',')}){id}}`

    try {
      await anilistQuery(mutation, variables, true)
      updated++
    } catch (e) {
      syncFailures++
      Logger('ERROR', `syncShikiToAlList: сбой SaveMediaListEntry (mediaId=${alId}, ${type})`, e)
    }
    await sleep(700)
  }

  Logger(
    'INFO',
    `Перенос ${type} завершён: всего ${valids.length}, отправлено ${updated}, ` +
      `пропущено без изменений ${skipped}, не найдено на AniList ${noId}`,
  )
}

export async function syncShikiToAlFavorites(
  shikiFavs: ShikiFavorites | null,
  exAlFavs: ExistingFavorites,
  onProgress?: ProgressFn,
): Promise<void> {
  if (!shikiFavs) return
  const processFavorites = async (
    arr: ShikiFavItem[] | undefined,
    alType: 'ANIME' | 'MANGA' | 'CHARACTER' | 'STAFF',
    exSet: Set<number>,
    varName: string,
  ) => {
    if (!arr || arr.length === 0) return
    let processedCount = 0
    const field =
      alType === 'ANIME'
        ? 'anime'
        : alType === 'MANGA'
          ? 'manga'
          : alType === 'CHARACTER'
            ? 'characters'
            : 'staff'
    const mutation = `mutation($id:Int!){ToggleFavourite(${varName}:$id){${field}{pageInfo{total}}}}`

    if (['ANIME', 'MANGA'].includes(alType)) {
      onProgress?.(`Сверка ID (Fav ${alType})...`)
      const idMap = await getAnilistIds(
        arr.map((x) => x.id),
        alType as AniListMediaType,
      )
      for (const item of arr) {
        processedCount++
        onProgress?.(`Shiki ➜ AL (Fav ${alType}): ${processedCount}/${arr.length}`)
        const alId = idMap[item.id]
        if (!alId || exSet.has(alId)) {
          if (processedCount % 50 === 0) await sleep(10)
          continue
        }
        try {
          await anilistQuery(mutation, { id: alId }, true)
        } catch (e) {
          syncFailures++
          Logger('ERROR', `syncShikiToAlFavorites: сбой ToggleFavourite (id=${alId}, ${alType})`, e)
        }
        await sleep(700)
      }
    } else {
      for (const item of arr) {
        processedCount++
        onProgress?.(`Shiki ➜ AL (Fav ${alType}): ${processedCount}/${arr.length}`)
        if (alType !== 'CHARACTER' && alType !== 'STAFF') continue
        const alId = await getAnilistIdByName(item.name, alType)
        if (!alId || exSet.has(alId)) {
          await sleep(600)
          continue
        }
        try {
          await anilistQuery(mutation, { id: alId }, true)
        } catch (e) {
          syncFailures++
          Logger(
            'ERROR',
            `syncShikiToAlFavorites: сбой ToggleFavourite по имени (id=${alId}, ${alType})`,
            e,
          )
        }
        await sleep(700)
      }
    }
  }
  const shikiStaff = [
    ...(shikiFavs.people || []),
    ...(shikiFavs.seyu || []),
    ...(shikiFavs.mangakas || []),
  ]
  const uniqStaff = Array.from(new Map(shikiStaff.map((i) => [i.id, i])).values())
  await processFavorites(shikiFavs.animes, 'ANIME', exAlFavs.anime, 'animeId')
  await processFavorites(shikiFavs.mangas, 'MANGA', exAlFavs.manga, 'mangaId')
  await processFavorites(shikiFavs.characters, 'CHARACTER', exAlFavs.characters, 'characterId')
  await processFavorites(uniqStaff, 'STAFF', exAlFavs.staff, 'staffId')
}
