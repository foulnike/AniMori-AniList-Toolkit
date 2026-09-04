// Распорядитель облачной копии — этап 6. Здесь решается только порядок
// действий: формат файла живёт в cloud-file.ts, сеть — в api/yandex-disk.ts,
// а сам список — в collection.ts.
//
// ОДНО МЕСТО ВМЕСТО ДВУХ
// Здесь было два провайдера, и Google Drive убран совсем. Причины измерены,
// а не выдуманы: вход с устройства не выдаёт область скрытой папки, хотя
// справочник её обещает; в статусе тестирования пропуск продления живёт
// семь дней, а войти могут только вписанные руками тестировщики; дешёвого
// чтения по короткой ссылке там нет вовсе. Двойная поддержка при той же
// пользе — плохая сделка для одного человека.
//
// Поэтому pass() снова простой и синхронный, а тонкие обёртки над
// провайдерами убраны вместе со вторым провайдером: выбирать не из чего.
// У кого было выбрано Google, место считается невыбранным, и об этом
// говорится прямо: тихое «облако не выбрано» читалось бы как поломка.
// Файл в Drive при этом никуда не девается — он остаётся у владельца
// и просто перестаёт обновляться.
//
// Облако здесь хранилище, а не второй хозяин списка: само оно ничего не
// начинает и ничего не синхронизирует в фоне. Запись и чтение бывают только
// по прямому действию человека: тихая синхронизация двух машин без спроса —
// ровно тот способ потерять список, от которого весь этап 3 и затевался.
//
// ГДЕ ЛЕЖИТ КОПИЯ
// Путь app:/animori-list.json: пропуску достаточно области на одну папку,
// и корня Диска он не видит вовсе. Заводить папку не нужно — Диск создаёт
// её сам при первой записи, и шага ensureFolder здесь больше нет.
//
// ЗАПИСЬ НЕ ЗАТИРАЕТ НЕЗНАКОМУЮ КОПИЮ МОЛЧА
// Перед записью спрашивается время правки файла, и если оно не то, которое
// мы запомнили после своего последнего касания, — значит, файл писал кто-то
// ещё, и решает человек. Сравнивается именно строка от облака, а не своё
// время записи: свои часы и часы Диска расходятся на минуты, и разница
// читалась бы как чужая правка на каждой второй записи.
//
// ССЫЛКА ДЛЯ ХОЛОДНОГО СТАРТА
// На телевизоре вход в облако невозможен по-человечески: пропуск — это
// строка под шесть десятков знаков, набираемая пультом. Поэтому у копии
// есть второй путь: владелец один раз публикует файл с компьютера
// (shareCopy), а новое устройство забирает список по короткой ссылке
// (pullByLink) — без входа, без пропуска и без выбранного места.
//
// Дорога односторонняя: по ссылке только читают. Поэтому pullByLink не
// трогает ни метку знакомой копии, ни числа последнего сохранения: своей
// копии в облаке у читателя нет, и обещать ему «сохранено вчера» — вранье.
//
// Ссылка нигде не запоминается: перезапись копии может сбросить публикацию,
// а Диск о таком поведении ничего не обещает. Её всегда спрашивают у облака
// заново (copyInfo отдаёт share), а повторная публикация законна и просто
// вернёт ссылку снова.

import {
  checkAccess as diskCheck,
  DISK_APP_ROOT,
  downloadPublic,
  downloadText as diskDownload,
  publicInfo,
  shareFile,
  statFile as diskStat,
  unshareFile,
  uploadText as diskUpload,
} from '../api/yandex-disk'
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
import { saveSetting, settings, type CloudPlace } from './settings'
import { saveSnapshotNow, SNAPSHOT_VERSION } from './snapshot'

/** Путь файла копии для API Диска: приставка app: и есть папка приложения. */
const FILE_PATH = `${DISK_APP_ROOT}/${CLOUD_FILE}`

/**
 * Где копия лежит с точки зрения человека. Показывается как есть: знать,
 * куда именно уезжает его список, он вправе без лазания в исходники.
 *
 * Имя папки Диск берёт из названия приложения в OAuth, а не из наших
 * констант, и совпадение с CLOUD_DIR здесь — договорённость, а не гарантия.
 */
