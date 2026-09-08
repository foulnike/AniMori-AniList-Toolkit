// Персонажи и авторы тайтла. Отдельно от anilist-media.ts: там сам тайтл,
// здесь люди, и спрашиваются они своим запросом уже после карточки.
//
// ОДИН ЗАПРОС НА ВСЮ ЖИЗНЬ УСТАНОВКИ
// Состав снят с готового тайтла и больше не меняется: озвучка не меняется
// задним числом, режиссёр вышедшего аниме — тем более. Поэтому люди ложатся
// на склад бессрочно, и каждый второй взгляд на карточку стоит сети ноль.
// До этого «главная → тайтл → назад → тот же тайтл» покупало двадцать четыре
// персонажа с озвучкой дважды.
//
// ПУСТОТА НА СКЛАД НЕ ЛОЖИТСЯ
// У анонса состава ещё нет, а через месяц он появится. Бессрочная запись
// «людей нет» означала бы, что их не будет уже никогда. Та же развилка, что
// у отрицательных записей в соседних модулях: вечное «нет» пишется только
// тогда, когда иначе быть не может.

import { isFresh, LIFE_PEOPLE } from '../core/cache-life'
import { dbGet, dbSet } from '../core/db'
import type { MediaCacheRecord } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import { once } from './rate-limit'

/** Сколько персонажей просим. Дальше первой пачки в карточке не смотрят. */
const CHARACTER_LIMIT = 24

/** Сколько авторов просим: значимых ролей у тайтла редко больше десятка. */
const STAFF_LIMIT = 12

/**
 * Ключи склада. Два разных, а не один общий: сводка склада считает персонажей
 * и персонал отдельными строками, и эти два префикса в её таблице уже ждут
 * своего писателя. Цифра — поколение формы записи.
 */
const CHAR_PREFIX = 'CHR3_'
const STAFF_PREFIX = 'STF4_'

/** Люди, уже поднятые со склада в этом запуске: перерисовка не трогает диск. */
const memory = new Map<number, MediaPeople>()

// Порядок персонажей задаёт сервер: ROLE выносит главных вперёд, и своей
// сортировки не нужно. Озвучка просится японская: она есть почти всегда,
// тогда как прочие языки у половины тайтлов пусты.
const PEOPLE_QUERY = `query ($id: Int!, $characters: Int!, $staff: Int!) {
  Media(id: $id) {
    id
    characters(page: 1, perPage: $characters, sort: [ROLE, RELEVANCE, ID]) {
      edges {
        role
        voiceActors(language: JAPANESE, sort: [RELEVANCE, ID]) {
          id
          siteUrl
          name {
            full
            native
          }
          image {
            large
            medium
          }
        }
        node {
          id
          siteUrl
          name {
            full
            native
          }
          image {
            large
            medium
          }
        }
      }
    }
    staff(page: 1, perPage: $staff, sort: [RELEVANCE, ID]) {
      edges {
        role
        node {
          id
          siteUrl
          name {
            full
            native
          }
          image {
            large
            medium
          }
        }
      }
    }
  }
}`

interface PersonReply {
  id?: number
  siteUrl?: string | null
  name?: { full?: string | null; native?: string | null } | null
  image?: { large?: string | null; medium?: string | null } | null
}

interface PeopleReply {
  Media?: {
    characters?: {
      edges?: Array<{
        role?: string | null
        voiceActors?: Array<PersonReply | null> | null
        node?: PersonReply | null
      } | null> | null
    } | null
    staff?: {
      edges?: Array<{ role?: string | null; node?: PersonReply | null } | null> | null
    } | null
  } | null
}

/** Человек как его знает AniList: номер, имена, портрет и своя страница. */
export interface PersonRef {
  personId: number
  name: string
  native: string | null
  image: string | null
  siteUrl: string | null
}

export interface CharacterRef extends PersonRef {
  /** MAIN, SUPPORTING или BACKGROUND — по этому полю сервер и сортирует. */
  role: string | null
  /** Японская озвучка или `null`: у манги её нет вовсе. */
  voice: PersonRef | null
}

export interface StaffRef extends PersonRef {
  /** Роль как её назвал сервер: «Director», «Original Creator». */
  role: string | null
}

