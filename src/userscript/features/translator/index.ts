// Переводчик интерфейса: очередь, кэш и наблюдатель за DOM.
// Устройство конвейера, маркеры узлов и разбор дефектов — docs/DECISIONS.md.

import { anilistPauseRemaining, anilistQuery, isAniListRateLimited } from '@/api/anilist'
import { isAnime365RateLimited } from '@/api/anime365'
import { fetchShiki, isShikimoriRateLimited, pauseShikimori } from '@/api/shikimori'
import {
  fetchShikiPersonREST,
  resolveShikiPersonByMedia,
  type AniListPersonRef,
  type PersonEndpoint,
} from '@/api/shikimori-people'
import { resolveTitle } from '@/api/titles'
import { CACHE_TIME, SHIKI_DOMAINS } from '@/core/constants'
import { dbGet, dbSet } from '@/core/db'
import { registerRetranslateCallback } from '@/core/dictionary'
import { settings } from '@/core/settings'
import type { AniListMedia, MediaType, ShikiCacheRecord } from '@/core/types'
import { Logger } from '@/utils/logger'
import {
  NO_TRANSLATE_CLASS,
  TRANSLATABLE_ATTRS,
  cleanShikiBB,
  safelySetText,
  setupVueInputInterceptor,
  translateNode,
} from './dom'

/** Категории очереди. Они же — префиксы ключей в IndexedDB. */
export type QueueKind = 'MED2' | 'CHR2' | 'STF3'

/** Что лежит в кэше: русское имя и готовый HTML описания. */
interface TranslationPayload {
  ru: string
  desc?: string
}

/** Один элемент страницы, ждущий перевода. */
interface QueueEntry {
  el: HTMLElement
  /** true — это заголовок самой страницы: там же меняется и заголовок вкладки. */
  extra: boolean
}

/** Маркер «искали, русского нет» — чтобы не долбить API по кругу. */
const NOT_FOUND = 'NOT_FOUND'

const MEDIA_BATCH = 40
const PERSON_BATCH = 10

/**
 * Окно сбора пачки: за полсекунды в очередь успевают остальные карточки экрана.
 * Окно фиксированное, а не скользящее: поток промахов не должен откладывать старт.
 */
const DISPATCH_DELAY_MS = 500

/** Пауза перед возвратом сбойного id в очередь — чтобы не крутить цикл на упавшей сети. */
const RETRY_DELAY_MS = 2000

/** Сколько раз пробуем один ключ, прежде чем отпустить его до перезагрузки страницы. */
const MAX_ATTEMPTS = 3

/**
 * Свои виджеты: их содержимое уже на русском и собрано вручную.
 * Отдать ссылки внутри них переводчику — потерять бейджи года, типа и статуса.
 */
const SELF_UI_SELECTOR =
  '.animori-franchise, .animori-themes, .animori-extlinks, .animori-ratings, #animori-actions'

const MEDIA_QUERY = `query ($ids: [Int]) {
  Page {
    media(id_in: $ids) {
      id
      type
      idMal
      seasonYear
      title { romaji }
    }
  }
}`

const PERSON_QUERY: Record<'CHR2' | 'STF3', string> = {
  CHR2: `query ($ids: [Int]) {
  Page(page: 1, perPage: ${PERSON_BATCH}) {
    characters(id_in: $ids) {
      id
      name { full native }
      media(sort: POPULARITY_DESC, page: 1, perPage: 6) { nodes { idMal type } }
    }
  }
}`,
  STF3: `query ($ids: [Int]) {
  Page(page: 1, perPage: ${PERSON_BATCH}) {
    staff(id_in: $ids) {
      id
      name { full native }
      staffMedia(sort: POPULARITY_DESC, page: 1, perPage: 6) { nodes { idMal type } }
    }
  }
}`,
}

/** Настройки двух почти одинаковых веток: персонажи и авторы. */
const PERSON_CONFIG: Record<
  'CHR2' | 'STF3',
  {
    gqlField: 'characters' | 'staff'
    endpoint: PersonEndpoint
    resolveType: 'characters' | 'staff'
  }
> = {
  CHR2: { gqlField: 'characters', endpoint: 'characters', resolveType: 'characters' },
  STF3: { gqlField: 'staff', endpoint: 'people', resolveType: 'staff' },
}

