// Загрузка удалённой базы словаря интерфейса (DICT_URL) с кэшем в IndexedDB.
// Сеть здесь — только способ обновить кэш: без него перевод был лотереей на каждом старте.
// Сбой загрузки не роняет bootstrap(): без словаря переводчик умеет даты, счётчики и названия.
//
// Пункт 3.6б: слой скрипта. Склад, учёт сети и мост остались в ядре и
// берутся алиасами; старое имя `@/api/dictionary` сведено сюда в vite.config.ts.

import { Bridge } from '@/bridge'
import { DICT_URL } from '@/core/constants'
import { dbGet, dbSet } from '@/core/db'
import { reportError, reportStatus } from '@/core/net-health'
import type { ShikiCacheRecord } from '@/core/types'
import { Logger } from '@/utils/logger'

/** Словарь интерфейса: оригинал — перевод. */
export type InterfaceDictionary = Record<string, string>

/** Источник в учёте состояния сети. Отдельный: больше ничто в проекте не ходит на этот хост. */
export const NET_SOURCE_DICT = 'dictionary'
export const NET_LABEL_DICT = 'Словарь (GitHub)'

/**
 * Ключ записи в shikiCache.
 * Префикс не совпадает со счётными: иначе словарь лёг бы в статистику инспектора карточкой тайтла.
 */
const DICT_CACHE_KEY = 'IFACE_DICT_v1'

/**
 * Через сколько считаем кэш устаревшим и идём за обновлением в фон.
 * Словарь пополняется редко, а лишний рейс за 180 КБ — ещё один повод для сетевого сбоя.
 */
const DICT_TTL_MS = 12 * 60 * 60 * 1000

/** Что лежит в кэше. */
interface CachedDictionary {
  dict: InterfaceDictionary
  /** Когда словарь реально пришёл из сети. Свежесть считается по нему. */
  fetchedAt: number
}

/**
 * Тянет общую базу переводов с GitHub. Таймаут не выставлен намеренно: жёсткий лимит
 * рубил бы 180 КБ на медленном канале, а запрос идёт в фоне и никого не задерживает.
 * @returns Объект { "Original": "Перевод" } либо null, если словарь не получен.
 */
export async function fetchInterfaceDictionary(): Promise<InterfaceDictionary | null> {
  const startedAt = Date.now()
  try {
    const res = await Bridge.http.request({
      method: 'GET',
      url: DICT_URL,
      credentials: 'omit',
    })
    reportStatus(NET_SOURCE_DICT, NET_LABEL_DICT, res.status, Date.now() - startedAt)
    if (!res.ok) {
      Logger('ERROR', 'Словарь интерфейса не отдался', { status: res.status, url: res.url })
      return null
    }
    return JSON.parse(res.text) as InterfaceDictionary
  } catch (e) {
    // Сетевой сбой и битый JSON равнозначны: работаем без словаря, а не падаем на старте.
    reportError(NET_SOURCE_DICT, NET_LABEL_DICT, e, Date.now() - startedAt)
    Logger('ERROR', 'Не удалось загрузить словарь интерфейса', e)
    return null
  }
}

/**
 * Кладёт словарь в кэш. Поле ts — время последнего обращения, а не загрузки: по нему
 * сборщик в core/db.ts сносил бы словарь у человека без сети. Свежесть — в data.fetchedAt.
 */
async function saveDictionary(dict: InterfaceDictionary, fetchedAt: number): Promise<void> {
  const record: ShikiCacheRecord<CachedDictionary> = {
    key: DICT_CACHE_KEY,
    data: { dict, fetchedAt },
    ts: Date.now(),
  }
  await dbSet('shikiCache', record)
}

/**
 * Точка входа для старта: применить словарь как можно раньше.
 * Сеть ждётся только при пустом кэше — один раз за установку.
 * @param apply Может быть вызван ДВАЖДЫ: сначала с кэшем, потом с обновлённой версией.
 * @returns true, если словарь был применён хоть один раз к моменту возврата.
 */
export async function loadInterfaceDictionary(
  apply: (dict: InterfaceDictionary) => void,
): Promise<boolean> {
  const cached = await dbGet<ShikiCacheRecord<CachedDictionary>>('shikiCache', DICT_CACHE_KEY)
  const cachedDict = cached?.data?.dict

  if (cachedDict) {
    const ageMin = Math.round((Date.now() - (cached?.data.fetchedAt ?? 0)) / 60000)
    Logger('API', `Словарь интерфейса взят из кэша (возраст ${ageMin} мин)`)
    apply(cachedDict)

    const fresh = Date.now() - (cached?.data.fetchedAt ?? 0) < DICT_TTL_MS
    if (fresh) {
      // Продлеваем время обращения, чтобы сборщик не снёс активную запись.
      void saveDictionary(cachedDict, cached?.data.fetchedAt ?? Date.now())
      return true
    }

    // Сбой фонового обновления ничего не портит: старый перевод лучше отсутствующего.
    void (async () => {
      const freshdict = await fetchInterfaceDictionary()
      if (!freshdict) return
      apply(freshdict)
      await saveDictionary(freshdict, Date.now())
      Logger('API', 'Словарь интерфейса обновлён в фоне')
    })()

    return true
  }

  // Ждём сеть: иначе человек увидит английский интерфейс и решит, что перевод сломался.
  Logger('API', 'Кэш словаря пуст, загрузка из сети...')
  const dict = await fetchInterfaceDictionary()
  if (!dict) return false

  apply(dict)
  await saveDictionary(dict, Date.now())
  return true
}
