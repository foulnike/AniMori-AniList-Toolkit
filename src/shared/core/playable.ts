// Метка доступности: есть ли у наших источников вход к тайтлу. Один бит на тайтл —
// и самый дорогой бит в приложении: спрашивать приходится службы, которые про
// перечни ни с кем не договаривались, а показывать — сеткой на полторы сотни постеров.
//
// Устройство: склад ответов в mediaCache, память на запуск, одна очередь и один
// работник над ней. Экраны кладут в очередь всё, что видно, и подпиской узнают
// о каждом новом ответе: рисовать по мере готовности — единственный способ не
// выглядеть остановкой, когда полка длиннее пары рядов.
//
// ДВЕ ФАЗЫ. Очередь проходится дважды. Сначала целиком — оптовыми источниками:
// два десятка тайтлов одним запросом, и большинство «да» встаёт на плитки за
// секунды. Только потом остаток идёт к дорогим, по тайтлу за раз и сверху вниз.
// Прежний порядок — заход «по двадцать четыре как есть» с потолком на заход —
// держал дешёвые ответы за чужими минутами и обрывался, не дойдя до хвоста:
// на списке в полторы сотни постеров метки замирали на первом десятке, а
// следующий заход начинал с того же начала и сжигал темп на тех же строках.
//
// ПРО «НЕТ». Метка отказа ставится только когда высказались все источники, кому
// тайтл вообще адресуем (canAskPresence в core/video.ts). Молчание службы — это
// «не знаю», а не «нет»: ошибиться отказом дороже, чем промолчать. Тайтл, о
// котором так и не высказались, уходит в тишину на десять минут: без этого срока
// работник крутился бы над ним, пока человек смотрит на экран.

import { Logger } from '../utils/logger'
import { dbGet, dbSet } from './db'
import type { MediaCacheRecord } from './types'
import { listVideoSources } from './video'
import type { PresenceMap, VideoRequest, VideoSource } from './video'

/** Ключ склада. Версия в имени: смена правил решения делает прежние ответы негодными. */
const CACHE_PREFIX = 'PLAY1_'

/** Сколько живёт «да»: вход к тайтлу пропадает разве что вместе со службой. */
const YES_TIME_MS = 604800000

/** Сколько живёт «нет»: сегодня озвучки нет, а завтра она есть. */
const NO_TIME_MS = 86400000

/** По скольку тайтлов уходит в один оптовый вопрос: столько же берёт и Kodik. */
const BULK_CHUNK = 20

/** Пауза между вопросами: очередь темпа не единственный жилец сети. */
const REST_MS = 60

/** Не чаще этого зовутся подписчики: перерисовка сетки дороже самого ответа. */
const NOTIFY_MS = 250

/** Через сколько переспрашивать тайтл, о котором источники промолчали. */
const HUSH_TIME_MS = 600000

/** Ответ источников: вход есть или входа нет. Третьего значения нет намеренно. */
export type PlayState = 'yes' | 'no'

/**
 * Чем спрашивать источники об одном тайтле. Собирает вопрос экран: имена и
 * чужие номера живут у него, а ядро их взять негде.
 */
export interface PlayAsk {
  mediaId: number
  malId: number | null
  titles: string[]
  year?: number
}

/** Ответ в памяти запуска: состояние и час получения. */
interface Held {
  at: number
  state: PlayState
}

/** Запись склада. Поле одно: срок годности лежит в самой записи хранилища. */
interface PlayRecord {
  state: PlayState
}

/** Один заход к источнику: кого спрашиваем и о чём. */
interface Turn {
  source: VideoSource
  asks: PlayAsk[]
}

const memory = new Map<number, Held>()

/** Тайтлы, уже поднятые со склада: пустой склад — тоже ответ, и второй раз он не читается. */
const looked = new Set<number>()

/** Очередь вопросов: ключ — тайтл, значение — чем спрашивать. Порядок — порядок показа. */
const queue = new Map<number, PlayAsk>()

/** Что уже сказали источники про тайтл. Живёт до решения по нему. */
const heard = new Map<number, Map<string, boolean>>()

/** Кого о чём уже спрашивали в этом заходе. Молчание — тоже спрошено. */
const tried = new Map<number, Set<string>>()

/** Когда о тайтле промолчали: раньше срока переспрашивать нечего. */
const hushed = new Map<number, number>()

