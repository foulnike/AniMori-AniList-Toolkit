// Снимок данных пользователя и очередь правок: вторая половина слоя хранения.
// Склад ответов сети живёт в db.ts и расходен; здесь то, что потерять нельзя.
// Базы приложения нет: источник правды — массив в памяти, на диске одна запись.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'

/** Ключи хранилища моста. Приставка AM_ занята только нашими записями. */
const SNAPSHOT_KEY = 'AM_SNAPSHOT'
const QUEUE_KEY = 'AM_EDIT_QUEUE'

/**
 * Имя файла дубля снимка (пункт 2.5.2). Путь выбирает оболочка:
 * список разрешённых имён живёт в src-tauri/src/files.rs.
 */
const SNAPSHOT_FILE = 'animori-snapshot.json'

/**
 * Номер версии снимка. Поднимать при любом изменении формы SnapshotEntry.
 * Миграций схемы здесь нет сознательно: старый снимок дешевле выбросить.
 *
 * 2 — добавлена метка взрослого.
 * 3 — добавлены названия тайтла.
 */
export const SNAPSHOT_VERSION = 3

/**
 * Задержка записи снимка: прокрутка списка меняет его десятками правок в секунду.
 * Запись на каждую правку на приставке съедает больше, чем сама отрисовка.
 */
const SNAPSHOT_DELAY_MS = 2000

/**
 * Потолок очереди правок. Без него сеть, лежащая сутки, накопит очередь
 * размером со всю коллекцию, а пишется она целиком на каждую правку.
 */
const QUEUE_LIMIT = 500

/** Что именно правили в записи списка. Удаление — тоже правка, её нельзя терять. */
export type EditKind = 'status' | 'score' | 'progress' | 'remove'

/**
 * Неотправленная правка. `id` свой, а не серверный: отметить принятой
 * надо именно ту запись, которую отправляли, а не похожую по полям.
 */
export interface PendingEdit {
  id: string
  /** AniList ID тайтла, а не записи списка: запись ещё может не существовать. */
  mediaId: number
  kind: EditKind
  /** Значение правки; для 'remove' всегда null. */
  value: string | number | null
  createdAt: number
  /** Сколько раз пытались отправить. Решает отправщик, хранится здесь. */
  attempts: number
}

/** Запись списка в снимке. Картинки сюда не кладём: их даёт склад. */
export interface SnapshotEntry {
  mediaId: number
  status: string | null
  /** Оценка 0..10, как в остальном ядре. */
  score10: number
  progress: number
  /** Когда запись меняли у нас или на сервере. */
  updatedAt: number
  /**
   * Взрослый тайтл. Метка хранится рядом со записью, а не спрашивается при отрисовке:
   * отбор идёт по всему списку сразу и без сети (пункт 3.8).
   */
  isAdult: boolean
  /**
   * Название латиницей и английское. Лежат в снимке, а не на складе:
   * склад расходен и протухает, а читаемость своего списка терять нельзя.
   * Русское название здесь не хранится: оно зависит от настроек источников
   * и живёт на складе вместе с описанием.
   */
  romaji: string | null
  english: string | null
}

/**
 * Снимок целиком. Пишется и читается одной записью: атомарность вместо транзакций.
 * `userId` хранится рядом, иначе после смены входа покажем чужой список.
 */
export interface UserSnapshot {
  version: number
  userId: number | null
  savedAt: number
  entries: SnapshotEntry[]
}

/** Поставщик снимка: собирает его из памяти в момент записи, а не заранее. */
type SnapshotSource = () => UserSnapshot

/** Единственный хозяин снимка. Второй пишущий гарантированно затрёт чужие правки. */
let source: SnapshotSource | null = null

/** Таймер отложенной записи снимка. */
let saveTimer: number | undefined

/** Идущая запись: вторая встаёт в очередь за первой, а не перегоняет её. */
let writeChain: Promise<void> = Promise.resolve()

/** Повешены ли точки сохранения. Повторные подписки дали бы двойную запись. */
let hooksInstalled = false

/** Пустой снимок. Отдаётся вместо null: вызывающий код не проверяет каждый раз. */
export function emptySnapshot(): UserSnapshot {
  return { version: SNAPSHOT_VERSION, userId: null, savedAt: 0, entries: [] }
}

/** Годна ли запись списка: битые записи отбрасываются поштучно, а не всем снимком. */
function isEntry(value: unknown): value is SnapshotEntry {
  if (typeof value !== 'object' || value === null) return false

  const entry = value as Partial<SnapshotEntry>
  return typeof entry.mediaId === 'number' && Number.isFinite(entry.mediaId)
}

/** Строка или «нет значения». Пустая строка равносильна отсутствию названия. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Приводит прочитанную запись к нынешней форме. Версия уже совпала, но файл дубля
 * мог быть правлен руками: метка взрослого без значения означает «нет».
 */
