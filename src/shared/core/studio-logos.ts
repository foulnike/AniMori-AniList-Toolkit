// Литографии студий: у AniList логотипов нет, список берётся у Шикимори
// раз в сеанс и ложится на склад бессрочно. Сверка по имени: промах —
// просто чип без картинки, это штатный исход, а не сбой.

import { dbGet, dbSet } from './db'
import { fetchShiki } from '../api/shikimori'
import { Logger } from '../utils/logger'
import type { ShikiCacheRecord } from './types'

/** Ключ единственной записи на складе. Цифра — версия формы записи. */
const CACHE_KEY = 'STUDIOS1'

/** Имена студий в нижнем регистре → абсолютный адрес литографии. */
let memory: Map<string, string> | null = null

/** Незавершённая добыча: две карточки могут спросить в один миг. */
let pending: Promise<Map<string, string> | null> = null

interface ShikiStudio {
  id?: number
  name?: string | null
  filtered_name?: string | null
  image?: string | null
}

async function load(): Promise<Map<string, string> | null> {
  const cached = await dbGet<ShikiCacheRecord<Record<string, string>>>('shikiCache', CACHE_KEY)
  if (cached?.data && typeof cached.data === 'object') {
    const map = new Map(Object.entries(cached.data))
    if (map.size > 0) return map
  }

  const reply = await fetchShiki<ShikiStudio[]>('/api/studios')
  if (!Array.isArray(reply.data)) return null

  // Конкатенация, а не шаблон: адрес из двух строк не теряет части по дороге.
  const base = 'https://' + (reply.domain ?? 'shikimori.io')
  const map = new Map<string, string>()
  for (const s of reply.data) {
    if (!s || typeof s.image !== 'string' || s.image === '') continue
    const url = s.image.startsWith('http') ? s.image : base + s.image
    if (typeof s.name === 'string' && s.name !== '') map.set(s.name.trim().toLowerCase(), url)
    if (
      typeof s.filtered_name === 'string' &&
      s.filtered_name !== '' &&
      s.filtered_name !== s.name
    )
      map.set(s.filtered_name.trim().toLowerCase(), url)
  }

  if (map.size === 0) return null

  await dbSet('shikiCache', { key: CACHE_KEY, data: Object.fromEntries(map), ts: Date.now() })
  Logger('DB', `Литографии студий: на складе ${map.size}`)
  return map
}

/** Карта «имя студии → литография»: память, склад, затем сеть. Промах — null. */
export async function studioLogos(): Promise<Map<string, string> | null> {
  if (memory) return memory
  if (pending) return await pending

  const task = load().catch((e) => {
    Logger('WARN', 'Литографии студий: добыть не вышло', e)
    return null
  })
  pending = task

  try {
    memory = await task
    return memory
  } finally {
    pending = null
  }
}
