// Формат облачной копии списка — этап 6. Здесь только сборка текста копии
// и разбор пришедшего: ни сети, ни диска, ни моста. Провайдер (в приоритете
// Яндекс Диск, за ним Google Drive) получает готовую строку и кладёт её
// у себя как есть, а обратно отдаёт её же.
//
// Модуль чистый нарочно. Облако — единственное место, где список покидает
// эту машину, и цена ошибки здесь не «экран съехал», а чужие или потерянные
// записи. Такое проверяют тестами, а не с чужим диском в руках.
//
// Чего здесь нет и не будет: пропуска входа в AniList. В копию попадают ровно
// те поля, что перечислены в cloudEntry, а любое лишнее поле пришедшего файла
// отбрасывается — тем же приёмом, что у снимка в core/snapshot.ts.

import type { SnapshotEntry } from './snapshot'

/** Папка копии в облаке. Полный путь до неё строит сам провайдер. */
export const CLOUD_DIR = 'AniMori'

/** Имя файла копии. Одно и то же у всех провайдеров и на всех устройствах. */
export const CLOUD_FILE = 'animori-list.json'

/**
 * Версия обёртки копии. Поднимать, когда меняются поля самой обёртки,
 * а не формы записей: за записи отвечает listVersion внутри файла.
 */
export const CLOUD_FORMAT = 1

/**
 * Потолок размера копии. Тот же, что у оболочки на запись файла
 * (src-tauri/src/files.rs и export.rs): отдавать провайдеру то, что своя же
 * оболочка обратно не примет, смысла нет.
 */
const MAX_TEXT_BYTES = 8 * 1024 * 1024

/** Длина метки устройства. Метка нужна человеку, а не программе. */
const MAX_DEVICE = 60

/**
 * Копия целиком. Читается и пишется одним файлом: половина копии хуже,
 * чем её отсутствие, а склеивать куски в чужом хранилище нечем.
 */
export interface CloudFile {
  /** Версия обёртки: CLOUD_FORMAT на момент записи. */
  format: number
  /**
   * Версия формы записей — SNAPSHOT_VERSION той сборки, что писала копию.
   * Копию другой версии не читаем: миграций схемы у снимка нет сознательно,
   * и приложить чужую форму к нынешней означало бы тихо испортить список.
   */
  listVersion: number
  /** Когда копия собрана, в миллисекундах. */
  savedAt: number
  /** Чем собрана: «Windows», «ТВ». Свободный текст, читает его человек. */
  device: string
  /** Чей это список или null, если список местный. */
  userId: number | null
  /** Сколько записей в копии. Дубль длины entries: виден в файле без счёта. */
  count: number
  entries: SnapshotEntry[]
}

export interface CloudBuildInput {
  entries: SnapshotEntry[]
  /** SNAPSHOT_VERSION вызывающего: сюда его передают, а не импортируют. */
  listVersion: number
  userId?: number | null
  device?: string
  /** Метка времени. Задаётся только в тестах, обычно берётся Date.now(). */
  savedAt?: number
}

export interface CloudBuildResult {
  /** Готовый текст файла. Провайдеру уходит ровно эта строка. */
  text: string
  /** Размер текста в байтах: его показывают человеку и пишут в журнал. */
  bytes: number
  file: CloudFile
}

/**
 * Исход разбора. Отказ — не исключение: копию мог править кто угодно чем
 * угодно, и вызывающему нужен внятный текст для экрана, а не стек.
 */
export type CloudParseResult =
  | { ok: true; file: CloudFile; dropped: number }
  | { ok: false; problem: string }

/** Строка или «нет значения». Пустая строка равносильна отсутствию. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Дата вида ГГГГ-ММ-ДД или null: копию могли править руками. */
function dateText(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/** Метка устройства: одна строка без краёв и без простыни. */
function device(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DEVICE)
}

/**
 * Годна ли запись. Проверка нарочно однополевая, как у снимка: битую запись
 * отбрасываем поштучно, а не всей копией — из-за одной кривой строки терять
 * список целиком было бы хуже самой кривой строки.
 */
