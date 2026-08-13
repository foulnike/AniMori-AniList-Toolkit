// Логика сканера дельты Shikimori ↔ AniList: загрузка списков и избранного,
// нормализация, сверка, статистика, игнор-лист и оркестратор скана.
//
// Отдельный файл, а не часть index.ts, из-за цикла импортов: index.ts монтирует
// ScannerModal.vue, компонент читает scanner-state.ts, а состоянию нужны эти функции.
//
// Мягкая отмена: флаг проверяется на границах шагов и между чанками глубокой
// проверки; сами сетевые запросы не прерываются, процесс встаёт на ближайшей границе.

import { Bridge } from '@/bridge'
import { anilistQuery } from '../../api/anilist'
import { fetchShiki } from '../../api/shikimori'
import type { CmpAniListEntry, CmpShikiEntry, ShikiStatus } from '../../core/types'
import { Logger } from '../../utils/logger'

export const CMP_STATUS_ORDER = [
  'watching',
  'rewatching',
  'planned',
  'completed',
  'on_hold',
  'dropped',
] as const

export const CMP_STATUS_LABEL: Record<string, string> = {
  watching: 'Смотрю/Читаю',
  rewatching: 'Пересматриваю',
  planned: 'Запланировано',
  completed: 'Просмотрено',
  on_hold: 'Отложено',
  dropped: 'Брошено',
  null: '—',
}

const AL_STATUS_MAP: Record<string, ShikiStatus> = {
  CURRENT: 'watching',
  REPEATING: 'rewatching',
  PLANNING: 'planned',
  COMPLETED: 'completed',
  PAUSED: 'on_hold',
  DROPPED: 'dropped',
}

const CMP_SPLIT_RELATIONS = ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'ALTERNATIVE', 'SPIN_OFF']

/** Пауза между страницами и чанками: троттлинг публичных API. */
const RATE_PAUSE_MS = 700

/** Ключи хранилища. Не входят в AniMoriSettings, поэтому читаются и пишутся отдельно. */
const IGNORE_KEY = 'CMP_IGNORE'
const LOGIN_KEY = 'SHIKI_LOGIN'

// ==== Отмена ====

/** Токен мягкой отмены. Объект, а не ref: этот модуль не должен зависеть от Vue. */
export interface CancelToken {
  cancelled: boolean
}

export class ScanCancelled extends Error {
  constructor() {
    super('Сканирование отменено')
    this.name = 'ScanCancelled'
  }
}

export function createCancelToken(): CancelToken {
  return { cancelled: false }
}

function throwIfCancelled(token: CancelToken): void {
  if (token.cancelled) throw new ScanCancelled()
}

/** Пауза с проверкой отмены после неё: точка выхода между страницами пагинации. */
async function pause(token: CancelToken, ms: number = RATE_PAUSE_MS): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
  throwIfCancelled(token)
}

// ==== Игнор-лист и запомненный логин ====
//
// Знак в хранилище значащий: аниме лежит как +malId, манга как -malId.
// Менять нельзя — у пользователей уже накоплены игноры в этом виде.
//
// Хранилище асинхронное, а cmpGetIgnore() и getSavedShikiLogin() вызываются из
// открытия модалки и обязаны отдать значение немедленно. Поэтому оба значения
// держатся в памяти, а loadScannerStorage() наполняет кэш один раз перед первым
// показом окна. Запись идёт «сначала в память, потом в хранилище»: крестик в
// игнор-листе убирает строку сразу, не дожидаясь диска.

let ignoreCache = new Set<number>()
let shikiLoginCache = ''
let storageLoaded = false

function parseIgnore(raw: unknown): Set<number> {
  if (typeof raw !== 'string' || !raw) return new Set()
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) return new Set()
  return new Set(parsed.filter((x): x is number => typeof x === 'number'))
}

/**
 * Читает игнор-лист и последний логин Shikimori в память.
 *
 * Вызывается при открытии сканера, а не на старте страницы: окно сравнения открывают
 * редко, и незачем ради него задерживать загрузку сайта. Повторные вызовы бесплатны.
 * При сбое чтения работаем с пустым игнором — это значит «показать все расхождения»,
 * то есть в худшем случае пользователь увидит лишние строки, а не потеряет данные.
 */
