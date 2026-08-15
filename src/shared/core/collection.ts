// Хозяин коллекции: единственный источник правды о списке пользователя.
// Записи держатся в памяти, на диск уходят снимком из snapshot.ts.
// Названия и картинки сюда не попадают: это забота склада в db.ts.

import { fetchUserList, fetchViewer, type RawListEntry } from '../api/anilist-list'
import { Logger } from '../utils/logger'
import {
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
 */
const entries = new Map<number, SnapshotEntry>()

/** Чей список сейчас в памяти. null — вход не выполнен или снимок пуст. */
let ownerUserId: number | null = null

/** Поднят ли снимок с диска. Повторный подъём затёр бы свежие правки. */
let loaded = false

/** Идущее обновление с сервера: второй вызов ждёт первый, а не шлёт свой запрос. */
let refreshInFlight: Promise<number> | null = null

/** Собирает снимок из памяти. Синхронно: хранилище ждёт готовый слепок. */
function collectSnapshot(): UserSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    userId: ownerUserId,
    savedAt: Date.now(),
    entries: Array.from(entries.values()),
  }
}

/** Запись списка из ответа сервера в виде, пригодном для снимка. */
function fromServer(raw: RawListEntry): SnapshotEntry {
  return {
    mediaId: raw.mediaId,
    status: raw.status,
    score10: raw.score,
    progress: raw.progress,
    updatedAt: raw.updatedAt,
  }
}

/**
 * Накатывает одну правку на память. Правка неизвестного тайтла создаёт запись:
 * так выглядит добавление в список, которое сервер ещё не видел.
 */
function applyEdit(edit: PendingEdit): void {
  if (edit.kind === 'remove') {
    entries.delete(edit.mediaId)
    return
  }

  const known = entries.get(edit.mediaId)
  const entry: SnapshotEntry = known ?? {
    mediaId: edit.mediaId,
    status: null,
    score10: 0,
    progress: 0,
    updatedAt: edit.createdAt,
  }

  if (edit.kind === 'status' && typeof edit.value === 'string') entry.status = edit.value
  if (edit.kind === 'score' && typeof edit.value === 'number') entry.score10 = edit.value
  if (edit.kind === 'progress' && typeof edit.value === 'number') entry.progress = edit.value

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
 * Забирает список с сервера и кладёт в память. Ответ сервера — основа,
 * неотправленные правки накатываются сверху, иначе оценка «откатится» на глазах.
 */
export async function refreshFromServer(type: MediaType = 'ANIME'): Promise<number> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const viewer = await fetchViewer()
    if (!viewer) return entries.size

    // Смена входа: чужие записи не должны смешаться со своими ни на мгновение.
    if (ownerUserId !== null && ownerUserId !== viewer.id) {
      Logger('WARN', `Коллекция: вход сменился (${ownerUserId} → ${viewer.id}), память очищена`)
      entries.clear()
    }
    ownerUserId = viewer.id

    const fresh = await fetchUserList(viewer.id, type)

    // Ответ замещает содержимое целиком: иначе удалённое на сайте останется навечно.
    entries.clear()
    for (const raw of fresh) entries.set(raw.mediaId, fromServer(raw))

    await applyPendingEdits()
    await saveSnapshotNow()
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

/** Чей список сейчас в памяти. */
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
 * Забывает список целиком: выход из учётной записи.
 * Снимок перезаписывается сразу: чужой список не должен пережить выход.
 */
export async function forgetCollection(): Promise<void> {
  entries.clear()
  ownerUserId = null
  await saveSnapshotNow()
  Logger('DB', 'Коллекция забыта: снимок очищен')
}

/** Пустой снимок для проверок и первого запуска без входа. */
export function blankSnapshot(): UserSnapshot {
  return emptySnapshot()
}
