// Строки списка вынесены из показа: экран остаётся про отбор и переносы,
// а здесь лежит всё, что превращает запись памяти в готовую плитку:
// сборка, порядок показа и доборы обложек с названиями.
// Модуль один сознательно: веер мелких файлов труднее держать в согласии.
import { ref, type Ref } from 'vue'

import { partsOut, peekLook, warmLooks, type MediaLook } from '@/core/media-looks'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import type { SnapshotEntry } from '@/core/snapshot'
import { Logger } from '@/utils/logger'

import { formatWord, partsShort } from '../labels'

import type { SortName } from './lists-keep'

/** По скольку тайтлов просить названия за заход: источники отвечают по одному. */
const TITLE_CHUNK = 10

/** Строка списка в виде, готовом к отрисовке: разметка ничего не считает. */
export interface Row {
  mediaId: number
  title: string
  facts: string
  mark: string | null
  repeat: number
  note: string | null
  ongoing: boolean
  own: string | null
  done: number
  cover: string | null
  color: string | null
  adult: boolean
}

/** Доборы, отданные экрану: два флажка для подвала и два пуска. */
export interface RowWarm {
  looksBusy: Ref<boolean>
  titlesBusy: Ref<boolean>
  fillLooks: () => Promise<void>
  fillTitles: () => Promise<void>
}

/** Короткая подпись под названием: вид и год. Больше в две строки не влезает. */
function factsText(look: MediaLook | null): string {
  if (look === null) return ''

  const parts: string[] = []

  const kindWord = formatWord(look.format)
  if (kindWord !== null) parts.push(kindWord)
  if (look.seasonYear !== null) parts.push(String(look.seasonYear))

  return parts.join(' · ')
}

/** Свой счёт частей на постере. Неизвестный итог не выдумывается. */
function ownText(entry: SnapshotEntry, parts: number | null): string | null {
  const short = partsShort()
  if (parts === null) return entry.progress > 0 ? `${entry.progress} ${short}` : null
  return `${entry.progress} / ${parts} ${short}`
}

/** Доля пройденного для полосы. Завершённое залито целиком даже без итога. */
function donePart(entry: SnapshotEntry, parts: number | null): number {
  if (entry.status === 'COMPLETED') return 1
  if (parts === null || parts <= 0 || entry.progress <= 0) return 0
  return Math.min(1, entry.progress / parts)
}

/**
 * Название записи: русское, латиница, английское, номер. Номер остаётся
 * только у записи, созданной правкой до ответа сервера.
 */
function titleOf(entry: SnapshotEntry): string {
  return (
    peekRussianName(entry.mediaId) ??
    entry.romaji ??
    entry.english ??
    peekLook(entry.mediaId)?.romaji ??
    `Тайтл #${entry.mediaId}`
  )
}

/** Средняя оценка каталога для порядка: неизвестная уходит в конец. */
function ratingOf(entry: SnapshotEntry): number {
  return peekLook(entry.mediaId)?.averageScore ?? -1
}

/**
 * Порядок показа. Названия сравниваются по-русски, поэтому список может
 * слегка переставиться, когда доберутся переводы: до них сравнивать нечего.
 */
export function sortEntries(list: SnapshotEntry[], key: SortName): SnapshotEntry[] {
  const out = [...list]

  switch (key) {
    case 'score':
      out.sort((a, b) => b.score10 - a.score10 || b.updatedAt - a.updatedAt)
      break
    case 'rating':
      out.sort((a, b) => ratingOf(b) - ratingOf(a) || b.updatedAt - a.updatedAt)
      break
    case 'nameUp':
      out.sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'ru'))
      break
    case 'nameDown':
      out.sort((a, b) => titleOf(b).localeCompare(titleOf(a), 'ru'))
      break
    default:
      out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  return out
}

/** Запись памяти в плитку. */
export function toRow(entry: SnapshotEntry): Row {
  const look = peekLook(entry.mediaId)

  // У идущего сезона знаменателем служат вышедшие серии.
  const parts = partsOut(look)

  return {
    mediaId: entry.mediaId,
    title: titleOf(entry),
    facts: factsText(look),
    mark: entry.score10 > 0 ? `★ ${entry.score10.toFixed(1)}` : null,
    repeat: entry.repeat,
    note: entry.notes,
    ongoing: (look?.airingEpisode ?? null) !== null,
    own: ownText(entry, parts),
    done: donePart(entry, parts),
    cover: look?.cover ?? null,
    color: look?.color ?? null,
    adult: entry.isAdult,
  }
}

/**
 * Доборы для показанных строк: обложек в снимке нет вовсе, а русские
 * названия лежат на складе. Экран отдаёт свои строки и способ перерисовки,
 * а номера работ гасят ответы устаревшего показа.
 */
export function useRowWarm(rows: Ref<Row[]>, redraw: () => void): RowWarm {
  const looksBusy = ref(false)
  const titlesBusy = ref(false)

  let lookRun = 0
  let titleRun = 0

  /**
   * Добирает обложки для показанных плиток. Сотня строк стоит двух
   * запросов, а возврат в ту же закладку — ни одного.
   */
  async function fillLooks(): Promise<void> {
    const mine = ++lookRun
    const wanted = rows.value
      .filter((row) => peekLook(row.mediaId) === null)
      .map((row) => row.mediaId)

    if (wanted.length === 0) return

    looksBusy.value = true

    try {
      await warmLooks(wanted)
      if (mine !== lookRun) return

      redraw()
    } catch (e) {
      // Без обложек список живой: на плитке останется первая буква названия.
      Logger('WARN', 'Списки: обложки добрать не вышло', e)
    } finally {
      if (mine === lookRun) looksBusy.value = false
    }
  }

  /**
   * Добирает русские названия для показанных плиток пачками. Ошибка здесь
   * не стопорит экран: без перевода название останется на латинице.
   */
  async function fillTitles(): Promise<void> {
    const mine = ++titleRun
    const wanted = rows.value
      .filter((row) => peekRussianName(row.mediaId) === null)
      .map((row) => row.mediaId)

    if (wanted.length === 0) return

    titlesBusy.value = true

    try {
      for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
        // Закладку успели сменить: остаток пачек этому показу не нужен.
        if (mine !== titleRun) return

        // Строке нужно одно имя: описание с оценками спросит открытая карточка.
        await prefetchRussianNames(wanted.slice(from, from + TITLE_CHUNK))
        if (mine !== titleRun) return

        redraw()
      }
    } catch (e) {
      Logger('WARN', 'Списки: названия добрать не вышло', e)
    } finally {
      if (mine === titleRun) titlesBusy.value = false
    }
  }

  return { looksBusy, titlesBusy, fillLooks, fillTitles }
}