interface AniListMediaRow {
  id: number
  type: MediaType
  idMal: number | null
  seasonYear?: number | null
  title?: { romaji?: string | null }
}

type AniListPersonRow = AniListPersonRef & { id: number }

// ==== Состояние модуля: наружу отдаются только функции ====

/** Ключ вида "MED2_123" -> элементы страницы, которые надо обновить. */
const queue = new Map<string, QueueEntry[]>()

/** ID, по которым ещё не сделан запрос. Порядок вставки = порядок обхода разметки. */
const pending: Record<QueueKind, Set<number>> = {
  MED2: new Set<number>(),
  CHR2: new Set<number>(),
  STF3: new Set<number>(),
}

/** Счётчик неудачных попыток по ключу. Успех обнуляет запись. */
const attempts = new Map<string, number>()

/**
 * Тайтл или персона, чья страница открыта прямо сейчас.
 * Заголовок и описание — единственное, на что человек смотрит сразу после перехода,
 * поэтому они идут впереди общей очереди и отдельным запросом на один id.
 */
let urgentTarget: { kind: QueueKind; id: number } | null = null

/**
 * Номер перехода. Пачка запоминает его на старте: если номер сменился,
 * пользователь уже на другой странице и дорабатывать чужую работу некому.
 */
let routeGeneration = 0

let isProcessing = false

/**
 * Заявка на повторный прогон: промахи, пришедшие во время работы цикла.
 * Без неё элементы ждали бы следующего перехода по сайту.
 */
let rerunRequested = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let dispatchTimer: ReturnType<typeof setTimeout> | null = null
let mutationHookTimer: ReturnType<typeof setTimeout> | null = null
let isStarted = false
let mutationHook: (() => void) | null = null

/**
 * Подписка на изменения страницы. Нужна медиа-виджетам:
 * AniList любит пересобирать блоки, и их надо вставлять заново.
 */
export function registerMutationHook(hook: (() => void) | null): void {
  mutationHook = hook
}

/** Размеры очередей для инспектора логгера (только чтение). */
export function getPendingQueueSizes(): Record<QueueKind, number> {
  return { MED2: pending.MED2.size, CHR2: pending.CHR2.size, STF3: pending.STF3.size }
}

/**
 * Сбрасывает счётчики неудач на смену роута: новая страница — новый шанс.
 * Внутри одной страницы счётчик держит цикл от кручения на упавшей сети.
 * Здесь же меняется номер перехода: пачка старой страницы увидит это и уступит дорогу.
 */
export function resetTranslatorRetries(): void {
  routeGeneration++

  const dropped = dropDetachedEntries()
  if (dropped > 0) {
    Logger('QUEUE', `[Process] Смена страницы: снято с очереди оторванных элементов ${dropped}`)
  }

  if (attempts.size === 0) return
  Logger('QUEUE', `[Process] Смена страницы: сброшено счётчиков неудач ${attempts.size}`)
  attempts.clear()
}

/**
 * Выбрасывает из очереди элементы, чьи узлы больше не в документе.
 * Иначе покинутый список тянет сотни запросов, результат которых писать некуда.
 */
function dropDetachedEntries(): number {
  let dropped = 0

  for (const [key, entries] of [...queue]) {
    const alive = entries.filter((entry) => entry.el.isConnected)
    if (alive.length === entries.length) continue

    if (alive.length > 0) {
      queue.set(key, alive)
      continue
    }

    queue.delete(key)
    attempts.delete(key)

    const sep = key.indexOf('_')
    const kind = key.slice(0, sep) as QueueKind
    const id = Number(key.slice(sep + 1))
    if (pending[kind]?.delete(id)) dropped++
  }

  return dropped
}

function totalPending(): number {
  return pending.MED2.size + pending.CHR2.size + pending.STF3.size
}

/**
 * Набирает пачку в порядке постановки, то есть сверху страницы вниз.
 *
 * Отбора «что видно на экране» здесь больше нет: расстояния считались один раз
 * на восемь секунд работы пачки и устаревали от первого же прокрута, разметка
 * сайта всё равно шире экрана, а порядок появления перевода всё равно решает сеть.
 * Срочное идёт мимо пачки — см. urgentTarget.
 *
 * Выбранные id снимаются с pending — вызывающему это делать не нужно.
 */
