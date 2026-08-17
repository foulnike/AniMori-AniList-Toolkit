// Хозяин коллекции: единственный источник правды о списке пользователя.
// Записи держатся в памяти, на диск уходят снимком из snapshot.ts.
// Картинки и русские названия сюда не попадают: это забота склада в db.ts.

import { fetchUserList, fetchViewer, type RawListEntry } from '../api/anilist-list'
import { Logger } from '../utils/logger'
import {
  clearEditQueue,
  emptySnapshot,
  markSnapshotDirty,
  ownSnapshot,
  readEditQueue,
  readSnapshot,
  saveSnapshotNow,
  SNAPSHOT_VERSION,
  type PendingEdit,
  type SnapshotEntry,
  type UserSnapshot,
} from './snapshot'
import type { MediaType } from './types'

/**
 * Записи по номеру тайтла. Словарь, а не массив: карточка и каждая правка
 * ищут запись по номеру, а обход тысяч записей на приставке виден глазом.
 *
 * Аниме и манга лежат в одной карте: номера AniList из общего пространства
 * и столкнуться не могут, а разделяют их экраны отбором по типу.
 */
const entries = new Map<number, SnapshotEntry>()

/**
 * Чей список сейчас в памяти. null — список местный: либо входа не было
 * вовсе, либо счёт отвязали. Записи при этом равно наши и равно живые.
 */
let ownerUserId: number | null = null

/** Поднят ли снимок с диска. Повторный подъём затёр бы свежие правки. */
let loaded = false

/** Идущее обновление с сервера: второй вызов ждёт первый, а не шлёт свой запрос. */
let refreshInFlight: Promise<number> | null = null

/**
 * Какие типы тянем по умолчанию. Оба сразу: половинчатый список хуже
 * одного лишнего запроса в минуту, а чтение манги ведут и без нашего плеера.
 */
const ALL_TYPES: readonly MediaType[] = ['ANIME', 'MANGA']

/** Собирает снимок из памяти. Синхронно: хранилище ждёт готовый слепок. */
function collectSnapshot(): UserSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    userId: ownerUserId,
    savedAt: Date.now(),
    entries: Array.from(entries.values()),
  }
}

/**
 * Запись списка из ответа сервера в виде, пригодном для снимка.
 * Тип приходит снаружи: запрос шёл по одному типу, и это надёжнее,
 * чем вычитывать его из каждой записи ответа.
 */
function fromServer(raw: RawListEntry, type: MediaType): SnapshotEntry {
  return {
    mediaId: raw.mediaId,
    type,
    status: raw.status,
    score10: raw.score,
    progress: raw.progress,
    volumes: raw.volumes,
    repeat: raw.repeat,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    notes: raw.notes,
    updatedAt: raw.updatedAt,
    isAdult: raw.isAdult,
    romaji: raw.romaji,
    english: raw.english,
  }
}

/**
 * Пустая запись для правки неизвестного тайтла: так выглядит добавление
 * в список, которое сервер ещё не видел. Поля перечислены явно: новое
 * поле снимка должно ломать сборку здесь, а не живой запуск.
 */
function blankEntry(mediaId: number, when: number): SnapshotEntry {
  return {
    mediaId,
    // Правка не знает о тайтле ничего кроме номера; ответ сервера поля поправит.
    // Аниме выбрано подставкой сознательно: таких записей подавляющее большинство.
    type: 'ANIME',
    status: null,
    score10: 0,
    progress: 0,
    volumes: 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
    updatedAt: when,
    isAdult: false,
    romaji: null,
    english: null,
  }
}

/**
 * Накатывает одну правку на память. Правка неизвестного тайтла создаёт запись:
 * так выглядит добавление в список, которое сервер ещё не видел.
 *
 * Пустая строка в дате и комментарии значит «стереть»: отдельного вида
 * правки для очистки нет, а везти null через очередь нельзя: так обозначено удаление.
 */