export async function loadScannerStorage(): Promise<void> {
  if (storageLoaded) return
  storageLoaded = true
  try {
    const [rawIgnore, rawLogin] = await Promise.all([
      Bridge.storage.get<unknown>(IGNORE_KEY, '[]'),
      Bridge.storage.get<unknown>(LOGIN_KEY, ''),
    ])
    ignoreCache = parseIgnore(rawIgnore)
    shikiLoginCache = typeof rawLogin === 'string' ? rawLogin : ''
  } catch (e) {
    Logger('WARN', 'Сканер сравнения: повреждён игнор-лист CMP_IGNORE, сброшен в пустой', e)
    ignoreCache = new Set()
    shikiLoginCache = ''
  }
}

export function cmpGetIgnore(): Set<number> {
  return new Set(ignoreCache)
}

export function cmpSaveIgnore(set: Set<number>): void {
  ignoreCache = new Set(set)
  void Bridge.storage.set(IGNORE_KEY, JSON.stringify([...set])).catch((e: unknown) => {
    Logger('ERROR', 'Сканер сравнения: не удалось сохранить игнор-лист', e)
  })
}

export function getSavedShikiLogin(): string {
  return shikiLoginCache
}

export function saveShikiLogin(login: string): void {
  shikiLoginCache = login
  void Bridge.storage.set(LOGIN_KEY, login).catch((e: unknown) => {
    Logger('ERROR', 'Сканер сравнения: не удалось сохранить логин Shikimori', e)
  })
}

// ==== Форматтеры ====

export function cmpStatusLabel(s: string | null): string {
  return CMP_STATUS_LABEL[s ?? 'null'] || '—'
}

export function cmpFmtScore(v: number): string {
  return v > 0 ? (Math.round(v * 10) / 10).toString() : '—'
}

export function cmpFmtProg(
  e: { progress: number; volumes: number },
  type: 'anime' | 'manga',
): string {
  return type === 'manga' ? `${e.progress} гл. / ${e.volumes} т.` : `${e.progress} эп.`
}

// ==== Снапшот скана ====

export interface ShikiFavourites {
  anime: Map<number, string>
  manga: Map<number, string>
  characters: Array<{ name: string; romaji: string }>
  people: Array<{ name: string; romaji: string }>
}

export interface CmpCatalog {
  alHas: Set<number>
  shikiHas: Set<number>
}

export interface CmpScanSnapshot {
  shA: Map<number, CmpShikiEntry>
  alA: Map<number, CmpAniListEntry>
  shM: Map<number, CmpShikiEntry>
  alM: Map<number, CmpAniListEntry>
  shFav: ShikiFavourites
  alFavA: Map<number, string>
  alFavM: Map<number, string>
  alFavChar: Array<{ name: string; native: string }>
  alFavStaff: Array<{ name: string; native: string }>
  catalog: CmpCatalog | null
}

// ==== Загрузка данных ====

async function cmpFetchAniListList(
  userName: string,
  type: 'ANIME' | 'MANGA',
): Promise<Map<number, CmpAniListEntry>> {
  const q =
    'query($n:String,$t:MediaType){MediaListCollection(userName:$n,type:$t){lists{entries{status score(format:POINT_100) progress progressVolumes repeat notes media{idMal title{romaji english} relations{edges{relationType node{idMal}}}}}}}}'
  const res = await anilistQuery<{
    MediaListCollection?: {
      lists?: Array<{
        entries?: Array<{
          status?: string
          score?: number
          progress?: number
          progressVolumes?: number
          repeat?: number
          notes?: string
          media?: {
            idMal?: number
            title?: { romaji?: string; english?: string }
            relations?: { edges?: Array<{ relationType?: string; node?: { idMal?: number } }> }
          }
        }>
      }>
    }
  }>(q, { n: userName, t: type }, true)
  const lists = res?.data?.MediaListCollection?.lists ?? []
  const map = new Map<number, CmpAniListEntry>()
  for (const l of lists) {
    for (const e of l.entries ?? []) {
      const mal = e.media?.idMal
      if (!mal || !e.media) continue
      const mappedStatus = e.status ? AL_STATUS_MAP[e.status] : null
      map.set(mal, {
        malId: mal,
        title: e.media.title?.romaji || e.media.title?.english || 'MAL#' + mal,
        status: mappedStatus ?? null,
        score10: e.score ? e.score / 10 : 0,
        progress: e.progress || 0,
        volumes: e.progressVolumes || 0,
        rewatches: e.repeat || 0,
        notes: (e.notes || '').trim(),
        relations: (e.media.relations?.edges ?? [])
          .filter((ed) => CMP_SPLIT_RELATIONS.includes(ed.relationType ?? ''))
          .map((ed) => ed.node?.idMal)
          .filter((id): id is number => Boolean(id)),
      })
    }
  }
  return map
}