function pickBatch(kind: QueueKind, size: number): number[] {
  const total = pending[kind].size
  const picked = [...pending[kind]].slice(0, size)
  picked.forEach((id) => pending[kind].delete(id))

  if (total > size) {
    Logger('QUEUE', `[Process] ${kind}: взято ${picked.length} из ${total}`)
  }

  return picked
}

/**
 * Забирает срочную задачу, если она ещё ждёт запроса.
 * Отметка снимается в любом случае: второй раз тот же id срочным не считается.
 */
function takeUrgent(): { kind: QueueKind; id: number } | null {
  if (!urgentTarget) return null

  const { kind, id } = urgentTarget
  urgentTarget = null

  if (!pending[kind].delete(id)) return null

  Logger('QUEUE', `[Process] Срочно: ${kind}_${id} — открытая страница впереди очереди`)
  return { kind, id }
}

// ==== Очередь ====

/**
 * Ставит обработку в план. Повторно не переставляем:
 * непрерывный поток промахов при скролле откладывал бы старт бесконечно.
 */
function scheduleDispatch(): void {
  if (dispatchTimer) return
  dispatchTimer = setTimeout(() => {
    dispatchTimer = null
    void processTransQueue()
  }, DISPATCH_DELAY_MS)
}

/**
 * Снимает маркер «уже в очереди» со всех элементов ключа.
 * Без этого queueContent отсечёт элемент и карточка останется непереведённой.
 */
function releaseQueued(key: string): void {
  for (const { el } of queue.get(key) ?? []) {
    if (el.dataset.queued === key) delete el.dataset.queued
  }
}

/**
 * Возвращает id в очередь немедленно, не считая это неудачей.
 * Для рейт-лимита: элемент не сломан, просто сейчас не время.
 */
function returnToQueue(kind: QueueKind, id: number): void {
  releaseQueued(`${kind}_${id}`)
  pending[kind].add(id)
}

/**
 * Уступает дорогу новой странице: невзятый остаток пачки возвращается в очередь.
 * Узлы, которых уже нет в документе, выбрасываются: писать перевод было бы некуда.
 */
function yieldRestToNewRoute(kind: QueueKind, ids: number[]): void {
  let kept = 0

  for (const id of ids) {
    const key = `${kind}_${id}`
    const entries = queue.get(key) ?? []

    if (!entries.some((entry) => entry.el.isConnected)) {
      queue.delete(key)
      attempts.delete(key)
      continue
    }

    returnToQueue(kind, id)
    kept++
  }

  Logger(
    'QUEUE',
    `[Process] ${kind}: смена страницы, пачка прервана, возвращено ${kept} из ${ids.length}`,
  )
}

/**
 * Возвращает id в очередь после сбоя, с паузой и счётчиком попыток.
 * После MAX_ATTEMPTS ключ отпускается: новый узел начнёт с чистого листа.
 */
function requeue(kind: QueueKind, id: number): void {
  const key = `${kind}_${id}`
  const tries = (attempts.get(key) ?? 0) + 1
  attempts.set(key, tries)
  releaseQueued(key)

  if (tries >= MAX_ATTEMPTS) {
    // Не рутина очереди, а потеря перевода до перезагрузки страницы.
    Logger('WARN', `[Process] ${key}: неудач подряд ${tries}, ключ отпущен`)
    queue.delete(key)
    return
  }

  setTimeout(() => {
    pending[kind].add(id)
    scheduleDispatch()
  }, RETRY_DELAY_MS)
}

/**
 * Кладёт элемент в очередь перевода или сразу берёт готовое из кэша.
 * extra — главный заголовок страницы; force — общий узел тултипа, переводим заново.
 */
async function queueContent(
  id: number,
  kind: QueueKind,
  el: HTMLElement,
  extra = false,
  force = false,
): Promise<void> {
  const key = `${kind}_${id}`
  if (el.dataset.queued === key && !extra && !force) return

  // Маркер ставится после учёта элемента: отказ IndexedDB не должен глушить узел.
  let cached: ShikiCacheRecord<TranslationPayload> | undefined | null = null
  try {
    cached = await dbGet<ShikiCacheRecord<TranslationPayload>>('shikiCache', key)
  } catch (e) {
    // Промах кэша не повод бросать элемент: идём в сеть как при Cache MISS.
    Logger('WARN', `[Cache] ${key}: чтение кэша не удалось, идём в сеть`, e)
  }

  try {
    const list = queue.get(key) ?? []
    list.push({ el, extra })
    queue.set(key, list)

    if (cached && Date.now() - cached.ts < CACHE_TIME) {
      const ageMin = Math.round((Date.now() - cached.ts) / 60000)
      Logger('QUEUE', `[Cache HIT] ${key} (возраст ${ageMin} мин)`)
      el.dataset.queued = key
      applyTranslation(kind, id, cached.data)
      return
    }

    Logger('QUEUE', `[Cache MISS] ${key} ➜ Помещено в очередь перевода`)
    pending[kind].add(id)
    el.dataset.queued = key
    scheduleDispatch()
  } catch (e) {
    if (el.dataset.queued === key) delete el.dataset.queued
    Logger('WARN', `[Queue] ${key}: постановка в очередь не удалась`, e)
  }
}

