// Распорядитель облачной копии — этап 6. Здесь решается только порядок
// действий: формат файла живёт в cloud-file.ts, сеть — в api/yandex-disk.ts,
// а сам список — в collection.ts. Разделение не ради слоёв: когда появится
// Google Drive, меняться будет только выбор провайдера в pass().
//
// Облако здесь ровно хранилище, а не второй хозяин списка: само по себе
// оно никогда ничего не начинает и ничего не синхронизирует в фоне. Запись
// и чтение бывают только по прямому действию человека: тихая синхронизация
// двух машин без спроса — это ровно тот способ потерять список, от которого
// весь этап 3 и затевался.

import { checkAccess, downloadText, ensureFolder, statFile, uploadText } from '../api/yandex-disk'
import { Logger } from '../utils/logger'
import { buildCloudFile, CLOUD_DIR, CLOUD_FILE, parseCloudFile, type CloudFile } from './cloud-file'
import {
  currentUserId,
  dropEntry,
  eachEntry,
  entryCount,
  getEntry,
  initCollection,
  putEntry,
  type PullMode,
} from './collection'
import { saveSetting, settings } from './settings'
import { saveSnapshotNow, SNAPSHOT_VERSION } from './snapshot'

/** Папка копии в корне облака. */
const DIR_PATH = `/${CLOUD_DIR}`

/**
 * Полный путь до файла копии. Показывается человеку как есть: знать, куда
 * именно уезжает его список, он вправе без лазания в исходники.
 */
export const CLOUD_PATH = `${DIR_PATH}/${CLOUD_FILE}`

/**
 * Исход облачного действия. Та же форма, что у клиента Диска, и по той же
 * причине: человеку нужна фраза на экран, а не исключение в журнале.
 */
export type CloudDone<T> = { ok: true; value: T } | { ok: false; problem: string }

/** Чем кончилось сохранение копии. */
export interface CloudSaved {
  bytes: number
  count: number
  savedAt: number
}

/** Что лежит в облаке сейчас. Отсутствие копии — нормальный ответ. */
export interface CloudInfo {
  there: boolean
  bytes: number
  /** Время правки файла со стороны облака в виде ISO 8601 или null. */
  modified: string | null
}

/** Счёт приложенной копии. Раздельный, как у переноса с сервера. */
interface CloudCounts {
  total: number
  added: number
  updated: number
  kept: number
  onlyHere: number
}

/** Итог восстановления со всеми числами и паспортом самой копии. */
export interface CloudApplied extends CloudCounts {
  mode: PullMode
  /** Сколько записей в копии оказалось битыми и было отброшено. */
  dropped: number
  from: { device: string; savedAt: number; userId: number | null }
}

/**
 * Пропуск для выбранного облака или отказ словами. Единственное место,
 * где решается, куда идти: второй провайдер добавит здесь одну ветку,
 * а не второй комплект функций.
 */
function pass(): CloudDone<string> {
  if (settings.cloudPlace !== 'yandex') {
    return { ok: false, problem: 'Облако не выбрано: укажите место в настройках' }
  }

  const token = settings.cloudToken.trim()
  if (token === '') {
    return { ok: false, problem: 'Пропуск Яндекс Диска не введён' }
  }

  return { ok: true, value: token }
}

/** Готово ли облако к работе. Нужно экрану, чтобы гасить кнопки. */
export function cloudReady(): boolean {
  return pass().ok
}

/**
 * Проверяет пропуск, не сохраняя его. Зовётся в момент, когда человек его
 * вставил: лучше сказать «не годится» сразу, чем молча запомнить строку
 * и отказать потом, когда человек уже надеётся на копию.
 */
export async function checkPlace(token: string): Promise<CloudDone<true>> {
  const done = await checkAccess(token)
  if (!done.ok) return done

  return { ok: true, value: true }
}

/**
 * Собирает список и кладёт копию в облако, замещая прежнюю.
 *
 * Папка заводится перед каждой записью, а не один раз при настройке: папку
 * могли удалить руками с сайта Диска между двумя сохранениями, и лишний
 * дешёвый запрос здесь дешевле отказа в самый нужный момент.
 *
 * @param device Метка устройства для человека: «Windows», «ТВ». Передаётся снаружи,
 * потому что ядро про площадку не знает и знать не должно.
 */
export async function saveCopy(device: string): Promise<CloudDone<CloudSaved>> {
  const token = pass()
  if (!token.ok) return token

  // Список обязан быть поднят: иначе в облако уедет пустота вместо
  // списка, который ещё лежит на диске и не прочитан.
  await initCollection()

  let built
  try {
    built = buildCloudFile({
      entries: Array.from(eachEntry()),
      listVersion: SNAPSHOT_VERSION,
      userId: currentUserId(),
      device,
    })
  } catch (e) {
    Logger('WARN', 'Облако: копия не собралась', e)
    return {
      ok: false,
      problem: e instanceof Error ? e.message : 'Копию списка не удалось собрать',
    }
  }

  const folder = await ensureFolder(token.value, DIR_PATH)
  if (!folder.ok) return folder

  const sent = await uploadText(token.value, CLOUD_PATH, built.text)
  if (!sent.ok) return sent

  // Отметка о копии пишется ПОСЛЕ успеха: обещание копии, которой нет,
  // хуже отсутствия копии: на первое человек полагается.
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', built.file.savedAt)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', built.file.count)

  Logger('DB', `Облако: копия сохранена, записей ${built.file.count}, байт ${built.bytes}`)

  return {
    ok: true,
    value: { bytes: built.bytes, count: built.file.count, savedAt: built.file.savedAt },
  }
}

