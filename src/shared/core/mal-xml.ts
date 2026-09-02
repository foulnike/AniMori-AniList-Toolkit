// Выгрузка списка в XML экспорта MyAnimeList: единственный формат обмена,
// который принимают чужие сервисы — Шикимори, AniList, Kitsu и сам MAL.
//
// Ни сети, ни диска, ни моста здесь нет: на входе записи, на выходе строка.
// Сохранение файла — забота экрана, а не этого модуля.
//
// Главная оговорка формата: он ключуется номером MAL, а список живёт на
// номерах AniList. Запись без номера MAL выразить нечем вовсе, и такие
// возвращаются поимённо: молча пропустить часть списка хуже, чем сказать,
// что именно не уехало.

import type { SnapshotEntry } from './snapshot'

/**
 * Закладки AniList в слова MAL. Пересмотра у MAL нет вовсе, и он идёт
 * как «Watching»: число пересмотров всё равно едет своим полем ниже,
 * так что смысл теряется не целиком.
 */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  CURRENT: 'Watching',
  REPEATING: 'Watching',
  COMPLETED: 'Completed',
  PAUSED: 'On-Hold',
  DROPPED: 'Dropped',
  PLANNING: 'Plan to Watch',
}

/** Пустая дата формата: именно так MAL обозначает «даты нет». */
const NO_DATE = '0000-00-00'

/** Дата снимка всегда ГГГГ-ММ-ДД; всё остальное считается отсутствием. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/** Что выгружаем и от чьего имени. */
export interface MalXmlInput {
  entries: Iterable<SnapshotEntry>
  /** Имя в шапке выгрузки. Импортеры его не читают, но формат его ждёт. */
  userName?: string
}

/** Итог выгрузки: сама строка и честный счёт того, что не уехало. */
export interface MalXmlResult {
  xml: string
  /** Сколько записей легло в выгрузку. */
  exported: number
  /**
   * Названия записей без номера MAL. Их формат выразить не может:
   * либо связи не знает сам AniList, либо запись старее того дня, когда
   * номер MAL стал приезжать со списком — тогда поможет перенос списка.
   */
  noMalId: string[]
  /** Записей без закладки: в списке их нет, выгружать нечего. */
  noStatus: number
}

/**
 * Заворачивает вольный текст в CDATA. Закрывающая скобка внутри текста
 * разрезается на два блока: без этого комментарий со «]]>» рвёт весь файл,
 * и импортер на чужой стороне отказывается от выгрузки целиком.
 */
function cdata(value: string): string {
  return `<![CDATA[${value.split(']]>').join(']]]]><![CDATA[>')}]]>`
}

/**
 * Закладка словом MAL. Незнакомая закладка считается отсутствием:
 * придуманная замена разложила бы список на чужом сервисе тихо.
 */
export function malStatus(status: string | null): string | null {
  if (status === null || status === '') return null
  return STATUS_WORDS[status] ?? null
}

/** Дата в виде формата или его же пустая дата. */
export function malDate(value: string | null): string {
  if (value === null || !DATE_SHAPE.test(value)) return NO_DATE
  return value
}

/**
 * Оценка целым баллом 0..10. У нас шкала с десятыми, у MAL целые:
 * десятые теряются, и это ограничение формата, а не небрежность.
 */
export function malScore(score10: number): number {
  if (!Number.isFinite(score10) || score10 <= 0) return 0
  return Math.min(10, Math.max(0, Math.round(score10)))
}

/** Название для выгрузки. Сопоставление идёт по номеру, так что это для глаз. */
function titleOf(entry: SnapshotEntry): string {
  return entry.english ?? entry.romaji ?? `Anime #${entry.mediaId}`
}

/**
 * Собирает выгрузку. Порядок записей — по номеру MAL, а не как пришли:
 * две выгрузки одного списка должны совпадать байт в байт, иначе их нечем
 * сравнить между собой.
 *
 * Поля выбраны по тому, что правда есть в снимке. Числа серий тайтла
 * в снимке нет, и поле series_episodes не пишется вовсе: выдуманный ноль
 * читался бы как «серий ноль», а не как «не знаю».
 */
export function buildMalXml(input: MalXmlInput): MalXmlResult {
  const rows: SnapshotEntry[] = []
  const noMalId: string[] = []
  let noStatus = 0

  for (const entry of input.entries) {
    if (malStatus(entry.status) === null) {
      noStatus++
      continue
    }

    if (typeof entry.malId !== 'number' || entry.malId <= 0) {
      noMalId.push(titleOf(entry))
      continue
    }

    rows.push(entry)
  }

  rows.sort((a, b) => (a.malId ?? 0) - (b.malId ?? 0))
  noMalId.sort((a, b) => a.localeCompare(b, 'ru'))

  const parts: string[] = []
  parts.push('<?xml version="1.0" encoding="UTF-8" ?>')
  parts.push('<myanimelist>')
  parts.push('  <myinfo>')
  parts.push('    <user_id>0</user_id>')
  parts.push(`    <user_name>${cdata(input.userName ?? 'AniMori')}</user_name>`)
  // Единица значит «аниме». Двойка — манга, но её мы не ведём.
  parts.push('    <user_export_type>1</user_export_type>')
  parts.push(`    <user_total_anime>${rows.length}</user_total_anime>`)
  parts.push('  </myinfo>')

  for (const entry of rows) {
    const status = malStatus(entry.status)
    if (status === null) continue

    parts.push('  <anime>')
    parts.push(`    <series_animedb_id>${entry.malId ?? 0}</series_animedb_id>`)
    parts.push(`    <series_title>${cdata(titleOf(entry))}</series_title>`)
    parts.push(`    <my_watched_episodes>${Math.max(0, Math.round(entry.progress))}</my_watched_episodes>`)
    parts.push(`    <my_start_date>${malDate(entry.startedAt)}</my_start_date>`)
    parts.push(`    <my_finish_date>${malDate(entry.completedAt)}</my_finish_date>`)
    parts.push(`    <my_score>${malScore(entry.score10)}</my_score>`)
    parts.push(`    <my_status>${status}</my_status>`)
    parts.push(`    <my_times_watched>${Math.max(0, Math.round(entry.repeat))}</my_times_watched>`)
    parts.push(`    <my_comments>${cdata(entry.notes ?? '')}</my_comments>`)
    // Без этого поля импортёр MAL пропускает уже известные ему записи
    // вместо того, чтобы подновить их нашими числами.
    parts.push('    <update_on_import>1</update_on_import>')
    parts.push('  </anime>')
  }

  parts.push('</myanimelist>')

  return {
    xml: `${parts.join('\n')}\n`,
    exported: rows.length,
    noMalId,
    noStatus,
  }
}

/**
 * Имя файла выгрузки с днём внутри: папка загрузок через полгода иначе
 * содержит пять файлов с одним именем и номерками в скобках.
 */
export function malXmlFileName(now: Date = new Date()): string {
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `animori-anime-${day}.xml`
}