async function cmpFetchAniListFavs(
  userName: string,
  kind: 'anime' | 'manga',
  token: CancelToken,
): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  let page = 1
  while (true) {
    throwIfCancelled(token)
    const q = `query($n:String,$p:Int){User(name:$n){favourites{${kind}(page:$p){pageInfo{hasNextPage} nodes{idMal title{romaji english}}}}}}`
    const res = await anilistQuery<{
      User?: {
        favourites?: {
          [K in typeof kind]?: {
            pageInfo?: { hasNextPage?: boolean }
            nodes?: Array<{ idMal?: number; title?: { romaji?: string; english?: string } }>
          }
        }
      }
    }>(q, { n: userName, p: page }, true)
    const fav = res?.data?.User?.favourites?.[kind]
    if (!fav) break
    for (const n of fav.nodes ?? []) {
      if (n.idMal) map.set(n.idMal, n.title?.romaji || n.title?.english || 'MAL#' + n.idMal)
    }
    if (!fav.pageInfo?.hasNextPage) break
    page++
    await pause(token)
  }
  return map
}

type ShikiRateItem<T extends 'anime' | 'manga'> = {
  status?: string
  score?: number
  episodes?: number
  chapters?: number
  volumes?: number
  rewatches?: number
  text?: string
} & {
  [K in T]: { id?: number; russian?: string; name?: string }
}

async function cmpFetchShikiList(
  userId: number | string,
  type: 'anime' | 'manga',
  token: CancelToken,
): Promise<Map<number, CmpShikiEntry>> {
  const map = new Map<number, CmpShikiEntry>()
  let page = 1
  while (true) {
    throwIfCancelled(token)
    const r = await fetchShiki<Array<ShikiRateItem<typeof type>>>(
      `/api/users/${userId}/${type}_rates?limit=5000&page=${page}`,
    )
    const data = r.data
    if (!Array.isArray(data) || data.length === 0) break
    for (const it of data) {
      const media = it[type]
      if (!media?.id) continue
      const mal = media.id
      const mappedStatus = it.status as ShikiStatus | null
      map.set(mal, {
        malId: mal,
        title: media.russian || media.name || 'MAL#' + mal,
        status: mappedStatus || null,
        score10: it.score || 0,
        progress: type === 'anime' ? it.episodes || 0 : it.chapters || 0,
        volumes: type === 'manga' ? it.volumes || 0 : 0,
        rewatches: it.rewatches || 0,
        notes: (it.text || '').trim(),
      })
    }
    if (data.length < 5000) break
    page++
    await pause(token)
  }
  return map
}

async function cmpFetchShikiFavs(userId: number | string): Promise<ShikiFavourites> {
  const r = await fetchShiki<{
    animes?: Array<{ id?: number; russian?: string; name?: string }>
    mangas?: Array<{ id?: number; russian?: string; name?: string }>
    characters?: Array<{ russian?: string; name?: string }>
    people?: Array<{ russian?: string; name?: string }>
    seyu?: Array<{ russian?: string; name?: string }>
    mangakas?: Array<{ russian?: string; name?: string }>
    producers?: Array<{ russian?: string; name?: string }>
  }>(`/api/users/${userId}/favourites`)
  const d = r.data ?? {}
  const toMap = (
    arr: Array<{ id?: number; russian?: string; name?: string }> | undefined,
  ): Map<number, string> => {
    const m = new Map<number, string>()
    ;(arr ?? []).forEach((x) => {
      if (x.id) m.set(x.id, x.russian || x.name || 'MAL#' + x.id)
    })
    return m
  }
  const toNames = (
    arr: Array<{ russian?: string; name?: string }> | undefined,
  ): Array<{ name: string; romaji: string }> =>
    (arr ?? [])
      .map((x) => ({ name: x.russian || x.name || '', romaji: x.name || '' }))
      .filter((x) => x.name || x.romaji)
  const staffAll = [
    ...(d.people ?? []),
    ...(d.seyu ?? []),
    ...(d.mangakas ?? []),
    ...(d.producers ?? []),
  ]
  return {
    anime: toMap(d.animes),
    manga: toMap(d.mangas),
    characters: toNames(d.characters),
    people: toNames(staffAll),
  }
}

