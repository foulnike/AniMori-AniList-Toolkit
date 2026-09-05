// Список пользователя с Шикимори: чтение по нику, без входа и без пропуска.
// По образцу anilist-list.ts и с тем же видом записи на выходе: ядро
// коллекции умеет сливать и замещать именно его, и второго вида записи
// ради второго источника заводить незачем.
//
// ВХОДА НЕТ СОЗНАТЕЛЬНО
// У AniList есть вход, потому что без него свой список не отдадут. Шикимори
// отдаёт открытый профиль любому, и для переноса достаточно ника. Значит,
// своего приложения OAuth здесь не заводится: чужой ключ в сборке — это
// ещё одна точка отказа и ещё одна чужая проверка на пути к чужим же данным.
// Скрытый профиль при таком устройстве недоступен, и об этом говорится прямо
// текстом из shikimori-user.ts, а не пустым списком.
//
// НОМЕРА: ЧЕРЕЗ MAL
// Коллекция живёт по номерам AniList: карточка, плеер, плитка и плеерный
// поиск спрашивают именно их. Шикимори даёт свои номера, которые для
// подавляющего большинства тайтлов совпадают с номерами MyAnimeList, поэтому
// перевод идёт тем же путём, что у поиска на кириллице — выписками
// fetchBriefsByMal пачками по пятьдесят.
//
// Чему пары не нашлось — то теряется, и число потерянного говорится вслух
// вместе с названиями. Молча проглотить часть списка нельзя: человек считает
// записи глазами и вправе знать, почему их стало меньше.

import { Logger } from '../utils/logger'
import type { RawListEntry } from './anilist-list'
import { fetchBriefsByMal } from './anilist-lookup'
import { hiddenProfileMessage, shikiUserGet } from './shikimori-user'

/**
 * Записей за одну страницу. Сервер допускает больше, но тысяча укладывается
 * в таймаут транспорта и даёт один запрос на почти любой живой список.
 */
const PAGE_SIZE = 1000

/**
 * Потолок страниц. Двадцать тысяч записей больше любого реального списка,
 * а страж нужен от другого: если сервер когда-нибудь перестанет отдавать
 * пустую страницу в конце, бесконечный обход повесит перенос насмерть.
 */
const MAX_PAGES = 20

/** Сколько названий потерянных записей называть вслух. Дальше — только число. */
const LOST_NAMES = 8

/** Кто нашёлся по нику. */
export interface ShikiUser {
  id: number
  /** Ник в том виде, в каком его пишет сам Сайт, а не как набрал человек. */
  nick: string
}

/** Итог чтения списка с Шикимори до всякого слияния с памятью. */
export interface ShikiImport {
  user: ShikiUser
  /** Записи в общем виде: ядро коллекции примет их как ответ сервера. */
  entries: RawListEntry[]
  /** Сколько записей отдал Шикимори. */
  read: number
  /** Сколько из них привязалось к номерам AniList. */
  matched: number
  /** Сколько осталось без пары и в список не попадёт. */
  lost: number
  /** Названия потерянных, до LOST_NAMES штук: экрану есть что показать. */
  lostTitles: string[]
}

/**
 * Закладки Шикимори в закладки AniList. Словарь, а не цепочка if:
 * незнакомая закладка должна дать null и попасть в журнал, а не превратиться
 * в «смотрю» по умолчанию.
 *
 * Пересмотр у Шикимори — отдельная закладка, у AniList тоже: совпадает один
 * в один. «Отложено» против «на паузе» — тоже одно и то же другими словами.
 */
const STATUS_MAP: Readonly<Record<string, string>> = {
  planned: 'PLANNING',
  watching: 'CURRENT',
  rewatching: 'REPEATING',
  completed: 'COMPLETED',
  on_hold: 'PAUSED',
  dropped: 'DROPPED',
}

/** Ответ сервера о пользователе. Лишние поля не описаны: нужны два. */
interface UserReply {
  id?: number
  nickname?: string
}

/** Запись списка в том виде, в каком её отдаёт /anime_rates. */
interface RateReply {
  status?: string | null
  score?: number | null
  episodes?: number | null
  rewatches?: number | null
  text?: string | null
  created_at?: string | null
  updated_at?: string | null
  anime?: {
    id?: number
    name?: string | null
    russian?: string | null
  } | null
}

/** Целое неотрицательное или ноль: чужие пустоты не должны стать NaN. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Строка или null. Пустой комментарий равносилен отсутствию комментария. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Время правки в миллисекундах. Нечитаемая дата даёт ноль, а не сегодня:
 * по этой метке слияние решает спор с местной правкой, и выдуманное «сейчас»
 * молча затёрло бы то, что человек правил здесь руками.
 */
