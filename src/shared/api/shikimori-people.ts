// Поиск персонажей и авторов Shikimori: три REST-запроса, фоллбэк на GraphQL и гард тёзок.
// Отдельно от shikimori.ts: там транспорт, здесь стратегия, но бюджет темпа у них общий.
// Сложность оттого, что Shikimori ищет по точному порядку слов, а AniList даёт западный.
//
// Про мангу здесь речь идёт не о наших данных, а об опознании человека: у мангак
// главные работы лежат в манге, и именно они доказывают, что найденный тёзка —
// тот самый автор. Стирать эти ветки вместе с мангой в приложении нельзя.

import { Bridge } from '@/bridge'
import { SHIKI_DOMAINS } from '../core/constants'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import { scoreNameMatch } from '../utils/name-match'
import type { NameCandidate, NameTarget } from '../utils/name-match'
import { shikiLimiter } from './rate-limit'
import { fetchShiki } from './shikimori'

/** Коллекция Shikimori: имя совпадает у REST-пути и у поля GraphQL. */
export type PersonEndpoint = 'characters' | 'people'

/** Штрафная пауза, когда 429 пришёл именно на поиске персон. */
const PERSON_RATE_PAUSE_MS = 6000
const PERSON_TIMEOUT_MS = 7000

export interface ShikiPerson {
  id: number
  russian: string | null
  description: string | null
  url: string | null
  /** Зеркало, на котором нашлась персона — нужно для сборки абсолютной ссылки. */
  domain: string
}

export interface ShikiPersonResult {
  /** 200 — найдено, 404 — нет или отклонён гардом, 429 — рейт-лимит. */
  status: number
  data: ShikiPerson | null
}

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

/** Идентификатор зеркала в учёте состояния сети. Совпадает с shikimori.ts намеренно. */
function netId(domain: string): string {
  return `shikimori:${domain}`
}

interface RawResponse {
  status: number
  responseText: string
}

/**
 * Обёртка над Bridge.http: никогда не реджектит, status 0 означает транспортный сбой.
 * Единственное горлышко файла: слот, учёт и пауза по 429 живут только здесь.
 */
async function request(opts: {
  method: 'GET' | 'POST'
  url: string
  domain: string
  headers?: Record<string, string>
  data?: string
}): Promise<RawResponse> {
  const label = `Shikimori (${opts.domain})`
  let startedAt = Date.now()
  try {
    await shikiLimiter.acquireSlot()

    // Время считается после очереди шлюза: иначе наша же пауза делала бы источник медленным.
    startedAt = Date.now()

    const r = await Bridge.http.request({
      method: opts.method,
      url: opts.url,
      headers: opts.headers,
      body: opts.data,
      timeoutMs: PERSON_TIMEOUT_MS,
      credentials: 'omit',
    })

    reportStatus(netId(opts.domain), label, r.status, Date.now() - startedAt)

    if (r.status === 429) {
      shikiLimiter.pause(PERSON_RATE_PAUSE_MS)
      Logger('WARN', `Shikimori 429 на поиске персоны: пауза ${PERSON_RATE_PAUSE_MS}мс`, {
        url: opts.url,
      })
    }

    return { status: r.status, responseText: r.text }
  } catch (e) {
    // Поиск персон не должен ронять перевод страницы, поэтому status 0 вместо исключения.
    reportError(netId(opts.domain), label, e, Date.now() - startedAt)
    Logger('WARN', `Shikimori: запрос поиска персоны не ушёл: ${opts.url}`, e)
    return { status: 0, responseText: '' }
  }
}

/** Кандидат из списка поиска или ролей. */
export interface PersonCandidate extends NameCandidate {
  id?: number
  url?: string | null
}

/** Детали персоны. Связи с тайтлами лежат в четырёх разных полях. */
interface PersonDetails {
  id?: number
  russian?: string | null
  description?: string | null
  url?: string | null
  animes?: Array<{ id?: number } | null>
  mangas?: Array<{ id?: number } | null>
  works?: Array<{ anime?: { id?: number } | null } | null>
  roles?: Array<{ animes?: Array<{ id?: number } | null> } | null>
}

/**
 * Собирает MAL id всех тайтлов, с которыми связан кандидат.
 * Манга в сборе остаётся сознательно: это доказательство личности для гарда тёзок,
 * а не содержимое наших экранов.
 */
