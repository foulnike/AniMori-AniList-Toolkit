// Распорядитель облачной копии — этап 6. Здесь решается только порядок
// действий: формат файла живёт в cloud-file.ts, сеть — в api/yandex-disk.ts
// и api/google-drive.ts, вход в Google — в api/google-oauth.ts, а сам
// список — в collection.ts.
//
// ДВА МЕСТА, ОДИН ПОРЯДОК ДЕЙСТВИЙ
// Обещание из прошлой шапки сдержано наполовину. Провайдер действительно
// выбирается в одном месте, но одной строкой обойтись не вышло: у Яндекса
// пропуск вставляют руками и он живёт годами, а Google выдаёт пропуск
// доступа программе на час. Поэтому pass() стал асинхронным и умеет
// продлевать пропуск сам, а ниже появились четыре тонкие обёртки —
// statCopy, readCopy, writeCopy, testCopy. Только они знают, куда идти;
// всё остальное про место не спрашивает.
//
// ПОЧЕМУ ПРОПУСК ДОСТУПА GOOGLE НЕ ЛОЖИТСЯ НА ДИСК
// Он стухнет раньше, чем человек вернётся к приложению, и запись его
// на диск была бы записью мусора. В памяти он живёт до закрытия окна,
// продлевается за минуту до срока и забывается при выходе из облака.
// На диске лежит только пропуск продления — единственное, что имеет смысл
// хранить между запусками.
//
// Облако здесь ровно хранилище, а не второй хозяин списка: само по себе
// оно никогда ничего не начинает и ничего не синхронизирует в фоне. Запись
// и чтение бывают только по прямому действию человека: тихая синхронизация
// двух машин без спроса — это ровно тот способ потерять список, от которого
// весь этап 3 и затевался.
//
// ГДЕ ЛЕЖИТ КОПИЯ
// У Яндекса путь app:/animori-list.json, а не /AniMori/…: пропуску
// достаточно области на одну папку, и корня Диска он не видит вовсе.
// Заводить папку не нужно — Диск создаёт её сам при первой записи,
// и шага ensureFolder здесь больше нет.
//
// У Google было задумано строже — скрытая папка приложения appDataFolder,
// которой в самом Диске не видно вовсе, — но её область drive.appdata вход
// с устройства не выдаёт: проверено живыми запросами, подробности в шапке
// api/google-oauth.ts. Поэтому копия лежит обычным файлом в Моём диске,
// и человеку её видно. Чужих файлов приложение при этом по-прежнему
// не видит: область drive.file показывает только своё. Путей в Диске нет,
// поэтому имя файла там просто имя, а не путь.
//
// ЗАПИСЬ НЕ ЗАТИРАЕТ НЕЗНАКОМУЮ КОПИЮ МОЛЧА
// Прежде сохранение шло с перезаписью не глядя, и два устройства с одной
// копией давали ровно то, против чего всё здесь написано: запись с машины,
// где список беднее, уничтожала копию другой без единого вопроса.
//
// Теперь перед записью спрашивается время правки файла, и если оно не то,
// которое мы запомнили после своего последнего касания, — значит, файл писал
// кто-то ещё, и решает человек. Сравнивается именно строка от облака,
// а не своё время записи: свои часы и часы провайдера расходятся на минуты,
// и разница читалась бы как чужая правка на каждой второй записи.
//
// Метка принадлежит текущему месту: у Яндекса и Google это разные файлы
// с разными часами. Очищает её choosePlace() — чтобы про это нельзя было
// забыть в интерфейсе.

