// Датасет названий: слепок выпуска animori-data на диске, читаемый без сети.
// Четвёртая ступень пути имени — между памятью запуска и складом IndexedDB:
// датасет свежее и полнее склада, а чтение стоит обращение к памяти.
//
// Обновление повторяет схему updater.rs: опись, сверка даты сборки, загрузка
// фоном, проверка отпечатков, замена целиком, применение со следующего запуска.
//
// ПОРОГ ПРОВЕРКИ
// Выпуск публикуется раз в неделю, а опись спрашивалась каждый запуск: тридцать
// пять запросов на одну публикацию у того, кто открывает программу пять раз
// в день. Теперь между проверками держится LIFE_DATASET_CHECK с разбросом по
// ключу, а сама проверка идёт с If-None-Match — почти всегда ответ без тела.
// Час проверки и отпечаток лежат в хранилище окна, а не в памяти запуска:
// весь смысл порога в том, чтобы переживать перезапуск.

import { Bridge } from '@/bridge'
import {
  fetchDatasetIndex,
  fetchDatasetPayload,
  type DatasetFileRef,
  type DatasetIndex,
  type DatasetMapPayload,
  type DatasetTitlesPayload,
} from '../api/dataset'
import { Logger } from '../utils/logger'
import { isFresh, LIFE_DATASET_CHECK } from './cache-life'
import { getEntry } from './collection'

/** Имя файла в приватном каталоге. Разрешённые имена живут в src-tauri/src/files.rs. */
const DATASET_FILE = 'animori-dataset.json'

/** Имена файлов выпуска выбираются точно: под маску подходят соседние. */
const FILE_TITLES = 'titles-anime.json.gz'
const FILE_MAP = 'map-mal-anilist.json.gz'

/**
 * Ключи в хранилище окна. Не в core/settings.ts сознательно: это не выбор
 * человека, а служебная память модуля, и в панели настроек ей нечего делать.
 */
const CHECKED_AT_KEY = 'am_dataset_checked_at'
const ETAG_KEY = 'am_dataset_etag'

/** Слепок одного выпуска на диске: имена и карта, записанные одной операцией. */
interface DatasetFile {
  v: number
  builtAt: string
  sourceTag: string
  license: string
  titles: DatasetTitlesPayload['titles']
  pairs: DatasetMapPayload['pairs']
}

/** Имена по номеру MAL. Пустая строка — ответ «перевода нет», а не пропуск. */
let titlesByMal: Map<number, string> | null = null

/** Обратная карта: номер AniList → номер MAL. */
let byAnilist: Map<number, number> | null = null

/** Дата сборки установленного выпуска: по ней решается, новее ли опись. */
let installedBuiltAt = ''

/** Подъём с диска случается один раз: второй вызов ждёт первый. */
let loading: Promise<boolean> | null = null

/** Идущее обновление: вторая проверка в том же запуске не нужна. */
let updating: Promise<void> | null = null

/** Разбор файла в память. Битый или чужой файл равен его отсутствию. */
function parseDataset(raw: string): boolean {
  let data: DatasetFile
  try {
    data = JSON.parse(raw) as DatasetFile
  } catch (e) {
    Logger('WARN', 'Датасет: файл на диске не читается как JSON', e)
    return false
  }

  if (data.v !== 1) {
    Logger('WARN', `Датасет: не та версия файла (${data.v})`)
    return false
  }
  if (!Array.isArray(data.titles) || !Array.isArray(data.pairs)) {
    Logger('WARN', 'Датасет: в файле нет массивов имен или пар')
    return false
  }

  const titles = new Map<number, string>()
  for (const row of data.titles) {
    if (!row || typeof row.id !== 'number') continue
    titles.set(row.id, typeof row.russian === 'string' ? row.russian : '')
  }

  const reverse = new Map<number, number>()
  for (const pair of data.pairs) {
    if (!Array.isArray(pair)) continue
    const [mal, anilist] = pair
    if (typeof mal === 'number' && typeof anilist === 'number') reverse.set(anilist, mal)
  }

  titlesByMal = titles
  byAnilist = reverse
  installedBuiltAt = typeof data.builtAt === 'string' ? data.builtAt : ''
  return true
}