/** Основной цикл: пачка за пачкой, пока очередь не опустеет. */
async function processTransQueue(): Promise<void> {
  if (isProcessing) {
    rerunRequested = true
    return
  }
  isProcessing = true
  rerunRequested = false

  try {
    while (totalPending() > 0) {
      Logger('QUEUE', `[Process] Запуск обработки. В ожидании: ${totalPending()} элементов.`)

      // Лимит любого из трёх источников цепочки: отступаем, а не колотим в дверь.
      if (isAniListRateLimited() || isShikimoriRateLimited() || isAnime365RateLimited()) {
        const wait = Math.max(1000, anilistPauseRemaining()) + Math.floor(Math.random() * 500)
        Logger('WARN', `[Process] Активен лимит API, повтор через ${wait}ms`)
        setTimeout(() => void processTransQueue(), wait)
        return
      }

      // Срочная дорожка: страница перед глазами важнее любого списка.
      const urgent = takeUrgent()
      if (urgent) {
        if (urgent.kind === 'MED2') await processMediaBatch([urgent.id])
        else await processPersonBatch(urgent.kind, [urgent.id])
        continue
      }

      // Персоны раньше тайтлов: они есть только на текущей странице, а пачка вчетверо меньше.
      if (pending.CHR2.size > 0) await processPersonBatch('CHR2')
      else if (pending.STF3.size > 0) await processPersonBatch('STF3')
      else if (pending.MED2.size > 0) await processMediaBatch()
    }

    Logger('QUEUE', '[Process] Очередь пуста. Ожидание новых элементов.')
  } finally {
    isProcessing = false
    // В очередь стучались, пока мы работали: ещё круг через общее окно, без рекурсии.
    if (rerunRequested) {
      rerunRequested = false
      scheduleDispatch()
    }
  }
}

/**
 * Пачка тайтлов: один запрос в AniList на до 40 штук, дальше — поштучно в Shikimori.
 * forcedIds — срочная дорожка: id уже снят с pending вызывающим.
 */
async function processMediaBatch(forcedIds?: number[]): Promise<void> {
  const ids = forcedIds ?? pickBatch('MED2', MEDIA_BATCH)
  const generation = routeGeneration

  let rows: AniListMediaRow[] = []
  try {
    const res = await anilistQuery<{ Page?: { media?: AniListMediaRow[] } }>(MEDIA_QUERY, { ids })
    rows = res.data?.Page?.media ?? []
  } catch (e) {
    Logger('ERROR', 'Перевод названий: сбой запроса к AniList', e)
    ids.forEach((id) => requeue('MED2', id))
    return
  }

  // Пропавшие в ответе строки нельзя забыть: элемент помечен и сам себя не предложит.
  const returned = new Set(rows.map((row) => row.id))
  for (const id of ids) {
    if (!returned.has(id)) requeue('MED2', id)
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue

    // Пользователь ушёл на другую страницу: остаток пачки уступает ей дорогу.
    if (generation !== routeGeneration) {
      yieldRestToNewRoute(
        'MED2',
        rows.slice(i).map((rest) => rest.id),
      )
      return
    }

    try {
      await dbSet('malCache', { id: row.id, data: row as AniListMedia })

      const resolved = row.idMal ? await resolveTitle(row.idMal, row.type) : null
      const payload: TranslationPayload = resolved
        ? {
            ru: resolved.russian,
            desc: resolved.description
              ? cleanShikiBB(resolved.description, resolved.url, resolved.sourceName)
              : undefined,
          }
        : { ru: NOT_FOUND }

      await dbSet('shikiCache', { key: `MED2_${row.id}`, data: payload, ts: Date.now() })
      attempts.delete(`MED2_${row.id}`)
      applyTranslation('MED2', row.id, payload)
    } catch (e) {
      Logger('ERROR', `Перевод названия: сбой на id ${row.id}`, e)
      requeue('MED2', row.id)
    }
    // Паузы здесь нет: темп держит общий ограничитель внутри api-клиентов.
  }
}

