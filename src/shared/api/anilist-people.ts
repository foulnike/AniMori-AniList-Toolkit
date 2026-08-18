// Персонажи и авторы тайтла. Отдельно от anilist-media.ts: там сам тайтл,
// здесь люди, и спрашиваются они своим запросом уже после карточки.

import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'

/** Сколько персонажей просим. Дальше первой пачки в карточке не смотрят. */
const CHARACTER_LIMIT = 24

/** Сколько авторов просим: значимых ролей у тайтла редко больше десятка. */
const STAFF_LIMIT = 12

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
 * Персонажи и авторы одного тайтла. Ключ не нужен: люди у всех одни и те же,
 * своей записи в этом ответе нет.
 */
export async function fetchMediaPeople(mediaId: number): Promise<MediaPeople> {
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

  Logger('API', `Люди тайтла ${mediaId}: ${characters.length} персонажей, ${staff.length} авторов`)

  return { characters, staff }
}
