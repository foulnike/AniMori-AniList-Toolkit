// Резолвер русского названия и описания: основной источник, затем фоллбэк.
// Отдельно от shikimori.ts и anime365.ts: зависит от обоих, иначе цикл внутри api/.
// Настройки читаются в момент вызова, а не при импорте (РИСК №1 в docs/DECISIONS.md).

import { settings } from '../core/settings'
import { fetchShiki } from './shikimori'
import { fetchAnime365ByMal } from './anime365'
import type { MediaType, ShikiMedia } from '../core/types'

export interface ResolvedTitle {
  russian: string
  description: string | null
  url: string
  /** Человекочитаемое имя источника для подписи в UI. */
  sourceName: string
}

/** Резолвит русское название и описание по цепочке источников. */
export async function resolveTitle(
  malId: number | null,
  type: MediaType,
): Promise<ResolvedTitle | null> {
  const order = [...new Set([settings.titlePrimary, settings.titleFallback])].filter(
    (src) => src && src !== 'off' && src !== 'none',
  )

  for (const src of order) {
    if (src === 'shikimori') {
      const shiki = await fetchShiki<ShikiMedia>(
        `/api/${type === 'MANGA' ? 'mangas' : 'animes'}/${malId}`,
      )
      if (shiki.data?.russian) {
        return {
          russian: shiki.data.russian,
          description: shiki.data.description ?? null,
          url: 'https://' + (shiki.domain ?? '') + (shiki.data.url ?? ''),
          sourceName: 'Shikimori',
        }
      }
    } else if (src === 'anime365') {
      const a = await fetchAnime365ByMal(malId, type)
      if (a?.russian) {
        return {
          russian: a.russian,
          description: a.description,
          url: a.url,
          sourceName: 'anime365',
        }
      }
    }
  }

  return null
}
