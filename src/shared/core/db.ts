// Слой IndexedDB: склад карточек (mediaCache), MAL-соответствий и франшиз.
// Инстанс базы приватен: наружу идут только функции, сырой IDBDatabase не достать.
// Через Bridge прятать не нужно: IndexedDB есть и в юзерскрипте, и в WebView Tauri.

import { CACHE_TIME, DB_NAME, DB_VERSION } from './constants'
import { Logger } from '../utils/logger'
import type { CacheRecord, CacheStoreName, DbStats, DbStatsError } from './types'

/**
 * Мигратор схемы. Вторым аргументом идёт транзакция обновления: без неё
 * нельзя перелить содержимое одного стора в другой, а только создавать пустые.
 */
type Migration = (db: IDBDatabase, tx: IDBTransaction | null) => void

/**
 * Потолок ожидания открытия. Семь секунд — заведомо больше любого честного
 * открытия с миграцией на медленном диске; всё дольше — зависание.
 */
const DB_OPEN_TIMEOUT_MS = 7000

let globalDbInstance: IDBDatabase | null = null

/**
 * Промис незавершённого открытия. Проверки globalDbInstance недостаточно:
 * она срабатывает только ПОСЛЕ разрешения, а на холодном старте очередь
 * переводчика выпускает десятки чтений разом. Несколько параллельных open()
 * — это ещё и шанс получить blocked самому на себя при смене версии схемы.
 */
let openInFlight: Promise<IDBDatabase | null> | null = null

/**
 * Миграции схемы. Ключ — версия, значение — мигратор от N-1 к N.
 * Прогон от `oldVersion+1` до DB_VERSION; каждый шаг идемпотентен (objectStoreNames.contains).
 * Новая миграция: поднять DB_VERSION в constants.ts и добавить `[N+1]: ...`.
 * Версии 1..5 консолидированы в шаг 5, далее нумерация с 6.
 */
const DB_MIGRATIONS: Record<number, Migration> = {
  5: (db) => {
    if (!db.objectStoreNames.contains('shikiCache'))
      db.createObjectStore('shikiCache', { keyPath: 'key' })
    if (!db.objectStoreNames.contains('malCache'))
      db.createObjectStore('malCache', { keyPath: 'id' })
    if (!db.objectStoreNames.contains('franchiseCache'))
      db.createObjectStore('franchiseCache', { keyPath: 'id' })
  },

  /**
   * Переименование склада карточек: shikiCache -> mediaCache.
   * Сначала копия, и только потом удаление старого: срок хранения
   * бессрочный, и потеря склада обошлась бы тысячами повторных запросов
   * к Shikimori под рейт-лимитом.
   *
   * На новой установке шаг 5 создаёт старый стор, а этот шаг тут же
   * его убирает: шаги не переписывают историю друг друга, и один лишний
   * созданный стор внутри одного обновления ничего не стоит.
   */
  6: (db, tx) => {
    if (!db.objectStoreNames.contains('mediaCache'))
      db.createObjectStore('mediaCache', { keyPath: 'key' })

    // Старого стора нет — переносить нечего.
    if (!db.objectStoreNames.contains('shikiCache')) return

    // Без транзакции обновления копировать нечем: оставляем старый стор на месте,
    // ничего не теряя. Псевдоним в dbGet/dbSet всё равно смотрит в новый стор,
    // поэтому хуже всего будет только то, что склад наполнится заново.
    if (!tx) {
      Logger('WARN', 'Миграция БД: нет транзакции обновления, перенос кэша пропущен')
      return
    }

    const from = tx.objectStore('shikiCache')
    const to = tx.objectStore('mediaCache')
    const cursorReq = from.openCursor()
    let moved = 0

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        to.put(cursor.value)
        moved++
        cursor.continue()
        return
      }

      // Копия готова целиком — теперь старый стор можно убирать.
      try {
        db.deleteObjectStore('shikiCache')
      } catch (e) {
        Logger('WARN', 'Миграция БД: старый стор не удалился, но копия уже на месте', e)
      }

      Logger('DB', `Миграция БД: в mediaCache перенесено записей — ${moved}`)
    }

    cursorReq.onerror = () => {
      // Старый стор намеренно остаётся: лишний стор в базе дешевле потерянного кэша.
      Logger('ERROR', 'Миграция БД: перенос кэша не удался', cursorReq.error)
    }
  },
}

/** Сторы, которые реально лежат в базе после шестой версии схемы. */
type PhysicalStore = 'mediaCache' | 'malCache' | 'franchiseCache'

