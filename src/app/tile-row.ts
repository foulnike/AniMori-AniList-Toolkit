// Плитка выдачи каталога: сборка строки для MediaTile в одном месте.
// Появилась со страницей студии (3.10): поиск и она собирали одно и то же дважды.

import type { MediaBrief } from '@/api/anilist-media'
import { getEntry } from '@/core/collection'
import { peekRussianName } from '@/core/media-title'

import { formatWord, partsShort, statusWord } from './labels'

/** Плитка выдачи. Всё готовится заранее: разметка ничего не считает. */
export interface TileRow {
  mediaId: number
  title: string
  facts: string
  cover: string | null
  color: string | null
  score: string | null
  mark: string | null
  own: string | null
  repeat: number
  note: string | null
  done: number
  adult: boolean
}

/** Оценка сервера для угла постера: у AniList она в сотнях. */
function scoreText(brief: MediaBrief): string | null {
  return brief.averageScore === null ? null : `${brief.averageScore}%`
}

/** Сколько всего частей у тайтла: теперь это всегда серии. */
function partsCount(brief: MediaBrief): number | null {
  return brief.episodes
}

/** Короткая подпись под названием: вид и год. Счёт частей ушёл на постер. */
function briefFacts(brief: MediaBrief): string {
  const parts: string[] = []

  const kindWord = formatWord(brief.format)
  if (kindWord !== null) parts.push(kindWord)
  if (brief.seasonYear !== null) parts.push(String(brief.seasonYear))

  return parts.join(' · ')
}

/**
 * Своя закладка: сначала местный список, и только потом ответ сервера.
 * Без входа ownEntry пуст всегда, а свой список у нас есть и так (пункт 3.14).
 */
function markText(brief: MediaBrief): string | null {
  const mine = getEntry(brief.mediaId)
  if (mine) return statusWord('ANIME', mine.status)

  return statusWord('ANIME', brief.ownEntry?.status ?? null)
}

/** Свой счёт частей по той же лестнице: память, ответ сервера, ноль. */
function ownSeen(brief: MediaBrief): number {
  const mine = getEntry(brief.mediaId)
  if (mine) return mine.progress

  return brief.ownEntry?.progress ?? 0
}

/** Строка счёта на постере: свой прогресс, а без него — размер тайтла. */
function ownText(brief: MediaBrief): string | null {
  const parts = partsCount(brief)
  const seen = ownSeen(brief)
  const short = partsShort('ANIME')

  if (seen > 0) return parts === null ? `${seen} ${short}` : `${seen} / ${parts} ${short}`
  return parts === null ? null : `${parts} ${short}`
}

/** Доля пройденного для полосы под постером. */
function donePart(brief: MediaBrief): number {
  const mine = getEntry(brief.mediaId)
  const status = mine ? mine.status : (brief.ownEntry?.status ?? null)
  if (status === 'COMPLETED') return 1

  const parts = partsCount(brief)
  const seen = ownSeen(brief)
  if (parts === null || parts <= 0 || seen <= 0) return 0

  return Math.min(1, seen / parts)
}

/** Название для плитки: русское, латиница, английское, номер. */
function pickTitle(brief: MediaBrief): string {
  return (
    peekRussianName(brief.mediaId) ?? brief.romaji ?? brief.english ?? `Тайтл #${brief.mediaId}`
  )
}

/** Выписка сервера в плитку показа. */
export function toTileRow(brief: MediaBrief): TileRow {
  // Повторы и комментарий бывают только своими: у ответа каталога их нет.
  const mine = getEntry(brief.mediaId)

  return {
    mediaId: brief.mediaId,
    title: pickTitle(brief),
    facts: briefFacts(brief),
    cover: brief.cover,
    color: brief.color,
    score: scoreText(brief),
    mark: markText(brief),
    own: ownText(brief),
    repeat: mine?.repeat ?? 0,
    note: mine?.notes ?? null,
    done: donePart(brief),
    adult: brief.isAdult,
  }
}
