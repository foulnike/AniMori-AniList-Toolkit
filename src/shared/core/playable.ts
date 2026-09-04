// Метка доступности: есть ли у наших источников вход к тайтлу. Один бит на тайтл —
// и самый дорогой бит в приложении: спрашивать приходится службы, которые про
// перечни ни с кем не договаривались, а показывать — сеткой на полторы сотни постеров.
//
// Устройство: склад ответов в mediaCache, память на запуск, общая очередь и по
// работнику на источник. Экраны кладут в очередь всё, что видно, и подпиской узнают
// о каждом новом ответе: рисовать по мере готовности — единственный способ не
// выглядеть остановкой, когда полка длиннее пары рядов.
//
// ДОРОЖКА НА ИСТОЧНИК. Работники идут одновременно и друг друга не ждут. Общий
// работник, проходивший очередь подряд, стоил витрины: один вопрос Aniliberty —
// это поиск по названию, до двух запросов по десять секунд ожидания, и всё это
// время оптовый ответ, готовый лечь на два десятка плиток разом, ждал своей череды.
// На списке в полторы сотни постеров метки замирали на первом десятке.
//
// СРЫВ — НЕ ОТВЕТ. Заход, на который служба не сказала ни слова, считается
// сорванным: тайтлы остаются в очереди, заход ужимается, а служба отдыхает — с
// каждым срывом подряд дольше. Прежде срыв записывался как «спрошено», и один
// HTTP 500 снимал с Kodik два десятка тайтлов до конца прохода, а оборванный поиск
// Aniliberty — тайтл насовсем.
//
// РАЗМЕР ЗАХОДА ПОДБИРАЕТСЯ. Служба вправе не понять перечень номеров вовсе:
// Kodik на таком отвечает пятисотой и до поштучного опроса внутри себя не
// доходит. Поэтому размер оптового захода здесь не постоянный: срыв делит его
// вчетверо вплоть до одного номера, а найденный рабочий размер до перезапуска
// уже не растёт — возврат к полному означал бы новый срыв на тех же тайтлах.
//
// ДОРОГОЕ — ВТОРЫМ. Тайтл, о котором ещё не высказался оптовый источник, дорогой
// службе не адресуется: незачем спрашивать поимённо о том, про что вот-вот скажут
// двумя десятками разом. Отдыхающий оптовый источник очередь при этом не держит.
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

/**
 * С чего начинается оптовый заход и до чего он ужимается после срывов. Единица
 * внизу — не оговорка: перечень номеров служба нигде не обещает, и один номер
 * за раз бывает единственным размером, на который она вообще отвечает.
 */
const BULK_CHUNK = 20
const BULK_MIN = 1

/** Во сколько раз срыв ужимает заход: вчетверо, чтобы искать рабочий размер быстро. */
const BULK_DOWN = 4

/** Пауза между заходами одной дорожки: очередь меток не единственный жилец сети. */
const REST_MS = 60

/** Не чаще этого зовутся подписчики: перерисовка сетки дороже самого ответа. */
const NOTIFY_MS = 250

/**
 * Сколько ждём ответа на заход. У служб свои сроки на запрос, но заход
 * складывается из нескольких запросов подряд, и дорожка не должна висеть на нём
 * дольше, чем человек готов смотреть на пустые плитки.
 */
const ASK_TIME_MS = 30000

/** Отдых после срыва: первый, прибавка за каждый следующий подряд и потолок. */
const REST_FAIL_MS = 3000
const REST_STEP_MS = 5000
const REST_MAX_MS = 60000

/**
 * Сколько срывов по одному тайтлу терпим, прежде чем счесть, что служба
 * промолчала. Трёх хватает, чтобы тайтл пережил подбор размера захода.
 */
const FAIL_LIMIT = 3

/** Через сколько переспрашивать тайтл, о котором источники так и не высказались. */
const HUSH_TIME_MS = 600000

/** Потолок очереди: витрина ушла вперёд, и хвост позапрошлой сетки уже никому не нужен. */
const QUEUE_MAX = 600

/** Сколько ждёт warmPlayable, прежде чем снять с экрана признак работы. */
const WARM_WAIT_MS = 4000
const WARM_STEP_MS = 150

/** Через сколько заглянуть в реестр, если к первой полке он ещё пуст. */
const WAIT_SOURCES_MS = 1000

/** Ответ источников: вход есть или входа нет. Третьего значения нет намеренно. */
export type PlayState = 'yes' | 'no'