/**
 * Переводит имя стора из вызова в физическое. Старое имя shikiCache — псевдоним:
 * вызовов dbGet/dbSet десятки и в приложении, и в юзерскрипте, и переписать
 * их все одним заходом — значит сломать то, что не проверить сборкой по частям.
 */
function physicalStore(store: CacheStoreName): PhysicalStore {
  return store === 'shikiCache' ? 'mediaCache' : store
}

/**
 * Вешает на живое соединение обработчики его собственной смерти.
 *
 * `onversionchange` — профилактика, а не лечение: `blocked` в соседней вкладке
 * возникает именно потому, что МЫ держим старую версию и не отпускаем.
 * `onclose` — соединение умерло не по нашей воле; без него в globalDbInstance навсегда
 * остался бы битый экземпляр, и транзакции падали бы до конца сессии.
 */
function attachConnectionHandlers(db: IDBDatabase): void {
  db.onversionchange = () => {
    Logger('WARN', 'IndexedDB: другое окно обновляет схему — закрываем соединение')
    try {
      db.close()
    } catch (e) {
      Logger('WARN', 'IndexedDB: сбой при закрытии соединения', e)
    }
    // Сравнение обязательно: там может лежать уже ДРУГОЕ, свежее соединение.
    if (globalDbInstance === db) globalDbInstance = null
  }

  db.onclose = () => {
    Logger('WARN', 'IndexedDB: соединение закрыто извне — следующее обращение переоткроет базу')
    if (globalDbInstance === db) globalDbInstance = null
  }
}

/**
 * Открывает базу, прогоняя недостающие миграции. Возвращает null при сбое.
 *
 * Дефект A3: раньше обрабатывались два исхода из трёх. При `blocked` не срабатывал
 * НИ ОДИН обработчик, промис не разрешался никогда, а `await openDB()` в bootstrap
 * вис вечно: переводчик, поиск, виджеты и роутер не стартовали вообще,
 * и в журнале не оставалось ни строчки.
 *
 * Теперь промис разрешается ВСЕГДА и ровно один раз: соединением, null по ошибке
 * или null по таймауту. Работа без кэша — это медленно, но работа; виснувший старт
 * — мёртвое приложение. Все потребители уже умеют обрабатывать null.
 */
export async function openDB(): Promise<IDBDatabase | null> {
  if (globalDbInstance) return globalDbInstance

  // Уже открываем — присоединяемся к тому же ожиданию вместо второго open().
  if (openInFlight) return openInFlight

  openInFlight = new Promise<IDBDatabase | null>((resolve) => {
    // Страж однократного завершения: исходов четыре, и сработать могут два
    // подряд: например, таймаут, а следом запоздалый onsuccess.
    let settled = false
    let timer: number | undefined

    const finish = (db: IDBDatabase | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) window.clearTimeout(timer)
      globalDbInstance = db
      resolve(db)
    }

    Logger('DB', 'Открытие подключения к IndexedDB...')

    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      // Сам вызов бросает синхронно, например в приватном режиме.
      Logger('ERROR', 'IndexedDB недоступен: indexedDB.open бросил исключение', e)
      finish(null)
      return
    }

    // Страховка от любого непредусмотренного исхода: старт обязан продолжиться
    // даже там, где мы не понимаем причины.
    timer = window.setTimeout(() => {
      Logger('ERROR', `IndexedDB не открылась за ${DB_OPEN_TIMEOUT_MS} мс — продолжаем без кэша`)
      finish(null)
    }, DB_OPEN_TIMEOUT_MS)

    req.onupgradeneeded = (e) => {
      const db = req.result
      const fromVersion = e.oldVersion || 0
      Logger('DB', `Миграция БД: ${fromVersion} → ${DB_VERSION}`)

      for (let v = fromVersion + 1; v <= DB_VERSION; v++) {
        const migrate = DB_MIGRATIONS[v]
        if (!migrate) continue
        try {
          // Транзакция обновления живёт только здесь: шагу, который переливает
          // данные, без неё не обойтись.
          migrate(db, req.transaction)
          Logger('DB', `Миграция БД: шаг ${v} выполнен успешно`)
        } catch (err) {
          Logger('ERROR', `Миграция БД: сбой на шаге ${v}`, err)
        }
      }
    }

    // finish() здесь НЕ вызывается: `blocked` не отменяет запрос, а приостанавливает.
    // Соседняя вкладка отпустит соединение по нашему onversionchange, и придёт
    // обычный onsuccess. Важна сама запись: без неё ситуация была невидимой.
    req.onblocked = () => {
      Logger(
        'WARN',
        'IndexedDB: открытие заблокировано другой вкладкой со старой версией схемы. ' +
          'Ждём освобождения; если не дождёмся — продолжим без кэша',
      )
    }

    req.onsuccess = () => {
      const db = req.result
      attachConnectionHandlers(db)

      if (settled) {
        // Промис уже разрешён в null по таймауту, но соединение годное: без этой
        // ветки оно висело бы брошенным и блокировало уже чужие вкладки.
        globalDbInstance = db
        Logger('DB', 'IndexedDB открылась после таймаута — кэш снова доступен')
        return
      }

      finish(db)
    }

    req.onerror = () => {
      Logger('ERROR', 'Ошибка открытия IndexedDB', req.error)
      finish(null)
    }
  })

  const db = await openInFlight

  // Маркер снимается в любом случае: запоминать отказ навсегда нельзя,
  // соседняя вкладка закроется и база станет доступной.
  openInFlight = null

  return db
}