/**
 * Пачка персонажей или авторов: сначала поиск по ролям, потом по имени.
 * forcedIds — срочная дорожка: id уже снят с pending вызывающим.
 */
async function processPersonBatch(kind: 'CHR2' | 'STF3', forcedIds?: number[]): Promise<void> {
  const cfg = PERSON_CONFIG[kind]
  const ids = forcedIds ?? pickBatch(kind, PERSON_BATCH)
  const generation = routeGeneration

  let rows: AniListPersonRow[] = []
  try {
    const res = await anilistQuery<{ Page?: Record<string, AniListPersonRow[] | undefined> }>(
      PERSON_QUERY[kind],
      { ids },
    )
    rows = res.data?.Page?.[cfg.gqlField] ?? []
  } catch (e) {
    Logger('ERROR', `Перевод имён (${kind}): сбой запроса к AniList`, e)
    ids.forEach((id) => requeue(kind, id))
    return
  }

  const returned = new Set(rows.map((row) => row.id))
  for (const id of ids) {
    if (!returned.has(id)) requeue(kind, id)
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue

    // Пользователь ушёл на другую страницу: остаток пачки уступает ей дорогу.
    if (generation !== routeGeneration) {
      yieldRestToNewRoute(
        kind,
        rows.slice(i).map((rest) => rest.id),
      )
      return
    }

    try {
      let person: {
        russian: string | null
        description: string | null
        link: string | null
      } | null = null

      // Путь 1: через роли в общих тайтлах — надёжнее всего против тёзок.
      const byMedia = await resolveShikiPersonByMedia(row, cfg.resolveType)
      if (byMedia?.id) {
        const details = await fetchShiki<{ description?: string | null; url?: string | null }>(
          `/api/${cfg.endpoint}/${byMedia.id}`,
        )
        person = {
          russian: byMedia.russian ?? null,
          description: details.data?.description ?? null,
          link: buildPersonLink(details.domain, details.data?.url ?? null),
        }
      } else {
        // Путь 2: поиск по имени со всеми вариантами порядка слов.
        const res = await fetchShikiPersonREST(
          cfg.endpoint,
          row.name.full,
          row.name.native,
          collectTargetMalIds(row, cfg.resolveType),
        )

        if (res.status === 429) {
          // Возвращаем весь остаток пачки: id уже вынуты из pending и иначе теряются.
          pauseShikimori(6000)
          const rest = rows.slice(i)
          for (const pendingRow of rest) returnToQueue(kind, pendingRow.id)
          Logger(
            'WARN',
            `Перевод имён (${kind}): лимит Shikimori, пауза 6с, возвращено в очередь ${rest.length}`,
          )
          return
        }

        if (res.status === 200 && res.data) {
          person = {
            russian: res.data.russian,
            description: res.data.description,
            link: buildPersonLink(res.data.domain, res.data.url),
          }
        }
      }

      const payload: TranslationPayload =
        person && person.russian
          ? {
              ru: person.russian,
              desc:
                person.description && person.link
                  ? cleanShikiBB(person.description, person.link)
                  : undefined,
            }
          : { ru: NOT_FOUND }

      await dbSet('shikiCache', { key: `${kind}_${row.id}`, data: payload, ts: Date.now() })
      attempts.delete(`${kind}_${row.id}`)
      applyTranslation(kind, row.id, payload)
    } catch (e) {
      Logger('ERROR', `Перевод имён (${kind}): сбой на id ${row.id}`, e)
      requeue(kind, row.id)
    }
    // Паузы здесь нет: темп держит общий ограничитель внутри api-клиентов.
  }
}

/** Собирает MAL id тайтлов персоны — их требует гард тёзок в shikimori-people. */
function collectTargetMalIds(row: AniListPersonRow, type: 'characters' | 'staff'): number[] {
  const nodes = (type === 'characters' ? row.media : row.staffMedia)?.nodes ?? []
  const ids: number[] = []
  for (const node of nodes) {
    if (node.idMal) ids.push(node.idMal)
  }
  return ids
}