/**
 * Чем спрашивать источники об одном тайтле. Собирает вопрос экран: имена и
 * чужие номера живут у него, а ядру их взять негде.
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

/** Самочувствие службы: срывы подряд, отдых до срока и нынешний размер захода. */
interface Health {
  fails: number
  until: number
  chunk: number
}

const memory = new Map<number, Held>()

/** Тайтлы, уже поднятые со склада: пустой склад — тоже ответ, и второй раз он не читается. */
const looked = new Set<number>()

/** Очередь вопросов: ключ — тайтл, значение — чем спрашивать. Порядок — порядок показа. */
const queue = new Map<number, PlayAsk>()

/** Что источники сказали про тайтл. Живёт до решения по нему. */
const heard = new Map<number, Map<string, boolean>>()

/** Кто про тайтл уже высказался. Молчание внутри ответа — тоже высказывание. */
const tried = new Map<number, Set<string>>()

/** Сколько раз служба сорвалась на тайтле. Терпение считается поимённо. */
const missed = new Map<number, Map<string, number>>()

/** Когда о тайтле так и не высказались: раньше срока переспрашивать нечего. */
const hushed = new Map<number, number>()

/** Подписчики: экраны, которым надо перерисоваться на новый ответ. */
const watchers = new Set<() => void>()

/** Идущие дорожки. По одной на службу: две удвоили бы запросы. */
const lanes = new Map<string, Promise<void>>()

/** Самочувствие служб. Ключ — id источника. */
const health = new Map<string, Health>()

/** Когда подписчиков звали в последний раз и отложенный зов, если он назначен. */
let notifiedAt = 0
let waiting: ReturnType<typeof setTimeout> | null = null

/** Будильник: один на всех, поднимает дорожки к сроку чужого отдыха. */
let waking: ReturnType<typeof setTimeout> | null = null
let wakeAt = 0

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

/** Зовёт подписчиков. Чужая ошибка в перерисовке не должна валить дорожку. */
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

/** Досылает отложенное: работа кончилась, и ждать больше нечего. */
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
  missed.delete(mediaId)
  hushed.delete(mediaId)

  notify()
}

/** Тайтл без решения уходит из очереди в тишину: переспросим его своим сроком. */
function hushOne(mediaId: number): void {
  hushed.set(mediaId, Date.now())

  queue.delete(mediaId)
  heard.delete(mediaId)
  tried.delete(mediaId)
  missed.delete(mediaId)
}

function healthOf(source: VideoSource): Health {
  const found = health.get(source.id)
  if (found !== undefined) return found

  const fresh: Health = { fails: 0, until: 0, chunk: BULK_CHUNK }
  health.set(source.id, fresh)
  return fresh
}

/** Отдыхает ли служба: до срока её не тревожим. */
function resting(source: VideoSource): boolean {
  return healthOf(source).until > Date.now()
}

/** Заход сорвался: он ужимается, а отдых растёт с каждым срывом подряд. */
function fell(source: VideoSource): void {
  const state = healthOf(source)

  state.fails += 1
  state.until = Date.now() + Math.min(REST_FAIL_MS + REST_STEP_MS * (state.fails - 1), REST_MAX_MS)
  state.chunk = Math.max(BULK_MIN, Math.floor(state.chunk / BULK_DOWN))

  Logger(
    'WARN',
    `Метка доступности: ${source.id} не ответил, срывов подряд ${state.fails}, заход ${state.chunk}`,
  )
}

/**
 * Служба ответила: счёт срывов обнуляется и отдых снимается. Размер захода при
 * этом остаётся найденным: вернуть его к полному значило бы снова сорваться
 * на том же перечне и снова потратить попытки тех же тайтлов.
 */
function stood(source: VideoSource): void {
  const state = healthOf(source)

  state.fails = 0
  state.until = 0
}

/** Отмечает, что служба про тайтл высказалась. */
function markTried(mediaId: number, sourceId: string): void {
  const marks = tried.get(mediaId) ?? new Set<string>()
  marks.add(sourceId)
  tried.set(mediaId, marks)
}

function wasTried(mediaId: number, sourceId: string): boolean {
  return tried.get(mediaId)?.has(sourceId) === true
}

/** Считает срывы службы на тайтле и отдаёт новый счёт. */
function markFail(mediaId: number, sourceId: string): number {
  const row = missed.get(mediaId) ?? new Map<string, number>()
  const count = (row.get(sourceId) ?? 0) + 1

  row.set(sourceId, count)
  missed.set(mediaId, row)
  return count
}

