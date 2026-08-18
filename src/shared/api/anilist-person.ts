// Карточка персонажа или автора по запросу: открывается из PeopleBox.
import { anilistQuery } from './anilist'
import type { PersonRef } from './anilist-people'
import { Logger } from '@/utils/logger'

/** Тип, переданный из плитки в PeopleBox. */
export type PersonTarget = { kind: 'character' | 'staff' } & PersonRef

const CHARACTER_CARD_QUERY = `
  query ($id: Int!) {
    Character(id: $id) {
      id
      name { full native alternative }
      image { large }
      description(asHtml: false)
      gender
      age
      dateOfBirth { year month day }
      siteUrl
      media(page: 1, perPage: 8, sort: [POPULARITY_DESC]) {
        edges {
          characterRole
          voiceActors(sort: [RELEVANCE, ID]) {
            id
            name { full native }
            language
            image { large medium }
            siteUrl
          }
          node {
            id
            title { romaji english }
            coverImage { medium }
            type
          }
        }
      }
    }
  }
`

const STAFF_CARD_QUERY = `
  query ($id: Int!) {
    Staff(id: $id) {
      id
      name { full native alternative }
      image { large }
      description(asHtml: false)
      primaryOccupations
      languageV2
      dateOfBirth { year month day }
      dateOfDeath { year month day }
      homeTown
      siteUrl
    }
  }
`

export interface CharacterCard {
  id: number
  name: { full: string; native: string | null; alternative: string[] | null }
  image: { large: string | null } | null
  description: string | null
  gender: string | null
  age: string | null
  dateOfBirth: { year: number | null; month: number | null; day: number | null } | null
  siteUrl: string
  media: {
    edges: Array<{
      characterRole: string | null
      voiceActors: Array<{
        id: number
        name: { full: string; native: string | null }
        language: string | null
        image: { large: string | null; medium: string | null } | null
        siteUrl: string
      }>
      node: {
        id: number
        title: { romaji: string | null; english: string | null }
        coverImage: { medium: string | null } | null
        type: string | null
      }
    }>
  } | null
}

export interface StaffCard {
  id: number
  name: { full: string; native: string | null; alternative: string[] | null }
  image: { large: string | null } | null
  description: string | null
  primaryOccupations: string[] | null
  languageV2: string | null
  dateOfBirth: { year: number | null; month: number | null; day: number | null } | null
  dateOfDeath: { year: number | null; month: number | null; day: number | null } | null
  homeTown: string | null
  siteUrl: string
}

export async function fetchCharacterCard(id: number): Promise<CharacterCard | null> {
  try {
    const reply = await anilistQuery<{ Character: CharacterCard }>(
      CHARACTER_CARD_QUERY,
      { id },
    )
    const data = reply?.data?.Character ?? null
    Logger('API', `Персонаж ${id}: ${data?.name.full ?? 'нет данных'}`)
    return data
  } catch (e) {
    Logger('WARN', `Персонаж ${id}: ошибка запроса`, e)
    return null
  }
}

export async function fetchStaffCard(id: number): Promise<StaffCard | null> {
  try {
    const reply = await anilistQuery<{ Staff: StaffCard }>(
      STAFF_CARD_QUERY,
      { id },
    )
    const data = reply?.data?.Staff ?? null
    Logger('API', `Автор ${id}: ${data?.name.full ?? 'нет данных'}`)
    return data
  } catch (e) {
    Logger('WARN', `Автор ${id}: ошибка запроса`, e)
    return null
  }
}
