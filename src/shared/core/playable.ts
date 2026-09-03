// Доступность тайтла у источников видео: та самая метка на плитке.
//
// Плитка своих данных не добывает — сотня плиток ушла бы в сеть сотню раз, —
// поэтому знание живёт здесь: память запуска, три состояния и один проход
// по реестру источников.
//
// Состояний именно три: «есть», «нет» и «ещё не спросили». Третье обязательно.
// Без него лежащий источник обратился бы в «смотреть нельзя» на всей витрине
// разом, а это ложь, и притом тихая. Отсутствие метки говорит «не знаю» —
// и это честнее любой догадки.
//
// Ответы не ложатся ни на склад, ни в датасет, и это не забывчивость.
// Доступность живёт часами: у Kodik час смерти стоит в самой ссылке, у служб
// изредка пропадают целые релизы. Вчерашний ответ здесь хуже отсутствия
// ответа, поэтому память держится ровно столько же, сколько выборка озвучек
// у самих источников, — десять минут, — и умирает вместе с запуском.
//
// Своих источников этот файл не знает: он ходит по реестру core/video, а кто
// в нём лежит, решает api/video-sources.ts. Реестр должен быть собран до
// первого вопроса: ядро своих поставщиков не зовёт.

import { Logger } from '../utils/logger'
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
 * Сколько ответ живёт в памяти. Ровно столько же, сколько выборка озвучек
 * у источников: держать метку дольше, чем живёт то, на чём она стоит, значило
 * бы обещать просмотр там, где смотреть уже нечего.
 */
const MEMORY_MS = 600000

/**
 * По скольку тайтлов спрашиваем за раз. Пачка идёт разом, но не вся полка:
 * у источников свои ограничители, и очередь из семидесяти вопросов задержала
 * бы не только метки, но и сам просмотр, если человек нажмёт «Смотреть»
 * посреди неё.
 */
const ASK_CHUNK = 4

const memory = new Map<number, { at: number; state: PlayState }>()
const pending = new Map<number, Promise<void>>()

/** Живая запись памяти. Протухшая удаляется: она равносильна отсутствию. */
function known(mediaId: number): PlayState | null {
  const found = memory.get(mediaId)
  if (found === undefined) return null

  if (Date.now() - found.at >= MEMORY_MS) {
    memory.delete(mediaId)
    return null
  }

  return found.state
}

/** Что известно прямо сейчас, без ожидания. Разметка ждать не умеет. */
export function peekPlayable(mediaId: number): PlayState | null {
  return known(mediaId)
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
    return
  }

  // Высказались не все — значит, «нет» ещё не доказано.
  if (answered < sources.length) return

  // Без номера MAL часть источников входа к тайтлу не имеет вовсе, и пустой
  // ответ у них ничего не значит. Такому тайтлу «нет видео» не ставится никогда.
  if (ask.malId === null || ask.malId <= 0) return

  memory.set(ask.mediaId, { at: Date.now(), state: 'no' })
}

/**
 * Добирает метки показанному куску полки. Спрашивается только то, чего ещё
 * не знаем: второй заход на тот же экран не стоит ни одного запроса.
 *
 * Возвращает, про сколько тайтлов ответ теперь есть.
 */
export async function warmPlayable(asks: PlayAsk[]): Promise<number> {
  const wanted: PlayAsk[] = []
  const seen = new Set<number>()

  for (const ask of asks) {
    const id = ask.mediaId
    if (!Number.isFinite(id) || id <= 0) continue
    if (seen.has(id)) continue

    seen.add(id)
    if (known(id) === null) wanted.push(ask)
  }

  if (wanted.length === 0) return 0

  if (listVideoSources().length === 0) {
    Logger('WARN', 'Доступность: реестр источников пуст, спрашивать некого')
    return 0
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

  return wanted.filter((ask) => known(ask.mediaId) !== null).length
}

/** Только для проверок и кнопки очистки кэша: память сама себя не чистит. */
export function forgetPlayable(): void {
  memory.clear()
  pending.clear()
}
