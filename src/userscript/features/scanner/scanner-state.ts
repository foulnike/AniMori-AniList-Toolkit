// Реактивное состояние сканера: SFC остаётся тонким слоем разметки.
//
// Цепочка намеренно разведена на две части:
//   snapshot -> diffA/diffM/stats/fav* (тяжёлые, пересчёт только после скана)
//   diff* + ignore -> секции (дешёвая фильтрация массивов)
// Иначе каждый клик по ✕ пересчитывает всё сравнение целиком. Снапшот лежит
// в shallowRef: внутри Map на десятки тысяч записей, глубокая реактивность тут вредит.

import { computed, ref, shallowRef } from 'vue'
import type { CmpAniListEntry, CmpShikiEntry } from '@/core/types'
import { Logger } from '@/utils/logger'
import {
  CMP_STATUS_ORDER,
  ScanCancelled,
  cmpDiff,
  cmpFavDiff,
  cmpGetIgnore,
  cmpNameDiff,
  cmpSaveIgnore,
  cmpStatusLabel,
  cmpStats,
  createCancelToken,
  fetchViewerName,
  getSavedShikiLogin,
  loadScannerStorage,
  runCompareScan,
} from './compare'
import type { CancelToken, CmpDiffResult, CmpScanSnapshot } from './compare'

/** Предел вывода строк в одной секции. Остальное сворачивается в «…ещё N». */
export const CMP_SECTION_LIMIT = 500

export interface DiffRow {
  /** malId без знака. Знак добавляется только при записи в игнор-лист. */
  id: number
  title: string
  /** Правая колонка строки: либо статус, либо «S: x | A: y». */
  meta: string
}

export interface DiffSection {
  key: string
  label: string
  /** 1 для аниме, -1 для манги — знак идентификатора в игнор-листе. */
  sign: 1 | -1
  /** У расхождений крестик есть у каждой строки; у имён из избранного — нет. */
  ignorable: boolean
  rows: DiffRow[]
}

// ==== Состояние ====

export const isScannerOpen = ref(false)
export const shikiLogin = ref('')
export const alName = ref('')
/** Подсказка в поле AniList: имя из Viewer{name}, запрашивается один раз на открытие. */
export const alPlaceholder = ref('Имя AniList (авто по токену)')
export const deepCheck = ref(false)
export const isScanning = ref(false)
export const statusText = ref('')
export const progressStep = ref(0)
export const progressTotal = ref(0)

const snapshot = shallowRef<CmpScanSnapshot | null>(null)
const ignore = ref<Set<number>>(new Set())
let cancelToken: CancelToken | null = null
let placeholderLoaded = false

export const hasResult = computed(() => snapshot.value !== null)

/** Строка счётчика вида «3/7». Пуста, пока скан не запущен. */
export const progressLabel = computed(() =>
  progressTotal.value > 0 ? `${progressStep.value}/${progressTotal.value}` : '',
)

// ==== Игнор-лист ====
//
// Знак id — формат хранилища, менять нельзя: аниме +malId, манга -malId.

function signedId(id: number, sign: 1 | -1): number {
  return id * sign
}

export function addIgnore(id: number, sign: 1 | -1): void {
  const next = new Set(ignore.value)
  next.add(signedId(id, sign))
  ignore.value = next
  cmpSaveIgnore(next)
}

export function removeIgnore(signed: number): void {
  const next = new Set(ignore.value)
  next.delete(signed)
  ignore.value = next
  cmpSaveIgnore(next)
}

function isIgnored(id: number, sign: 1 | -1): boolean {
  return ignore.value.has(signedId(id, sign))
}

/** Название для строки игнор-листа: ищется в картах списков и избранного по знаку. */
function titleOf(signed: number): string {
  const s = snapshot.value
  const id = Math.abs(signed)
  if (!s) return 'MAL#' + id
  const maps: Array<Map<number, CmpShikiEntry | CmpAniListEntry>> =
    signed > 0 ? [s.shA, s.alA] : [s.shM, s.alM]
  for (const m of maps) {
    const hit = m.get(id)
    if (hit) return hit.title
  }
  const favMaps: Array<Map<number, string>> =
    signed > 0 ? [s.shFav.anime, s.alFavA] : [s.shFav.manga, s.alFavM]
  for (const m of favMaps) {
    const hit = m.get(id)
    if (hit) return hit
  }
  return 'MAL#' + id
}

export const ignoreList = computed(() =>
  [...ignore.value].map((signed) => ({
    signed,
    kind: signed > 0 ? 'аниме' : 'манга',
    title: titleOf(signed),
  })),
)

// ==== Производные от снапшота (тяжёлые) ====

const diffAnime = computed<CmpDiffResult | null>(() => {
  const s = snapshot.value
  return s ? cmpDiff(s.shA, s.alA, 'anime') : null
})

const diffManga = computed<CmpDiffResult | null>(() => {
  const s = snapshot.value
  return s ? cmpDiff(s.shM, s.alM, 'manga') : null
})