import {
  checkAccess as driveCheck,
  downloadText as driveDownload,
  statFile as driveStat,
  uploadText as driveUpload,
} from '../api/google-drive'
import { refreshAccess, revokeAccess, type GoogleKeys } from '../api/google-oauth'
import {
  checkAccess as diskCheck,
  DISK_APP_ROOT,
  downloadText as diskDownload,
  statFile as diskStat,
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
 * констант, и совпадение с CLOUD_DIR здесь — договорённость, а не гарантия:
 * назовут приложение иначе — и папка будет называться иначе.
 */
export const CLOUD_PATH = `Приложения/${CLOUD_DIR}/${CLOUD_FILE}`

/**
 * То же для Google. Копия лежит на виду, и выдавать её за спрятанную нельзя:
 * человек найдёт файл в Моём диске, вправе его переименовать, перенести
 * или убрать — приложение при следующей записи просто создаст новый.
 * Чужих файлов оно при этом не видит: область drive.file показывает
 * только своё.
 */
export const DRIVE_PATH = `Google Диск → ${CLOUD_FILE}`

/**
 * За сколько до срока менять пропуск доступа Google. Минута — запас
 * на дорогу: пропуск, годный «ещё пять секунд», по пути стухнет.
 */
const ACCESS_EDGE_MS = 60000

/**
 * Исход облачного действия. Та же форма, что у клиентов обоих облаков,
 * и по той же причине: человеку нужна фраза на экран, а не исключение
 * в журнале.
 */
export type CloudDone<T> = { ok: true; value: T } | { ok: false; problem: string }

/** Исход шага, где значение не нужно: важны только успех и фраза отказа. */
type Step = { ok: true } | { ok: false; problem: string }

/** Чем и куда ходить. Внутреннее: наружу отдаётся только исход действия. */
interface Hands {
  place: 'yandex' | 'google'
  /** Пропуск, годный прямо сейчас. */
  token: string
  /** Как зовётся файл копии в этом облаке: путь у Яндекса, имя у Google. */
  path: string
}

/** Что известно про файл копии, без разницы, чей он. */
interface SeenFile {
  bytes: number
  /** Время правки со стороны облака в виде ISO 8601 или null. */
  modified: string | null
}

/** Чем кончилось сохранение копии. */
export interface CloudSaved {
  bytes: number
  count: number
  savedAt: number
}

/**
 * Что лежит в облаке вместо нашей копии. Нужно ровно для вопроса
 * человеку: решать судьбу чужой записи вслепую он не должен.
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
 * Пропуск доступа Google на время работы окна. Живёт в памяти нарочно —
 * см. шапку файла.
 */
let googlePass: { token: string; until: number } | null = null

/**
 * Забыть пропуск доступа Google. Зовётся при выходе и при смене места:
 * оставленный в памяти пропуск после «выйти» — это доступ, который человек
 * уже считает закрытым.
 */
export function forgetCloudPass(): void {
  googlePass = null
}

/**
 * Пропуск Google, годный прямо сейчас. Продлевает молча: человек просил
 * сохранить копию, а не поговорить про пропуска.
 */
async function googleToken(): Promise<CloudDone<string>> {
  if (googlePass !== null && googlePass.until - ACCESS_EDGE_MS > Date.now()) {
    return { ok: true, value: googlePass.token }
  }

  const client = settings.cloudGoogleClient.trim()
  const secret = settings.cloudGoogleSecret.trim()
  const refresh = settings.cloudGoogleRefresh.trim()

  if (client === '' || secret === '') {
    return { ok: false, problem: 'Не заданы ключи клиента Google: укажите их в настройках' }
  }

  if (refresh === '') {
    return { ok: false, problem: 'Вход в Google не пройден: войдите в настройках' }
  }

  const got = await refreshAccess(client, secret, refresh)
  if (!got.ok) {
    // Негодный пропуск в памяти хуже пустоты: следующая попытка
    // отказала бы, не спросив Google.
    googlePass = null
    return { ok: false, problem: got.problem }
  }

  googlePass = { token: got.value.access, until: got.value.accessUntil }
  Logger('API', 'Облако: пропуск Google продлён')

  return { ok: true, value: got.value.access }
}

/**
 * Чем и куда ходить сейчас, или отказ словами. Единственное место, где
 * решается место: второй провайдер добавил здесь одну ветку, а не второй
 * комплект действий.
 */
async function pass(): Promise<CloudDone<Hands>> {
  if (settings.cloudPlace === 'yandex') {
    const token = settings.cloudToken.trim()
    if (token === '') return { ok: false, problem: 'Пропуск Яндекс Диска не введён' }

    return { ok: true, value: { place: 'yandex', token, path: FILE_PATH } }
  }

  if (settings.cloudPlace === 'google') {
    const token = await googleToken()
    if (!token.ok) return token

    return { ok: true, value: { place: 'google', token: token.value, path: CLOUD_FILE } }
  }

  return { ok: false, problem: 'Облако не выбрано: укажите место в настройках' }
}

/**
 * Есть ли чем ходить в облако. Нужно экрану, чтобы гасить кнопки, поэтому
 * ответ обязан быть мгновенным и сети не касается: годен ли пропуск на самом
 * деле, знает только облако, и спрашивают об этом checkChosenPlace().
 */
export function cloudReady(): boolean {
  if (settings.cloudPlace === 'yandex') return settings.cloudToken.trim() !== ''
  if (settings.cloudPlace === 'google') return settings.cloudGoogleRefresh.trim() !== ''

  return false
}

/** Пустая строка от Google значит «время неизвестно», а не «начало времён». */
function orNull(when: string): string | null {
  return when === '' ? null : when
}

/** Спрашивает облако про файл копии. Отсутствие файла — не ошибка. */
async function statCopy(hands: Hands): Promise<CloudDone<SeenFile | null>> {
  if (hands.place === 'google') {
    const done = await driveStat(hands.token, hands.path)
    if (!done.ok) return done
    if (done.value === null) return { ok: true, value: null }

    return { ok: true, value: { bytes: done.value.bytes, modified: orNull(done.value.modified) } }
  }

  const done = await diskStat(hands.token, hands.path)
  if (!done.ok) return done
  if (done.value === null) return { ok: true, value: null }

  return { ok: true, value: { bytes: done.value.bytes, modified: done.value.modified ?? null } }
}

/** Читает копию целиком. */
async function readCopy(hands: Hands): Promise<CloudDone<string>> {
  if (hands.place === 'google') return driveDownload(hands.token, hands.path)

  return diskDownload(hands.token, hands.path)
}

/** Пишет копию поверх прежней. */
async function writeCopy(hands: Hands, text: string): Promise<Step> {
  if (hands.place === 'google') return driveUpload(hands.token, hands.path, text)

  return diskUpload(hands.token, hands.path, text)
}

/** Проверяет, что пропуск годен и папка копии доступна. */
async function testCopy(hands: Hands): Promise<Step> {
  if (hands.place === 'google') return driveCheck(hands.token)

  return diskCheck(hands.token)
}

/**
 * Проверяет вставленный пропуск Яндекс Диска, не сохраняя его. Зовётся
 * в момент, когда человек его вставил: лучше сказать «не годится» сразу,
 * чем молча запомнить строку и отказать потом, когда человек уже надеется
 * на копию.
 */
export async function checkPlace(token: string): Promise<CloudDone<true>> {
  const done = await diskCheck(token)
  if (!done.ok) return done

  return { ok: true, value: true }
}

/**
 * Проверяет выбранное сейчас место целиком: и пропуск, и доступ к папке.
 * Для Google это единственная честная проверка — пропуск там не вставляют,
 * а получают, и убедиться, что полученным можно работать, стоит сразу.
 */
export async function checkChosenPlace(): Promise<CloudDone<true>> {
  const hands = await pass()
  if (!hands.ok) return hands

  const done = await testCopy(hands.value)
  if (!done.ok) return { ok: false, problem: done.problem }

  return { ok: true, value: true }
}

/**
 * Запоминает вход в Google после подтверждения на другом устройстве.
 *
 * Пустой пропуск продления НЕ затирает прежний: при повторном входе Google
 * иногда его не присылает, и старый в этом случае годен. Затереть его
 * пустотой значило бы выкинуть единственный ключ от копии.
 *
 * Метка чужой копии здесь не чистится нарочно: место не менялось. Если
 * вошли в другой счёт Google, файл там другой, и первое же сохранение
 * честно переспросит — а лишний вопрос дешевле стёртой копии.
 */
export async function keepGoogleLogin(keys: GoogleKeys): Promise<void> {
  googlePass = { token: keys.access, until: keys.accessUntil }

  if (keys.refresh !== '') {
    await saveSetting('cloudGoogleRefresh', 'am_cloud_g_refresh', keys.refresh)
  }

  Logger('DB', 'Облако: вход в Google запомнен')
}

/**
 * Выход из Google: отзывает доступ у самого Google и стирает всё своё.
 *
 * Ключи стираются даже при неудаче отзыва — см. шапку revokeAccess:
 * пропавшая сеть не должна держать человека вошедшим против его воли.
 * Про неудачу при этом говорится вслух, потому что доступ у Google мог
 * остаться живым, и человек вправе убрать его на их странице приложений.
 */
export async function signOutGoogle(): Promise<CloudDone<true>> {
  const done = await revokeAccess(settings.cloudGoogleRefresh.trim())

  forgetCloudPass()
  await saveSetting('cloudGoogleRefresh', 'am_cloud_g_refresh', '')
  await saveSetting('cloudSeenModified', 'am_cloud_seen_modified', '')
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', 0)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', 0)

  Logger('DB', 'Облако: вход в Google забыт')

  if (!done.ok) return { ok: false, problem: done.problem }

  return { ok: true, value: true }
}

