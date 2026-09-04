// Доступность тайтла у источников видео: та самая метка на плитке.
//
// Плитка своих данных не добывает — сотня плиток ушла бы в сеть сотню раз, —
// поэтому знание живёт здесь: три состояния, склад ответов и один проход
// по реестру источников.
//
// Состояний именно три: «есть», «нет» и «ещё не спросили». Третье обязательно.
// Без него лежащий источник обратился бы в «смотреть нельзя» на всей витрине
// разом, а это ложь, и притом тихая. Отсутствие метки говорит «не знаю» —
// и это честнее любой догадки.
//
// Ответ лежит на складе, а не только в запуске. Без склада метка стоила бы
// двух запросов на плитку при каждом заходе, и показывать её всюду было бы
// нельзя — только верху одной полки. Сроки разные, и разница не случайна:
//
//   «есть» — неделя. Тайтл, который у источника лежит, оттуда почти никогда
//     не исчезает: озвучка сменится, вход останется.
//   «нет» — сутки, ровно как промах у Aniliberty (MISS_RETRY_MS). Это ответ
//     «пока не завезли», и он обязан протухать сам: релизы приезжают каждый
//     день, а метка «нет видео» на завезённом тайтле — прямая ложь.
//
// На складе лежит один бит про наличие входа. Ссылки на поток не лежат нигде
// и никогда: они подписаны и живут часы (см. docs/ARCHITECTURE-VIDEO.md).
//
// Спрашивается реестр в два захода. Источник, умеющий оптовый вопрос, получает
// всю пачку разом: два десятка тайтлов уходят в один запрос, и полка на шесть
// десятков строк стоит трёх. Источник, входящий по названию, стоит запроса
// на тайтл — ему достаётся только нерешённое и только в пределах бюджета,
// а остаток доберётся следующим заходом. Раньше спрашивалось по четыре тайтла
// сразу и у всех подряд: полка в триста строк на таком порядке не доходила
// до конца никогда.
//
// В датасет это знание по-прежнему не идёт: датасет выходит под CC0 и несёт
// факты каталога, а не наблюдения нашего клиента за чужими службами. Правило
// «Kodik — только рантайм» тем и соблюдено: склад лежит на своём диске
// и чистится кнопкой в настройках вместе с остальным кэшем.
//
// Своих источников этот файл не знает: он ходит по реестру core/video, а кто
// в нём лежит, решает api/video-sources.ts. Реестр должен быть собран до
// первого вопроса: ядро своих поставщиков не зовёт.

import { Logger } from '../utils/logger'
import { dbGet, dbSet } from './db'
import type { MediaCacheRecord } from './types'
import {
  listVideoSources,
  type PresenceMap,
  type VideoRequest,
  type VideoSource,
} from './video'

/** Что известно про тайтл. «Ещё не спросили» — это отсутствие записи. */
export type PlayState = 'yes' | 'no'

/** Что источникам нужно про тайтл: Kodik входит по номеру, Aniliberty — по названию. */
export interface PlayAsk {
  mediaId: number
  malId: number | null
  /** Названия по убыванию пригодности для поиска: романдзи, английское, русское. */
  titles: string[]
  year?: number
}

/**
 * Приставка ключа на складе. Своя и с номером: сменится смысл записи —
 * сменится и приставка, а старые записи умрут сами, не притворяясь новыми.
 */
const CACHE_PREFIX = 'PLAY1_'

/** Сколько живёт ответ «есть»: неделя. */
const YES_TIME_MS = 604800000

/** Сколько живёт ответ «нет»: сутки. */
const NO_TIME_MS = 86400000

/**
 * По скольку тайтлов спрашивать источник, не умеющий оптового вопроса.
 * Пачка идёт разом, но не вся полка: у источников свои ограничители, и очередь
 * из семидесяти вопросов задержала бы не только метки, но и сам просмотр,
 * если человек нажмёт «Смотреть» посреди неё.
 */
const ASK_CHUNK = 4

/**
 * Сколько тайтлов достаётся дорогим источникам за один заход. Оптовый вопрос
 * идёт про всю пачку целиком, а тот, кто входит по названию, стоит запроса
 * на тайтл: полка на триста строк встала бы у него в очередь на пять минут.
 * Остаток доберётся следующим заходом: склад к тому времени ответит даром.
 */
const SLOW_LIMIT = 24

/** Что лежит на складе. Объектом, а не строкой: у записи будет чему прирасти. */
interface PlayRecord {
  state: PlayState
}

/** Ответ вместе со временем добычи: срок считается от него, а не от показа. */
interface Held {
  at: number
  state: PlayState
}

/** Сколько источников высказалось про тайтл и было ли среди них «да». */
interface Tally {
  yes: boolean
  count: number
}

const memory = new Map<number, Held>()
const pending = new Map<number, Promise<void>>()