function when(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0

  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Ник без лишнего. Ссылку целиком тоже принимаем: человек скорее скопирует
 * адрес своего профиля, чем вспомнит, что нужна только его хвостовая часть.
 */
export function cleanNick(raw: string): string {
  const cut = raw.trim().replace(/\/+$/, '')
  if (cut === '') return ''

  const tail = cut.slice(cut.lastIndexOf('/') + 1)
  return tail.startsWith('@') ? tail.slice(1) : tail
}

/**
 * Найти пользователя по нику. Номер нужен потому, что списки сервер отдаёт
 * только по номеру, а ник меняется когда угодно.
 *
 * Отказы разведены по кодам: 404 — нет такого ника, 403 — профиль закрыт,
 * 429 — сервер просит подождать. Одно общее «не получилось» гоняло бы
 * искать опечатку там, где дело в приватности.
 */
export async function findShikiUser(nick: string): Promise<ShikiUser> {
  const wanted = cleanNick(nick)
  if (wanted === '') throw new Error('Ник не введён.')

  const path = `/api/users/${encodeURIComponent(wanted)}?is_nickname=1`
  const reply = await shikiUserGet<UserReply>(path)

  if (reply.status === 404) {
    throw new Error(`На Шикимори нет пользователя «${wanted}». Проверьте ник.`)
  }

  if (reply.status === 403 || reply.status === 401) {
    throw new Error(hiddenProfileMessage())
  }

  if (reply.status === 429) {
    throw new Error('Шикимори просит подождать: слишком много запросов. Повторите через минуту.')
  }

  const id = count(reply.data?.id)
  if (!reply.ok || id === 0) {
    throw new Error(`Шикимори ответил отказом (${reply.status}). Попробуйте позже.`)
  }

  return { id, nick: text(reply.data?.nickname) ?? wanted }
}

/**
 * Все закладки аниме постранично. Отбора по закладке нет сознательно:
 * переносится весь список целиком, и какие закладки человеку интересны,
 * решать не переносу.
 *
 * Пустая страница и 404 значат одно и то же: страниц больше нет.
 */
async function readRates(userId: number): Promise<RateReply[]> {
  const all: RateReply[] = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/api/users/${userId}/anime_rates?limit=${PAGE_SIZE}&page=${page}`
    const reply = await shikiUserGet<RateReply[]>(path)

    if (reply.status === 403 || reply.status === 401) throw new Error(hiddenProfileMessage())

    if (reply.status === 429) {
      throw new Error(
        'Шикимори просит подождать: слишком много запросов. Повторите через минуту.',
      )
    }

    if (reply.status === 404) break

    if (!reply.ok) {
      // Первая страница — это весь ответ, и молчать о её отказе нельзя.
      // Средина обхода — тоже: перенести половину списка хуже, чем не перенести
      // ничего: неполный список человек примет за полный.
      throw new Error(`Шикимори ответил отказом (${reply.status}) на странице ${page}.`)
    }

    const chunk = reply.data
    if (!Array.isArray(chunk) || chunk.length === 0) break

    all.push(...chunk)
    Logger('API', `Шикимори: страница ${page}, записей ${chunk.length}`)

    // Неполная страница — последняя: лишний запрос за пустотой ни к чему.
    if (chunk.length < PAGE_SIZE) break
  }

  return all
}

/**
 * Номера MAL из ответа. Номер тайтла у Шикимори совпадает с номером MAL по
 * устройству базы, и именно по нему тайтл находится у AniList.
 */
function malIdOf(rate: RateReply): number {
  return count(rate.anime?.id)
}

/** Имя для жалобы о потере: русское, иначе латиница, иначе номер. */
function nameOf(rate: RateReply): string {
  return text(rate.anime?.russian) ?? text(rate.anime?.name) ?? `#${malIdOf(rate)}`
}

/**
 * Читает список с Шикимори и переводит его в общий вид записи.
 * В память ничего не кладёт и ничего не решает за человека: слияние
 * и замена — дело ядра коллекции.
 *
 * Дат начала и конца просмотра в закладках Шикимори нет вовсе, и они
 * приезжают пустыми. Подставлять вместо них время создания закладки
 * нельзя: это будет число из воздуха в поле, которое человек примет за своё.
 */
export async function importShikiList(nick: string): Promise<ShikiImport> {
  const user = await findShikiUser(nick)
  const rates = await readRates(user.id)

  Logger('API', `Шикимори: список ${user.nick} прочитан, записей ${rates.length}`)

  // Один тайтл в закладках встречается один раз, но страницы могут зайти внахлёст,
  // если список правят прямо во время обхода.
  const byMal = new Map<number, RateReply>()
  for (const rate of rates) {
    const malId = malIdOf(rate)
    if (malId === 0) continue

    const known = byMal.get(malId)
    if (!known || when(known.updated_at) <= when(rate.updated_at)) byMal.set(malId, rate)
  }

  const wanted = Array.from(byMal.keys())
  const briefs = wanted.length === 0 ? [] : await fetchBriefsByMal(wanted)

  const found = new Map<number, (typeof briefs)[number]>()
  for (const brief of briefs) if (brief.malId !== null) found.set(brief.malId, brief)

  const entries: RawListEntry[] = []
  const lostTitles: string[] = []
  let lost = 0

  for (const [malId, rate] of byMal) {
    const brief = found.get(malId)
    if (!brief) {
      // Тайтла нет у AniList либо связь с MAL там не записана. Молчать нельзя:
      // человек увидит разницу в числах и решит, что программа сломалась.
      lost++
      if (lostTitles.length < LOST_NAMES) lostTitles.push(nameOf(rate))
      continue
    }

    const status = text(rate.status)
    const mapped = status === null ? null : (STATUS_MAP[status] ?? null)
    if (status !== null && mapped === null) {
      Logger('WARN', `Шикимори: незнакомая закладка «${status}» у ${nameOf(rate)}`)
    }

    // Время правки обязательно: по нему слияние решает, чья запись свежее.
    // Если сервер промолчал и о правке, и о создании, запись считается
    // самой старой: местная правка важнее неизвестности.
    const edited = when(rate.updated_at) || when(rate.created_at)

    entries.push({
      mediaId: brief.mediaId,
      malId,
      status: mapped,
      score: count(rate.score),
      progress: count(rate.episodes),
      repeat: count(rate.rewatches),
      startedAt: null,
      completedAt: null,
      notes: text(rate.text),
      updatedAt: edited,
      isAdult: brief.isAdult,
      romaji: brief.romaji,
      english: brief.english,
    })
  }

  Logger(
    'API',
    `Шикимори: привязано ${entries.length} из ${byMal.size}, без пары ${lost}`,
  )

  return {
    user,
    entries,
    read: rates.length,
    matched: entries.length,
    lost,
    lostTitles,
  }
}
