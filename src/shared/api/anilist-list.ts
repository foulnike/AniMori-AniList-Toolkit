// Список пользователя с AniList: кто мы и что у нас в коллекции.
// Живёт отдельно от anilist.ts: там темп, паузы и разбор отказов, и файл уже велик.
// Наружу отдаётся плоский массив записей без деления на списки сайта.

import { Logger } from '../utils/logger'
import { anilistQuery, canSignAniList } from './anilist'

/** Кто вошёл. Коллекция запрашивается по номеру пользователя, а не по пропуску. */
export interface ViewerInfo {
  id: number
  name: string
}

/**
 * Запись списка в сыром виде. Картинок здесь нет: их даёт склад.
 * Названия есть: без них свой список нечитаем без сети.
 *
 * Вида тайтла здесь нет и не нужно: спрашивается только аниме.
 * Прочитанных томов тоже: они ушли вместе с мангой.
 */
export interface RawListEntry {
  mediaId: number
  /**
   * Номер MAL или null, если сервер связи не знает. По нему тайтл ищется
   * в датасете названий и у русских источников без отдельной пачки соответствий.
   */
  malId: number | null
  status: string | null
  /** Шкала 0..10 с десятыми долями: запрошена явно, независимо от настроек сайта. */
  score: number
  /** Просмотренных серий. */
  progress: number
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
 * Вид тайтла вписан словом, а не вынесен в переменную: без условия
 * MediaListCollection отдаёт и аниме, и мангу сразу, а коллекции манга больше
 * не нужна. Заодно это дешевле: ответ меньше на целый список.
 *
 * Названия и признак взрослого берутся здесь же: отдельный запрос за ними
 * означал бы второй обход всей коллекции пачками по пятьдесят тайтлов.
 *
 * Номер MAL берётся здесь же: без него каждый незнакомый тайтл ждал бы
 * пачки соответствий, прежде чем его имя нашлось бы в датасете.
 *
 * Пересмотры, даты и комментарий стоят почти ничего в весе ответа, а без них
 * окно правки показывало бы пустоту вместо того, что человек уже вписал.
 */
const LIST_QUERY = `query ($userId: Int) {
  MediaListCollection(userId: $userId, type: ANIME) {
    lists {
      entries {
        mediaId
        status
        score(format: POINT_10_DECIMAL)
        progress
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
          idMal
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
 * Номер MAL из вложенного тайтла. Сервер отвечает null, когда связи нет:
 * такой тайтл ищется в датасете через карту соответствий, а не напрямую.
 */
function readMalId(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null

  const id = (value as Record<string, unknown>).idMal
  return typeof id === 'number' && Number.isFinite(id) && id > 0 ? id : null
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
    malId: readMalId(raw.media),
    status: typeof raw.status === 'string' ? raw.status : null,
    score: num(raw.score, 0),
    progress: num(raw.progress, 0),
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
 *
 * Без подписи сеть не тревожится вовсе: ответ известен заранее, а место
 * в темпе нужно поиску и карточкам, которые работают и без входа.
 *
 * Спрашивается общий признак подписи, а не свой токен: в настольном
 * приложении пропуск лежит в Rust, и разметка его не видит принципиально.
 */
export async function fetchViewer(): Promise<ViewerInfo | null> {
  if (!canSignAniList()) {
    Logger('INFO', 'AniList: вход не выполнен, хозяина у сервера не спрашиваем')
    return null
  }

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
export async function fetchUserList(userId: number): Promise<RawListEntry[]> {
  const reply = await anilistQuery<ListReply>(LIST_QUERY, { userId }, true)
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
  Logger('API', `Список AniList (аниме): записей ${byMedia.size}`)

  return Array.from(byMedia.values())
}