/**
 * Тайтлы, про которые склад уже спрашивали. Перерисовка полки зовёт подъём
 * заново, и без этого списка каждый показ стучал бы в диск за теми же
 * промахами. Промах склада — тоже знание.
 */
const looked = new Set<number>()

/** Сколько живёт ответ. «Нет» дешевле перепроверить, чем ошибиться им. */
function lifeOf(state: PlayState): number {
  return state === 'yes' ? YES_TIME_MS : NO_TIME_MS
}

function fresh(held: Held): boolean {
  return Date.now() - held.at < lifeOf(held.state)
}

/** Живая запись памяти. Протухшая удаляется: она равносильна отсутствию. */
function known(mediaId: number): PlayState | null {
  const found = memory.get(mediaId)
  if (found === undefined) return null

  if (!fresh(found)) {
    memory.delete(mediaId)
    // Про склад забываем тоже: там лежит та же протухшая запись, и её
    // перезапишет первый же ответ сети.
    looked.delete(mediaId)
    return null
  }

  return found.state
}

/** Что известно прямо сейчас, без ожидания. Разметка ждать не умеет. */
export function peekPlayable(mediaId: number): PlayState | null {
  return known(mediaId)
}

/**
 * Читает ответ со склада. Битая запись и запись не той формы считаются
 * промахом: склад правится кнопкой очистки, а не миграциями.
 */
async function readCache(mediaId: number): Promise<PlayState | null> {
  const record = await dbGet<MediaCacheRecord<PlayRecord>>(
    'mediaCache',
    `${CACHE_PREFIX}${mediaId}`,
  )

  const state = record?.data?.state
  if (state !== 'yes' && state !== 'no') return null

  const held: Held = { at: typeof record?.ts === 'number' ? record.ts : 0, state }
  if (!fresh(held)) return null

  memory.set(mediaId, held)
  return state
}

/** Кладёт ответ на склад. Ошибки записи глушит сам слой БД. */
async function writeCache(mediaId: number, state: PlayState): Promise<void> {
  await dbSet('mediaCache', {
    key: `${CACHE_PREFIX}${mediaId}`,
    data: { state },
    ts: Date.now(),
  })
}

/**
 * Поднимает со склада всё, что там есть, и ничего не спрашивает у сети.
 * Зовётся перед показом: пришедший вчера ответ достаётся даром, и метка
 * стоит уже на первой отрисовке.
 *
 * Возвращает, про сколько тайтлов ответ нашёлся.
 */
export async function primePlayable(mediaIds: readonly number[]): Promise<number> {
  const wanted: number[] = []
  const seen = new Set<number>()

  for (const id of mediaIds) {
    if (!Number.isFinite(id) || id <= 0) continue
    if (seen.has(id)) continue

    seen.add(id)
    if (known(id) === null && !looked.has(id)) wanted.push(id)
  }

  if (wanted.length === 0) return 0

  let found = 0

  await Promise.all(
    wanted.map(async (id) => {
      // Помета до чтения: недоступная база отвечает промахом, и второй раз
      // тревожить её тем же вопросом незачем — ответ добудет сеть.
      looked.add(id)
      if ((await readCache(id)) !== null) found += 1
    }),
  )

  return found
}

/** Вопрос источнику из вопроса метки. Собирается так же, как его собирает плеер. */
function reqOf(ask: PlayAsk): VideoRequest {
  return {
    anilistId: ask.mediaId,
    malId: ask.malId,
    // У аниме номер Шикимори равен номеру MAL: так же собирает запрос плеер.
    shikimoriId: ask.malId,
    titles: ask.titles,
    year: ask.year,
  }
}

/**
 * Спрашивает один источник про пачку. Умеет оптовый вопрос — задаём его,
 * не умеет — идём поштучно и мелкими горстями, как раньше.
 *
 * Молчание источника про тайтл в ответ не попадает вовсе: карта несёт
 * только то, что сказано определённо.
 */
async function askSource(
  source: VideoSource,
  reqs: readonly VideoRequest[],
): Promise<PresenceMap> {
  const out: PresenceMap = new Map()
  if (reqs.length === 0) return out

  if (source.askPresence !== undefined) {
    try {
      return await source.askPresence(reqs)
    } catch (e) {
      Logger('WARN', `Доступность: источник ${source.id} не ответил про пачку из ${reqs.length}`, e)
      return out
    }
  }

  for (let from = 0; from < reqs.length; from += ASK_CHUNK) {
    await Promise.all(
      reqs.slice(from, from + ASK_CHUNK).map(async (req) => {
        try {
          const voices = await source.listVoices(req)
          out.set(req.anilistId, voices.length > 0)
        } catch (e) {
          Logger('WARN', `Доступность: источник ${source.id} не ответил про ${req.anilistId}`, e)
        }
      }),
    )
  }

  return out
}

