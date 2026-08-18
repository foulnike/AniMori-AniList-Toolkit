// Русские имена и описания людей: память, склад, затем сеть.
// Зеркало media-title.ts: тот же склад shikiCache и те же приёмы, только
// ключи от людей, а не от тайтлов. Очередь опроса ведёт компонент: ему
// виднее, когда тайтл сменился и спрашивать дальше бессмысленно.

import { CACHE_TIME } from './constants'
import { dbGet, dbSet } from './db'
import type { PersonRef } from '../api/anilist-people'
import { fetchShikiPersonREST } from '../api/shikimori-people'
import { Logger } from '../utils/logger'
import type { ShikiCacheRecord } from './types'

/** Чем человек является в карточке тайтла: героем или автором. */
export type PersonKind = 'character' | 'staff'

/** Префиксы ключей на складе. Цифра — версия формы записи, а не номер источника. */
const KEY_PREFIX: Record<PersonKind, string> = { character: 'CHR2_', staff: 'STF3_' }

/** Готовая русская карточка человека. */
export interface RussianPerson {
  russian: string
  description: string | null
  /** Абсолютная ссылка на Shikimori, если источник её вернул. */
  shikiUrl: string | null
}

/** Знание этого запуска. `null` значит «спрашивали, перевода нет». */
const memory = new Map<string, RussianPerson | null>()

/** Чьи ключи уже искали на складе. */
const asked = new Set<string>()

/** Незавершённые добычи: плитка и окошко часто просят одного человека в один миг. */
const pending = new Map<string, Promise<RussianPerson | null>>()

function memoryKey(kind: PersonKind, personId: number): string {
  return `${kind}:${personId}`
}

function cacheKey(kind: PersonKind, personId: number): string {
  return `${KEY_PREFIX[kind]}${personId}`
}

/** Читает карточку со склада. Протухшая запись считается отсутствующей. */
async function readCache(kind: PersonKind, personId: number): Promise<RussianPerson | null> {
  const key = memoryKey(kind, personId)
  asked.add(key)

  const record = await dbGet<ShikiCacheRecord<RussianPerson>>(
    'shikiCache',
    cacheKey(kind, personId),
  )
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  const data = record.data
  return data && typeof data.russian === 'string' && data.russian ? data : null
}

/** Кладёт карточку на склад. Отсутствие перевода на склад не пишется. */
async function writeCache(
  kind: PersonKind,
  personId: number,
  data: RussianPerson,
): Promise<void> {
  await dbSet('shikiCache', { key: cacheKey(kind, personId), data, ts: Date.now() })
}

/** Описание с Шикимори приходит с BBcode: теги выкидываются, текст остаётся. */
function stripBbcode(text: string | null): string | null {
  if (!text) return null
  const clean = text
    .replace(/\[url=[^\]]+\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[\/?[a-z][^\]]*\]/gi, '')
    .trim()
  return clean === '' ? null : clean
}

/** Полный путь для одного человека: склад, затем поиск Shikimori. */
async function loadOne(
  kind: PersonKind,
  person: PersonRef,
  targetMalIds: number[],
): Promise<RussianPerson | null> {
  const key = memoryKey(kind, person.personId)

  const cached = await readCache(kind, person.personId)
  if (cached) {
    memory.set(key, cached)
    return cached
  }

  const found = await fetchShikiPersonREST(
    kind === 'character' ? 'characters' : 'people',
    person.name,
    person.native,
    targetMalIds,
  )

  // Сбой транспорта и 429 не запоминаются: сеть вернётся — спросим снова.
  if (found.status === 0 || found.status === 429) return null

  if (found.status !== 200 || !found.data?.russian) {
    memory.set(key, null)
    return null
  }

  const card: RussianPerson = {
    russian: found.data.russian,
    description: stripBbcode(found.data.description),
    shikiUrl: found.data.url ? `https://${found.data.domain}${found.data.url}` : null,
  }

  memory.set(key, card)
  await writeCache(kind, person.personId, card)
  return card
}

/**
 * Русская карточка человека или `null`, если перевода нет.
 * Повторные вызовы пока идёт добыча ждут тот же ответ, а не шлют свой запрос.
 * @param targetMalIds MAL id текущего тайтла — гард против тёзок.
 */
export async function getRussianPerson(
  kind: PersonKind,
  person: PersonRef,
  targetMalIds: number[] = [],
): Promise<RussianPerson | null> {
  const key = memoryKey(kind, person.personId)
  if (memory.has(key)) return memory.get(key) ?? null

  const inFlight = pending.get(key)
  if (inFlight) return await inFlight

  const task = loadOne(kind, person, targetMalIds).catch((e) => {
    // Сбой не запоминается в памяти: сеть вернётся — спросим снова.
    Logger('WARN', `Русское имя: добыть не вышло (${person.name})`, e)
    return null
  })

  pending.set(key, task)

  try {
    return await task
  } finally {
    pending.delete(key)
  }
}

/**
 * Что уже известно прямо сейчас, без ожидания.
 * Для отрисовки плитки и шапки окошка: нет перевода — показываем ромадзи.
 */
export function peekRussianPerson(kind: PersonKind, personId: number): RussianPerson | null {
  return memory.get(memoryKey(kind, personId)) ?? null
}

/** Забывает знание запуска. Склад не трогается: его чистят из настроек. */
export function forgetRussianPeople(): void {
  memory.clear()
  asked.clear()
  pending.clear()
}