/**
 * Поднимает датасет с диска. Зовётся на старте и из первого запроса имени:
 * обещание общее, так что цена чтения одна на всех. Отсутствие файла —
 * штатный исход первого запуска, а не сбой.
 */
export function initDatasetNames(): Promise<boolean> {
  if (loading) return loading

  loading = (async () => {
    if (!Bridge.files.available) return false

    const raw = await Bridge.files.read(DATASET_FILE)
    if (raw === null) return false

    const parsed = parseDataset(raw)
    if (!parsed) {
      Logger('WARN', `Датасет: файл на диске не разобран (${raw.length} байт), работаем без него`)
      return false
    }

    Logger('DB', `Датасет поднят: имён ${titlesByMal?.size ?? 0}, пар ${byAnilist?.size ?? 0}`)
    return true
  })()

  return loading
}

/** Что ответил датасет на вопрос об имени тайтла. */
export type DatasetAnswer =
  | { kind: 'name'; name: string }
  /** Выпуск знает тайтл и отвечает: русского имени нет. Сеть не спрашивается. */
  | { kind: 'none' }
  /** Тайтла в выпуске нет: дальше склад и сеть, как прежде. */
  | { kind: 'unknown' }

/**
 * Русское имя из датасета по номеру AniList. Номер MAL берётся из своей
 * записи списка, когда она есть, — его дал сам AniList, — а иначе из
 * обратной карты выпуска.
 */
export async function lookupDatasetName(mediaId: number): Promise<DatasetAnswer> {
  const ok = await initDatasetNames()
  if (!ok || !titlesByMal) return { kind: 'unknown' }

  const malId = getEntry(mediaId)?.malId ?? byAnilist?.get(mediaId) ?? null
  if (malId === null) return { kind: 'unknown' }

  const russian = titlesByMal.get(malId)
  if (russian === undefined) return { kind: 'unknown' }
  return russian === '' ? { kind: 'none' } : { kind: 'name', name: russian }
}

/**
 * Номер MAL по номеру AniList из установленного выпуска, без сети.
 *
 * Своя запись списка спрашивается первой по той же причине, что и у имени:
 * там номер дал сам AniList, и он точнее любого слепка. Карта выпуска —
 * вторая ступень: две трети всех пар лежат на диске и не меняются никогда.
 *
 * Синхронная сознательно: зовётся из сетевого слоя в цикле по пачке тайтлов,
 * и обещание на каждый номер там ни к чему. Датасет к тому моменту уже поднят:
 * вызывающая сторона дожидается initDatasetNames один раз на всю пачку.
 * Пустота значит «в выпуске этой пары нет», а не «пары не существует».
 */
export function datasetMalId(mediaId: number): number | null {
  const own = getEntry(mediaId)?.malId
  if (typeof own === 'number' && own > 0) return own

  return byAnilist?.get(mediaId) ?? null
}

/** Состояние датасета для карточки «О программе»: честный снимок без сети. */
export interface DatasetStatus {
  loaded: boolean
  builtAt: string | null
  names: number
  pairs: number
}

/**
 * Что поднято в память этим запуском. Обновление, приехавшее фоном, сюда
 * не попадает сознательно: оно работает со следующего запуска, и показывать
 * его раньше времени было бы враньём.
 */
export function datasetStatus(): DatasetStatus {
  const loaded = titlesByMal !== null

  return {
    loaded,
    builtAt: loaded ? installedBuiltAt : null,
    names: titlesByMal?.size ?? 0,
    pairs: byAnilist?.size ?? 0,
  }
}

/** Строка описи по точному имени файла: маска ловит соседей, как в сборщике. */
function findFile(index: DatasetIndex, name: string): DatasetFileRef | null {
  return index.files.find((file) => file.name === name) ?? null
}

/** Годны ли распакованные файлы: числа и дата сборки обязаны сойтись с описью. */
function payloadOk(
  index: DatasetIndex,
  titles: DatasetTitlesPayload,
  map: DatasetMapPayload,
): boolean {
  return (
    Array.isArray(titles.titles) &&
    Array.isArray(map.pairs) &&
    titles.count === titles.titles.length &&
    map.count === map.pairs.length &&
    titles.builtAt === index.builtAt &&
    map.builtAt === index.builtAt
  )
}