/**
 * Пробует решить по тому, что уже услышано.
 *
 * «Да» ставится от первого же источника: вход есть, и спорить тут нечему.
 * «Нет» — только когда каждый, кому тайтл адресуем, ответил явно. Кто-то
 * высказался молчанием — значит «не знаю», и такой тайтл уходит в тишину:
 * метка «нет видео» на «не знаю» — прямая ложь.
 */
function settle(ask: PlayAsk, sources: readonly VideoSource[]): void {
  const row = heard.get(ask.mediaId)

  if (row !== undefined) {
    for (const state of row.values()) {
      if (state) {
        remember(ask.mediaId, 'yes')
        return
      }
    }
  }

  const able = sources.filter((source) => canAsk(source, ask))
  if (able.length === 0) {
    hushOne(ask.mediaId)
    return
  }

  if (able.some((source) => !wasTried(ask.mediaId, source.id))) return

  if (row !== undefined && able.every((source) => row.has(source.id))) {
    remember(ask.mediaId, 'no')
    return
  }

  hushOne(ask.mediaId)
}

/** Спрашивает службу. Никогда не отклоняется: срыв — это null и запись в журнал. */
async function askSource(
  source: VideoSource,
  asks: readonly PlayAsk[],
): Promise<PresenceMap | null> {
  const question = source.askPresence
  if (question === undefined) return null

  let bomb: ReturnType<typeof setTimeout> | null = null

  // Свой срок поверх чужого: у службы он на один запрос, а заход складывается
  // из нескольких, и повисший заход держал бы дорожку до самого ухода с экрана.
  const late = new Promise<never>((_, reject) => {
    bomb = setTimeout(() => {
      reject(new Error('ответа нет дольше срока'))
    }, ASK_TIME_MS)
  })

  try {
    return await Promise.race([
      question.call(
        source,
        asks.map((ask) => reqOf(ask)),
      ),
      late,
    ])
  } catch (e) {
    Logger('WARN', `Метка доступности: источник ${source.id} не ответил`, e)
    return null
  } finally {
    if (bomb !== null) clearTimeout(bomb)
  }
}

/** Высказались ли оптовые службы по тайтлу. Отдыхающая очередь не держит. */
function bulkSpoke(ask: PlayAsk, sources: readonly VideoSource[]): boolean {
  for (const source of sources) {
    if (source.presenceCost !== 'batch') continue
    if (!canAsk(source, ask)) continue
    if (resting(source)) continue
    if (!wasTried(ask.mediaId, source.id)) return false
  }

  return true
}

/** Берёт из очереди то, что этой службе ещё можно задать. Порядок — порядок показа. */
function pick(source: VideoSource, sources: readonly VideoSource[], limit: number): PlayAsk[] {
  const asks: PlayAsk[] = []
  const waitsBulk = source.presenceCost !== 'batch'

  for (const ask of queue.values()) {
    if (wasTried(ask.mediaId, source.id)) continue
    if (!canAsk(source, ask)) continue
    if (waitsBulk && !bulkSpoke(ask, sources)) continue

    asks.push(ask)
    if (asks.length >= limit) break
  }

  return asks
}

/** Один заход: спросили, разложили ответ, попробовали решить. */
async function runTurn(
  source: VideoSource,
  asks: readonly PlayAsk[],
  sources: readonly VideoSource[],
): Promise<void> {
  const answer = await askSource(source, asks)

  // Ни слова про весь заход — это срыв службы, а не ответ о тайтлах: HTTP 500
  // оптовой и оборванный поиск дорогой приходят сюда одинаково пустыми.
  if (answer === null || answer.size === 0) {
    fell(source)

    for (const ask of asks) {
      // Терпение не бесконечно: иначе дорожка топталась бы на первых тайтлах
      // очереди всё время, пока служба лежит.
      if (markFail(ask.mediaId, source.id) < FAIL_LIMIT) continue

      markTried(ask.mediaId, source.id)
      settle(ask, sources)
    }

    return
  }

  stood(source)

  for (const ask of asks) {
    markTried(ask.mediaId, source.id)

    const state = answer.get(ask.mediaId)
    if (state !== undefined) {
      const row = heard.get(ask.mediaId) ?? new Map<string, boolean>()
      row.set(source.id, state)
      heard.set(ask.mediaId, row)
    }

    settle(ask, sources)
  }
}

/** Источники, которым вообще можно задать вопрос о наличии. */
function askableSources(): VideoSource[] {
  return listVideoSources().filter((source) => source.askPresence !== undefined)
}