/** Собирает абсолютную ссылку на страницу персоны: домен плюс относительный url. */
function buildPersonLink(domain: string | null, url: string | null): string | null {
  if (!url) return null
  const host = domain ?? SHIKI_DOMAINS[0] ?? 'shikimori.io'
  return 'https://' + host + url
}

// ==== Применение к странице ====

/** Есть ли у элемента свой видимый текст (прямой непустой текстовый узел). */
function hasOwnText(el: Element): boolean {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? '').trim().length > 0) return true
  }
  return false
}

/**
 * Пишет перевод, не разрушая разметку: textContent допустим только без дочерних элементов.
 * Возвращает false, если писать было некуда.
 */
function writeText(el: HTMLElement, text: string): boolean {
  if (safelySetText(el, text)) return true
  if (el.children.length > 0) return false
  el.textContent = text
  return true
}

/** Подставляет готовый перевод во все элементы, ждавшие этот id. */
function applyTranslation(kind: QueueKind, id: number, data: TranslationPayload): void {
  const key = `${kind}_${id}`
  const entries = queue.get(key) ?? []
  if (data.ru === NOT_FOUND) {
    queue.delete(key)
    return
  }

  for (const { el, extra } of entries) {
    try {
      // 1. Плавающая подсказка: узел общий, пишем только на заказанном тайтле.
      if (el.classList.contains('title') && el.closest('.tooltip')) {
        if (el.dataset.translatingId !== String(id)) continue
        el.dataset.ru = data.ru
        writeText(el, data.ru)
        el.dataset.translated = String(id)
        continue
      }

      // 2. Главный заголовок страницы и заголовок вкладки браузера.
      if (extra) {
        writeText(el, data.ru)
        document.title = `${data.ru} · AniList`
        el.dataset.translated = String(id)
        continue
      }

      // 3. Блок описания. Отметку ставим, только если русский текст правда встал:
      //    иначе обход страницы будет считать блок готовым и не вернётся к нему.
      if (el.classList.contains('description')) {
        applyDescription(el, data)
        if (el.querySelector('.ru-desc')) el.dataset.translated = String(id)
        continue
      }

      // 4. Обычная карточка: без текста внутри хватит родного тултипа AniList.
      const nameEl = el.querySelector<HTMLElement>('.name') ?? el
      writeText(nameEl, data.ru)
      if (el.getAttribute('title')) el.setAttribute('title', data.ru)
      if (el.getAttribute('aria-label')) el.setAttribute('aria-label', data.ru)
      el.dataset.translated = String(id)
    } catch (e) {
      Logger('WARN', `Не удалось применить перевод для ${key}`, e)
    }
  }

  queue.delete(key)
}

/**
 * Вставляет русское описание, а оригинал прячет в раскрывашку.
 * Оригинал помечается am-notr, иначе переводчик со временем перепишет и его.
 */
function applyDescription(el: HTMLElement, data: TranslationPayload): void {
  if (!data.desc) return
  if (el.querySelector('.ru-desc')) return

  const originalHtml = el.innerHTML

  const ru = document.createElement('div')
  ru.className = 'ru-desc'
  ru.style.marginBottom = '20px'
  ru.innerHTML = data.desc

  const details = document.createElement('details')
  details.classList.add(NO_TRANSLATE_CLASS)
  const summary = document.createElement('summary')
  summary.textContent = 'Оригинальное описание (AniList)'
  summary.style.cssText = 'cursor:pointer;color:#3dbbee;font-weight:bold;outline:none;'
  const original = document.createElement('div')
  original.innerHTML = originalHtml
  details.append(summary, original)

  el.innerHTML = ''
  el.append(ru, details)
}

/**
 * Ставит описание текущей страницы в очередь, если русского текста в нём нет.
 *
 * React пересобирает блок описания и возвращает туда оригинал, а маркер
 * dataset.queued остаётся на том же живом узле — из-за него queueContent молча
 * выходил, и перевод не возвращался до перезагрузки страницы. Поэтому пропажу
 * ловим отдельно и ставим задачу принудительно; повторной работы это не даёт:
 * ответ берётся из кэша, а сама вставка проверяет, что не дублируется.
 */