export const CLOUD_PATH = `Приложения/${CLOUD_DIR}/${CLOUD_FILE}`

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

/**
 * Что лежит в облаке вместо нашей копии. Нужно ровно для вопроса человеку:
 * решать судьбу чужой записи вслепую он не должен.
 */
export interface CloudStranger {
  bytes: number
  /** Время правки со стороны облака в виде ISO 8601 или null. */
  modified: string | null
}

/**
 * Исход сохранения. Отдельный тип от CloudDone потому, что у отказа есть
 * третье состояние: не ошибка, а вопрос. Незнакомая копия в облаке не значит,
 * что что-то сломалось; значит только, что решать теперь человеку.
 */
export type CloudSaveDone =
  | { ok: true; value: CloudSaved }
  | { ok: false; problem: string; stranger?: CloudStranger }

/** Что лежит в облаке сейчас. Отсутствие копии — нормальный ответ. */
export interface CloudInfo {
  there: boolean
  bytes: number
  /** Время правки файла со стороны облака в виде ISO 8601 или null. */
  modified: string | null
  /** Публичная ссылка на копию или null, если она не опубликована. */
  share: string | null
}

/** Что видно по ссылке до того, как прикладывать копию к списку. */
export interface CloudLink {
  /** Проверенный ключ публикации: его и передавать в pullByLink. */
  key: string
  bytes: number
  /** Время правки файла в виде ISO 8601 или null. */
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
 * Итог приложения вместе с двумя числами самого файла. Внутреннее: числа
 * нужны только pullCopy, чтобы обновить отметку о своей копии в облаке.
 */
interface AppliedCopy {
  applied: CloudApplied
  savedAt: number
  count: number
}

/**
 * Какой пропуск брать сейчас, или отказ словами. Синхронно и без сети:
 * пропуск Диска вставляют руками, и живёт он месяцами — продлевать его
 * не нужно и нечем.
 */
function pass(): CloudDone<string> {
  if (settings.cloudPlace === 'yandex') {
    const token = settings.cloudToken.trim()
    if (token === '') return { ok: false, problem: 'Пропуск Яндекс Диска не введён' }

    return { ok: true, value: token }
  }

  if (settings.cloudPlace === 'google') {
    return {
      ok: false,
      problem:
        'Google Диск из программы убран: выберите Яндекс Диск в настройках. ' +
        'Файл копии в Google Диске остался на месте — он просто больше не обновляется.',
    }
  }

  return { ok: false, problem: 'Облако не выбрано: укажите место в настройках' }
}

/**
 * Есть ли чем ходить в облако. Нужно экрану, чтобы гасить кнопки, поэтому
 * ответ обязан быть мгновенным и сети не касается: годен ли пропуск на самом
 * деле, знает только облако, и спрашивают об этом checkChosenPlace().
 */
export function cloudReady(): boolean {
  return settings.cloudPlace === 'yandex' && settings.cloudToken.trim() !== ''
}

/**
 * Проверяет вставленный пропуск, не сохраняя его. Зовётся в момент, когда
 * человек его вставил: лучше сказать «не годится» сразу, чем молча запомнить
 * строку и отказать потом, когда человек уже надеется на копию.
 */
export async function checkPlace(token: string): Promise<CloudDone<true>> {
  const done = await diskCheck(token)
  if (!done.ok) return done

  return { ok: true, value: true }
}

/** Проверяет выбранное сейчас место целиком: и пропуск, и доступ к папке. */
export async function checkChosenPlace(): Promise<CloudDone<true>> {
  const token = pass()
  if (!token.ok) return token

  const done = await diskCheck(token.value)
  if (!done.ok) return { ok: false, problem: done.problem }

  return { ok: true, value: true }
}

/**
 * Меняет место копии. Всё, что относилось к прежнему месту, забывается
 * здесь же — иначе про это пришлось бы помнить интерфейсу:
 *
 * 1. Метка знакомой копии: у нового места свой файл и свои часы, и старая
 *    строка означала бы «эта копия наша» без всякой проверки.
 * 2. Числа последней копии: на новом месте копии ещё нет, а панель обещала
 *    бы человеку «812 записей, сохранено вчера» — обещание пустое.
 */
export async function choosePlace(place: CloudPlace): Promise<void> {
  if (settings.cloudPlace === place) return

  await saveSetting('cloudPlace', 'am_cloud_place', place)
  await saveSetting('cloudSeenModified', 'am_cloud_seen_modified', '')
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', 0)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', 0)