async function cmpFetchAniListFavPeople(
  userName: string,
  kind: 'characters' | 'staff',
  token: CancelToken,
): Promise<Array<{ name: string; native: string }>> {
  const arr: Array<{ name: string; native: string }> = []
  let page = 1
  while (true) {
    throwIfCancelled(token)
    const q = `query($n:String,$p:Int){User(name:$n){favourites{${kind}(page:$p){pageInfo{hasNextPage} nodes{name{full native}}}}}}`
    const res = await anilistQuery<{
      User?: {
        favourites?: {
          [K in typeof kind]?: {
            pageInfo?: { hasNextPage?: boolean }
            nodes?: Array<{ name?: { full?: string; native?: string } }>
          }
        }
      }
    }>(q, { n: userName, p: page }, true)
    const fav = res?.data?.User?.favourites?.[kind]
    if (!fav) break
    for (const n of fav.nodes ?? [])
      arr.push({ name: n.name?.full || '', native: n.name?.native || '' })
    if (!fav.pageInfo?.hasNextPage) break
    page++
    await pause(token)
  }
  return arr
}

async function cmpResolveShikiUser(login: string): Promise<number> {
  const isNum = /^\d+$/.test(login)
  const path = isNum
    ? `/api/users/${login}`
    : `/api/users/${encodeURIComponent(login)}?is_nickname=1`
  const r = await fetchShiki<{ id?: number }>(path)
  if (r.data?.id) return r.data.id
  throw new Error('Пользователь Shikimori не найден: ' + login)
}

/** Имя текущего пользователя AniList по токену. Используется и для подсказки в поле. */
export async function fetchViewerName(): Promise<string> {
  const v = await anilistQuery<{ Viewer?: { name?: string } }>('query{Viewer{name}}', {}, true)
  return v?.data?.Viewer?.name ?? ''
}

// ==== Сверка ====

async function cmpDeepCheck(
  onlyShiki: { anime: number[]; manga: number[] },
  onlyAl: { anime: number[]; manga: number[] },
  token: CancelToken,
  setStatus?: (text: string) => void,
): Promise<CmpCatalog> {
  const alHas = new Set<number>()
  const shikiHas = new Set<number>()
  if (setStatus) setStatus('Глубокая проверка: каталог AniList...')
  for (const [type, ids] of [
    ['ANIME', onlyShiki.anime],
    ['MANGA', onlyShiki.manga],
  ] as const) {
    for (let i = 0; i < ids.length; i += 50) {
      throwIfCancelled(token)
      const chunk = ids.slice(i, i + 50)
      const res = await anilistQuery<{ Page?: { media?: Array<{ idMal?: number }> } }>(
        'query($m:[Int],$t:MediaType){Page(page:1,perPage:50){media(idMal_in:$m,type:$t){idMal}}}',
        { m: chunk, t: type },
      )
      const media = res?.data?.Page?.media ?? []
      media.forEach((m) => {
        if (m.idMal) alHas.add(m.idMal)
      })
      await pause(token)
    }
  }
  if (setStatus) setStatus('Глубокая проверка: каталог Shikimori...')
  for (const [ep, ids] of [
    ['animes', onlyAl.anime],
    ['mangas', onlyAl.manga],
  ] as const) {
    for (let i = 0; i < ids.length; i += 50) {
      throwIfCancelled(token)
      const chunk = ids.slice(i, i + 50)
      const r = await fetchShiki<Array<{ id?: number }>>(
        `/api/${ep}?ids=${chunk.join(',')}&limit=50`,
      )
      const data = r.data ?? []
      if (Array.isArray(data))
        data.forEach((m) => {
          if (m.id) shikiHas.add(m.id)
        })
      await pause(token)
    }
  }
  return { alHas, shikiHas }
}

export interface CmpStats {
  total: number
  byStatus: Record<string, number>
  mean: number
}

export function cmpStats(map: Map<number, { status: string | null; score10: number }>): CmpStats {
  const st: Record<string, number> = {}
  CMP_STATUS_ORDER.forEach((s) => (st[s] = 0))
  let scored = 0,
    sum = 0
  for (const e of map.values()) {
    if (e.status && st[e.status] !== undefined) {
      const count = st[e.status]
      if (count !== undefined) st[e.status] = count + 1
    }
    if (e.score10 > 0) {
      scored++
      sum += e.score10
    }
  }
  return { total: map.size, byStatus: st, mean: scored ? sum / scored : 0 }
}