export interface MediaPeople {
  characters: CharacterRef[]
  staff: StaffRef[]
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Человек из ответа. Безымянного нет смысла показывать: плитка без имени
 * ничего не сообщает, а портрет сам по себе не опознать.
 */
function readPerson(raw: PersonReply | null | undefined): PersonRef | null {
  if (!raw || typeof raw.id !== 'number') return null

  const name = textOrNull(raw.name?.full)
  if (name === null) return null

  return {
    personId: raw.id,
    name,
    native: textOrNull(raw.name?.native),
    image: textOrNull(raw.image?.large) ?? textOrNull(raw.image?.medium),
    siteUrl: textOrNull(raw.siteUrl),
  }
}

/**
 * Люди со склада. Обе записи читаются разом и принимаются только вместе:
 * карточка с персонажами и без авторов выглядит битой, а стоит вторая
 * половина того же самого запроса.
 */
async function readCache(mediaId: number): Promise<MediaPeople | null> {
  const charKey = `${CHAR_PREFIX}${mediaId}`
  const staffKey = `${STAFF_PREFIX}${mediaId}`

  const [chars, staff] = await Promise.all([
    dbGet<MediaCacheRecord<CharacterRef[]>>('mediaCache', charKey),
    dbGet<MediaCacheRecord<StaffRef[]>>('mediaCache', staffKey),
  ])

  if (!Array.isArray(chars?.data) || !Array.isArray(staff?.data)) return null
  if (!isFresh(charKey, chars?.ts, LIFE_PEOPLE)) return null

  return { characters: chars.data, staff: staff.data }
}

/** Кладёт людей на склад двумя записями. Отказ склада делу не мешает. */
async function writeCache(mediaId: number, people: MediaPeople): Promise<void> {
  const ts = Date.now()

  await Promise.all([
    dbSet('mediaCache', { key: `${CHAR_PREFIX}${mediaId}`, data: people.characters, ts }),
    dbSet('mediaCache', { key: `${STAFF_PREFIX}${mediaId}`, data: people.staff, ts }),
  ])
}

/** Сетевой поход за людьми тайтла и запись добытого на склад. */
async function load(mediaId: number): Promise<MediaPeople> {
  const reply = await anilistQuery<PeopleReply>(PEOPLE_QUERY, {
    id: mediaId,
    characters: CHARACTER_LIMIT,
    staff: STAFF_LIMIT,
  })

  const media = reply.data?.Media
  if (!media) {
    Logger('WARN', `Люди тайтла ${mediaId}: сервер ответил пустотой`, reply.errors)
    return { characters: [], staff: [] }
  }

  const characters: CharacterRef[] = []
  for (const edge of media.characters?.edges ?? []) {
    const node = readPerson(edge?.node)
    if (node === null) continue

    const voices = edge?.voiceActors ?? []
    characters.push({
      ...node,
      role: textOrNull(edge?.role),
      voice: voices.length > 0 ? readPerson(voices[0]) : null,
    })
  }

  const staff: StaffRef[] = []
  for (const edge of media.staff?.edges ?? []) {
    const node = readPerson(edge?.node)
    if (node === null) continue

    staff.push({ ...node, role: textOrNull(edge?.role) })
  }

  const people: MediaPeople = { characters, staff }

  Logger('API', `Люди тайтла ${mediaId}: ${characters.length} персонажей, ${staff.length} авторов`)

  // На склад идёт только найденное: пустота у анонса ещё наполнится,
  // а бессрочная запись о ней закрыла бы вопрос навсегда.
  if (characters.length > 0 || staff.length > 0) {
    memory.set(mediaId, people)
    void writeCache(mediaId, people).catch((e) => {
      Logger('WARN', `Люди тайтла ${mediaId}: на склад не легли`, e)
    })
  }

  return people
}

/**
 * Персонажи и авторы одного тайтла. Ключ не нужен: люди у всех одни и те же,
 * своей записи в этом ответе нет.
 *
 * Память запуска, затем склад, затем сеть. Два одновременных вопроса об одном
 * тайтле — один запрос: карточку открывают и сразу листают вниз к составу,
 * а подписок у этого вопроса бывает две сразу.
 */
export async function fetchMediaPeople(mediaId: number): Promise<MediaPeople> {
  const known = memory.get(mediaId)
  if (known) return known

  const stored = await readCache(mediaId)
  if (stored) {
    memory.set(mediaId, stored)
    return stored
  }

  return await once(`people-${mediaId}`, () => load(mediaId))
}

/** Забыть людей в памяти запуска. Зовётся при ручной очистке склада. */
export function forgetMediaPeople(): void {
  memory.clear()
}