/**
 * Меняет место копии. Всё, что относилось к прежнему месту, забывается
 * здесь же — иначе про это пришлось бы помнить интерфейсу:
 *
 * 1. Метка чужой копии: у нового места свой файл и свои часы, и старая
 *    строка означала бы «эта копия наша» без всякой проверки.
 * 2. Числа последней копии: на новом месте копии ещё нет, а панель обещала
 *    бы человеку «812 записей, сохранено вчера» — обещание пустое.
 * 3. Пропуск доступа в памяти: он выдан прежним облаком.
 *
 * Сам пропуск продления Google не стирается: место меняют и туда, и обратно,
 * а заставлять человека входить заново из-за переключения — грубость.
 * Для настоящего выхода есть signOutGoogle().
 */
export async function choosePlace(place: CloudPlace): Promise<void> {
  if (settings.cloudPlace === place) return

  forgetCloudPass()
  await saveSetting('cloudPlace', 'am_cloud_place', place)
  await saveSetting('cloudSeenModified', 'am_cloud_seen_modified', '')
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', 0)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', 0)

  Logger('DB', `Облако: место копии теперь ${place}`)
}

/** Где копия лежит с точки зрения человека — для выбранного сейчас места. */
export function cloudPathText(): string {
  if (settings.cloudPlace === 'yandex') return CLOUD_PATH
  if (settings.cloudPlace === 'google') return DRIVE_PATH

  return ''
}