export type CmpDiffItem = { id: number; title: string; info: string }
export type CmpDiffItemPair = { id: number; title: string; shiki: string; al: string }
export type CmpDiffItemRewatch = { id: number; title: string; shiki: number; al: number }

export interface CmpDiffResult {
  onlyShiki: CmpDiffItem[]
  onlyShikiRel: CmpDiffItem[]
  onlyAl: CmpDiffItem[]
  onlyAlRel: CmpDiffItem[]
  status: CmpDiffItemPair[]
  score: CmpDiffItemPair[]
  progress: CmpDiffItemPair[]
  rewatch: CmpDiffItemRewatch[]
  notes: CmpDiffItemPair[]
}

export function cmpDiff(
  shiki: Map<number, CmpShikiEntry>,
  al: Map<number, CmpAniListEntry>,
  type: 'anime' | 'manga',
): CmpDiffResult {
  const alRelated = new Set<number>()
  for (const a of al.values()) for (const rid of a.relations || []) alRelated.add(rid)
  const ids = new Set([...shiki.keys(), ...al.keys()])
  const out: CmpDiffResult = {
    onlyShiki: [],
    onlyShikiRel: [],
    onlyAl: [],
    onlyAlRel: [],
    status: [],
    score: [],
    progress: [],
    rewatch: [],
    notes: [],
  }
  for (const id of ids) {
    const s = shiki.get(id),
      a = al.get(id)
    if (s && !a) {
      ;(alRelated.has(id) ? out.onlyShikiRel : out.onlyShiki).push({
        id,
        title: s.title,
        info: cmpStatusLabel(s.status),
      })
      continue
    }
    if (a && !s) {
      const rel = (a.relations || []).some((rid) => shiki.has(rid))
      ;(rel ? out.onlyAlRel : out.onlyAl).push({
        id,
        title: a.title,
        info: cmpStatusLabel(a.status),
      })
      continue
    }
    if (!s || !a) continue
    const title = a.title || s.title
    if (s.status !== a.status)
      out.status.push({ id, title, shiki: cmpStatusLabel(s.status), al: cmpStatusLabel(a.status) })
    if (Math.round(s.score10) !== Math.round(a.score10))
      out.score.push({ id, title, shiki: cmpFmtScore(s.score10), al: cmpFmtScore(a.score10) })
    const pDiff = s.progress !== a.progress || (type === 'manga' && s.volumes !== a.volumes)
    if (pDiff) out.progress.push({ id, title, shiki: cmpFmtProg(s, type), al: cmpFmtProg(a, type) })
    if (s.rewatches !== a.rewatches)
      out.rewatch.push({ id, title, shiki: s.rewatches, al: a.rewatches })
    if (s.notes !== a.notes && (s.notes || a.notes))
      out.notes.push({ id, title, shiki: s.notes ? 'есть' : '—', al: a.notes ? 'есть' : '—' })
  }
  return out
}

export interface CmpFavDiffResult {
  onlyShiki: Array<{ id: number; title: string }>
  onlyAl: Array<{ id: number; title: string }>
  shikiCount: number
  alCount: number
}

export function cmpFavDiff(
  shikiFav: Map<number, string>,
  alFav: Map<number, string>,
): CmpFavDiffResult {
  const ids = new Set([...shikiFav.keys(), ...alFav.keys()])
  const onlyShiki: Array<{ id: number; title: string }> = []
  const onlyAl: Array<{ id: number; title: string }> = []
  for (const id of ids) {
    const shTitle = shikiFav.get(id)
    const alTitle = alFav.get(id)
    if (shTitle && !alTitle) onlyShiki.push({ id, title: shTitle })
    else if (alTitle && !shTitle) onlyAl.push({ id, title: alTitle })
  }
  return { onlyShiki, onlyAl, shikiCount: shikiFav.size, alCount: alFav.size }
}

function cmpNormName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter(Boolean)
    .sort()
    .join(' ')
}

export interface CmpNameDiffResult {
  onlyShiki: Array<{ title: string }>
  onlyAl: Array<{ title: string }>
  shikiCount: number
  alCount: number
}

