// Каркас медиа-страницы: определяет открытый тайтл, грузит данные и зовёт виджеты.
// AniList на React пересобирает разметку и выкидывает вставленные узлы (РИСК №3).
// Поэтому виджеты ставятся не однократно, а по подписке registerMutationHook().

import { anilistQuery } from '../../api/anilist'
import { fetchShiki } from '../../api/shikimori'
import { SHIKI_DOMAINS } from '../../core/constants'
import { dbGet, dbSet } from '../../core/db'
import type { AniListMedia } from '../../core/types'
import { registerMutationHook } from '../translator'
import { hidePlayerButton } from '../ui/action-panel-state'
import { Logger } from '../../utils/logger'
import type { MediaAniListData, MediaContext, MediaShikiData, MediaWidget } from './types'

export type { MediaContext, MediaWidget } from './types'

const MEDIA_QUERY = `query ($id: Int) {
  Media(id: $id) {
    id
    type
    idMal
    seasonYear
    averageScore
    title { romaji english }
  }
}`

/** Сколько раз пробуем один тайтл, прежде чем ждать перехода или перезагрузки. */
const MAX_LOAD_ATTEMPTS = 3

/** Паузы перед повторами: сеть могла моргнуть, но долбить сервер подряд нельзя. */
const RETRY_DELAYS_MS = [2000, 5000, 10000]

/** Зарегистрированные виджеты в порядке добавления. */
const widgets: MediaWidget[] = []

/** ID тайтла, страница которого открыта сейчас. */
let currentMediaId: number | null = null

/** Загруженные данные текущего тайтла. null — данных ещё нет или они не нужны. */
let currentContext: MediaContext | null = null

/** Идёт ли загрузка: защита от параллельных запросов по одному тайтлу. */
let isLoading = false

/**
 * Дефект A4: пока шла загрузка, пришёл ещё один вызов — повторить проход после неё.
 * Раньше такой переход просто терялся, и страница оставалась полупустой до перезагрузки.
 */
let pendingRoute = false

/** Тайтл, на котором споткнулись, и число уже назначенных повторов. */
let failedMediaId: number | null = null
let failedAttempts = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

let isStarted = false

/**
 * Регистрирует виджет медиа-страницы.
 * Вызывать до initMedia(); порядок регистрации определяет порядок вставки.
 */
export function registerMediaWidget(widget: MediaWidget): void {
  widgets.push(widget)
}

/** Разбирает адрес страницы. null — это не страница тайтла. */
function parseMediaPath(): { endpoint: 'animes' | 'mangas'; aniId: number } | null {
  const parts = window.location.pathname.split('/')
  const section = parts[1]
  const rawId = parts[2]
  if (!rawId) return null
  if (section !== 'anime' && section !== 'manga') return null

  const aniId = parseInt(rawId, 10)
  if (!aniId) return null

  return { endpoint: section === 'manga' ? 'mangas' : 'animes', aniId }
}

/** Снимает со страницы всё, что вставили виджеты. Вызывается при переходе на другой тайтл. */
function cleanupWidgets(): void {
  for (const widget of widgets) {
    for (const selector of widget.cleanupSelectors) {
      document.querySelectorAll(selector).forEach((el) => el.remove())
    }
  }
}

/** Забывает неудачу: тайтл загрузился или пользователь ушёл на другой. */
function clearLoadFailure(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  failedMediaId = null
  failedAttempts = 0
}

/**
 * Сервер не ответил: снимаем отметку об открытом тайтле, иначе следующие проходы
 * решат, что работа сделана, и виджеты не появятся до перезагрузки страницы.
 * Повтор идёт по таймеру: страница дёргается часто, а сеть щадить надо.
 */
function scheduleLoadRetry(aniId: number): void {
  if (failedMediaId !== aniId) {
    failedMediaId = aniId
    failedAttempts = 0
  }

  currentMediaId = null

  if (failedAttempts >= MAX_LOAD_ATTEMPTS) {
    Logger(
      'WARN',
      `[Widget] ID: ${aniId}: попыток ${failedAttempts}, ждём перехода или перезагрузки`,
    )
    return
  }

  const delay = RETRY_DELAYS_MS[failedAttempts] ?? 10000
  failedAttempts++

  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null

    // За время паузы пользователь мог уйти: чужую страницу грузить незачем.
    const route = parseMediaPath()
    if (!route || route.aniId !== aniId) return

    void loadMediaPage()
  }, delay)

  Logger('WARN', `[Widget] ID: ${aniId}: данные не получены, повтор через ${delay}ms`)
}

/**
 * Вставляет или восстанавливает все виджеты. Безопасно вызывать сколько угодно раз.
 * Ошибка одного виджета не мешает остальным: один сбой убрал бы весь сайдбар.
 */
export function ensureMediaWidgets(): void {
  const ctx = currentContext
  if (!ctx) return

  const route = parseMediaPath()
  if (!route || route.aniId !== ctx.aniId) return

  ctx.sidebar = document.querySelector<HTMLElement>('.sidebar')

  for (const widget of widgets) {
    try {
      widget.mount(ctx)
    } catch (e) {
      Logger('WARN', `[Widget] Виджет ${widget.name} не удалось вставить`, e)
    }
  }
}