function ensurePageDescription(kind: QueueKind, id: number): void {
  const desc = document.querySelector<HTMLElement>('.description')
  if (!desc) return

  const hasRu = desc.querySelector('.ru-desc') !== null
  const wasTranslated = desc.dataset.translated === String(id)
  if (hasRu && wasTranslated) return

  // Перевод стоял и пропал — блок перерисован поверх нас, маркеры уже не годятся.
  if (wasTranslated) {
    delete desc.dataset.queued
    delete desc.dataset.translated
    void queueContent(id, kind, desc, false, true)
    return
  }

  void queueContent(id, kind, desc)
}

/**
 * Подсказка при наведении: узел один на всю страницу, надо угадать адресата.
 * Ориентируемся не на маркер, а на совпадение видимого текста с нашим.
 */
function processTooltip(tooltipNode: HTMLElement): void {
  const titleEl = tooltipNode.querySelector<HTMLElement>('.title')
  if (!titleEl) return

  // В тултипе уже стоит наш перевод — трогать нечего.
  const current = (titleEl.textContent ?? '').trim()
  if (titleEl.dataset.ru && titleEl.dataset.ru === current) return

  const hovered = document.querySelectorAll<HTMLElement>(':hover')
  const target = hovered.length > 0 ? hovered[hovered.length - 1] : null
  if (!target) return

  const link = target.closest<HTMLAnchorElement>(
    'a[href^="/anime/"], a[href^="/manga/"], a[href^="/character/"], a[href^="/staff/"]',
  )
  const holder =
    link ??
    target.closest<HTMLElement>(
      '.media-card, .character-card, .staff-card, .relation-card, .studio-anime',
    )
  if (!holder) return

  const href =
    holder instanceof HTMLAnchorElement
      ? holder.getAttribute('href')
      : (holder
          .querySelector<HTMLAnchorElement>(
            'a[href^="/anime/"], a[href^="/manga/"], a[href^="/character/"], a[href^="/staff/"]',
          )
          ?.getAttribute('href') ?? null)
  const parsed = href ? parseAniListHref(href) : null
  if (!parsed) return

  titleEl.dataset.translatingId = String(parsed.id)
  void queueContent(parsed.id, parsed.kind, titleEl, false, true)
}

/** Разбирает ссылку AniList вида /anime/123/... в пару «тип очереди + id». */
function parseAniListHref(href: string): { kind: QueueKind; id: number } | null {
  const m = href.match(/^\/(anime|manga|character|staff)\/(\d+)/)
  if (!m || !m[1] || !m[2]) return null
  const id = parseInt(m[2], 10)
  if (!id) return null

  if (m[1] === 'character') return settings.translateCharacters ? { kind: 'CHR2', id } : null
  if (m[1] === 'staff') return settings.translateStaff ? { kind: 'STF3', id } : null
  return settings.translateTitles ? { kind: 'MED2', id } : null
}

/** Насколько ссылка похожа на обычную карточку, а не на обложку или меню. */
function isTranslatableLink(link: HTMLAnchorElement, kind: QueueKind): boolean {
  // Свой UI переводить нельзя: там уже русский текст и своя разметка.
  if (link.closest(`.${NO_TRANSLATE_CLASS}`)) return false
  if (link.closest(SELF_UI_SELECTOR)) return false

  if (link.querySelector('img')) return false
  if (link.classList.contains('cover')) return false
  if (link.closest('.nav')) return false

  // Плитки-обложки текста не держат: имя показывает родной тултип AniList.
  if (!hasOwnText(link) && !link.querySelector('.name')) return false

  if (kind === 'MED2') {
    if (link.classList.contains('relation-title')) return false
    if (link.closest('.relations')) return false
    if (link.closest('.role')) return false
  }
  return true
}

/**
 * Обходит страницу и собирает всё, что надо перевести; 300 мс против беготни при скролле.
 * Повторные постановки отсекает сам queueContent по маркеру dataset.queued.
 */
