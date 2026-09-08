// Одна карточка Шикимори на тайтл и имена пачками: стратегия поверх транспорта.
// Перебор зеркал, темп и трактовка кодов живут в shikimori.ts, здесь — кто и сколько
// раз источник спрашивает.
//
// Причина существования файла в двух числах. Карточку `/api/animes/{id}` на одно
// открытие тайтла спрашивали дважды: русское название берёт из неё описание,
// оценки площадок — рейтинг и распределение голосов, и каждый шёл за ней сам.
// А имена для сеток добывались по одному: пятьсот строк списка стоили пятисот
// запросов, хотя GraphQL отдаёт по пятьдесят за раз.
//
// Склада здесь нет сознательно: что и надолго ложится на диск, решают вызывающие —
// у них разные ключи и разные сроки (`RU4_`, `NAME1_`, `NONAME1_`, `RATE1_`).
// Здешняя память живёт ровно запуск и стоит на одном: один поход за карточкой
// вместо двух одинаковых.

import { Logger } from '../utils/logger'
import { fetchShiki, fetchShikiGraphql } from './shikimori'
import type { ShikiMedia } from '../core/types'

/** Ответ источника о карточке: данные и зеркало, с которого они приехали. */
export interface ShikiAnime {
  /** `null` — источник ответил, что такого тайтла не знает. */
  data: ShikiMedia | null
  /** Домен ответившего зеркала: из него собирается ссылка на тайтл. */
  domain: string | null
}

/** Итог оптового запроса имён. */
export interface ShikiNames {
  /** Найденные русские имена по номеру MAL. */
  names: Map<number, string>
  /**
   * О ком источник вообще ответил — включая тех, чьего имени не знает.
   * Главное поле итога: без него не отличить «перевода нет» от «пачка не доехала»,
   * а это разница между вечной записью на складе и молчанием до следующего раза.
   */
  answered: Set<number>
}

/**
 * Сколько номеров уходит в одну пачку. Больше пятидесяти Сшикимори не отдаёт:
 * `limit` выше потолка он не ругает, а молча урезает ответ — та же повадка,
 * что у REST с `limit=100`.
 */
const NAMES_CHUNK = 50

/** Форма запроса уже обкатана на составе тайтла: `ids` — строка через запятую. */
const NAMES_QUERY =
  'query($ids: String!, $limit: Int!) { animes(ids: $ids, limit: $limit) { id russian name } }'

interface NamesReply {
  animes?: Array<{
    /** У GraphQL номер — строка (`ID!`), а не число, как в REST. */
    id?: string | number | null
    russian?: string | null
    name?: string | null
  } | null> | null
}

/** Карточки, о которых источник уже ответил в этом запуске, включая отказы. */
const cards = new Map<number, ShikiAnime>()

/** Незавершённые походы за карточкой: название и оценки просят её в один миг. */
const pending = new Map<number, Promise<ShikiAnime>>()

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null

  const clean = value.trim()
  return clean === '' ? null : clean
}

/**
 * Карточка тайтла с Шикимори: один запрос на номер за весь запуск.
 *
 * Одновременные просьбы ждут один ответ, а не шлют свой запрос: название
 * и оценки героя карточки грузятся рядом и раньше всегда стоили двух походов.
 *
 * Отказ источника (`data: null`) тоже запоминается: спрашивать второй раз
 * о том же в одном запуске бессмысленно. А вот сбой сети не запоминается:
 * исключение уезжает вызывающему, память остаётся чистой, сеть вернётся — спросим снова.
 */
export async function fetchShikiAnime(malId: number): Promise<ShikiAnime> {
  const known = cards.get(malId)
  if (known) return known

  const inFlight = pending.get(malId)
  if (inFlight) return await inFlight

  const task = fetchShiki<ShikiMedia>(`/api/animes/${malId}`).then((reply) => {
    const answer: ShikiAnime = { data: reply.data, domain: reply.domain }
    cards.set(malId, answer)
    return answer
  })

  pending.set(malId, task)

  try {
    return await task
  } finally {
    pending.delete(malId)
  }
}

/**
 * Русские имена сразу для многих тайтлов: пачки по пятьдесят номеров MAL.
 *
 * Сеткам и полкам от источника нужна одна строка, а не карточка целиком,
 * и GraphQL как раз позволяет просить только её: ответ легче вдесятки раз
 * и не тащит описание с голосами туда, где их не видно.
 *
 * Пачка падает молча и по отдельности: одно упавшее зеркало не повод бросать
 * остальные пятьсот строк без названий. Кто не попал ни в `names`, ни
 * в `answered` — о том источник не сказал ничего, и писать про него нечего.
 */
export async function fetchShikiNames(malIds: number[]): Promise<ShikiNames> {
  const names = new Map<number, string>()
  const answered = new Set<number>()

  const wanted = [...new Set(malIds.filter((id) => Number.isFinite(id) && id > 0))]
  if (wanted.length === 0) return { names, answered }

  let chunks = 0

  for (let at = 0; at < wanted.length; at += NAMES_CHUNK) {
    const slice = wanted.slice(at, at + NAMES_CHUNK)
    chunks++

    try {
      const reply = await fetchShikiGraphql<NamesReply>(
        NAMES_QUERY,
        { ids: slice.join(','), limit: slice.length },
        `имена: ${slice.length}`,
      )

      // Ответа нет вовсе — это не «имён не знаем», а неудача пачки.
      if (!reply.data) {
        Logger('WARN', `Имена Шикимори: пачка из ${slice.length} осталась без ответа`)
        continue
      }

      // Источник ответил про всю пачку сразу: кого нет в списке, того он не знает.
      slice.forEach((id) => answered.add(id))

      for (const row of reply.data.animes ?? []) {
        if (!row) continue

        const malId = Number(row.id)
        if (!Number.isFinite(malId) || malId <= 0) continue

        const russian = textOrNull(row.russian)
        if (russian) names.set(malId, russian)
      }
    } catch (e) {
      // Здесь же глушится и исчерпание повторов по 429: остаток пачек уйдёт
      // уже после паузы — шлюз держит её сам.
      Logger('WARN', `Имена Шикимори: пачка из ${slice.length} не доехала`, e)
    }
  }

  Logger(
    'INFO',
    `Имена Шикимори: спросили ${wanted.length} пачками ${chunks}, ` +
      `ответили про ${answered.size}, нашли ${names.size}`,
  )

  return { names, answered }
}

/**
 * Забывает знание запуска о карточках. Нужно после чистки склада из настроек:
 * иначе отказ, запомненный до чистки, доживёт до закрытия окна.
 */
export function forgetShikiCards(): void {
  cards.clear()
  pending.clear()
}