/** Работник одной службы: спрашивает, пока в очереди есть вопросы для неё. */
async function lane(source: VideoSource): Promise<void> {
  for (;;) {
    const sources = askableSources()
    if (sources.length === 0) return

    const state = healthOf(source)
    const rest = state.until - Date.now()

    if (rest > 0) {
      // Отдых — не повод бросать дорожку: очередь всё это время держит её
      // тайтлы, и по сроку их спросят снова.
      await sleep(rest)
      continue
    }

    const asks = pick(source, sources, source.presenceCost === 'batch' ? state.chunk : 1)
    if (asks.length === 0) return

    await runTurn(source, asks, sources)
    await sleep(REST_MS)
  }
}

/** Через сколько будить дорожки: ближайший чужой отдых. Меньше нуля — ждать нечего. */
function nearestRest(sources: readonly VideoSource[]): number {
  const now = Date.now()
  let soon = -1

  for (const source of sources) {
    const left = healthOf(source).until - now
    if (left <= 0) continue
    if (soon < 0 || left < soon) soon = left
  }

  return soon
}

/** Убирает из очереди тайтлы, которые уже некому адресовать. */
function sweep(sources: readonly VideoSource[]): void {
  for (const ask of [...queue.values()]) {
    const open = sources.some((source) => canAsk(source, ask) && !wasTried(ask.mediaId, source.id))
    if (open) continue

    hushOne(ask.mediaId)
  }
}

/** Заводит будильник на ближайший срок. Раньше назначенного он не переносится. */
function wake(ms: number): void {
  if (ms < 0) return

  const at = Date.now() + ms
  if (waking !== null && wakeAt <= at) return
  if (waking !== null) clearTimeout(waking)

  wakeAt = at
  waking = setTimeout(() => {
    waking = null
    wakeAt = 0
    pump()
  }, ms)
}

/** Поднимает работников по всем службам, которым есть что спросить. */
function pump(): void {
  if (queue.size === 0) return

  const sources = askableSources()

  // Реестр собирает слой api, и до первой полки он может быть пуст. Очередь при
  // этом не трогаем: службы появятся, и вопросы дождутся их на месте.
  if (sources.length === 0) {
    wake(WAIT_SOURCES_MS)
    return
  }

  for (const source of sources) {
    if (lanes.has(source.id)) continue
    if (pick(source, sources, 1).length === 0) continue

    const work = lane(source)
      .catch((e: unknown) => {
        Logger('WARN', `Метка доступности: дорожка ${source.id} сорвалась`, e)
      })
      .finally(() => {
        lanes.delete(source.id)
        if (lanes.size === 0) flush()

        // Пока дорожка кончалась, экран мог положить в очередь новое, а соседняя
        // служба — отпустить придержанные вопросы.
        if (queue.size > 0) pump()
      })

    lanes.set(source.id, work)
  }

  if (lanes.size > 0) return

  // Дорожек нет, а очередь не пуста: либо ждём чужого отдыха, либо в ней осели
  // тайтлы, которые уже некому спросить.
  const soon = nearestRest(sources)
  if (soon >= 0) {
    wake(soon)
    return
  }

  sweep(sources)
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

  for (const ask of older) {
    if (queue.has(ask.mediaId)) continue

    if (queue.size < QUEUE_MAX) {
      queue.set(ask.mediaId, ask)
      continue
    }

    // Не влез в потолок: витрина ушла вперёд, и пометки по нему уже лишние.
    heard.delete(ask.mediaId)
    tried.delete(ask.mediaId)
    missed.delete(ask.mediaId)
  }

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
  pump()
  return added
}

/**
 * То же, но с ожиданием ответов по своим тайтлам. Нужно там, где экран
 * показывает признак работы.
 *
 * Ждёт только свои вопросы и только до срока: очередь общая и живёт минутами,
 * а верчение на экране столько висеть не должно — остальное дорисует подписка.
 *
 * Возвращает, сколько из спрошенных тайтлов получили метку.
 */
export async function warmPlayable(asks: readonly PlayAsk[]): Promise<number> {
  requestPlayable(asks)

  const until = Date.now() + WARM_WAIT_MS

  for (;;) {
    const left = asks.some((ask) => known(ask.mediaId) === null && queue.has(ask.mediaId))
    if (!left) break
    if (Date.now() >= until) break

    await sleep(WARM_STEP_MS)
  }

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
  missed.clear()
  hushed.clear()
  health.clear()
}
