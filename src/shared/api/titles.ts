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

/** Описание с Шикимори приходит с BBcode: теги выкидываются, текст остаётся. */
function stripBbcode(text: string | null): string | null {
  if (!text) return null

  // Парные теги вида [character=123]...[/character]: содержимое остаётся,
  // прогон до неподвижной точки снимает вложенность.
  let clean = text
  const pair = /\[([a-z][a-z0-9]*)(?:=[^\]]*)?\]([\s\S]*?)\[\/\1\]/gi
  let prev = ''
  while (prev !== clean) {
    prev = clean
    clean = clean.replace(pair, '$2')
  }

  clean = clean.replace(/\[\/?[a-z][a-z0-9]*(?:=[^\]]*)?\]/gi, '').trim()
  return clean === '' ? null : clean
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
          description: stripBbcode(shiki.data.description ?? null),
          url: 'https://' + (shiki.domain ?? '') + (shiki.data.url ?? ''),
          sourceName: 'Shikimori',
        }
      }
    } else if (src === 'anime365') {
      const a = await fetchAnime365ByMal(malId, type)
      if (a?.russian) {
        return {
          russian: a.russian,
          description: stripBbcode(a.description),
          url: a.url,
          sourceName: 'anime365',
        }
      }
    }
  }

  return null
}
