// Виджет хронологии франшизы: тайтлы по годам со статусом из списка пользователя.
// Данные требуют двух запросов, а mount() синхронный: готовый блок кэшируется в модуле.
// Когда карточки Shikimori нет вовсе, виджет молчит: об этом уже сказали рейтинги.

import { anilistQuery } from '@/api/anilist'
import { fetchShiki, shikimoriTrouble } from '@/api/shikimori'
import { amApplyAccentToDom } from '@/core/accent'
import { settings } from '@/core/settings'
import type { MediaType } from '@/core/types'
import { Logger } from '@/utils/logger'
import type { MediaContext, MediaWidget } from './types'

/** Сам блок франшизы. Исключаем темы и ссылки: они переиспользуют тот же класс для вида. */
const BOX_SELECTOR = '.animori-franchise:not(.animori-themes):not(.animori-extlinks)'
const COLLAPSE_THRESHOLD = 5

const FRANCHISE_MAP_QUERY = `query ($m: [Int], $t: MediaType) {
  Page {
    media(idMal_in: $m, type: $t) {
      id
      idMal
      type
      mediaListEntry { status }
    }
  }
}`

interface FranchiseNode {
  id?: number | null
  name?: string | null
  url?: string | null
  year?: number | null
  kind?: string | null
}

interface FranchiseResponse {
  nodes?: FranchiseNode[] | null
}

type ListStatus = 'COMPLETED' | 'CURRENT' | 'PLANNING' | 'REPEATING' | 'PAUSED' | 'DROPPED'

interface MapMediaItem {
  id: number
  idMal?: number | null
  type?: MediaType | null
  mediaListEntry?: { status?: string | null } | null
}

interface FranchiseMapResponse {
  Page?: { media?: Array<MapMediaItem | null> | null } | null
}

interface StatusLabel {
  anime: string
  manga: string
  color: string
}

const STATUS_LABELS: Record<ListStatus, StatusLabel> = {
  COMPLETED: { anime: ' (Просмотрено)', manga: ' (Прочитано)', color: '#a6e3a1' },
  CURRENT: { anime: ' (Смотрю)', manga: ' (Читаю)', color: '#89b4fa' },
  PLANNING: { anime: ' (В планах)', manga: ' (В планах)', color: '#cba6f7' },
  REPEATING: { anime: ' (Пересматриваю)', manga: ' (Перечитываю)', color: '#f5c2e7' },
  PAUSED: { anime: ' (Отложено)', manga: ' (Отложено)', color: '#f9e2af' },
  DROPPED: { anime: ' (Брошено)', manga: ' (Брошено)', color: '#f38ba8' },
}

const SHIKI_ONLY_LABEL = ' (Только на Shiki)'
const SHIKI_ONLY_COLOR = '#a0aec0'

/** Готовый блок и тайтл, для которого он построен. */
let builtAniId: number | null = null
let builtBox: HTMLElement | null = null

/** Замок: для какого тайтла сейчас идёт загрузка. */
let loadingAniId: number | null = null

/**
 * Для какого тайтла сетевая часть уже отработана — независимо от того, появился ли блок.
 * Без этого тайтлы без франшизы бомбардировали API на каждую мутацию страницы.
 */
let settledAniId: number | null = null

function isStatus(value: string | null | undefined): value is ListStatus {
  return (
    value === 'COMPLETED' ||
    value === 'CURRENT' ||
    value === 'PLANNING' ||
    value === 'REPEATING' ||
    value === 'PAUSED' ||
    value === 'DROPPED'
  )
}

/** Пользователь всё ещё на той же странице? После await проверять обязательно. */
function isStillOnPage(aniId: number): boolean {
  const parts = window.location.pathname.split('/')
  const section = parts[1]
  const rawId = parts[2]
  if (section !== 'anime' && section !== 'manga') return false
  return parseInt(rawId ?? '', 10) === aniId
}

/** Центрирует список на текущем тайтле, чтобы в свёрнутом виде было видно «Сейчас здесь». */
function scrollToActive(box: HTMLElement): void {
  const list = box.querySelector<HTMLElement>('.franchise-list')
  if (!list || list.classList.contains('expanded')) return
  const active = list.querySelector<HTMLElement>('.active')
  if (!active) return
  list.scrollTop = active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2
}

/**
 * Место блока: сразу перед родным блоком связей AniList, а если его нет — в конец сайдбара.
 * React при перерисовке может вернуть свой блок связей выше нашего, поэтому порядок подправляется.
 */
function placeBox(box: HTMLElement, ctx: MediaContext): void {
  const relations = document.querySelector('.relations')
  const existing = document.querySelector<HTMLElement>(BOX_SELECTOR)

  if (!existing) {
    if (relations) relations.before(box)
    else if (ctx.sidebar) ctx.sidebar.append(box)
    else return

    amApplyAccentToDom()
    window.setTimeout(() => scrollToActive(box), 100)
    return
  }

  if (relations && existing.parentNode === ctx.sidebar) {
    relations.before(existing)
    window.setTimeout(() => scrollToActive(existing), 100)
  }
}

