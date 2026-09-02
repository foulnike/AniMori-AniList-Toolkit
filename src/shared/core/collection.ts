// Хозяин коллекции: единственный источник правды о списке пользователя.
// Записи держатся в памяти, на диск уходят снимком из snapshot.ts.
// Картинки и русские названия сюда не попадают: это забота склада в db.ts.
//
// Список односторонний: правки живут только здесь и на сервер не уезжают.
// AniList служит источником переноса, а не хранилищем, поэтому очереди
// правок и отправщика больше нет, а перенос по умолчанию сливает список,
// а не замещает его.

import { fetchUserList, fetchViewer, type RawListEntry } from '../api/anilist-list'
import { Logger } from '../utils/logger'
import {
  emptySnapshot,
  markSnapshotDirty,
  ownSnapshot,
  readSnapshot,
  saveSnapshotNow,
  SNAPSHOT_VERSION,
  type SnapshotEntry,
  type UserSnapshot,
} from './snapshot'

/**
 * Что правится в записи. Список закрыт перечислением: правка незнакомого
 * вида молча не сделала бы ничего, а такую ошибку лучше поймать сборкой.
 *
 * Прочитанных томов среди видов нет: они ушли вместе с мангой.
 */
export type EditKind =
  | 'status'
  | 'score'
  | 'progress'
  | 'repeat'
  | 'startedAt'
  | 'completedAt'
  | 'notes'
  | 'remove'

/**
 * Облик тайтла: то, что запись о себе знать не может, а показ требует.
 * Экран берёт его из карточки или плитки и передаёт вместе с правкой,
 * иначе запись, добавленная до переноса списка, навсегда осталась бы
 * «Тайтл #id»: латинские имена приносил только ответ сервера.
 */
export type EntryLook = {
  romaji: string | null
  english: string | null
  isAdult: boolean
}

/**
 * Как переносить список с сервера.
 *
 * merge — ответ сервера сливается с памятью по времени правки. У нас правда
 * о том, что человек менял здесь, у сервера — о том, что он менял на сайте.
 *
 * replace — память вычищается целиком. Нужен для переезда на чистое место
 * и обязателен при смене счёта: сливать чужой список со своим нельзя.
 */
export type PullMode = 'merge' | 'replace'

/**
 * Итог переноса. Числа раздельные не для красоты: «перенесено N записей»
 * не отвечает на единственный важный вопрос — не потерялось ли что-то
 * из набранного здесь.
 */
export interface PullResult {
  /** Каким способом перенос в итоге прошёл. Смена счёта его меняет сама. */
  mode: PullMode
  /** Записей в памяти после переноса. */
  total: number
  /** Приехало с сервера впервые. */
  added: number
  /** Ответ сервера оказался свежее нашего и заменил запись. */
  updated: number
  /** Наша правка оказалась свежее ответа и осталась на месте. */
  kept: number
  /** Записей, которых на сервере нет вовсе: добавленные здесь. */
  onlyHere: number
}

/**
 * Записи по номеру тайтла. Словарь, а не массив: карточка и каждая правка
 * ищут запись по номеру, а обход тысяч записей на приставке виден глазом.
 */
const entries = new Map<number, SnapshotEntry>()

/**
 * Чей список сейчас в памяти. null — список местный: либо переноса не было
 * вовсе, либо счёт отвязали. Записи при этом равно наши и равно живые.
 */
let ownerUserId: number | null = null

/** Поднят ли снимок с диска. Повторный подъём затёр бы свежие правки. */
let loaded = false

/** Общее ожидание первого подъёма: экраны не получают временно пустую карту. */
let initInFlight: Promise<number> | null = null

/** Идущий перенос: второй вызов ждёт первый, а не шлёт свой запрос. */
let refreshInFlight: Promise<PullResult> | null = null

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
 *
 * Вида тайтла и прочитанных томов здесь больше нет: снимок шестой версии
 * их не хранит, а у сервера спрашивается только аниме.
 */