/** Подписчики: экраны, которым надо перерисоваться на новый ответ. */
const watchers = new Set<() => void>()

/** Идущий заход работника. Он один: два одновременных удвоили бы запросы. */
let working: Promise<void> | null = null

/** Когда подписчиков звали в последний раз и отложенный зов, если он назначен. */
let notifiedAt = 0
let waiting: ReturnType<typeof setTimeout> | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Сколько живёт ответ: отказ перепроверяется куда чаще находки. */
function lifeOf(state: PlayState): number {
  return state === 'yes' ? YES_TIME_MS : NO_TIME_MS
}

/** Ответ из памяти запуска. Протухший забывается на месте. */
function known(mediaId: number): PlayState | null {
  const held = memory.get(mediaId)
  if (held === undefined) return null

  if (Date.now() - held.at < lifeOf(held.state)) return held.state

  memory.delete(mediaId)
  return null
}

async function readCache(mediaId: number): Promise<PlayState | null> {
  try {
    const found = await dbGet<MediaCacheRecord<PlayRecord>>(
      'mediaCache',
      CACHE_PREFIX + String(mediaId),
    )
    if (!found) return null

    const state = found.data.state
    if (state !== 'yes' && state !== 'no') return null

    return Date.now() - found.ts < lifeOf(state) ? state : null
  } catch (e) {
    // Склад — удобство, а не условие работы: без него просто спросим сеть.
    Logger('WARN', `Метка доступности: склад не отдал ${mediaId}`, e)
    return null
  }
}

function writeCache(mediaId: number, state: PlayState): void {
  void dbSet('mediaCache', {
    key: CACHE_PREFIX + String(mediaId),
    data: { state },
    ts: Date.now(),
  }).catch((e: unknown) => {
    Logger('WARN', `Метка доступности: склад не принял ${mediaId}`, e)
  })
}

/** Что источникам нужно знать о тайтле. Номер MAL и номер Шикимори у нас один. */
function reqOf(ask: PlayAsk): VideoRequest {
  return {
    anilistId: ask.mediaId,
    malId: ask.malId,
    shikimoriId: ask.malId,
    titles: [...ask.titles],
    ...(ask.year === undefined ? {} : { year: ask.year }),
  }
}

/** Адресуем ли этот тайтл этому источнику. Не объявлено — считаем, что да. */
function canAsk(source: VideoSource, ask: PlayAsk): boolean {
  const able = source.canAskPresence
  return able === undefined ? true : able.call(source, reqOf(ask))
}

/** Зовёт подписчиков. Чужая ошибка в перерисовке не должна валить заход. */
function callWatchers(): void {
  notifiedAt = Date.now()

  for (const watcher of [...watchers]) {
    try {
      watcher()
    } catch (e) {
      Logger('WARN', 'Метка доступности: подписчик споткнулся', e)
    }
  }
}

/**
 * Оповещение с придержкой. Оптовый ответ приносит два десятка меток разом, и
 * перерисовывать сетку на каждую значило бы двадцать пересборок строк подряд.
 */
function notify(): void {
  if (waiting !== null) return

  const left = NOTIFY_MS - (Date.now() - notifiedAt)
  if (left <= 0) {
    callWatchers()
    return
  }

  waiting = setTimeout(() => {
    waiting = null
    callWatchers()
  }, left)
}

/** Досылает отложенное: заход кончился, и ждать больше нечего. */
function flush(): void {
  if (waiting !== null) {
    clearTimeout(waiting)
    waiting = null
  }

  callWatchers()
}

/** Кладёт решение: в память, на склад и в глаза человеку. */
function remember(mediaId: number, state: PlayState): void {
  memory.set(mediaId, { at: Date.now(), state })
  looked.add(mediaId)
  writeCache(mediaId, state)

  queue.delete(mediaId)
  heard.delete(mediaId)
  tried.delete(mediaId)
  hushed.delete(mediaId)

  notify()
}

/**
 * Пробует решить по тому, что уже услышано.
 *
 * «Да» ставится от первого же источника: вход есть, и спорить тут нечему.
 * «Нет» — только когда высказались все, кому тайтл адресуем: молчание одного
 * из них означает «не знаю», а метка «нет видео» на «не знаю» — прямая ложь.
 */