  Logger('DB', `Облако: место копии теперь ${place}`)
}

/** Где копия лежит с точки зрения человека — для выбранного сейчас места. */
export function cloudPathText(): string {
  return settings.cloudPlace === 'yandex' ? CLOUD_PATH : ''
}

/**
 * Запоминает время правки файла, каким его назвало облако. Зовётся после
 * каждого своего касания копии — и записи, и чтения: именно с этой строкой
 * сравнится следующее сохранение.
 *
 * Неудача запроса пишет пустоту, а не оставляет прежнее значение. Пустота
 * значит «не знаем», и следующая запись переспросит человека. Прежнее
 * значение означало бы «копия наша» без проверки, а из двух ошибок лишний
 * вопрос дешевле стёртой копии.
 */
async function rememberSeen(token: string): Promise<void> {
  const seen = await diskStat(token, FILE_PATH)
  const mark = seen.ok && seen.value !== null ? (seen.value.modified ?? '') : ''
  await saveSetting('cloudSeenModified', 'am_cloud_seen_modified', mark)
}

/**
 * Собирает список и кладёт копию в облако, замещая прежнюю.
 *
 * @param device Метка устройства для человека: «Windows», «ТВ». Передаётся снаружи,
 * потому что ядро про площадку не знает и знать не должно.
 * @param force «Замещать, даже если в облаке незнакомая копия». Ставится только
 * после вопроса человеку, который видел её размер и время.
 */
export async function saveCopy(device: string, force = false): Promise<CloudSaveDone> {
  const token = pass()
  if (!token.ok) return token

  // Список обязан быть поднят: иначе в облако уедет пустота вместо списка,
  // который ещё лежит на диске и не прочитан.
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

  // Сторож перед записью — см. шапку файла. Один дешёвый запрос перед
  // заливкой в сотни килобайт — цена, которую не стоит и обсуждать.
  if (!force) {
    const there = await diskStat(token.value, FILE_PATH)
    if (!there.ok) return there

    const found = there.value
    if (found !== null && (found.modified ?? '') !== settings.cloudSeenModified) {
      return {
        ok: false,
        problem:
          'В облаке лежит копия, которую писали не мы: ' +
          'запись поверх стёрла бы её безвозвратно.',
        stranger: { bytes: found.bytes, modified: found.modified },
      }
    }
  }

  const sent = await diskUpload(token.value, FILE_PATH, built.text)
  if (!sent.ok) return sent

  // Отметка о копии пишется ПОСЛЕ успеха: обещание копии, которой нет,
  // хуже отсутствия копии — на первое человек полагается.
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', built.file.savedAt)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', built.file.count)
  await rememberSeen(token.value)

  Logger('DB', `Облако: копия сохранена, записей ${built.file.count}, байт ${built.bytes}`)

  return {
    ok: true,
    value: { bytes: built.bytes, count: built.file.count, savedAt: built.file.savedAt },
  }
}

/**
 * Спрашивает облако, что там лежит. Нужно до восстановления: решать судьбу
 * своего списка вслепую человек не должен. Заодно отдаёт публичную ссылку,
 * если копия опубликована: запоминать её негде и незачем.
 */
export async function copyInfo(): Promise<CloudDone<CloudInfo>> {
  const token = pass()
  if (!token.ok) return token

  const found = await diskStat(token.value, FILE_PATH)
  if (!found.ok) return found

  if (found.value === null) {
    return { ok: true, value: { there: false, bytes: 0, modified: null, share: null } }
  }

  return {
    ok: true,
    value: {
      there: true,
      bytes: found.value.bytes,
      modified: found.value.modified,
      share: found.value.share,
    },
  }
}