/**
 * Запоминает время правки файла, каким его назвало облако. Зовётся после
 * каждого своего касания копии — и записи, и чтения: именно с этой строкой
 * сравнится следующее сохранение.
 *
 * Неудача запроса пишет пустоту, а не оставляет прежнее значение. Пустота
 * значит «не знаем», и следующая запись переспросит человека. Прежнее
 * значение означало бы «копия наша» без проверки, а из двух ошибок
 * лишний вопрос дешевле стёртой копии.
 */
async function rememberSeen(hands: Hands): Promise<void> {
  const seen = await statCopy(hands)
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
  const hands = await pass()
  if (!hands.ok) return hands

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

  // Сторож перед записью — см. шапку файла. Один дешёвый запрос перед
  // заливкой в сотни килобайт — цена, которую не стоит и обсуждать.
  if (!force) {
    const there = await statCopy(hands.value)
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

  const sent = await writeCopy(hands.value, built.text)
  if (!sent.ok) return sent

  // Отметка о копии пишется ПОСЛЕ успеха: обещание копии, которой нет,
  // хуже отсутствия копии: на первое человек полагается.
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', built.file.savedAt)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', built.file.count)
  await rememberSeen(hands.value)

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
  const hands = await pass()
  if (!hands.ok) return hands

  const found = await statCopy(hands.value)
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
  const hands = await pass()
  if (!hands.ok) return hands

  await initCollection()

  const got = await readCopy(hands.value)
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

  // Копия, которую только что прочли, с этого момента знакомая: сохранение
  // поверх неё спрашивать не должно. Заодно числа на панели перестают
  // говорить о прошлой своей записи там, где в облаке уже другая копия.
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', file.savedAt)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', file.count)
  await rememberSeen(hands.value)

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