function normalizeEntry(entry: SnapshotEntry): SnapshotEntry {
  return {
    mediaId: entry.mediaId,
    status: typeof entry.status === 'string' ? entry.status : null,
    score10: typeof entry.score10 === 'number' ? entry.score10 : 0,
    progress: typeof entry.progress === 'number' ? entry.progress : 0,
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
    isAdult: entry.isAdult === true,
    romaji: text(entry.romaji),
    english: text(entry.english),
  }
}

/**
 * Разбирает прочитанное в снимок. Стороннее и битое отбрасывается в пустой:
 * коллекция восстановима одним запросом, а половинчатый список вводит в заблуждение.
 */
function parseSnapshot(raw: unknown): UserSnapshot {
  if (typeof raw !== 'object' || raw === null) return emptySnapshot()

  const candidate = raw as Partial<UserSnapshot>
  if (candidate.version !== SNAPSHOT_VERSION) {
    if (typeof candidate.version === 'number') {
      Logger(
        'WARN',
        `Снимок версии ${candidate.version} не подходит к ${SNAPSHOT_VERSION} — читаем с нуля`,
      )
    }
    return emptySnapshot()
  }

  if (!Array.isArray(candidate.entries)) return emptySnapshot()

  const entries = candidate.entries.filter(isEntry).map(normalizeEntry)
  if (entries.length !== candidate.entries.length) {
    Logger('WARN', `Снимок: отброшено ${candidate.entries.length - entries.length} битых записей`)
  }

  return {
    version: SNAPSHOT_VERSION,
    userId: typeof candidate.userId === 'number' ? candidate.userId : null,
    savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0,
    entries,
  }
}

/**
 * Поднимает снимок из файла — страховка на случай почищенного хранилища.
 * Ничего не бросает: отсутствие файла — штатный исход, а не сбой.
 */
async function readSnapshotFile(): Promise<UserSnapshot | null> {
  if (!Bridge.files.available) return null

  const raw = await Bridge.files.read(SNAPSHOT_FILE)
  if (!raw) return null

  try {
    const snapshot = parseSnapshot(JSON.parse(raw))
    if (snapshot.entries.length === 0) return null
    return snapshot
  } catch (e) {
    Logger('WARN', 'Снимок: дубль в файле не разобран', e)
    return null
  }
}

/**
 * Кладёт второй экземпляр снимка в файл. Ошибки только в журнал:
 * без дубля программа работает, а прерванная запись снимка — потеря данных.
 */
async function writeSnapshotFile(payload: UserSnapshot): Promise<void> {
  if (!Bridge.files.available) return

  const ok = await Bridge.files.write(SNAPSHOT_FILE, JSON.stringify(payload))
  if (!ok) Logger('WARN', 'Снимок: дубль в файл не записан')
}

/**
 * Читает снимок с диска. Никогда не отклоняется: пустой список лучше мёртвого запуска.
 * Записи старой версии не поднимаются, а забываются — см. SNAPSHOT_VERSION.
 */
export async function readSnapshot(): Promise<UserSnapshot> {
  try {
    const raw = await Bridge.storage.get<unknown>(SNAPSHOT_KEY)
    const snapshot = parseSnapshot(raw)

    // Пустое хранилище при живом дубле — почистили данные окна со стороны.
    if (snapshot.entries.length === 0) {
      const backup = await readSnapshotFile()
      if (backup) {
        Logger('DB', `Снимок поднят из файла: записей ${backup.entries.length}`)
        // Сразу возвращаем в хранилище: иначе подъём повторится каждый запуск.
        try {
          await Bridge.storage.set(SNAPSHOT_KEY, backup)
        } catch (e) {
          Logger('WARN', 'Снимок: поднятый дубль не вернулся в хранилище', e)
        }
        return backup
      }
    }

    Logger('DB', `Снимок прочитан: записей ${snapshot.entries.length}`)
    return snapshot
  } catch (e) {
    Logger('ERROR', 'Снимок: ошибка чтения', e)
    return emptySnapshot()
  }
}

/**
 * Назначает хозяина снимка и вешает точки сохранения. Вызывается один раз на старте.
 * Повторный вызов игнорируется: два пишущих в одну запись теряют правки друг друга.
 */
export function ownSnapshot(next: SnapshotSource): void {
  if (source) {
    Logger('ERROR', 'Снимок: хозяин уже назначен, второй пишущий отклонён')
    return
  }

  source = next
  installSaveHooks()
}

/**
 * Планирует запись снимка. Зовётся на любое изменение списка в памяти.
 * Серия вызовов даёт одну запись: таймер взводится только свободный.
 *
 * Дубль в файл отложенная запись не делает: файл страхует от чистки
 * данных окна, а хранилище к этому моменту уже записано.
 */
export function markSnapshotDirty(): void {
  if (!source) {
    Logger('WARN', 'Снимок: изменение без хозяина — записывать нечего')
    return
  }

  if (saveTimer !== undefined) return

  saveTimer = window.setTimeout(() => {
    saveTimer = undefined
    void saveSnapshotNow()
  }, SNAPSHOT_DELAY_MS)
}