function collectCandidateMalIds(details: PersonDetails): number[] {
  const ids: number[] = []
  if (Array.isArray(details.animes)) {
    details.animes.forEach((a) => {
      if (a?.id) ids.push(a.id)
    })
  }
  if (Array.isArray(details.mangas)) {
    details.mangas.forEach((m) => {
      if (m?.id) ids.push(m.id)
    })
  }
  if (Array.isArray(details.works)) {
    details.works.forEach((w) => {
      if (w?.anime?.id) ids.push(w.anime.id)
    })
  }
  if (Array.isArray(details.roles)) {
    details.roles.forEach((rr) => {
      ;(rr?.animes ?? []).forEach((a) => {
        if (a?.id) ids.push(a.id)
      })
    })
  }
  return ids
}

/** Выбирает лучшего кандидата из списка по баллу совпадения. */
function pickBest(
  list: PersonCandidate[],
  target: NameTarget,
): { cand: PersonCandidate; score: number } | null {
  let best: PersonCandidate | null = null
  let bestScore = 0
  for (const c of list) {
    const sc = scoreNameMatch(c, target)
    if (sc > bestScore) {
      bestScore = sc
      best = c
    }
  }
  return best && bestScore >= 80 ? { cand: best, score: bestScore } : null
}

/**
 * Ищет персонажа или автора на Shikimori по имени с AniList.
 * @param endpointStr Коллекция: characters или people.
 * @param searchName Имя ромаджи (подчёркивания и дефисы будут заменены на пробелы).
 * @param nativeName Имя на кандзи, если известно — главный признак точного совпадения.
 * @param targetMalIds MAL id тайтлов цели для гарда тёзок.
 */
