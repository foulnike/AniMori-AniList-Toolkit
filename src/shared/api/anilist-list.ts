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

/**
 * Запись списка в сыром виде. Картинок здесь нет: их даёт склад.
 * Названия есть: без них свой список нечитаем без сети.
 *
 * Типа тайтла здесь нет сознательно: запрос идёт по одному типу сразу,
 * и вызывающий знает его точнее, чем мы вычитали бы из ответа.
 */
export interface RawListEntry {
  mediaId: number
  status: string | null
  /** Шкала 0..10 с десятыми долями: запрошена явно, независимо от настроек сайта. */
  score: number
  /** Серий у аниме, глав у манги. */
  progress: number
  /** Прочитано томов. У аниме всегда ноль — это штатно. */
  volumes: number
  /** Сколько раз пересматривали или перечитывали. */
  repeat: number
  /** Дата начала в виде ГГГГ-ММ-ДД или null. Неполную дату не отдаём. */
  startedAt: string | null
  /** Дата завершения в виде ГГГГ-ММ-ДД или null. */
  completedAt: string | null
  /** Личный комментарий к записи. Пустая строка равносильна отсутствию. */
  notes: string | null
  updatedAt: number
  /** Взрослый тайтл по мнению AniList. Отбор — забота экранов, не этого слоя. */
  isAdult: boolean
  /** Название латиницей. Есть почти всегда и служит опорой показа. */
  romaji: string | null
  /** Английское название. У многих тайтлов отсутствует. */
  english: string | null
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
 * Названия и признак взрослого берутся здесь же: отдельный запрос за ними
 * означал бы второй обход всей коллекции пачками по пятьдесят тайтлов.
 *
 * Пересмотры, даты и комментарий стоят почти ничего в весе ответа, а без них
 * окно правки показывало бы пустоту вместо того, что человек уже вписал.
 */
const LIST_QUERY = `query ($userId: Int, $type: MediaType) {
  MediaListCollection(userId: $userId, type: $type) {
    lists {
      entries {
        mediaId
        status
        score(format: POINT_10_DECIMAL)
        progress
        progressVolumes
        repeat
        notes
        startedAt {
          year
          month
          day
        }
        completedAt {
          year
          month
          day
        }
        updatedAt
        media {
          isAdult
          title {
            romaji
            english
          }
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
 * Название из вложенного тайтла. Пустая строка равносильна отсутствию:
 * показывать пустоту хуже, чем честно взять следующий вариант названия.
 */
function readTitle(value: unknown, key: 'romaji' | 'english'): string | null {
  if (typeof value !== 'object' || value === null) return null

  const title = (value as Record<string, unknown>).title
  if (typeof title !== 'object' || title === null) return null

  const text = (title as Record<string, unknown>)[key]
  return typeof text === 'string' && text.length > 0 ? text : null
}

/** Две цифры с нулём впереди: месяц и день в дате пишутся ровно так. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Нечёткая дата AniList в строку ГГГГ-ММ-ДД. Неполная дата отбрасывается:
 * ни поле даты в окне правки, ни обратная отправка её не примут, а выдуманный
 * первый день месяца — это уже не то, что человек записал.
 */
function readFuzzy(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null

  const date = value as Record<string, unknown>
  const year = date.year
  const month = date.month
  const day = date.day

  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return null
  if (year <= 0 || month <= 0 || day <= 0) return null

  return `${year}-${pad(month)}-${pad(day)}`
}

/** Строка или null. Пустой комментарий равносилен отсутствию комментария. */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
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
    volumes: num(raw.progressVolumes, 0),
    repeat: num(raw.repeat, 0),
    startedAt: readFuzzy(raw.startedAt),
    completedAt: readFuzzy(raw.completedAt),
    notes: readText(raw.notes),
    updatedAt: num(raw.updatedAt, 0) * 1000,
    isAdult: readAdult(raw.media),
    romaji: readTitle(raw.media, 'romaji'),
    english: readTitle(raw.media, 'english'),
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
