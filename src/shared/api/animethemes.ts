// Клиент AnimeThemes.moe: опенинги и эндинги по MAL ID.
// Единственный API без ключа и без зеркал, зато с обязательным кэшем mediaCache.
// Пустой результат тоже кэшируется: иначе тайтлы без тем дёргали бы API каждый раз.

import { Bridge, type HttpResponse } from '@/bridge'
import { CACHE_TIME } from '../core/constants'
import { dbGet, dbSet } from '../core/db'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from '../core/types'
import { MAX_RATE_RETRIES, animeThemesLimiter } from './rate-limit'

/** Базовый адрес собран конкатенацией: литерал схемы в шаблонной строке ломался при отправке. */
const API_BASE = 'https://api.animethemes.moe/anime'

/**
 * Имя источника для учёта доступности. Именно имя, а не адрес: net-health по замыслу
 * не знает ни одного хоста, иначе превратится в список заблокированного.
 */
export const NET_SOURCE_ANIMETHEMES = 'animethemes'
export const NET_LABEL_ANIMETHEMES = 'AnimeThemes'

/** Пауза перед повтором после 429. Джиттер разводит одновременные повторы. */
const RETRY_DELAY_MS = 1500
const REQUEST_TIMEOUT_MS = 10000

const pendingThemes = new Map<number, Promise<MalThemes | null>>()

export interface ThemeItem {
  seq: string
  title: string
  artist: string
}

export interface MalThemes {
  openings: ThemeItem[]
  endings: ThemeItem[]
}

interface AnimeThemesSong {
  title?: string
  artists?: Array<{ name?: string }>
}

interface AnimeThemesEntry {
  type?: string
  slug?: string
  song?: AnimeThemesSong
}

interface AnimeThemesResponse {
  anime?: Array<{ animethemes?: AnimeThemesEntry[] }>
}

/** Разбирает ответ API в списки опенингов и эндингов. */
function formatThemes(themes: AnimeThemesEntry[]): MalThemes {
  const formattedData: MalThemes = { openings: [], endings: [] }

  themes.forEach((t) => {
    const song = t.song ?? {}
    const slug = t.slug ?? ''
    const title = song.title || slug
    const artist = (song.artists ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(', ')
    const seq = slug.replace(/[^0-9]/g, '') || '1'
    const item: ThemeItem = { seq, title, artist }

    if (t.type === 'OP') formattedData.openings.push(item)
    else if (t.type === 'ED') formattedData.endings.push(item)
  })

  return formattedData
}

/**
 * Грузит темы по MAL ID; кэш — mediaCache, ключ THEMES2_<malId>.
 * Никогда не отклоняется: любая неудача — null, иначе сбой всплывёт в mount() виджета.
 * @param malId Идентификатор MyAnimeList или null, если его не удалось разрешить.
 * @param attempt Номер попытки после 429, считая с нуля. Служебный параметр рекурсии.
 */
export async function fetchMalThemes(malId: number | null): Promise<MalThemes | null> {
  if (!malId) return null

  const pending = pendingThemes.get(malId)
  if (pending) return pending

  const task = fetchMalThemesAttempt(malId)
  pendingThemes.set(malId, task)
  try {
    return await task
  } finally {
    pendingThemes.delete(malId)
  }
}

async function fetchMalThemesAttempt(malId: number, attempt = 0): Promise<MalThemes | null> {
  const cacheKey = `THEMES2_${malId}`
  const cached = await dbGet<MediaCacheRecord<MalThemes>>('mediaCache', cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TIME) return cached.data

  Logger('API', `Запрос AnimeThemes.moe для MAL ID: ${malId}`)

  let res: HttpResponse
  // Замер идёт вместе с ожиданием слота: важно, сколько ждал виджет, а не сервер.
  const startedAt = Date.now()
  try {
    // Слот берём перед каждой отправкой: для счётчика окна повтор — такой же запрос.
    await animeThemesLimiter.acquireSlot()

    res = await Bridge.http.request({
      method: 'GET',
      url:
        API_BASE +
        '?filter[has]=resources&filter[site]=MyAnimeList' +
        `&filter[external_id]=${malId}&include=animethemes.song.artists`,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
  } catch (e) {
    // Сюда приходит только транспортный сбой, таймаут или отмена.
    Logger('ERROR', 'AnimeThemes Network Error', e)
    reportError(NET_SOURCE_ANIMETHEMES, NET_LABEL_ANIMETHEMES, e, Date.now() - startedAt)
    return null
  }

  // Отчёт идёт до разбора статусов ниже: net-health сам игнорирует 429 и 401.
  reportStatus(NET_SOURCE_ANIMETHEMES, NET_LABEL_ANIMETHEMES, res.status, Date.now() - startedAt)

  // Код вне 2xx мост исключением не считает, поэтому статусы разбираем сами.
  if (res.status === 429) {
    // Пауза на ограничителе, а не sleep: она притормозит и соседние карточки в очереди.
    const waitMs = RETRY_DELAY_MS + Math.floor(Math.random() * 500)
    animeThemesLimiter.pause(waitMs)

    if (attempt + 1 >= MAX_RATE_RETRIES) {
      Logger('ERROR', `AnimeThemes: лимит 429 не отпустил, темы не загружены (MAL ${malId})`, {
        attempts: attempt + 1,
      })
      // Не кэшируем: это временный отказ, а не отсутствие тем.
      return null
    }

    Logger(
      'WARN',
      `AnimeThemes 429: пауза ${waitMs}мс, повтор ${attempt + 2}/${MAX_RATE_RETRIES} — MAL ${malId}`,
    )
    // Повтор пойдёт через шлюз и сам дождётся конца паузы.
    return fetchMalThemesAttempt(malId, attempt + 1)
  }

  if (res.status !== 200) {
    Logger('ERROR', `AnimeThemes Error HTTP ${res.status}`)
    return null
  }

  try {
    const data = JSON.parse(res.text) as AnimeThemesResponse
    const animeList = data.anime ?? []

    // Не найдено — кэшируем пустой результат.
    if (animeList.length === 0) {
      const emptyData: MalThemes = { openings: [], endings: [] }
      void dbSet('mediaCache', { key: cacheKey, data: emptyData, ts: Date.now() })
      return emptyData
    }

    const formattedData = formatThemes(animeList[0]?.animethemes ?? [])
    void dbSet('mediaCache', { key: cacheKey, data: formattedData, ts: Date.now() })
    return formattedData
  } catch (e) {
    Logger('ERROR', 'Ошибка парсинга AnimeThemes', e)
    return null
  }
}