/**
 * Блок с одной строкой причины вместо хронологии.
 * Класс тот же, что у настоящего блока: его снимает тот же cleanup и возвращает тот же placeBox.
 */
function buildTroubleBox(reason: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'animori-franchise am-accent-scope'

  const heading = document.createElement('h2')
  heading.textContent = 'Хронология Франшизы'
  box.appendChild(heading)

  const note = document.createElement('div')
  note.className = 'am-net-note'
  note.textContent =
    `Shikimori ${reason}: хронологию сейчас не у кого запросить. ` +
    `Она появится сама, когда источник снова ответит. ` +
    `Подробности — в настройках, вкладка «Разработчик».`
  note.style.cssText =
    'padding: 8px 10px; border-radius: 6px; font-size: 0.85em; line-height: 1.35;' +
    ' color: rgb(var(--color-text-light)); background: rgba(var(--color-red, 252,129,129), 0.10);'
  box.appendChild(note)

  return box
}

/** Строка списка: год, название, статус и тип тайтла. */
function createNode(
  node: FranchiseNode,
  mapped: MapMediaItem | undefined,
  ctx: MediaContext,
): HTMLAnchorElement {
  const link = document.createElement('a')
  const isCurrentPage = typeof node.id === 'number' && node.id === ctx.malData.idMal
  const alId = mapped?.id ?? null

  link.className = 'franchise-node' + (isCurrentPage ? ' active' : '')

  let statusText = ''
  let statusColor = ''

  if (alId) {
    link.href = '/' + ctx.malData.type.toLowerCase() + '/' + String(alId)

    const status = mapped?.mediaListEntry?.status
    if (isStatus(status)) {
      const label = STATUS_LABELS[status]
      statusText = mapped?.type === 'MANGA' ? label.manga : label.anime
      statusColor = label.color
      if (!isCurrentPage) {
        link.style.borderLeftColor = statusColor
        link.style.background = statusColor + '15'
      }
    }
  } else {
    // Тайтла нет в каталоге AniList — ведём на Shikimori.
    link.href = 'https://' + ctx.shikiDomain + (node.url ?? '')
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.classList.add('shiki-only')
    statusText = SHIKI_ONLY_LABEL
    statusColor = SHIKI_ONLY_COLOR
  }

  const year = document.createElement('div')
  year.className = 'node-year'
  year.textContent = node.year ? String(node.year) : '???'

  const title = document.createElement('div')
  title.className = 'node-title'
  const titleText = document.createElement('span')
  titleText.textContent = node.name ?? ''
  title.appendChild(titleText)

  if (statusText) {
    const status = document.createElement('span')
    status.textContent = statusText
    status.style.color = statusColor
    status.style.fontSize = '0.85em'
    status.style.fontWeight = 'bold'
    status.style.marginLeft = '8px'
    title.appendChild(status)
  }

  if (isCurrentPage) {
    const here = document.createElement('span')
    here.textContent = ' ⬅ Сейчас здесь'
    here.style.color = 'rgb(var(--color-blue))'
    here.style.fontSize = '0.85em'
    here.style.fontWeight = 'bold'
    here.style.marginLeft = statusText ? '4px' : '8px'
    title.appendChild(here)
  }

  const kind = document.createElement('div')
  kind.className = 'node-kind'
  kind.textContent = node.kind ?? ''

  link.append(year, title, kind)
  return link
}

