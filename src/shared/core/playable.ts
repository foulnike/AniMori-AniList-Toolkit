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
import { listVideoSources, type VideoRequest } from './video'

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
 * По скольку тайтлов спрашиваем сеть за раз. Пачка идёт разом, но не вся полка:
 * у источников свои ограничители, и очередь из семидесяти вопросов задержала
 * бы не только метки, но и сам просмотр, если человек нажмёт «Смотреть»
 * посреди неё.
 */
const ASK_CHUNK = 4

/** Что лежит на складе. Объектом, а не строкой: у записи будет чему прирасти. */
interface PlayRecord {
  state: PlayState
}

/** Ответ вместе со временем добычи: срок считается от него, а не от показа. */
interface Held {
  at: number
  state: PlayState
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

/**
 * Спрашивает все источники сразу: медленный не держит быстрого.
 *
 * «Нет» ставится только при полном согласии. Отказал хоть один источник —
 * состояние остаётся неизвестным: молчание службы это приговор ей, а не тайтлу.
 */
async function probe(ask: PlayAsk): Promise<void> {
  const sources = listVideoSources()
  if (sources.length === 0) return

  const req: VideoRequest = {
    anilistId: ask.mediaId,
    malId: ask.malId,
    // У аниме номер Шикимори равен номеру MAL: так же собирает запрос плеер.
    shikimoriId: ask.malId,
    titles: ask.titles,
    year: ask.year,
  }

  let answered = 0
  let found = false

  await Promise.all(
    sources.map(async (source) => {
      try {
        const voices = await source.listVoices(req)
        answered += 1
        if (voices.length > 0) found = true
      } catch (e) {
        Logger('WARN', `Доступность: источник ${source.id} не ответил про ${ask.mediaId}`, e)
      }
    }),
  )

  if (found) {
    memory.set(ask.mediaId, { at: Date.now(), state: 'yes' })
    await writeCache(ask.mediaId, 'yes')
    return
  }

  // Высказались не все — значит, «нет» ещё не доказано.
  if (answered < sources.length) return

  // Без номера MAL часть источников входа к тайтлу не имеет вовсе, и пустой
  // ответ у них ничего не значит. Такому тайтлу «нет видео» не ставится никогда.
  if (ask.malId === null || ask.malId <= 0) return

  memory.set(ask.mediaId, { at: Date.now(), state: 'no' })
  await writeCache(ask.mediaId, 'no')
}

/**
 * Добирает метки показанному куску полки. Сеть тревожится только за тем, чего
 * нет ни в памяти, ни на складе: второй заход на тот же экран не стоит
 * ни одного запроса.
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

  const wanted = queue.filter((ask) => known(ask.mediaId) === null)
  if (wanted.length === 0) return queue.length

  if (listVideoSources().length === 0) {
    Logger('WARN', 'Доступность: реестр источников пуст, спрашивать некого')
    return queue.length - wanted.length
  }

  for (let from = 0; from < wanted.length; from += ASK_CHUNK) {
    const chunk = wanted.slice(from, from + ASK_CHUNK)

    await Promise.all(
      chunk.map(async (ask) => {
        // Тот же тайтл мог спросить другой экран: ждём тот заход, а не свой.
        const running = pending.get(ask.mediaId)
        if (running !== undefined) {
          await running
          return
        }

        const task = probe(ask)
        pending.set(ask.mediaId, task)

        try {
          await task
        } finally {
          pending.delete(ask.mediaId)
        }
      }),
    )
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