/**
 * Читает запись по ключу.
 * @param store Имя object store. Старое `shikiCache` равносильно `mediaCache`.
 * @param key keyPath стора: `key` (строка) для mediaCache, `id` (число) для остальных.
 */
export async function dbGet<T = unknown>(
  store: CacheStoreName,
  key: IDBValidKey,
): Promise<T | null> {
  const name = physicalStore(store)
  try {
    const db = await openDB()
    if (!db) return null

    return await new Promise<T | null>((resolve) => {
      const req = db.transaction(name, 'readonly').objectStore(name).get(key)
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
      req.onerror = () => {
        Logger('ERROR', `Ошибка чтения DB (${name})`, key)
        resolve(null)
      }
    })
  } catch (e) {
    Logger('ERROR', `Сбой dbGet (${name})`, e)
    return null
  }
}

/** Пишет (put — вставка или перезапись) запись в object store. */
export async function dbSet(store: CacheStoreName, data: CacheRecord): Promise<void> {
  const name = physicalStore(store)
  try {
    const db = await openDB()
    if (!db) return

    return await new Promise<void>((resolve) => {
      const tx = db.transaction(name, 'readwrite')
      tx.objectStore(name).put(data)
      tx.oncomplete = () => {
        Logger('DB', `Запись в кэш ${name} успешна`)
        resolve()
      }
      tx.onerror = (e) => {
        Logger('ERROR', `Ошибка записи DB (${name})`, e)
        resolve()
      }
    })
  } catch (e) {
    Logger('ERROR', `Сбой dbSet (${name})`, e)
  }
}

/**
 * Очищает все сторы кэша. Вызывается из настроек по кнопке.
 *
 * Раньше промис разрешался только по tx.oncomplete, а отказ и прерывание
 * транзакции не обрабатывались вовсе — ожидание висело вечно, кнопка не давала
 * отклика, в журнале пусто. Транзакцию легко потерять: параллельный сканер,
 * фоновый сборщик мусора или перезагрузка страницы в тот же момент.
 *
 * Исключение наружу не бросается намеренно: вызывающая сторона идёт сценарием
 * «очистить и перезагрузиться», а перезагрузка полезна и при частичной очистке.
 */
export async function clearCache(): Promise<void> {
  Logger('INFO', 'Запущен ручной сброс кэша IndexedDB')
  const db = await openDB()
  if (!db) {
    Logger('ERROR', 'Сброс кэша не выполнен: база недоступна')
    return
  }

  return new Promise<void>((resolve) => {
    // Страж однократного завершения: onerror всплывает до onabort, а двойная
    // запись в журнал сбивала бы с толку при разборе жалоб.
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }

    let tx: IDBTransaction
    try {
      tx = db.transaction(['mediaCache', 'malCache', 'franchiseCache'], 'readwrite')
      tx.objectStore('mediaCache').clear()
      tx.objectStore('malCache').clear()
      tx.objectStore('franchiseCache').clear()
    } catch (e) {
      // Открытие транзакции бросает синхронно, например при закрытом соединении
      // после миграции в другой вкладке.
      Logger('ERROR', 'Сброс кэша: не удалось открыть транзакцию', e)
      finish()
      return
    }

    tx.oncomplete = () => {
      Logger('DB', 'Сброс кэша IndexedDB завершён')
      finish()
    }

    tx.onerror = () => {
      Logger('ERROR', 'Сброс кэша: транзакция завершилась ошибкой', tx.error)
      finish()
    }

    tx.onabort = () => {
      Logger('ERROR', 'Сброс кэша: транзакция прервана', tx.error)
      finish()
    }
  })
}

/**
 * Фоновый GC: курсором по mediaCache удаляет записи старше CACHE_TIME.
 * При бессрочном сроке хранения выходит сразу, не обходя базу.
 */
