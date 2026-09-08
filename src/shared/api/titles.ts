// Резолвер русского названия и описания: основной источник, затем фоллбэк.
// Отдельно от shikimori.ts и anime365.ts: зависит от обоих, иначе цикл внутри api/.
// Настройки читаются в момент вызова, а не при импорте — так решено в docs/DECISIONS.md.
//
// Описание отдаётся как приехало, с разметкой источника: разбирает её
// core/rich-text.ts на слое показа. Прежде теги вырезались здесь, и вместе
// с ними терялись ссылки на другие тайтлы, спойлеры и начертания.
//
// Карточка Шикимори берётся через общего добытчика (shikimori-media.ts):
// оценки площадок грузятся рядом и просят ту же самую запись, а раньше
// каждый ходил за ней сам — два одинаковых запроса на одно открытие тайтла.

import { settings } from '../core/settings'
import { fetchShikiAnime } from './shikimori-media'
import { fetchAnime365ByMal } from './anime365'

export interface ResolvedTitle {
  russian: string
  /** Описание с разметкой источника: BBcode Шикимори или маркдаун AniList. */
  description: string | null
  url: string
  /** Человекочитаемое имя источника для подписи в UI. */
  sourceName: string
  /** Оценка MAL из зеркала Шикимори, шкала 0..10. */
  score: number | null
  /** Распределение голосов Шикимори: из него считается их собственная средняя. */
  rates: Array<{ name: string; value: number }> | null
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null

  const clean = value.trim()
  return clean === '' ? null : clean
}

/**
 * Резолвит русское название и описание по цепочке источников.
 *
 * Адреса всегда анимешные: раздела манги у нас больше нет.
 */
export async function resolveTitle(malId: number | null): Promise<ResolvedTitle | null> {
  const order = [...new Set([settings.titlePrimary, settings.titleFallback])].filter(
    (src) => src && src !== 'off' && src !== 'none',
  )

  for (const src of order) {
    if (src === 'shikimori') {
      // Без номера MAL спрашивать не по чему: прежде такой вызов уезжал
      // за `/api/animes/null` и тратил чужой бюджет ради гарантированного 404.
      if (malId === null) continue

      const shiki = await fetchShikiAnime(malId)
      if (shiki.data?.russian) {
        const rawScore = Number(shiki.data.score)
        return {
          russian: shiki.data.russian,
          description: textOrNull(shiki.data.description),
          url: 'https://' + (shiki.domain ?? '') + (shiki.data.url ?? ''),
          sourceName: 'Shikimori',
          score: Number.isFinite(rawScore) && rawScore > 0 ? rawScore : null,
          rates: Array.isArray(shiki.data.rates_scores_stats)
            ? shiki.data.rates_scores_stats
            : null,
        }
      }
    } else if (src === 'anime365') {
      const a = await fetchAnime365ByMal(malId)
      if (a?.russian) {
        return {
          russian: a.russian,
          description: textOrNull(a.description),
          url: a.url,
          sourceName: 'anime365',
          score: null,
          rates: null,
        }
      }
    }
  }

  return null
}