export const statsAnime = computed(() => {
  const s = snapshot.value
  return s ? { shiki: cmpStats(s.shA), al: cmpStats(s.alA) } : null
})

export const statsManga = computed(() => {
  const s = snapshot.value
  return s ? { shiki: cmpStats(s.shM), al: cmpStats(s.alM) } : null
})

export const statusRows = computed(() =>
  CMP_STATUS_ORDER.map((key) => ({ key, label: cmpStatusLabel(key) })),
)

const favAnime = computed(() => {
  const s = snapshot.value
  return s ? cmpFavDiff(s.shFav.anime, s.alFavA) : null
})

const favManga = computed(() => {
  const s = snapshot.value
  return s ? cmpFavDiff(s.shFav.manga, s.alFavM) : null
})

const favCharacters = computed(() => {
  const s = snapshot.value
  return s ? cmpNameDiff(s.shFav.characters, s.alFavChar) : null
})

const favStaff = computed(() => {
  const s = snapshot.value
  return s ? cmpNameDiff(s.shFav.people, s.alFavStaff) : null
})

// ==== Секции расхождений ====

/**
 * Сборка секций одного типа (аниме либо манга). Порядок и подписи секций —
 * канон из прежней версии, менять их нельзя.
 *
 * При глубокой проверке списки того, что есть только в одном из сервисов, разбиваются
 * надвое по наличию в чужом каталоге: то, что есть — можно добавить, чего нет —
 * расхождение неустранимо.
 */
function buildSections(diff: CmpDiffResult, sign: 1 | -1, type: 'anime' | 'manga'): DiffSection[] {
  const cat = snapshot.value?.catalog ?? null
  const out: DiffSection[] = []
  const info = (rows: Array<{ id: number; title: string; info: string }>): DiffRow[] =>
    rows.map((r) => ({ id: r.id, title: r.title, meta: r.info }))
  const pair = (
    rows: Array<{ id: number; title: string; shiki: string | number; al: string | number }>,
  ): DiffRow[] =>
    rows.map((r) => ({ id: r.id, title: r.title, meta: `S: ${r.shiki} | A: ${r.al}` }))
  const add = (key: string, label: string, rows: DiffRow[]): void => {
    out.push({ key: `${type}-${key}`, label, sign, ignorable: true, rows })
  }

  if (cat) {
    add(
      'only-shiki-have',
      'Только на Shikimori — ЕСТЬ в каталоге AniList (можно добавить)',
      info(diff.onlyShiki.filter((x) => cat.alHas.has(x.id))),
    )
    add(
      'only-shiki-missing',
      'Только на Shikimori — НЕТ в каталоге AniList',
      info(diff.onlyShiki.filter((x) => !cat.alHas.has(x.id))),
    )
    add(
      'only-al-have',
      'Только на AniList — ЕСТЬ в каталоге Shikimori (можно добавить)',
      info(diff.onlyAl.filter((x) => cat.shikiHas.has(x.id))),
    )
    add(
      'only-al-missing',
      'Только на AniList — НЕТ в каталоге Shikimori',
      info(diff.onlyAl.filter((x) => !cat.shikiHas.has(x.id))),
    )
  } else {
    add('only-shiki', 'В списке только на Shikimori', info(diff.onlyShiki))
    add('only-al', 'В списке только на AniList', info(diff.onlyAl))
  }

  add(
    'related',
    'Связано с уже отслеживаемым (деление на сезоны / сиквелы)',
    info([...diff.onlyShikiRel, ...diff.onlyAlRel]),
  )
  add('status', 'Разный статус', pair(diff.status))
  add('score', 'Разная оценка', pair(diff.score))
  add('progress', 'Разный прогресс', pair(diff.progress))
  add('rewatch', 'Разные пересмотры', pair(diff.rewatch))
  add('notes', 'Разные заметки', pair(diff.notes))
  return out
}

/** Фильтрация игнора и выбрасывание пустых блоков — дешёвая часть цепочки. */
function visible(sections: DiffSection[]): DiffSection[] {
  return sections
    .map((s) => (s.ignorable ? { ...s, rows: s.rows.filter((r) => !isIgnored(r.id, s.sign)) } : s))
    .filter((s) => s.rows.length > 0)
}

export const animeSections = computed<DiffSection[]>(() => {
  const d = diffAnime.value
  return d ? visible(buildSections(d, 1, 'anime')) : []
})

export const mangaSections = computed<DiffSection[]>(() => {
  const d = diffManga.value
  return d ? visible(buildSections(d, -1, 'manga')) : []
})

export const animeDiffCount = computed(() =>
  animeSections.value.reduce((acc, s) => acc + s.rows.length, 0),
)

export const mangaDiffCount = computed(() =>
  mangaSections.value.reduce((acc, s) => acc + s.rows.length, 0),
)

// ==== Избранное ====

/** Счётчики для шапки блока избранного: «Аниме: N Shiki / M AniList · Манга: …». */
export const favCounts = computed(() => {
  const a = favAnime.value
  const m = favManga.value
  if (!a || !m) return null
  return {
    animeShiki: a.shikiCount,
    animeAl: a.alCount,
    mangaShiki: m.shikiCount,
    mangaAl: m.alCount,
  }
})