function applyEdit(edit: PendingEdit): void {
  if (edit.kind === 'remove') {
    entries.delete(edit.mediaId)
    return
  }

  const known = entries.get(edit.mediaId)
  const entry: SnapshotEntry = known ?? blankEntry(edit.mediaId, edit.createdAt)

  if (edit.kind === 'status' && typeof edit.value === 'string') entry.status = edit.value
  if (edit.kind === 'score' && typeof edit.value === 'number') entry.score10 = edit.value
  if (edit.kind === 'progress' && typeof edit.value === 'number') entry.progress = edit.value
  if (edit.kind === 'volumes' && typeof edit.value === 'number') entry.volumes = edit.value
  if (edit.kind === 'repeat' && typeof edit.value === 'number') entry.repeat = edit.value
  if (edit.kind === 'startedAt' && typeof edit.value === 'string') {
    entry.startedAt = edit.value === '' ? null : edit.value
  }
  if (edit.kind === 'completedAt' && typeof edit.value === 'string') {
    entry.completedAt = edit.value === '' ? null : edit.value
  }
  if (edit.kind === 'notes' && typeof edit.value === 'string') {
    entry.notes = edit.value === '' ? null : edit.value
  }

  // Наша правка свежее любого ответа: именно её пользователь видел последней.
  entry.updatedAt = Math.max(entry.updatedAt, edit.createdAt)
  entries.set(edit.mediaId, entry)
}

/**
 * Накатывает всю очередь по порядку и возвращает число правок.
 * Порядок важен: две правки одного тайтла не переставляются местами.
 */
async function applyPendingEdits(): Promise<number> {
  const queue = await readEditQueue()
  for (const edit of queue) applyEdit(edit)

  if (queue.length > 0) Logger('DB', `Коллекция: накачено неотправленных правок ${queue.length}`)
  return queue.length
}

/**
 * Поднимает снимок с диска и берёт его под себя. Зовётся один раз на старте,
 * до первого обращения к сети: список виден сразу, даже без сети вовсе.
 */
export async function initCollection(): Promise<number> {
  if (loaded) return entries.size
  loaded = true

  const snapshot = await readSnapshot()
  ownerUserId = snapshot.userId
  for (const entry of snapshot.entries) entries.set(entry.mediaId, entry)

  await applyPendingEdits()
  ownSnapshot(collectSnapshot)
  Logger('DB', `Коллекция поднята из снимка: записей ${entries.size}`)

  return entries.size
}

/**
 * Переносит список с сервера в память с заменой. Ответ сервера — основа,
 * неотправленные правки накатываются сверху, иначе оценка «откатится» на глазах.
 *
 * Это замена, а не слияние: спрошенные типы вычищаются целиком, иначе
 * удалённое на сайте осталось бы у нас навечно. Отсюда правило: зовётся
 * только по прямому действию человека, никогда сам по открытию экрана.
 *
 * Без входа переносить неоткуда, и это отказ, а не тихий ноль: кнопка,
 * которая ничего не делает и ничего не говорит, выглядит поломкой.
 *
 * @param types Какие типы тянуть. По умолчанию оба: экраны разделены, но список один
 * и наполняться он должен целиком, иначе числа у закладок врут до первого визита.
 */