/**
 * Публикует копию и возвращает короткую ссылку на неё. Единственное место,
 * где список становится доступен кому-то ещё, и зовётся оно только кнопкой:
 * решение открыть свой список принимает человек, а не программа.
 */
export async function shareCopy(): Promise<CloudDone<string>> {
  const token = pass()
  if (!token.ok) return token

  return shareFile(token.value, FILE_PATH)
}

/** Закрывает ссылку. Сам файл копии остаётся на месте и в работе. */
export async function unshareCopy(): Promise<CloudDone<true>> {
  const token = pass()
  if (!token.ok) return token

  const done = await unshareFile(token.value, FILE_PATH)
  if (!done.ok) return done

  return { ok: true, value: true }
}

/**
 * Что лежит по чужой ссылке. Пропуска не требует вовсе — на этом и держится
 * холодный старт. Показать размер и время до приложения обязательно: замена
 * списка вслепую по строке, набранной пультом, — способ потерять список
 * из-за одной опечатки.
 */
export async function linkInfo(link: string): Promise<CloudDone<CloudLink>> {
  const found = await publicInfo(link)
  if (!found.ok) return found

  return {
    ok: true,
    value: {
      key: found.value.key,
      bytes: found.value.file.bytes,
      modified: found.value.file.modified,
    },
  }
}

/**
 * Сливает копию с памятью по времени правки — тем же правилом, что и перенос
 * с сервера в collection.ts.
 *
 * При равных метках остаётся местная запись, а не копия, и это отличие от
 * слияния с сервером осознанное: копия — это слепок нашего же списка,
 * и равная метка значит одну и ту же правку, а не спор двух источников.
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
 * Прикладывает прочитанный текст копии к списку. Один порядок действий
 * для обоих путей: и для своей копии по пропуску, и для чужой по ссылке.
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
 *
 * Снимок пишется дублем в файл, как и при переносе с сервера:
 * восстановление бывает редко и двигает список целиком.
 */
async function applyText(text: string, mode: PullMode): Promise<CloudDone<AppliedCopy>> {
  const read = parseCloudFile(text, SNAPSHOT_VERSION)
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
      applied: {
        ...counts,
        mode,
        dropped: read.dropped,
        from: { device: file.device, savedAt: file.savedAt, userId: file.userId },
      },
      savedAt: file.savedAt,
      count: file.count,
    },
  }
}

/** Забирает свою копию из облака по пропуску и прикладывает к списку. */
export async function pullCopy(mode: PullMode): Promise<CloudDone<CloudApplied>> {
  const token = pass()
  if (!token.ok) return token

  await initCollection()

  const got = await diskDownload(token.value, FILE_PATH)
  if (!got.ok) return got

  const done = await applyText(got.value, mode)
  if (!done.ok) return done

  // Копия, которую только что прочли, с этого момента знакомая: сохранение
  // поверх неё спрашивать не должно. Заодно числа на панели перестают
  // говорить о прошлой своей записи там, где в облаке уже другая копия.
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', done.value.savedAt)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', done.value.count)
  await rememberSeen(token.value)

  return { ok: true, value: done.value.applied }
}

/**
 * Забирает список по короткой ссылке и прикладывает к своему. Ни пропуска,
 * ни выбранного места не требует: это единственный путь, доступный на
 * устройстве, где набирать нечем.
 *
 * Отметки о своей копии не трогаются нарочно — см. шапку файла: у читателя
 * своей копии в облаке нет, и панель не должна обещать обратное.
 */
export async function pullByLink(key: string, mode: PullMode): Promise<CloudDone<CloudApplied>> {
  await initCollection()

  const got = await downloadPublic(key)
  if (!got.ok) return got

  const done = await applyText(got.value, mode)
  if (!done.ok) return done

  Logger('DB', 'Облако: список приложен из копии по ссылке')

  return { ok: true, value: done.value.applied }
}