/** Сброс состояния для изолированных тестов запуска. На проде не используется. */
export function resetDatasetNames(): void {
  titlesByMal = null
  byAnilist = null
  installedBuiltAt = ''
  loading = null
  updating = null
}

/**
 * Пора ли спрашивать опись. Разброс считается от даты установленной сборки:
 * берём её в ключ, чтобы у разных установок проверки не сошлись в один час
 * после общей публикации. Пустой час проверки — первый запуск: спрашиваем.
 */
function dueForCheck(checkedAt: number): boolean {
  return !isFresh(`dataset:${installedBuiltAt}`, checkedAt, LIFE_DATASET_CHECK)
}

/**
 * Фоновая сверка с последним выпуском. Новее — оба файла качаются, сверяются
 * по отпечаткам и заменяют слепок целиком. В память этого запуска обновление
 * не попадает: менять имена под рукой у человека нехорошо, новый выпуск
 * работает со следующего запуска.
 *
 * @param force Проверить несмотря на порог. Ставится только там, где проверку
 * затеял сам человек кнопкой: ему отказывать порогом нельзя, иначе кнопка
 * молчит без объяснений.
 */
export function updateDatasetNamesInBackground(force = false): Promise<void> | undefined {
  if (!Bridge.files.available || updating) return undefined

  updating = (async () => {
    // Сначала диск: сравнивать даты есть с чем только после подъёма.
    await initDatasetNames()

    const [checkedAt, knownEtag] = await Promise.all([
      Bridge.storage.get<number>(CHECKED_AT_KEY, 0),
      Bridge.storage.get<string>(ETAG_KEY, ''),
    ])

    if (!force && !dueForCheck(checkedAt)) {
      Logger('DB', 'Датасет: проверка выпуска ещё не к сроку')
      return
    }

    const answer = await fetchDatasetIndex(knownEtag || null)

    // Неудача час проверки не сдвигает: иначе один отказ сети на старте
    // отодвинул бы следующую попытку на полсуток на ровном месте.
    if (answer.kind === 'fail') return

    await Bridge.storage.set(CHECKED_AT_KEY, Date.now())

    // 304: сервер сам сказал, что опись та же. Тела нет, и сравнивать нечего.
    if (answer.kind === 'same') return

    const { index, etag } = answer
    if (etag !== '') await Bridge.storage.set(ETAG_KEY, etag)

    if (installedBuiltAt !== '' && index.builtAt <= installedBuiltAt) {
      Logger('DB', `Датасет актуален: сборка ${installedBuiltAt}`)
      return
    }

    const titlesRef = findFile(index, FILE_TITLES)
    const mapRef = findFile(index, FILE_MAP)
    if (!titlesRef || !mapRef) {
      Logger('WARN', 'Датасет: в описи нет нужных файлов')
      return
    }

    const titles = (await fetchDatasetPayload(titlesRef)) as DatasetTitlesPayload | null
    const map = (await fetchDatasetPayload(mapRef)) as DatasetMapPayload | null
    if (!titles || !map) return

    if (!payloadOk(index, titles, map)) {
      Logger('WARN', 'Датасет: содержимое не сошлось с описью, выпуск отклонён')
      return
    }

    const file: DatasetFile = {
      v: 1,
      builtAt: index.builtAt,
      sourceTag: index.sourceTag,
      license: index.license,
      titles: titles.titles,
      pairs: map.pairs,
    }

    const ok = await Bridge.files.write(DATASET_FILE, JSON.stringify(file))
    if (ok) {
      loading = null
      await initDatasetNames()
      Logger('DB', `Датасет обновлён до сборки ${index.builtAt}: имён ${titles.count}`)
    } else {
      Logger('WARN', 'Датасет: новый выпуск не записался на диск')
    }
  })()

  updating
    .catch((e) => {
      Logger('WARN', 'Датасет: фоновое обновление не удалось', e)
    })
    .finally(() => {
      updating = null
    })
  return updating
}