function settle(ask: PlayAsk, sources: readonly VideoSource[]): void {
  const row = heard.get(ask.mediaId)
  if (row === undefined) return

  for (const state of row.values()) {
    if (state) {
      remember(ask.mediaId, 'yes')
      return
    }
  }

  const able = sources.filter((source) => canAsk(source, ask))
  if (able.length === 0) return
  if (able.some((source) => !row.has(source.id))) return

  remember(ask.mediaId, 'no')
}

/** Спрашивает источник. Никогда не отклоняется: отказ — это null и запись в журнал. */
async function askSource(
  source: VideoSource,
  asks: readonly PlayAsk[],
): Promise<PresenceMap | null> {
  const question = source.askPresence
  if (question === undefined) return null

  try {
    return await question.call(
      source,
      asks.map((ask) => reqOf(ask)),
    )
  } catch (e) {
    Logger('WARN', `Метка доступности: источник ${source.id} не ответил`, e)
    return null
  }
}

/**
 * Следующий заход: первый источник из перечня, которому есть что задать, и
 * столько тайтлов, сколько он берёт за раз. Очередь просматривается в своём
 * порядке, поэтому отвечается сначала то, что человек видит сверху.
 */
function nextTurn(sources: readonly VideoSource[], limit: number): Turn | null {
  for (const source of sources) {
    const asks: PlayAsk[] = []

    for (const ask of queue.values()) {
      if (tried.get(ask.mediaId)?.has(source.id) === true) continue
      if (!canAsk(source, ask)) continue

      asks.push(ask)
      if (asks.length >= limit) break
    }

    if (asks.length > 0) return { source, asks }
  }

  return null
}

/** Один заход: спросили, отметили спрошенное, попробовали решить. */
async function runTurn(turn: Turn, sources: readonly VideoSource[]): Promise<void> {
  const answer = await askSource(turn.source, turn.asks)

  for (const ask of turn.asks) {
    // Отметка ставится и на молчание: иначе работник спрашивал бы одно и то же
    // по кругу и до хвоста очереди не доходил никогда.
    const marks = tried.get(ask.mediaId) ?? new Set<string>()
    marks.add(turn.source.id)
    tried.set(ask.mediaId, marks)

    const state = answer?.get(ask.mediaId)
    if (state !== undefined) {
      const row = heard.get(ask.mediaId) ?? new Map<string, boolean>()
      row.set(turn.source.id, state)
      heard.set(ask.mediaId, row)
    }

    settle(ask, sources)
  }
}

/** Остаток, о котором все спрошенные промолчали, уходит в тишину до своего срока. */
function hush(): void {
  const now = Date.now()

  for (const mediaId of queue.keys()) {
    hushed.set(mediaId, now)
    heard.delete(mediaId)
    tried.delete(mediaId)
  }

  queue.clear()
}

/** Проход по очереди до конца: сначала дешёвые вопросы, потом дорогие. */
async function drain(): Promise<void> {
  tried.clear()

  for (;;) {
    if (queue.size === 0) break

    // Реестр собирает слой api, и до первой полки он может быть пуст:
    // тогда очередь только копила бы память.
    const sources = listVideoSources().filter((source) => source.askPresence !== undefined)
    if (sources.length === 0) {
      queue.clear()
      break
    }

    const bulk = sources.filter((source) => source.presenceCost === 'batch')
    const slow = sources.filter((source) => source.presenceCost !== 'batch')

    // Дешёвая фаза идёт первой на каждом шаге, а не один раз в начале: пока
    // работник возится с дорогими, экран мог положить в очередь новую полку,
    // и её оптовый ответ не должен ждать чужих минут.
    const turn = nextTurn(bulk, BULK_CHUNK) ?? nextTurn(slow, 1)
    if (turn === null) {
      hush()
      break
    }

    await runTurn(turn, sources)
    await sleep(REST_MS)
  }

  flush()
}

/** Запускает работника, если он не идёт. Возвращает обещание идущего захода. */
function pump(): Promise<void> {
  if (working === null) {
    working = drain()
      .catch((e: unknown) => {
        Logger('WARN', 'Метка доступности: заход сорвался', e)
      })
      .finally(() => {
        working = null

        // Пока заход кончался, экран мог положить в очередь новое: без этой
        // проверки просьба ждала бы следующего входа на экран.
        if (queue.size > 0) void pump()
      })
  }

  return working
}