/**
 * Пишет снимок немедленно и дожидается диска. Не отклоняется.
 * Отложенная запись отменяется: иначе после ухода в фон будет вторая, пустая.
 *
 * @param options.backup Писать ли второй экземпляр в файл. По умолчанию нет:
 * дубль нужен на точках сохранения и при полной замене списка, а не на каждую
 * правку оценки — иначе прокрутка со правками бьёт в диск дважды.
 */
export async function saveSnapshotNow(options?: { backup?: boolean }): Promise<void> {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer)
    saveTimer = undefined
  }

  const collect = source
  if (!collect) return

  const withBackup = options?.backup === true

  // Сборка снимка синхронная: иначе между сбором и записью влезет правка.
  let payload: UserSnapshot
  try {
    payload = collect()
    payload.version = SNAPSHOT_VERSION
    payload.savedAt = Date.now()
  } catch (e) {
    Logger('ERROR', 'Снимок: хозяин не смог собрать данные', e)
    return
  }

  writeChain = writeChain.then(async () => {
    try {
      await Bridge.storage.set(SNAPSHOT_KEY, payload)
      Logger('DB', `Снимок записан: записей ${payload.entries.length}`)
    } catch (e) {
      Logger('ERROR', 'Снимок: ошибка записи', e)
    }

    // Дубль после основной записи и внутри того же звена: порядок версий важен.
    if (withBackup) await writeSnapshotFile(payload)
  })

  return writeChain
}

/**
 * Две точки сохранения: уход в фон и закрытие окна. Только они пишут дубль в файл.
 * На Android процесс гасят без закрытия, так что уход в фон там единственный шанс.
 */
function installSaveHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveSnapshotNow({ backup: true })
  })

  // pagehide, а не beforeunload: в WebView и на мобилках второй часто не приходит вовсе.
  window.addEventListener('pagehide', () => {
    void saveSnapshotNow({ backup: true })
  })
}

/** Годна ли запись очереди. Битые правки отправлять нельзя и держать бессмысленно. */
function isEdit(value: unknown): value is PendingEdit {
  if (typeof value !== 'object' || value === null) return false

  const edit = value as Partial<PendingEdit>
  return typeof edit.id === 'string' && typeof edit.mediaId === 'number' && !!edit.kind
}

/** Читает очередь правок. Порядок соблюдается: две правки одного тайтла не коммутируют. */
export async function readEditQueue(): Promise<PendingEdit[]> {
  try {
    const raw = await Bridge.storage.get<unknown>(QUEUE_KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter(isEdit)
  } catch (e) {
    Logger('ERROR', 'Очередь правок: ошибка чтения', e)
    return []
  }
}

/**
 * Перезаписывает очередь целиком и дожидается диска.
 * Очередь крошечная, поэтому частичная запись не нужна и только мешала бы.
 */
async function writeQueue(edits: PendingEdit[]): Promise<void> {
  writeChain = writeChain.then(async () => {
    try {
      await Bridge.storage.set(QUEUE_KEY, edits)
      await Bridge.storage.flush()
    } catch (e) {
      Logger('ERROR', 'Очередь правок: ошибка записи', e)
    }
  })

  return writeChain
}

/**
 * Кладёт правку в очередь и возвращает её в готовом виде. Запись немедленная.
 * Задержки здесь нет сознательно: это единственные данные, которые негде взять заново.
 */
export async function enqueueEdit(
  mediaId: number,
  kind: EditKind,
  value: string | number | null,
): Promise<PendingEdit> {
  const edit: PendingEdit = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    mediaId,
    kind,
    value: kind === 'remove' ? null : value,
    createdAt: Date.now(),
    attempts: 0,
  }

  const queue = await readEditQueue()

  // Переполнение решается в пользу свежих правок: старые уже перекрыты новыми.
  if (queue.length >= QUEUE_LIMIT) {
    const dropped = queue.length - QUEUE_LIMIT + 1
    queue.splice(0, dropped)
    Logger('WARN', `Очередь правок переполнена: отброшено старых правок ${dropped}`)
  }

  queue.push(edit)
  await writeQueue(queue)
  Logger('DB', `Правка в очереди: ${kind} для ${mediaId}, всего ${queue.length}`)

  return edit
}

/** Убирает принятую сервером правку. Неизвестный идентификатор ошибкой не считается. */
export async function markEditAccepted(id: string): Promise<void> {
  const queue = await readEditQueue()
  const left = queue.filter((edit) => edit.id !== id)
  if (left.length === queue.length) return

  await writeQueue(left)
}

/**
 * Считает неудачную попытку отправки и возвращает новое число попыток.
 * Сама правка остаётся в очереди: бросать её или нет, решает отправщик.
 */
export async function bumpEditAttempt(id: string): Promise<number> {
  const queue = await readEditQueue()
  const edit = queue.find((item) => item.id === id)
  if (!edit) return 0

  edit.attempts++
  await writeQueue(queue)

  return edit.attempts
}
