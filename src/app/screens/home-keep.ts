// Память главной между показами экрана.
//
// Переход на карточку и назад сносит экран целиком: его собственное состояние
// умирает вместе с ним. Отбор и набранная лента переживают это здесь: человек
// мог нажать «Показать ещё» пять раз, открыть тайтл и вернуться — начинать
// сто постеров с нуля при каждом возврате было бы и долго, и обидно.
//
// Это состояние сеанса, а не данные хозяина: ни в снимок, ни в базу оно не пишется
// и честно гибнет вместе с окном.

import { ref } from 'vue'

import { emptyPick, type CatalogPick } from '@/api/anilist-catalog'
import type { MediaBrief } from '@/api/anilist-media'
import type { FeedRun } from '@/core/recs'

/** Чем сужен подбор: жанры, тэги, годы, форматы и порядок. */
export const homePick = ref<CatalogPick>(emptyPick())

/** Набранная лента: ключ отбора, обход и уже показанное. */
export interface FeedKeep {
  key: string
  run: FeedRun | null
  items: MediaBrief[]
}

/** Вне реактивности нарочно: за перерисовку отвечает экран, а оборачивать
    в ref сотни описаний тайтлов значит даром вешать на каждое поле наблюдателя. */
export const feedKeep: FeedKeep = { key: '', run: null, items: [] }

/** Забыть набранное: смена отбора начинает ленту заново. */
export function dropFeed(): void {
  feedKeep.key = ''
  feedKeep.run = null
  feedKeep.items = []
}