/**
 * Кладёт вопросы в очередь. Уже решённое, уже стоящее в очереди и то, о чём
 * недавно промолчали, отбрасывается здесь же: очередь не должна расти от
 * повторных перерисовок одного и того же экрана.
 */
function enqueue(asks: readonly PlayAsk[]): number {
  const fresh: PlayAsk[] = []
  const now = Date.now()

  for (const ask of asks) {
    const id = ask.mediaId
    if (!Number.isFinite(id) || id <= 0) continue
    if (known(id) !== null || queue.has(id)) continue

    // Ни имени, ни номера: спрашивать нечем, и это не повод занимать очередь.
    if (ask.titles.length === 0 && ask.malId === null) continue

    const quiet = hushed.get(id)
    if (quiet !== undefined && now - quiet < HUSH_TIME_MS) continue

    fresh.push(ask)
  }

  if (fresh.length === 0) return 0

  // Свежая просьба — про то, что человек видит сейчас, поэтому она встаёт
  // впереди прежней очереди: иначе метки доезжали бы на экран, с которого
  // уже ушли, а открытая полка ждала бы своей череды за чужой сеткой.
  const older = [...queue.values()]
  queue.clear()

  for (const ask of fresh) queue.set(ask.mediaId, ask)
  for (const ask of older) if (!queue.has(ask.mediaId)) queue.set(ask.mediaId, ask)

  return fresh.length
}

/**
 * Что известно о тайтле прямо сейчас, без сети и без склада. Разметка зовёт
 * только это: сотня плиток не вправе уйти в сеть сотню раз.
 */
export function peekPlayable(mediaId: number): PlayState | null {
  return known(mediaId)
}

/**
 * Поднимает ответы со склада. Сети не касается вовсе, поэтому зовётся по всем
 * показанным тайтлам разом: однажды спрошенное показывается целиком, включая
 * хвост списка за прокруткой.
 *
 * Возвращает, сколько тайтлов получили метку: ноль означает, что перерисовывать
 * нечего.
 */
export async function primePlayable(mediaIds: readonly number[]): Promise<number> {
  const wanted = [...new Set(mediaIds)].filter(
    (id) => Number.isFinite(id) && id > 0 && known(id) === null && !looked.has(id),
  )
  if (wanted.length === 0) return 0

  const states = await Promise.all(wanted.map((id) => readCache(id)))

  let found = 0

  for (let index = 0; index < wanted.length; index += 1) {
    const id = wanted[index]
    if (id === undefined) continue

    // Отметка «смотрели» ставится после чтения, а не до него: до ответа склада
    // соседний заход счёл бы тайтл проверенным и метку бы не показал.
    looked.add(id)

    const state = states[index] ?? null
    if (state === null) continue

    memory.set(id, { at: Date.now(), state })
    found += 1
  }

  return found
}

/**
 * Просит спросить источники и сразу возвращает управление. Ответы приходят
 * подпиской onPlayableChange, а не отсюда: экран рисует по мере готовности,
 * и полка перестаёт зависеть от самого медленного тайтла в очереди.
 *
 * Возвращает, сколько вопросов впрямь встало в очередь.
 */
export function requestPlayable(asks: readonly PlayAsk[]): number {
  const added = enqueue(asks)
  if (queue.size > 0) void pump()
  return added
}

/**
 * То же, но с ожиданием конца захода. Нужно там, где экран показывает признак
 * работы: очередь общая, поэтому ждётся она вся, а не только свои вопросы.
 *
 * Возвращает, сколько из спрошенных тайтлов получили метку.
 */
export async function warmPlayable(asks: readonly PlayAsk[]): Promise<number> {
  requestPlayable(asks)
  await pump()

  let found = 0
  for (const ask of asks) {
    if (known(ask.mediaId) !== null) found += 1
  }

  return found
}

/**
 * Подписка на новые ответы. Возвращает отписку: экран обязан её позвать при
 * уходе, иначе перерисовка переживёт сам экран.
 */
export function onPlayableChange(watcher: () => void): () => void {
  watchers.add(watcher)

  return () => {
    watchers.delete(watcher)
  }
}

/** Только для проверок и кнопки очистки кэша: память сама себя не чистит. */
export function forgetPlayable(): void {
  memory.clear()
  looked.clear()
  queue.clear()
  heard.clear()
  tried.clear()
  hushed.clear()
}