export const favSections = computed<DiffSection[]>(() => {
  const a = favAnime.value
  const m = favManga.value
  if (!a || !m) return []
  const rows = (arr: Array<{ id: number; title: string }>): DiffRow[] =>
    arr.map((x) => ({ id: x.id, title: x.title, meta: '' }))
  return visible([
    {
      key: 'fav-anime-shiki',
      label: 'Избранное аниме: только в Shikimori',
      sign: 1,
      ignorable: true,
      rows: rows(a.onlyShiki),
    },
    {
      key: 'fav-anime-al',
      label: 'Избранное аниме: только в AniList',
      sign: 1,
      ignorable: true,
      rows: rows(a.onlyAl),
    },
    {
      key: 'fav-manga-shiki',
      label: 'Избранное манга: только в Shikimori',
      sign: -1,
      ignorable: true,
      rows: rows(m.onlyShiki),
    },
    {
      key: 'fav-manga-al',
      label: 'Избранное манга: только в AniList',
      sign: -1,
      ignorable: true,
      rows: rows(m.onlyAl),
    },
  ])
})

/** «Избранное совпадает» считается только по аниме и манге, без имён. */
export const favIsEqual = computed(() => favCounts.value !== null && favSections.value.length === 0)

/** Блоки персонажей и стаффа: матч по имени, без id и без игнора. */
export const nameFavBlocks = computed(() => {
  const c = favCharacters.value
  const s = favStaff.value
  if (!c || !s) return []
  const build = (label: string, d: NonNullable<typeof c>) => ({
    key: label,
    label,
    shikiCount: d.shikiCount,
    alCount: d.alCount,
    sections: [
      {
        key: `${label}-shiki`,
        label: `${label}: только в Shikimori`,
        sign: 1 as const,
        ignorable: false,
        rows: d.onlyShiki.map((x, i) => ({ id: i, title: x.title, meta: '' })),
      },
      {
        key: `${label}-al`,
        label: `${label}: только в AniList`,
        sign: 1 as const,
        ignorable: false,
        rows: d.onlyAl.map((x, i) => ({ id: i, title: x.title, meta: '' })),
      },
    ].filter((sec) => sec.rows.length > 0),
  })
  return [build('Избранные персонажи', c), build('Избранный стафф', s)]
})

// ==== Действия ====

export async function openScanner(): Promise<void> {
  // Игнор-лист и запомненный логин ждём ДО показа окна: иначе окно откроется
  // с пустым полем логина, а скрытые ранее тайтлы на мгновение выскочат в списке.
  // Чтение одноразовое, задержка есть только при первом открытии.
  await loadScannerStorage()
  isScannerOpen.value = true
  if (!shikiLogin.value) shikiLogin.value = getSavedShikiLogin()
  ignore.value = cmpGetIgnore()
  if (placeholderLoaded) return
  placeholderLoaded = true
  try {
    const name = await fetchViewerName()
    if (name) alPlaceholder.value = name + ' (по токену)'
  } catch (e) {
    // Подсказка необязательна: без токена остаётся исходный плейсхолдер.
    Logger('INFO', 'Сканер сравнения: имя AniList для подсказки недоступно (нет токена?)', e)
  }
}

export function closeScanner(): void {
  isScannerOpen.value = false
}

/** Мягкая отмена: запросы не рвём, процесс встанет на ближайшей границе шага/чанка. */
export function cancelScan(): void {
  if (!cancelToken || !isScanning.value) return
  cancelToken.cancelled = true
  statusText.value = 'Отмена... ждём завершения текущего запроса.'
}

export async function startScan(): Promise<void> {
  if (isScanning.value) return
  const login = shikiLogin.value.trim()
  if (!login) {
    statusText.value = 'Укажите логин Shikimori.'
    return
  }
  const token = createCancelToken()
  cancelToken = token
  isScanning.value = true
  progressStep.value = 0
  progressTotal.value = deepCheck.value ? 7 : 6
  statusText.value = 'Начинаю...'
  try {
    const { snapshot: snap, summary } = await runCompareScan({
      shikiLogin: login,
      alName: alName.value.trim(),
      deepCheck: deepCheck.value,
      token,
      onProgress: (p) => {
        progressStep.value = p.step
        progressTotal.value = p.total
        statusText.value = p.text
      },
    })
    snapshot.value = snap
    statusText.value = summary
  } catch (e) {
    if (e instanceof ScanCancelled) {
      statusText.value = 'Сканирование отменено.'
      Logger('INFO', 'Сканер сравнения: скан отменён пользователем')
    } else {
      const msg = e instanceof Error ? e.message : String(e)
      statusText.value = 'Ошибка: ' + msg
      Logger('ERROR', 'Сканер сравнения: скан завершился ошибкой', e)
    }
  } finally {
    isScanning.value = false
    cancelToken = null
  }
}