function fromServer(raw: RawListEntry): SnapshotEntry {
  return {
    mediaId: raw.mediaId,
    malId: raw.malId,
    status: raw.status,
    score10: raw.score,
    progress: raw.progress,
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
 * в список, которого на сервере ещё нет. Поля перечислены явно: новое
 * поле снимка должно ломать сборку здесь, а не живой запуск.
 */
function blankEntry(mediaId: number, when: number, look?: EntryLook): SnapshotEntry {
  return {
    mediaId,
    malId: null,
    status: null,
    score10: 0,
    progress: 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
    updatedAt: when,
    isAdult: look?.isAdult ?? false,
    romaji: look?.romaji ?? null,
    english: look?.english ?? null,
  }
}

/**
 * Поднимает снимок с диска и берёт его под себя. Зовётся один раз на старте,
 * до первого обращения к сети: список виден сразу, даже без сети вовсе.
 *
 * Идемпотентна и дешёва после первого раза, поэтому её вправе звать любое
 * действие, которому нужен живой список и запись снимка.
 */
export async function initCollection(): Promise<number> {
  if (loaded) return entries.size
  if (initInFlight) return initInFlight

  initInFlight = (async () => {
    const snapshot = await readSnapshot()
    entries.clear()
    ownerUserId = snapshot.userId
    for (const entry of snapshot.entries) entries.set(entry.mediaId, entry)

    ownSnapshot(collectSnapshot)
    loaded = true
    Logger('DB', `Коллекция поднята из снимка: записей ${entries.size}`)

    return entries.size
  })()

  try {
    return await initInFlight
  } finally {
    initInFlight = null
  }
}

/**
 * Сливает ответ сервера с памятью. Спор решается временем правки: у записи
 * из ответа метка сервера, у поправленной здесь — наша, поставленная
 * в editEntry.
 *
 * При равных метках побеждает сервер, а не память: его запись не хуже нашей,
 * а лишняя «своя» победа скрыла бы правку, сделанную на сайте.
 *
 * Записи, которых в ответе нет, остаются на месте. Отличить добавленную
 * здесь от удалённой на сайте нечем, и выбор в пользу сохранности:
 * лишняя запись видна и убирается руками, потерянная — нет.
 */
function mergeFromServer(raw: RawListEntry[]): PullResult {
  let added = 0
  let updated = 0
  let kept = 0
  const seen = new Set<number>()

  for (const item of raw) {
    seen.add(item.mediaId)
    const fresh = fromServer(item)
    const mine = entries.get(item.mediaId)

    if (!mine) {
      entries.set(item.mediaId, fresh)
      added++
      continue
    }

    if (mine.updatedAt > fresh.updatedAt) {
      // Спор о полях записи наша правка выиграла, но пустоты дополнить можно:
      // номер MAL и латинские имена запись, добавленная здесь, о себе не знает,
      // а без номера MAL её потом нечем выгрузить в XML.
      if (mine.malId === null) mine.malId = fresh.malId
      if (mine.romaji === null) mine.romaji = fresh.romaji
      if (mine.english === null) mine.english = fresh.english
      kept++
      continue
    }

    entries.set(item.mediaId, fresh)
    updated++
  }

  let onlyHere = 0
  for (const mediaId of entries.keys()) if (!seen.has(mediaId)) onlyHere++

  return { mode: 'merge', total: entries.size, added, updated, kept, onlyHere }
}

/**
 * Замещает память ответом сервера целиком. Заодно из памяти уходят записи
 * манги из старых снимков: читать их некому, а в числах у закладок
 * они врали бы до первого ручного удаления.
 */
function replaceFromServer(raw: RawListEntry[]): PullResult {
  entries.clear()
  for (const item of raw) entries.set(item.mediaId, fromServer(item))

  return {
    mode: 'replace',
    total: entries.size,
    added: entries.size,
    updated: 0,
    kept: 0,
    onlyHere: 0,
  }
}

/**
 * Переносит список с сервера в память. По умолчанию слиянием: правки живут
 * только здесь, и замена целиком стёрла бы всё, что человек тут набрал.
 *
 * Зовётся только по прямому действию человека, никогда сам по открытию
 * экрана: даже слияние двигает записи, а неожидаемое движение списка
 * читается как поломка.
 *
 * Без входа переносить неоткуда, и это отказ, а не тихий ноль: кнопка,
 * которая ничего не делает и ничего не говорит, выглядит поломкой.
 *
 * Идущий перенос переиспользуется как есть: второе нажатие получит итог
 * первого, даже если способ просило другой. Два переноса подряд по разным
 * правилам всё равно дали бы кашу, а не сумму.
 */
export async function refreshFromServer(mode: PullMode = 'merge'): Promise<PullResult> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    // Снимок под собой обязателен до переноса: иначе запись снимка ниже
    // окажется молчаливым ничегонеделанием без хозяина.
    await initCollection()

    const viewer = await fetchViewer()
    if (!viewer) {
      throw new Error('Вход в AniList не выполнен: переносить список неоткуда')
    }

    // Сначала ответ, и только потом память: отказ сети иначе оставит
    // пустой список вместо прежнего целого.
    const raw = await fetchUserList(viewer.id)

    // Чужой список сливать с нашим нельзя: метки времени двух разных людей
    // между собой ничего не значат. Смена счёта всегда замещает.
    let use = mode
    if (ownerUserId !== null && ownerUserId !== viewer.id) {
      use = 'replace'
      Logger('WARN', `Коллекция: вход сменился (${ownerUserId} → ${viewer.id}), память замещена`)
    }

    ownerUserId = viewer.id

    const done = use === 'replace' ? replaceFromServer(raw) : mergeFromServer(raw)

    // Перенос бывает редко и двигает список целиком, так что дубль в файл
    // здесь уместен.
    await saveSnapshotNow({ backup: true })
    Logger(
      'DB',
      `Коллекция перенесена с сервера (${done.mode}): всего ${done.total}, ` +
        `новых ${done.added}, обновлено ${done.updated}, ` +
        `оставлено своих ${done.kept}, только здесь ${done.onlyHere}`,
    )

    return done
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
 * Перебор записей без копии массива. Отборы, сортировки и выгрузка в XML
 * строятся над ним; здесь только доступ к содержимому.
 */
export function eachEntry(): IterableIterator<SnapshotEntry> {
  return entries.values()
}

/**
 * Меняет запись в памяти и планирует запись снимка.
 * Правки на сервер не уезжают: список односторонний.
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
 * Единственная точка правки записи для экранов. Работает синхронно и всегда:
 * входа для неё не нужно, сети тоже — правка ложится в память, а снимок
 * уходит на диск отложенной записью.
 *
 * Пустая строка в дате и комментарии значит «стереть»: отдельного вида
 * правки для очистки нет.
 *
 * @param look Облик тайтла, если экран его знает. Новой записи он даёт имя,
 * известной — заполняет пустоты. Занятые поля не трогаются: имя из ответа
 * сервера точнее имени с плитки, с которой пришла правка.
 */
export function editEntry(
  mediaId: number,
  kind: EditKind,
  value: string | number | null,
  look?: EntryLook,
): void {
  if (!Number.isFinite(mediaId) || mediaId <= 0) return

  if (kind === 'remove') {
    dropEntry(mediaId)
    return
  }

  const known = entries.get(mediaId)
  const entry: SnapshotEntry = known ? { ...known } : blankEntry(mediaId, Date.now(), look)

  if (known && look) {
    if (entry.romaji === null) entry.romaji = look.romaji
    if (entry.english === null) entry.english = look.english
  }

  if (kind === 'status' && typeof value === 'string') entry.status = value
  if (kind === 'score' && typeof value === 'number') entry.score10 = value
  if (kind === 'progress' && typeof value === 'number') entry.progress = value
  if (kind === 'repeat' && typeof value === 'number') entry.repeat = value
  if (kind === 'startedAt' && typeof value === 'string') {
    entry.startedAt = value === '' ? null : value
  }
  if (kind === 'completedAt' && typeof value === 'string') {
    entry.completedAt = value === '' ? null : value
  }
  if (kind === 'notes' && typeof value === 'string') {
    entry.notes = value === '' ? null : value
  }

  // Метка правки — наши часы. По ней слияние решает спор с ответом сервера,
  // так что ставить её обязательно, даже когда значение не изменилось.
  entry.updatedAt = Date.now()
  putEntry(entry)
}

/**
 * Отвязывает список от счёта AniList, оставляя записи на месте (пункт 3.16).
 * Возвращает число оставшихся записей: экрану есть что сказать человеку.
 *
 * Выход из счёта и удаление списка — разные желания. Список ведётся и без
 * входа, так что отвязка отнимает только связь с сайтом, а не данные.
 *
 * Снимок поднимается первым делом, и это не предосторожность, а условие
 * работы: запись снимка без хозяина молча ничего не делает, а хозяина
 * назначает только подъём. Без этого отвязка с экрана настроек меняла бы
 * одну память, на диске оставался бы прежний хозяин, и следующий перенос
 * считал бы список чужим и замещал его целиком.
 */
export async function unlinkCollection(): Promise<number> {
  await initCollection()

  ownerUserId = null
  await saveSnapshotNow({ backup: true })

  Logger('DB', `Коллекция отвязана от счёта: записей ${entries.size}`)

  return entries.size
}

/**
 * Забывает список целиком: удаление данных по прямой просьбе хозяина.
 * Выход из счёта сюда не ведёт и вести не должен: для него есть unlinkCollection.
 *
 * Подъём первым делом по той же причине, что и в отвязке: без хозяина
 * запись снимка молча не случится, и удалённый список вернётся при запуске.
 */
export async function forgetCollection(): Promise<void> {
  await initCollection()

  entries.clear()
  ownerUserId = null
  await saveSnapshotNow({ backup: true })
  Logger('DB', 'Коллекция забыта: снимок очищен')
}

/** Пустой снимок для проверок и первого запуска без входа. */
export function blankSnapshot(): UserSnapshot {
  return emptySnapshot()
}