export async function fetchShikiPersonREST(
  endpointStr: PersonEndpoint,
  searchName: string | null | undefined,
  nativeName?: string | null,
  targetMalIds: number[] = [],
): Promise<ShikiPersonResult> {
  if (!searchName) return { status: 404, data: null }

  const cleanStr = searchName.replace(/_/g, ' ').replace(/-/g, ' ').trim()
  const nameParts = cleanStr.split(' ')
  const reversedName = nameParts.length > 1 ? [...nameParts].reverse().join(' ') : cleanStr
  const target: NameTarget = { full: cleanStr, native: nativeName ?? null }

  Logger('API', `Поиск персоны на Shiki: ${cleanStr}`)

  /** Считаем транспортные сбои: от них зависит уровень итогового сообщения. */
  let transportFailures = 0

  for (const domain of SHIKI_DOMAINS) {
    try {
      let item: PersonCandidate | null = null
      let itemScore = 0
      let rateLimited = false

      // Шаг 1: три варианта REST-поиска. Прямой порядок, обратный, другой эндпоинт.
      const searchUrls = [
        mirrorUrl(domain, `/api/${endpointStr}/search?search=${encodeURIComponent(cleanStr)}`),
        ...(nameParts.length > 1
          ? [
              mirrorUrl(
                domain,
                `/api/${endpointStr}/search?search=${encodeURIComponent(reversedName)}`,
              ),
            ]
          : []),
        mirrorUrl(domain, `/api/${endpointStr}?search=${encodeURIComponent(cleanStr)}`),
      ]

      for (const url of searchUrls) {
        const r = await request({ method: 'GET', url, domain })
        if (r.status === 429) {
          rateLimited = true
          break
        }
        if (r.status === 0) transportFailures++
        if (r.status === 200) {
          try {
            const list = JSON.parse(r.responseText) as PersonCandidate[]
            if (Array.isArray(list) && list.length > 0) {
              const m = pickBest(list, target)
              if (m && m.score > itemScore) {
                item = m.cand
                itemScore = m.score
              }
            }
          } catch (e) {
            // Один из трёх поисков отдал мусор — остальные ещё могут сработать.
            Logger('WARN', `Shikimori: неразборчивый ответ поиска персоны (${domain})`, e)
          }
        }
        if (itemScore >= 100) break // точный кандзи, дальше искать нечего
      }

      if (rateLimited) return { status: 429, data: null }

      // Шаг 2: фоллбэк на GraphQL — иногда находит то, что REST не отдаёт.
      if (!item) {
        const gqlQuery =
          `query($search: String) { ${endpointStr}(search: $search, limit: 5) ` +
          '{ id name russian japanese } }'
        const r = await request({
          method: 'POST',
          url: mirrorUrl(domain, '/api/graphql'),
          domain,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          data: JSON.stringify({ query: gqlQuery, variables: { search: cleanStr } }),
        })
        if (r.status === 429) return { status: 429, data: null }
        if (r.status === 0) transportFailures++
        if (r.status === 200) {
          try {
            const res = JSON.parse(r.responseText) as {
              data?: Record<string, PersonCandidate[] | undefined>
            }
            const list = res.data?.[endpointStr] ?? []
            const m = pickBest(list, target)
            if (m) {
              item = m.cand
              itemScore = m.score
            }
          } catch (e) {
            Logger('WARN', `Shikimori: неразборчивый ответ GraphQL поиска (${domain})`, e)
          }
        }
      }

      // Шаг 3: дозагрузка деталей — в списке поиска нет ни описания, ни связей.
      if (item?.id) {
        const rDetails = await request({
          method: 'GET',
          url: mirrorUrl(domain, `/api/${endpointStr}/${item.id}`),
          domain,
        })
        if (rDetails.status === 429) return { status: 429, data: null }
        if (rDetails.status === 0) transportFailures++

        let detailsRes: PersonDetails | null = null
        if (rDetails.status === 200) {
          try {
            detailsRes = JSON.parse(rDetails.responseText) as PersonDetails
          } catch (e) {
            Logger('WARN', `Shikimori: неразборчивые детали персоны (${domain})`, e)
          }
        }

        // Гард тёзок: неточное совпадение требует общего тайтла, иначе подменялись однофамильцы.
        if (targetMalIds.length && itemScore < 90 && detailsRes) {
          const candMal = collectCandidateMalIds(detailsRes)
          if (candMal.length && !candMal.some((id) => targetMalIds.includes(id))) {
            Logger(
              'WARN',
              `Отклонён вероятный тёзка: ${cleanStr} (нет общих тайтлов, score=${itemScore})`,
            )
            return { status: 404, data: null }
          }
        }

        if (detailsRes) {
          return {
            status: 200,
            data: {
              id: detailsRes.id ?? item.id,
              russian: detailsRes.russian ?? item.russian ?? null,
              description: detailsRes.description ?? null,
              url: detailsRes.url ?? null,
              domain,
            },
          }
        }

        return {
          status: 200,
          data: {
            id: item.id,
            russian: item.russian ?? null,
            description: null,
            url: null,
            domain,
          },
        }
      }
    } catch (e) {
      transportFailures++
      Logger('WARN', `Сбой поиска персоны "${cleanStr}" на зеркале ${domain}`, e)
    }
  }

  // Два разных исхода: источник ответил и не знает такой персоны либо до него не достучались.
  if (transportFailures > 0) {
    Logger('ERROR', `Поиск персоны сорвался на всех зеркалах: ${cleanStr}`, {
      transportFailures,
    })
    return { status: 0, data: null }
  }

  Logger('WARN', `Персона не найдена на Shikimori: ${cleanStr}`)
  return { status: 404, data: null }
}

export interface AniListPersonRef {
  name: { full?: string | null; native?: string | null }
  media?: { nodes?: Array<{ idMal?: number | null; type?: string | null }> } | null
  staffMedia?: { nodes?: Array<{ idMal?: number | null; type?: string | null }> } | null
}

interface ShikiRoleEntry {
  character?: PersonCandidate | null
  person?: PersonCandidate | null
}

/**
 * Сколько тайтлов максимум проверяем при резолве через роли.
 * Совпадение почти всегда на первых: список AniList идёт по убыванию значимости.
 */
const MAX_MEDIA_PROBES = 5

/**
 * Кэш списков ролей на время сессии: без него один /roles тянулся до 11 раз за минуту.
 * Храним промис, а не результат: тогда параллельные вызовы ждут одного запроса.
 */
const rolesCache = new Map<string, Promise<ShikiRoleEntry[] | null>>()