export function cmpNameDiff(
  shikiArr: Array<{ name: string; romaji: string }>,
  alArr: Array<{ name: string; native: string }>,
): CmpNameDiffResult {
  const alKeys = new Set(alArr.map((x) => cmpNormName(x.name)).filter(Boolean))
  const shKeys = new Set(shikiArr.map((x) => cmpNormName(x.romaji || x.name)).filter(Boolean))
  const onlyShiki = shikiArr
    .filter((x) => {
      const k = cmpNormName(x.romaji || x.name)
      return k && !alKeys.has(k)
    })
    .map((x) => ({ title: x.name }))
  const onlyAl = alArr
    .filter((x) => {
      const k = cmpNormName(x.name)
      return k && !shKeys.has(k)
    })
    .map((x) => ({ title: x.name || x.native }))
  return { onlyShiki, onlyAl, shikiCount: shikiArr.length, alCount: alArr.length }
}

// ==== Оркестратор ====

export interface ScanProgress {
  /** Номер текущего шага, начиная с 1. */
  step: number
  /** Всего шагов: 6, а с глубокой проверкой 7. */
  total: number
  text: string
}

export interface RunScanOptions {
  shikiLogin: string
  /** Пусто — имя определяется по токену через Viewer{name}. */
  alName: string
  deepCheck: boolean
  token: CancelToken
  onProgress: (progress: ScanProgress) => void
}

export interface ScanResult {
  snapshot: CmpScanSnapshot
  /** Итоговая строка «Готово: ...» — считается здесь, чтобы UI не знал о размерах карт. */
  summary: string
}

/**
 * Ошибки наружу не глушатся: их ловит scanner-state.ts и кладёт в строку статуса.
 */
export async function runCompareScan(options: RunScanOptions): Promise<ScanResult> {
  const { shikiLogin, deepCheck, token, onProgress } = options
  const total = deepCheck ? 7 : 6
  let alName = options.alName

  const step = (n: number, text: string) => onProgress({ step: n, total, text })

  saveShikiLogin(shikiLogin)
  throwIfCancelled(token)

  step(1, 'Определяю пользователя AniList...')
  if (!alName) {
    alName = await fetchViewerName()
    if (!alName)
      throw new Error(
        'Не удалось определить AniList-пользователя. Укажите имя вручную или задайте токен в настройках.',
      )
  }
  throwIfCancelled(token)

  step(2, 'Ищу пользователя Shikimori...')
  const shikiId = await cmpResolveShikiUser(shikiLogin)
  throwIfCancelled(token)

  step(3, 'Загружаю списки (аниме)...')
  const [shA, alA] = await Promise.all([
    cmpFetchShikiList(shikiId, 'anime', token),
    cmpFetchAniListList(alName, 'ANIME'),
  ])
  throwIfCancelled(token)

  step(4, 'Загружаю списки (манга)...')
  const [shM, alM] = await Promise.all([
    cmpFetchShikiList(shikiId, 'manga', token),
    cmpFetchAniListList(alName, 'MANGA'),
  ])
  throwIfCancelled(token)

  step(5, 'Загружаю избранное...')
  const shFav = await cmpFetchShikiFavs(shikiId)
  const alFavA = await cmpFetchAniListFavs(alName, 'anime', token)
  const alFavM = await cmpFetchAniListFavs(alName, 'manga', token)
  const alFavChar = await cmpFetchAniListFavPeople(alName, 'characters', token)
  const alFavStaff = await cmpFetchAniListFavPeople(alName, 'staff', token)
  throwIfCancelled(token)

  let catalog: CmpCatalog | null = null
  if (deepCheck) {
    // Предварительная сверка нужна только чтобы узнать, какие id проверять по каталогам.
    const dA0 = cmpDiff(shA, alA, 'anime')
    const dM0 = cmpDiff(shM, alM, 'manga')
    catalog = await cmpDeepCheck(
      { anime: dA0.onlyShiki.map((x) => x.id), manga: dM0.onlyShiki.map((x) => x.id) },
      { anime: dA0.onlyAl.map((x) => x.id), manga: dM0.onlyAl.map((x) => x.id) },
      token,
      (text) => step(6, text),
    )
  }

  step(total, 'Сравниваю...')
  const snapshot: CmpScanSnapshot = {
    shA,
    alA,
    shM,
    alM,
    shFav,
    alFavA,
    alFavM,
    alFavChar,
    alFavStaff,
    catalog,
  }

  return {
    snapshot,
    summary: `Готово: Shiki ${shA.size + shM.size} / AniList ${alA.size + alM.size} тайтлов.`,
  }
}