export async function refreshFromServer(
  types: readonly MediaType[] = ALL_TYPES,
): Promise<number> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const viewer = await fetchViewer()
    if (!viewer) {
      throw new Error('Вход в AniList не выполнен: переносить список неоткуда')
    }

    // Смена входа: чужие записи не должны смешаться со своими ни на мгновение.
    if (ownerUserId !== null && ownerUserId !== viewer.id) {
      Logger('WARN', `Коллекция: вход сменился (${ownerUserId} → ${viewer.id}), память очищена`)
      entries.clear()
    }
    ownerUserId = viewer.id

    // Сначала собираем все ответы и только потом трогаем память: отказ
    // на втором типе иначе оставит половину списка вместо прежнего целого.
    const loads: Array<{ type: MediaType; raw: RawListEntry[] }> = []
    for (const type of types) {
      // Последовательно, а не веером: темп AniList общий на весь ключ.
      loads.push({ type, raw: await fetchUserList(viewer.id, type) })
    }

    // Ответ замещает содержимое целиком: иначе удалённое на сайте останется навечно.
    // Чистится только то, что мы только что спросили: обновление одного типа
    // не имеет права выносить второй.
    for (const { type } of loads) {
      for (const [mediaId, entry] of entries) {
        if (entry.type === type) entries.delete(mediaId)
      }
    }

    for (const { type, raw } of loads) {
      for (const item of raw) entries.set(item.mediaId, fromServer(item, type))
    }

    await applyPendingEdits()
    // Полная замена списка бывает редко, так что дубль в файл здесь уместен.
    await saveSnapshotNow({ backup: true })
    Logger('DB', `Коллекция обновлена с сервера: записей ${entries.size}`)

    return entries.size
  })()

  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

/** Запись по номеру тайтла или undefined. Копия не делается сознательно. */
export function getEntry(mediaId: number): SnapshotEntry | undefined {
  return entries.get(mediaId)
}

/** Сколько записей в памяти. Нужно экранам и инспектору настроек. */
export function entryCount(): number {
  return entries.size
}

/** Чей список сейчас в памяти. null значит «местный». */
export function currentUserId(): number | null {
  return ownerUserId
}

/**
 * Перебор записей без копии массива. Отборы и сортировки строятся над ним;
 * сами отборы — шаг 2.6б, здесь только доступ к содержимому.
 */
export function eachEntry(): IterableIterator<SnapshotEntry> {
  return entries.values()
}

/**
 * Меняет запись в памяти и планирует запись снимка.
 * Отправкой на сервер занимается очередь правок, а не этот вызов (пункт 2.7).
 */
export function putEntry(entry: SnapshotEntry): void {
  entries.set(entry.mediaId, entry)
  markSnapshotDirty()
}

/** Убирает запись из памяти. Отсутствие записи ошибкой не считается. */
export function dropEntry(mediaId: number): void {
  if (!entries.delete(mediaId)) return
  markSnapshotDirty()
}

/**
 * Отвязывает список от счёта AniList, оставляя записи на месте (пункт 3.16).
 * Возвращает число оставшихся записей: экрану есть что сказать человеку.
 *
 * Выход из счёта и удаление списка — разные желания. Список ведётся и без
 * входа, так что отвязка отнимает только связь с сайтом, а не данные.
 *
 * Очередь выбрасывается: правки адресованы прежнему счёту и на память уже
 * накачены, а при следующем входе они улетели бы на сайт без спроса.
 *
 * Снимок переписывается сразу и с дублем: иначе на диске останется прежний
 * хозяин, и первый же запуск снова счтёт список чужим.
 */
export async function unlinkCollection(): Promise<number> {
  const dropped = await clearEditQueue()
  ownerUserId = null
  await saveSnapshotNow({ backup: true })

  Logger(
    'DB',
    `Коллекция отвязана от счёта: записей ${entries.size}, выброшено правок ${dropped}`,
  )

  return entries.size
}

/**
 * Забывает список целиком: удаление данных по прямой просьбе хозяина.
 * Выход из счёта сюда не ведёт и вести не должен: для него есть unlinkCollection.
 *
 * Снимок и его дубль переписываются сразу, очередь выбрасывается:
 * правки к удалённым записям воскресили бы часть списка после его удаления.
 */
export async function forgetCollection(): Promise<void> {
  await clearEditQueue()
  entries.clear()
  ownerUserId = null
  await saveSnapshotNow({ backup: true })
  Logger('DB', 'Коллекция забыта: снимок очищен')
}

/** Пустой снимок для проверок и первого запуска без входа. */
export function blankSnapshot(): UserSnapshot {
  return emptySnapshot()
}