/**
 * Спрашивает облако, что там лежит. Нужно до восстановления: решать
 * судьбу своего списка вслепую человек не должен.
 */
export async function copyInfo(): Promise<CloudDone<CloudInfo>> {
  const token = pass()
  if (!token.ok) return token

  const found = await statFile(token.value, CLOUD_PATH)
  if (!found.ok) return found

  if (found.value === null) {
    return { ok: true, value: { there: false, bytes: 0, modified: null } }
  }

  return {
    ok: true,
    value: { there: true, bytes: found.value.bytes, modified: found.value.modified },
  }
}

/**
 * Сливает копию с памятью по времени правки — тем же правилом, что и перенос
 * с сервера в collection.ts.
 *
 * При равных метках остаётся местная запись, а не копия, и это отличие
 * от слияния с сервером осознанное: копия — это слепок нашего же списка,
 * и равная метка значит одну и ту же правку, а не спор двух источников.
 * Лишняя замена тут только гоняла бы снимок на диск.
 *
 * Записи, которых в копии нет, остаются на месте: копия могла быть снята
 * до того, как их добавили, и ничто в файле не отличает «ещё не было»
 * от «удалили на другом устройстве».
 */
function mergeFromCopy(file: CloudFile): CloudCounts {
  let added = 0
  let updated = 0
  let kept = 0
  const seen = new Set<number>()

  for (const fresh of file.entries) {
    seen.add(fresh.mediaId)
    const mine = getEntry(fresh.mediaId)

    if (!mine) {
      putEntry(fresh)
      added++
      continue
    }

    if (mine.updatedAt >= fresh.updatedAt) {
      // Спор о полях местная запись выиграла, но пустоты дополнить можно:
      // без номера MAL запись потом нечем выгрузить в XML.
      const filled = { ...mine }
      let touched = false
      if (filled.malId === null && fresh.malId !== null) {
        filled.malId = fresh.malId
        touched = true
      }
      if (filled.romaji === null && fresh.romaji !== null) {
        filled.romaji = fresh.romaji
        touched = true
      }
      if (filled.english === null && fresh.english !== null) {
        filled.english = fresh.english
        touched = true
      }
      if (touched) putEntry(filled)

      kept++
      continue
    }

    putEntry(fresh)
    updated++
  }

  let onlyHere = 0
  for (const entry of eachEntry()) if (!seen.has(entry.mediaId)) onlyHere++

  return { total: entryCount(), added, updated, kept, onlyHere }
}

/**
 * Замещает память копией целиком. Нужен для переезда на чистое устройство
 * и при переносе чужого списка, где слияние дало бы кашу из двух жизней.
 */
function replaceFromCopy(file: CloudFile): CloudCounts {
  // Номера собираются заранее: dropEntry правит ту же карту, по которой
  // идёт обход, а удалять по живому итератору нельзя.
  const gone = Array.from(eachEntry(), (entry) => entry.mediaId)
  for (const mediaId of gone) dropEntry(mediaId)
  for (const entry of file.entries) putEntry(entry)

  return {
    total: entryCount(),
    added: entryCount(),
    updated: 0,
    kept: 0,
    onlyHere: 0,
  }
}

/**
 * Забирает копию из облака и прикладывает к списку.
 *
 * Снимок пишется дублем в файл, как и при переносе с сервера: восстановление
 * бывает редко и двигает список целиком.
 *
 * Два отказа здесь стоят нарочно, и оба про сохранность списка:
 *
 * 1. Чужая копия не сливается. Метки времени двух разных людей между собой
 *    ничего не значат, и слияние дало бы смесь, разобрать которую потом
 *    нечем. Замена целиком — дело другое: это осознанный переезд.
 *
 * 2. Пустая копия не замещает живой список. Формально такая копия законна,
 *    но единственный её смысл — стереть всё, а для этого есть отдельная
 *    кнопка рядом, и она спрашивает подтверждения.
 */
export async function pullCopy(mode: PullMode): Promise<CloudDone<CloudApplied>> {
  const token = pass()
  if (!token.ok) return token

  await initCollection()

  const got = await downloadText(token.value, CLOUD_PATH)
  if (!got.ok) return got

  const read = parseCloudFile(got.value, SNAPSHOT_VERSION)
  if (!read.ok) return { ok: false, problem: read.problem }

  const file = read.file
  const mine = currentUserId()

  if (mode === 'merge' && mine !== null && file.userId !== null && file.userId !== mine) {
    return {
      ok: false,
      problem:
        `Копия снята с другого счёта AniList (${file.userId}, здесь ${mine}): ` +
        'сливать два разных списка нельзя. Замена целиком возможна.',
    }
  }

  if (mode === 'replace' && file.count === 0 && entryCount() > 0) {
    return {
      ok: false,
      problem:
        'В копии нет ни одной записи: замена стёрла бы весь список. ' +
        'Сохраните копию заново или очистите список явно, если именно этого хотите.',
    }
  }

  const counts = mode === 'replace' ? replaceFromCopy(file) : mergeFromCopy(file)
  await saveSnapshotNow({ backup: true })

  Logger(
    'DB',
    `Облако: копия приложена (${mode}): всего ${counts.total}, ` +
      `новых ${counts.added}, обновлено ${counts.updated}, ` +
      `оставлено своих ${counts.kept}, только здесь ${counts.onlyHere}, ` +
      `отброшено битых ${read.dropped}`,
  )

  return {
    ok: true,
    value: {
      ...counts,
      mode,
      dropped: read.dropped,
      from: { device: file.device, savedAt: file.savedAt, userId: file.userId },
    },
  }
}