/** Кнопки разворачивания. Верхняя нужна для крупных франшиз: нижняя уезжает за экран. */
function addToggles(
  box: HTMLElement,
  heading: HTMLElement,
  list: HTMLElement,
  total: number,
): void {
  const topToggle = document.createElement('button')
  topToggle.type = 'button'
  topToggle.className = 'franchise-toggle franchise-toggle-top'
  topToggle.textContent = 'Свернуть ▲'
  topToggle.style.display = 'none'
  heading.after(topToggle)

  const bottomToggle = document.createElement('button')
  bottomToggle.type = 'button'
  bottomToggle.className = 'franchise-toggle'
  bottomToggle.textContent = 'Развернуть (' + String(total) + ') ▼'

  let expanded = false
  const setExpanded = (state: boolean): void => {
    expanded = state
    list.classList.toggle('expanded', expanded)
    topToggle.style.display = expanded ? 'block' : 'none'
    bottomToggle.textContent = expanded ? 'Свернуть ▲' : 'Развернуть (' + String(total) + ') ▼'
    if (!expanded) {
      window.setTimeout(() => {
        scrollToActive(box)
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 50)
    }
  }

  topToggle.addEventListener('click', () => setExpanded(false))
  bottomToggle.addEventListener('click', () => setExpanded(!expanded))
  box.appendChild(bottomToggle)
}

/** Сортировка по году, затем по ID: тайтлы без года уходят в конец списка. */
function sortNodes(nodes: FranchiseNode[]): FranchiseNode[] {
  return [...nodes].sort((a, b) => {
    const yearA = a.year ?? Number.POSITIVE_INFINITY
    const yearB = b.year ?? Number.POSITIVE_INFINITY
    if (yearA !== yearB) return yearA - yearB
    return (a.id ?? 0) - (b.id ?? 0)
  })
}

/** Карта MAL ID → тайтл AniList вместе со статусом в списке пользователя. */
async function loadAniListMap(
  malIds: number[],
  type: MediaType,
): Promise<Map<number, MapMediaItem>> {
  const map = new Map<number, MapMediaItem>()
  if (malIds.length === 0) return map

  // useAuth: без токена запрос всё равно вернёт тайтлы, только без mediaListEntry.
  const res = await anilistQuery<FranchiseMapResponse>(
    FRANCHISE_MAP_QUERY,
    { m: malIds, t: type },
    true,
  )

  for (const item of res.data?.Page?.media ?? []) {
    if (!item || typeof item.idMal !== 'number') continue
    map.set(item.idMal, item)
  }
  return map
}

/** Загружает франшизу и собирает блок. Вызывается один раз на тайтл. */
async function buildFranchise(ctx: MediaContext): Promise<void> {
  const aniId = ctx.aniId
  const malId = ctx.malData.idMal
  if (!malId) return

  try {
    const res = await fetchShiki<FranchiseResponse>(
      '/api/' + ctx.endpoint + '/' + String(malId) + '/franchise',
    )
    // Пользователь ушёл — НЕ помечаем тайтл отработанным: при возврате блок нужен.
    if (!isStillOnPage(aniId)) return

    // С этой точки сетевая часть считается выполненной для этого тайтла.
    settledAniId = aniId

    const nodes = res.data?.nodes ?? []
    // Один узел — это сам тайтл, хронологию рисовать нечего.
    if (nodes.length <= 1) return

    const sorted = sortNodes(nodes)
    const malIds = sorted
      .map((node) => node.id)
      .filter((id): id is number => typeof id === 'number')

    const map = await loadAniListMap(malIds, ctx.malData.type)
    if (!isStillOnPage(aniId)) return

    const box = document.createElement('div')
    box.className = 'animori-franchise am-accent-scope'

    const heading = document.createElement('h2')
    heading.textContent = 'Хронология Франшизы'
    box.appendChild(heading)

    const list = document.createElement('div')
    list.className = 'franchise-list'
    box.appendChild(list)

    for (const node of sorted) {
      const mapped = typeof node.id === 'number' ? map.get(node.id) : undefined
      list.appendChild(createNode(node, mapped, ctx))
    }

    if (sorted.length > COLLAPSE_THRESHOLD) addToggles(box, heading, list, sorted.length)

    builtAniId = aniId
    builtBox = box
    placeBox(box, ctx)
  } catch (e) {
    // Сбой тоже считается отработанным: иначе при мёртвых зеркалах будет цикл повторов.
    if (isStillOnPage(aniId)) {
      settledAniId = aniId

      // Заглушка — только при устойчивом молчании: одиночный сбой лечит следующий переход.
      const reason = shikimoriTrouble()
      if (reason && !document.querySelector(BOX_SELECTOR)) {
        const box = buildTroubleBox(reason)
        builtAniId = aniId
        builtBox = box
        placeBox(box, ctx)
      }
    }
    Logger('ERROR', '[Franchise] Не удалось построить хронологию франшизы', e)
  } finally {
    if (loadingAniId === aniId) loadingAniId = null
  }
}

function mount(ctx: MediaContext): void {
  if (!settings.enableFranchise) return
  if (!ctx.shikiData) return
  if (!ctx.malData.idMal) return

  // Сменился тайтл — старый блок и все отметки больше не нужны.
  if (builtAniId !== null && builtAniId !== ctx.aniId) {
    builtAniId = null
    builtBox = null
  }
  if (settledAniId !== null && settledAniId !== ctx.aniId) {
    settledAniId = null
  }

  // Блок уже собран: возвращаем его на место без повторных запросов.
  if (builtBox && builtAniId === ctx.aniId) {
    placeBox(builtBox, ctx)
    return
  }

  // Сеть по этому тайтлу уже ходила и блока не вышло: каждая мутация стоила бы запроса.
  if (settledAniId === ctx.aniId) return

  if (loadingAniId === ctx.aniId) return
  loadingAniId = ctx.aniId
  void buildFranchise(ctx)
}

export const franchiseWidget: MediaWidget = {
  name: 'franchise',
  cleanupSelectors: [BOX_SELECTOR],
  mount,
}