function isCloudEntry(value: unknown): value is SnapshotEntry {
  if (typeof value !== 'object' || value === null) return false

  const entry = value as Partial<SnapshotEntry>
  return typeof entry.mediaId === 'number' && Number.isFinite(entry.mediaId)
}

/**
 * Приводит запись к нынешней форме. Поля перечислены явно, и это не
 * многословие ради строгости: что не переписано здесь, то в копию и не
 * попадёт, даже если лежало во входе. Так пропуск входа или чужое поле
 * не уедут в облако вместе со списком.
 *
 * Список полей повторяет normalizeEntry в core/snapshot.ts. Меняются они
 * только вместе: разошедшиеся списки дадут копию, которую снимок не примет.
 */
function cloudEntry(entry: SnapshotEntry): SnapshotEntry {
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

/** По номеру тайтла: две копии одного списка обязаны совпадать до байта. */
function byMediaId(one: SnapshotEntry, two: SnapshotEntry): number {
  return one.mediaId - two.mediaId
}

/**
 * Собирает текст копии. Порядок записей закреплён, а отступов нет: копию
 * читает программа, а лишние пробелы на списке в десять тысяч записей —
 * это лишние сотни килобайт через чужую сеть.
 *
 * Отклоняется только на непомерном размере: остальное поправимо молча.
 */
export function buildCloudFile(input: CloudBuildInput): CloudBuildResult {
  const rows = input.entries.filter(isCloudEntry).map(cloudEntry)
  rows.sort(byMediaId)

  const file: CloudFile = {
    format: CLOUD_FORMAT,
    listVersion: input.listVersion,
    savedAt: typeof input.savedAt === 'number' ? input.savedAt : Date.now(),
    device: device(input.device),
    userId: typeof input.userId === 'number' ? input.userId : null,
    count: rows.length,
    entries: rows,
  }

  const body = JSON.stringify(file)
  const bytes = new TextEncoder().encode(body).length
  if (bytes > MAX_TEXT_BYTES) {
    throw new Error(`Копия списка слишком большая: ${bytes} байт`)
  }

  return { text: body, bytes, file }
}

/**
 * Разбирает пришедший файл. Пустая копия — законный исход разбора, а не
 * отказ: пустым выглядит список, удалённый хозяином осознанно. Решать,
 * можно ли класть пустоту поверх живого списка, обязан вызывающий, и он
 * же сверяет userId со своим: здесь проверяется форма, а не право.
 *
 * @param source Текст файла, как его отдал провайдер.
 * @param listVersion SNAPSHOT_VERSION нынешней сборки.
 */
export function parseCloudFile(source: string, listVersion: number): CloudParseResult {
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, problem: 'Файл копии пуст' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { ok: false, problem: 'Файл копии не разобран: это не JSON' }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: 'Файл копии не похож на копию списка' }
  }

  const candidate = raw as Partial<CloudFile>

  if (candidate.format !== CLOUD_FORMAT) {
    const seen = typeof candidate.format === 'number' ? candidate.format : 'неизвестного'
    return {
      ok: false,
      problem: `Копия ${seen} формата: эта сборка знает формат ${CLOUD_FORMAT}`,
    }
  }

  if (candidate.listVersion !== listVersion) {
    const seen = typeof candidate.listVersion === 'number' ? candidate.listVersion : 'неизвестной'
    return {
      ok: false,
      problem: `Копия от версии списка ${seen}, а здесь версия ${listVersion}: приложить её нельзя`,
    }
  }

  if (!Array.isArray(candidate.entries)) {
    return { ok: false, problem: 'В копии нет списка записей' }
  }

  const rows = candidate.entries.filter(isCloudEntry).map(cloudEntry)
  rows.sort(byMediaId)

  return {
    ok: true,
    dropped: candidate.entries.length - rows.length,
    file: {
      format: CLOUD_FORMAT,
      listVersion,
      savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0,
      device: device(candidate.device),
      userId: typeof candidate.userId === 'number' ? candidate.userId : null,
      count: rows.length,
      entries: rows,
    },
  }
}