/**
 * Спрашивает реестр про всю пачку в два захода: сперва оптовые — один их
 * запрос закрывает два десятка тайтлов, — потом дорогие, и только про то,
 * что осталось нерешённым, и только в пределах бюджета.
 *
 * «Нет» ставится только при полном согласии. Не высказался хотя бы один
 * источник — состояние остаётся неизвестным: молчание службы это приговор
 * ей, а не тайтлу. Тот, кому пачка не досталась из-за бюджета, тоже считается
 * не высказавшимся.
 */
async function askSources(asks: readonly PlayAsk[]): Promise<void> {
  const sources = listVideoSources()
  if (sources.length === 0) {
    Logger('WARN', 'Доступность: реестр источников пуст, спрашивать некого')
    return
  }

  const said = new Map<number, Tally>()

  const mark = (answer: PresenceMap): void => {
    for (const [mediaId, state] of answer) {
      const found = said.get(mediaId) ?? { yes: false, count: 0 }
      found.yes = found.yes || state
      found.count += 1
      said.set(mediaId, found)
    }
  }

  const bulk = sources.filter(
    (source) => source.askPresence !== undefined && source.presenceCost === 'batch',
  )
  const slow = sources.filter((source) => !bulk.includes(source))

  for (const source of bulk) {
    mark(await askSource(source, asks.map(reqOf)))
  }

  // Дорогим достаётся только нерешённое: найденный оптом тайтл уже с меткой.
  const left = asks
    .filter((ask) => !(said.get(ask.mediaId)?.yes ?? false))
    .slice(0, SLOW_LIMIT)
    .map(reqOf)

  for (const source of slow) {
    mark(await askSource(source, left))
  }

  const now = Date.now()
  const writes: Array<Promise<void>> = []

  for (const ask of asks) {
    const answer = said.get(ask.mediaId)
    if (answer === undefined) continue

    if (answer.yes) {
      memory.set(ask.mediaId, { at: now, state: 'yes' })
      writes.push(writeCache(ask.mediaId, 'yes'))
      continue
    }

    // Высказались не все — значит, «нет» ещё не доказано.
    if (answer.count < sources.length) continue

    // Без номера MAL часть источников входа к тайтлу не имеет вовсе, и пустой
    // ответ у них ничего не значит. Такому тайтлу «нет видео» не ставится никогда.
    if (ask.malId === null || ask.malId <= 0) continue

    memory.set(ask.mediaId, { at: now, state: 'no' })
    writes.push(writeCache(ask.mediaId, 'no'))
  }

  await Promise.all(writes)
}

/**
 * Добирает метки показанному куску полки. Сеть тревожится только за тем, чего
 * нет ни в памяти, ни на складе: второй заход на тот же экран не стоит
 * ни одного запроса.
 *
 * Вся пачка уходит одним вопросом, а не по тайтлу за раз: именно поэтому
 * экранам можно просить шесть десятков строк вместо десяти.
 *
 * Возвращает, про сколько тайтлов ответ теперь есть.
 */
export async function warmPlayable(asks: readonly PlayAsk[]): Promise<number> {
  const queue: PlayAsk[] = []
  const seen = new Set<number>()

  for (const ask of asks) {
    const id = ask.mediaId
    if (!Number.isFinite(id) || id <= 0) continue
    if (seen.has(id)) continue

    seen.add(id)
    if (known(id) === null) queue.push(ask)
  }

  if (queue.length === 0) return 0

  // Сначала склад: он отвечает даром и снимает вопрос целиком.
  await primePlayable(queue.map((ask) => ask.mediaId))

  // Те же тайтлы мог спросить другой экран: ждём его заход, а не свой.
  const running = new Set<Promise<void>>()
  for (const ask of queue) {
    const task = pending.get(ask.mediaId)
    if (task !== undefined) running.add(task)
  }
  if (running.size > 0) await Promise.all([...running])

  const wanted = queue.filter((ask) => known(ask.mediaId) === null && !pending.has(ask.mediaId))

  if (wanted.length > 0) {
    // Обещание одно на всю пачку, и в очереди оно записано за каждым тайтлом:
    // соседний экран дождётся его, а не спросит то же самое вторично.
    const task = askSources(wanted)
    for (const ask of wanted) pending.set(ask.mediaId, task)

    try {
      await task
    } finally {
      for (const ask of wanted) pending.delete(ask.mediaId)
    }
  }

  return queue.filter((ask) => known(ask.mediaId) !== null).length
}

/**
 * Забывает всё, что помнит запуск. Записи склада живут своей жизнью: их
 * уносит кнопка очистки кэша в настройках, как и остальные записи mediaCache.
 */
export function forgetPlayable(): void {
  memory.clear()
  pending.clear()
  looked.clear()
}
