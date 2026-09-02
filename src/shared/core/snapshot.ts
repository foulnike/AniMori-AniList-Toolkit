// Снимок данных пользователя: то из слоя хранения, что потерять нельзя.
// Склад ответов сети живёт в db.ts и расходен: его терять не жалко.
// Базы приложения нет: источник правды — массив в памяти, на диске одна запись.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'
import { serialWrite } from './store-chain'

/** Ключ хранилища моста. Приставка AM_ занята только нашими записями. */
const SNAPSHOT_KEY = 'AM_SNAPSHOT'

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
 * 4 — добавлены тип тайтла и прочитанные тома.
 * 5 — добавлены пересмотры, даты начала и конца, личный комментарий.
 * 6 — тип тайтла и тома больше не хранятся: манги в приложении нет.
 *
 * Поднятие с 5 на 6 и есть весь перенос данных: прежний снимок читается
 * с нуля, а список восстанавливается одним запросом к серверу. Записи
 * манги при этом уходят сами, и вычищать их поштучно не нужно.
 *
 * Поле malId добавлено без поднятия версии. Оно необязательное, и старый
 * снимок от его отсутствия не ломается: номер добудет карта датасета или
 * сеть. Поднятие же обесценило бы снимок целиком, и список пропал бы
 * до первого ручного переноса — слишком дорого за одно добавочное поле.
 */
export const SNAPSHOT_VERSION = 6

/**
 * Задержка записи снимка: прокрутка списка меняет его десятками правок в секунду.
 * Запись на каждую правку на приставке съедает больше, чем сама отрисовка.
 */
const SNAPSHOT_DELAY_MS = 2000

/** Запись списка в снимке. Картинки сюда не кладём: их даёт склад. */
export interface SnapshotEntry {
  mediaId: number
  /**
   * Номер MAL или null. По нему тайтл ищется в датасете названий и у русских
   * источников без отдельной пачки соответствий. Необязательное поле: снимки,
   * записанные до его появления, его не имеют, и тогда номер добирается картой
   * датасета или сетью.
   */
  malId?: number | null
  status: string | null
  /** Оценка 0..10, как в остальном ядре. */
  score10: number
  /** Просмотренных серий. */
  progress: number
  /**
   * Сколько раз пересматривали. Сервер считает их отдельно от закладки:
   * «Пересматриваю» — состояние, а это счётчик завершённых кругов.
   */
  repeat: number
  /**
   * Когда начали и когда закончили, в виде ГГГГ-ММ-ДД. Строка, а не метка
   * времени: это календарный день без часов и пояса, и любой перевод
   * в миллисекунды способен сдвинуть его на сутки в ту или другую сторону.
   */
  startedAt: string | null
  completedAt: string | null
  /** Личный комментарий к записи. Хранится как есть, без обрезки и разметки. */
  notes: string | null
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
 *
 * userId равный null значит «список местный»: так выглядит и первый запуск
 * без входа, и список, отвязанный от счёта по просьбе хозяина.
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
 * Дата вида ГГГГ-ММ-ДД или null. Форма проверяется строго: файл дубля
 * мог быть правлен руками, а поле даты в окне и сам сервер ждут ровно этот вид.
 */
function dateText(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/**
 * Приводит прочитанную запись к нынешней форме. Версия уже совпала, но файл дубля
 * мог быть правлен руками: метка взрослого без значения означает «нет».
 *
 * Поля перечислены явно: что не переписано здесь, то на диск и не попадёт,
 * даже если лежало в прочитанной записи. Так же ушли и поля прежних версий:
 * вид тайтла и прочитанные тома.
 */
function normalizeEntry(entry: SnapshotEntry): SnapshotEntry {
  return {
    mediaId: entry.mediaId,
    malId:
      typeof entry.malId === 'number' && Number.isFinite(entry.malId) && entry.malId > 0
        ? entry.malId
        : null,
    status: typeof entry.status === 'string' ? entry.status : null,
    score10: typeof entry.score10 === 'number' ? entry.score10 : 0,
    progress: typeof entry.progress === 'number' ? entry.progress : 0,
    repeat: typeof entry.repeat === 'number' ? entry.repeat : 0,
    startedAt: dateText(entry.startedAt),
    completedAt: dateText(entry.completedAt),
    notes: text(entry.notes),
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
type ParsedSnapshot = { valid: boolean; snapshot: UserSnapshot }

function parseSnapshot(raw: unknown): ParsedSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, snapshot: emptySnapshot() }
  }

  const candidate = raw as Partial<UserSnapshot>
  if (candidate.version !== SNAPSHOT_VERSION) {
    if (typeof candidate.version === 'number') {
      Logger(
        'WARN',
        `Снимок версии ${candidate.version} не подходит к ${SNAPSHOT_VERSION} — читаем с нуля`,
      )
    }
    return { valid: false, snapshot: emptySnapshot() }
  }

  if (!Array.isArray(candidate.entries)) {
    return { valid: false, snapshot: emptySnapshot() }
  }

  const entries = candidate.entries.filter(isEntry).map(normalizeEntry)
  if (entries.length !== candidate.entries.length) {
    Logger('WARN', `Снимок: отброшено ${candidate.entries.length - entries.length} битых записей`)
  }

  return {
    valid: true,
    snapshot: {
      version: SNAPSHOT_VERSION,
      userId: typeof candidate.userId === 'number' ? candidate.userId : null,
      savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0,
      entries,
    },
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
    const parsed = parseSnapshot(JSON.parse(raw))
    return parsed.valid ? parsed.snapshot : null
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
    const parsed = parseSnapshot(raw)

    // Резерв используется только для отсутствующей или повреждённой записи.
    // Валидный пустой снимок означает осознанное удаление списка.
    if (!parsed.valid) {
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

    Logger('DB', `Снимок прочитан: записей ${parsed.snapshot.entries.length}`)
    return parsed.snapshot
  } catch (e) {
    Logger('ERROR', 'Снимок: ошибка чтения', e)
    const backup = await readSnapshotFile()
    if (backup) {
      Logger('DB', `Снимок поднят из файла после ошибки чтения: записей ${backup.entries.length}`)
      return backup
    }
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

  return serialWrite(async () => {
    try {
      await Bridge.storage.set(SNAPSHOT_KEY, payload)
      Logger('DB', `Снимок записан: записей ${payload.entries.length}`)
    } catch (e) {
      Logger('ERROR', 'Снимок: ошибка записи', e)
    }

    // Дубль после основной записи и внутри того же звена: порядок версий важен.
    if (withBackup) await writeSnapshotFile(payload)
  })
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
