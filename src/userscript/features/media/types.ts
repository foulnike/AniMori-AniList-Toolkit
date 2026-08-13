// Общие типы медиа-страницы: контекст тайтла и контракт виджета сайдбара.
// Вынесены отдельно, чтобы виджеты не импортировали друг друга ради одного интерфейса.

import type { MediaType } from '../../core/types'

/** Данные тайтла из AniList, нужные виджетам. */
export interface MediaAniListData {
  id: number
  type: MediaType
  idMal: number | null
  seasonYear?: number | null
  averageScore?: number | null
  title: { romaji?: string | null; english?: string | null }
}

/** Распределение оценок Shikimori: name — оценка, value — число голосов. */
export interface ShikiScoreStat {
  name: string
  value: number
}

/** Полная карточка тайтла с Shikimori (`FULL_` в кэше). */
export interface MediaShikiData {
  russian?: string | null
  url?: string | null
  score?: string | number | null
  domain?: string | null
  rates_scores_stats?: ShikiScoreStat[] | null
}

/** Всё, что виджету нужно знать о текущей открытой странице. */
export interface MediaContext {
  /** ID тайтла в AniList — он же ID текущего роута. */
  aniId: number
  malData: MediaAniListData
  shikiData: MediaShikiData | null
  /** Домен зеркала, с которого реально пришли данные. */
  shikiDomain: string
  /** REST-раздел Shikimori для этого типа: animes или mangas. */
  endpoint: 'animes' | 'mangas'
  /** Контейнер сайдбара AniList. Может отсутствовать, пока React не отрисовал страницу. */
  sidebar: HTMLElement | null
}

/**
 * Виджет медиа-страницы. Вызывается многократно: AniList пересобирает разметку.
 * Обязан сам проверить, что уже вставлен, и молча выйти — иначе продублируется (РИСК №3).
 */
export type MediaWidget = {
  /** Имя для логов. */
  name: string
  /** CSS-классы, которые надо снять со страницы при переходе на другой тайтл. */
  cleanupSelectors: readonly string[]
  /** Вставка или восстановление виджета. Ошибки внутри не должны ронять остальные виджеты. */
  mount: (ctx: MediaContext) => void
}