/** Данные AniList: сначала из кэша, при промахе или неполной записи — из GraphQL. */
async function loadAniListData(aniId: number): Promise<MediaAniListData | null> {
  const cached = (await dbGet<{ id: number; data: AniListMedia }>('malCache', aniId))?.data as
    MediaAniListData | undefined

  if (cached && typeof cached.averageScore === 'number') return cached

  const res = await anilistQuery<{ Media?: MediaAniListData | null }>(MEDIA_QUERY, { id: aniId })
  const media = res.data?.Media ?? null
  if (media) await dbSet('malCache', { id: aniId, data: media as unknown as AniListMedia })

  return media ?? cached ?? null
}

/**
 * Готовит контекст страницы: адрес, данные AniList, данные Shikimori.
 * После каждого await проверяется тот же ли тайтл: иначе данные попадут на чужую страницу.
 */
async function loadMediaPage(): Promise<void> {
  const route = parseMediaPath()

  // Кнопка плеера гасится отдельно: она живёт в панели Vue, а не в разметке виджета.
  if (!route) {
    clearLoadFailure()
    if (currentMediaId !== null) {
      cleanupWidgets()
      hidePlayerButton()
      currentMediaId = null
      currentContext = null
    }
    return
  }

  const { aniId, endpoint } = route

  // Ушли с проблемного тайтла — прошлые неудачи больше не считаются.
  if (failedMediaId !== null && failedMediaId !== aniId) clearLoadFailure()

  // Ждём паузы после сбоя: без этого каждая перерисовка страницы била бы по серверу.
  if (failedMediaId === aniId && (retryTimer !== null || failedAttempts >= MAX_LOAD_ATTEMPTS)) {
    return
  }

  // Тот же тайтл: данные уже есть, надо лишь восстановить разметку.
  if (currentMediaId === aniId) {
    if (currentContext) ensureMediaWidgets()
    return
  }

  // Дефект A4: отменить чужую загрузку нельзя, но и терять переход нельзя.
  if (isLoading) {
    pendingRoute = true
    return
  }
  isLoading = true

  try {
    cleanupWidgets()
    currentMediaId = aniId
    currentContext = null

    Logger('INFO', `[Widget] Открыта страница медиа ID: ${aniId}`)

    const malData = await loadAniListData(aniId)
    if (currentMediaId !== aniId) return

    // Пустой ответ — это сбой связи, а не приговор тайтлу: пробуем ещё раз.
    if (!malData) {
      scheduleLoadRetry(aniId)
      return
    }

    // А вот отсутствие MAL ID — свойство самого тайтла, повторять запрос бессмысленно.
    if (!malData.idMal) {
      Logger('INFO', '[Widget] MAL ID отсутствует, виджеты отключены')
      return
    }

    const cacheKey = `FULL_${aniId}`
    let shikiData =
      (await dbGet<{ key: string; data: MediaShikiData; ts: number }>('shikiCache', cacheKey))
        ?.data ?? null
    if (currentMediaId !== aniId) return

    let shikiDomain = SHIKI_DOMAINS[0] ?? 'shikimori.io'
    let shikiFailed = false

    if (!shikiData) {
      const res = await fetchShiki<MediaShikiData>(`/api/${endpoint}/${malData.idMal}`)
      if (currentMediaId !== aniId) return

      shikiData = res.data ?? null
      shikiDomain = res.domain ?? shikiDomain
      if (shikiData) {
        await dbSet('shikiCache', { key: cacheKey, data: shikiData, ts: Date.now() })
      } else {
        shikiFailed = true
      }
    } else if (shikiData.domain) {
      shikiDomain = shikiData.domain
    }

    currentContext = {
      aniId,
      malData,
      shikiData,
      shikiDomain,
      endpoint,
      sidebar: document.querySelector<HTMLElement>('.sidebar'),
    }

    ensureMediaWidgets()

    // Часть виджетов живёт на данных Shikimori: ставим то, что есть, и пробуем добрать.
    if (shikiFailed) scheduleLoadRetry(aniId)
    else clearLoadFailure()
  } catch (e) {
    Logger('ERROR', `[Widget] Не удалось подготовить страницу медиа ID: ${aniId}`, e)
    scheduleLoadRetry(aniId)
  } finally {
    isLoading = false

    // Флаг снимается ДО повторного вызова, иначе проход увидит его и цикл не кончится.
    if (pendingRoute) {
      pendingRoute = false
      void loadMediaPage()
    }
  }
}

/**
 * Полный проход по текущему адресу: загрузка, восстановление разметки или очистка.
 * Нужен снаружи для core/lifecycle.ts: переход не всегда меняет разметку сайдбара.
 */
export function refreshMediaPage(): void {
  void loadMediaPage()
}

/**
 * Запускает медиа-модуль: одна подписка на изменения страницы плюс первый проход.
 * Вызывать после loadSettings(), openDB() и initTranslator().
 */
export function initMedia(): void {
  if (isStarted) return
  isStarted = true

  registerMutationHook(() => {
    void loadMediaPage()
  })

  Logger('INFO', `[Widget] Медиа-модуль запущен, виджетов зарегистрировано: ${widgets.length}`)
  void loadMediaPage()
}