function debouncedFindContent(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    if (!settings.translateTitles && !settings.translateCharacters && !settings.translateStaff) {
      return
    }

    // Ссылки в списках и сетках.
    const linkSelectors: Array<{ selector: string; kind: QueueKind; enabled: boolean }> = [
      {
        selector: 'a[href^="/anime/"], a[href^="/manga/"]',
        kind: 'MED2',
        enabled: settings.translateTitles,
      },
      { selector: 'a[href^="/character/"]', kind: 'CHR2', enabled: settings.translateCharacters },
      { selector: 'a[href^="/staff/"]', kind: 'STF3', enabled: settings.translateStaff },
    ]

    for (const { selector, kind, enabled } of linkSelectors) {
      if (!enabled) continue
      document.querySelectorAll<HTMLAnchorElement>(selector).forEach((link) => {
        if (!isTranslatableLink(link, kind)) return
        const parsed = parseAniListHref(link.getAttribute('href') ?? '')
        if (!parsed || parsed.kind !== kind) return
        void queueContent(parsed.id, kind, link)
      })
    }

    // Заголовок и описание текущей страницы.
    const page = parseAniListHref(window.location.pathname)
    if (!page) return

    // Открытая страница — то, на что человек смотрит прямо сейчас: она идёт вне очереди.
    urgentTarget = { kind: page.kind, id: page.id }

    const headerSelector =
      page.kind === 'MED2'
        ? '.header .content h1'
        : '.header .names h1.name, .header h1.name, .header .content h1'

    const h1 = document.querySelector<HTMLElement>(headerSelector)
    if (h1 && h1.dataset.translated !== String(page.id)) {
      void queueContent(page.id, page.kind, h1, true)
    }

    ensurePageDescription(page.kind, page.id)
  }, 300)
}

// ==== Наблюдатель ====

/** Ищет тултип, к которому относится изменённый узел. */
function findTooltip(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : (node?.parentElement ?? null)
  if (!el) return null
  if (el.classList.contains('tooltip')) return el
  return el.closest<HTMLElement>('.tooltip')
}

/**
 * Запускает переводчик: один раз на страницу.
 * Вызывать только ПОСЛЕ loadSettings(), openDB() и загрузки словаря.
 */
export function initTranslator(): void {
  if (isStarted) return
  isStarted = true

  let mutationQueue: MutationRecord[] = []
  let rafId: number | null = null

  const processMutations = (): void => {
    rafId = null
    const batch = mutationQueue
    mutationQueue = []
    const startTime = performance.now()

    for (const mutation of batch) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          translateNode(node)
          if (!(node instanceof HTMLElement)) return

          // Раскрываем обрезанные описания: иначе русский текст встанет в огрызок.
          if (node.classList.contains('description-length-toggle')) node.click()
          else node.querySelector<HTMLElement>('.description-length-toggle')?.click()

          if (node.classList.contains('tooltip')) processTooltip(node)
          else {
            const tooltip = node.querySelector<HTMLElement>('.tooltip')
            if (tooltip) processTooltip(tooltip)
          }
        })

        // Тултип переиспользован под новую карточку — переводим его заново.
        const reused = findTooltip(mutation.target)
        if (reused) processTooltip(reused)
      } else if (mutation.type === 'characterData') {
        translateNode(mutation.target)
        // Тултип часто обновляется точечной правкой текста.
        const tooltip = findTooltip(mutation.target)
        if (tooltip) processTooltip(tooltip)
      } else if (mutation.type === 'attributes') {
        const name = mutation.attributeName
        if (name && TRANSLATABLE_ATTRS.includes(name)) translateNode(mutation.target)
      }
    }

    const spent = Math.round(performance.now() - startTime)
    if (spent > 50) Logger('WARN', `[Performance] Обновление интерфейса заняло ${spent}ms`)

    debouncedFindContent()

    // Виджеты медиа-страницы восстанавливаем с задержкой, чтобы не дёргать на каждый чих.
    if (mutationHook) {
      if (mutationHookTimer) clearTimeout(mutationHookTimer)
      mutationHookTimer = setTimeout(() => mutationHook?.(), 150)
    }
  }

  const observer = new MutationObserver((mutations) => {
    mutationQueue.push(...mutations)
    if (rafId === null) rafId = requestAnimationFrame(processMutations)
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
    attributeFilter: [...TRANSLATABLE_ATTRS],
  })

  setupVueInputInterceptor()

  // После редактирования словаря перевод применяется сразу, без перезагрузки страницы.
  registerRetranslateCallback(() => {
    try {
      translateNode(document.body)
    } catch (e) {
      Logger('WARN', 'Ре-скан перевода не удался', e)
    }
  })

  Logger('INFO', 'Переводчик интерфейса запущен')
  translateNode(document.body)
  debouncedFindContent()
}