/** Загружает роли тайтла через кэш. */
function loadRoles(kind: string, id: number): Promise<ShikiRoleEntry[] | null> {
  const key = kind + '/' + String(id)
  const cached = rolesCache.get(key)
  if (cached) return cached

  const task = fetchShiki<ShikiRoleEntry[]>('/api/' + kind + '/' + String(id) + '/roles')
    .then((res) => res.data)
    .catch((e: unknown) => {
      // Сбой не кэшируем: зеркало могло лечь временно.
      rolesCache.delete(key)
      Logger('WARN', `Не удалось загрузить роли: ${key}`, e)
      return null
    })

  rolesCache.set(key, task)
  return task
}

/**
 * Резолвит персонажа/автора через роли в общих тайтлах, когда поиск по имени не сработал.
 * Кандидаты уже ограничены составом тайтла, поэтому порог мягче (55), но не ниже.
 *
 * Раздел берётся по виду тайтла у AniList, и манга тут остаётся сознательно.
 * Это не контент приложения, а доказательство личности: у мангаки главные
 * работы лежат в манге, и без этого раздела мы потеряли бы часть совпадений
 * и стали бы показывать латиницу вместо русских имён.
 */
export async function resolveShikiPersonByMedia(
  personData: AniListPersonRef,
  type: 'characters' | 'staff',
): Promise<PersonCandidate | null> {
  const mediaNodes = (type === 'characters' ? personData.media : personData.staffMedia)?.nodes ?? []
  const mediaRefs = mediaNodes
    .filter((m) => m.idMal)
    .map((m) => ({ id: m.idMal as number, kind: m.type === 'MANGA' ? 'mangas' : 'animes' }))
    .slice(0, MAX_MEDIA_PROBES)
  if (mediaRefs.length === 0) return null

  const target: NameTarget = {
    full: personData.name.full ?? '',
    native: personData.name.native ?? '',
  }

  let best: PersonCandidate | null = null
  let bestScore = 0

  for (const ref of mediaRefs) {
    const roles = await loadRoles(ref.kind, ref.id)
    if (roles) {
      const items = roles
        .map((r) => (type === 'characters' ? r.character : r.person))
        .filter((x): x is PersonCandidate => Boolean(x))
      for (const c of items) {
        const sc = scoreNameMatch(c, target)
        if (sc > bestScore) {
          bestScore = sc
          best = c
        }
        if (bestScore >= 100) break
      }
    }
    if (bestScore >= 100) break
  }

  return bestScore >= 55 ? best : null
}

/**
 * Весь состав тайтла одним запросом: персонажи и авторы с русскими именами.
 * Кэш списка ролей общий с точечным резолвом. Описаний в списке нет:
 * их добирает fetchShikiPersonDetails по уже известному номеру.
 *
 * Раздел называет вызывающий, и параметром он остаётся намеренно: экраны
 * спрашивают только `animes`, а резолв по ролям ходит и в `mangas` — там
 * лежат главные работы мангак. Прибей раздел словом — и номер манги повёл
 * бы в раздел аниме, то есть к составу совсем другого тайтла.
 */
export async function fetchShikiRoles(
  malId: number,
  kind: 'animes' | 'mangas',
): Promise<{ characters: PersonCandidate[]; people: PersonCandidate[] } | null> {
  const roles = await loadRoles(kind, malId)
  if (!roles) return null

  return {
    characters: roles.map((r) => r.character).filter((x): x is PersonCandidate => Boolean(x)),
    people: roles.map((r) => r.person).filter((x): x is PersonCandidate => Boolean(x)),
  }
}

/**
 * Детали персоны по уже известному номеру: один запрос без поиска.
 * Нужен добором описания для карточек, добытых списком ролей.
 */
export async function fetchShikiPersonDetails(
  endpointStr: PersonEndpoint,
  id: number,
): Promise<ShikiPerson | null> {
  for (const domain of SHIKI_DOMAINS) {
    const r = await request({
      method: 'GET',
      url: mirrorUrl(domain, `/api/${endpointStr}/${id}`),
      domain,
    })
    // 429 уже поставил шлюз на паузу: следующее зеркало спросится после неё.
    if (r.status === 429) continue
    if (r.status !== 200) continue

    try {
      const d = JSON.parse(r.responseText) as PersonDetails
      return {
        id: d.id ?? id,
        russian: d.russian ?? null,
        description: d.description ?? null,
        url: d.url ?? null,
        domain,
      }
    } catch (e) {
      Logger('WARN', `Shikimori: неразборчивые детали персоны ${id} (${domain})`, e)
    }
  }

  return null
}