export async function runGarbageCollector(): Promise<void> {
  // Срока жизни у записей нет: чистит только clearCache() из настроек.
  if (!Number.isFinite(CACHE_TIME)) return

  try {
    const db = await openDB()
    if (!db) return

    const store = db.transaction(['mediaCache'], 'readwrite').objectStore('mediaCache')
    const req = store.openCursor()
    let deletedCount = 0

    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        const record = cursor.value as { ts?: number }
        if (typeof record.ts === 'number' && Date.now() - record.ts > CACHE_TIME) {
          cursor.delete()
          deletedCount++
        }
        cursor.continue()
      } else if (deletedCount > 0) {
        Logger('DB', `Garbage Collector очистил ${deletedCount} устаревших записей из кэша`)
      }
    }
  } catch (e) {
    Logger('ERROR', 'Ошибка Garbage Collector', e)
  }
}

/** Снимок БД для инспектора: количество записей по типам ключей и оценка размера. */
export async function getDbStats(): Promise<DbStats | DbStatsError> {
  try {
    const db = await openDB()
    if (!db) return { error: 'БД недоступна' }

    // Размер памяти — до открытия транзакции, иначе она успеет закрыться на await.
    let estimatedSize = 'Неизвестно'
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate()
        estimatedSize = ((est.usage ?? 0) / 1024 / 1024).toFixed(2) + ' MB'
      }
    } catch (e) {
      Logger('WARN', 'getDbStats: navigator.storage.estimate() недоступен', e)
    }

    return await new Promise<DbStats | DbStatsError>((resolve) => {
      const tx = db.transaction(['mediaCache', 'malCache', 'franchiseCache'], 'readonly')
      const mediaStore = tx.objectStore('mediaCache')
      const malStore = tx.objectStore('malCache')
      const franchiseStore = tx.objectStore('franchiseCache')

      const stats: DbStats = {
        media: 0,
        characters: 0,
        staff: 0,
        themes: 0,
        russianTitles: 0,
        looks: 0,
        ratings: 0,
        malMappings: 0,
        franchises: 0,
        other: 0,
        totalCacheRecords: 0,
        estimatedSize,
      }

      const malReq = malStore.count()
      malReq.onsuccess = () => {
        stats.malMappings = malReq.result
      }

      const franchiseReq = franchiseStore.count()
      franchiseReq.onsuccess = () => {
        stats.franchises = franchiseReq.result
      }

      const mediaReq = mediaStore.getAllKeys()
      mediaReq.onsuccess = () => {
        const keys = mediaReq.result
        stats.totalCacheRecords = keys.length

        for (const key of keys) {
          if (typeof key !== 'string') continue

          const known = KEY_PREFIXES.find(([prefix]) => key.startsWith(prefix))
          if (known) stats[known[1]]++
          // Незнакомый префикс не пропадает: остаток и есть признак того,
          // что склад пополнился, а таблица выше про это не знает.
          else stats.other++
        }
      }

      tx.oncomplete = () => resolve(stats)
      tx.onerror = () => resolve({ error: 'Ошибка чтения метрик БД' })
    })
  } catch (e) {
    Logger('ERROR', 'Сбой getDbStats', e)
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Поле статистики, которое наполняется по префиксу ключа. Отдельный тип,
 * а не строки в таблице: опечатка в имени поля станет ошибкой сборки,
 * а не вечным нулём на экране.
 */
type PrefixField =
  'media' | 'characters' | 'staff' | 'themes' | 'russianTitles' | 'looks' | 'ratings'

/**
 * Что за запись лежит под префиксом ключа. Таблица, а не череда else if:
 * счётчик тем уже показывал ноль при живом кэше, потому что ветка искала
 * THEMES_ вместо THEMES2_, а для RU3_, LOOK2_ и RATE1_ ветки не было вовсе.
 *
 * Порядок важен только внутри одного вида: сравнение идёт первым совпадением.
 */
const KEY_PREFIXES: ReadonlyArray<readonly [string, PrefixField]> = [
  ['MED2_', 'media'],
  ['FULL_', 'media'],
  ['CHR2_', 'characters'],
  ['STF3_', 'staff'],
  ['THEMES2_', 'themes'],
  ['RU3_', 'russianTitles'],
  // Имя тайтла лежит отдельной записью от карточки, но для инспектора это один
  // и тот же вид кэша: два префикса намеренно ведут в одно поле.
  ['NAME1_', 'russianTitles'],
  ['LOOK2_', 'looks'],
  ['RATE1_', 'ratings'],
]
