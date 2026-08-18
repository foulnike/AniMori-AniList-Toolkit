// Один человек: описание, факты и сэйю персонажа. Спрашивается
// по нажатию и ложится в память запуска: окно закрывают и открывают часто.

import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import type { PersonRef } from './anilist-people'

/** Сколько тайтлов персонажа спрашиваем: из них берутся сэйю. */
const MEDIA_LIMIT = 12

/** Потолок сэйю: у долгих франшиз голосов набирается десяток. */
const VOICE_LIMIT = 12

/** Кто перед нами: у персонажа и автора разные запросы и разные факты. */
export type PersonKind = 'character' | 'staff'

/** То, что окно знает до ответа сервера: хватает на шапку. */
export interface PersonTarget {
  kind: PersonKind
  personId: number
  name: string
  native: string | null
  image: string | null
  siteUrl: string | null
}

/** Подпись и значение для ряда фактов. Пустые поля в ряд не попадают. */
export interface PersonFact {
  name: string
  value: string
}

export interface PersonCard {
  personId: number
  kind: PersonKind
  name: string
  native: string | null
  image: string | null
  siteUrl: string | null
  about: string | null
  facts: PersonFact[]
  /** Голоса персонажа. У автора список всегда пуст. */
  voices: PersonRef[]
}

const CHARACTER_QUERY = `query ($id: Int!, $media: Int!) {
  Character(id: $id) {
    id
    siteUrl
    description(asHtml: false)
    gender
    age
    bloodType
    favourites
    name {
      full
      native
    }
    image {
      large
      medium
    }
    dateOfBirth {
      year
      month
      day
    }
    media(page: 1, perPage: $media, sort: [POPULARITY_DESC]) {
      edges {
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
      }
    }
  }
}`

const STAFF_QUERY = `query ($id: Int!) {
  Staff(id: $id) {
    id
    siteUrl
    description(asHtml: false)
    gender
    age
    homeTown
    yearsActive
    favourites
    primaryOccupations
    name {
      full
      native
    }
    image {
      large
      medium
    }
    dateOfBirth {
      year
      month
      day
    }
  }
}`

interface NameReply {
  full?: string | null
  native?: string | null
}

interface ImageReply {
  large?: string | null
  medium?: string | null
}

interface DateReply {
  year?: number | null
  month?: number | null
  day?: number | null
}

interface PersonReply {
  id?: number
  siteUrl?: string | null
  name?: NameReply | null
  image?: ImageReply | null
  description?: string | null
  gender?: string | null
  age?: string | number | null
  bloodType?: string | null
  homeTown?: string | null
  yearsActive?: Array<number | null> | null
  favourites?: number | null
  primaryOccupations?: Array<string | null> | null
  dateOfBirth?: DateReply | null
  media?: {
    edges?: Array<{ voiceActors?: Array<PersonReply | null> | null } | null> | null
  } | null
}

interface CharacterReply {
  Character?: PersonReply | null
}

interface StaffReply {
  Staff?: PersonReply | null
}

const MONTHS: ReadonlyArray<string> = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

/** Пол словом. Незнакомое значение показывается как пришло. */
const GENDER_WORDS: Record<string, string> = {
  Male: 'Мужской',
  Female: 'Женский',
  'Non-binary': 'Небинарный',
}

function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Описание приходит разметкой AniList: метки спойлера, жирный шрифт
 * и обрывки HTML. Показывается оно простым текстом, так что чистим здесь.
 */
function cleanText(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null

  const flat = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/~!|!~/g, '')
    .replace(/__|\*\*/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return flat === '' ? null : flat
}

/** День рождения. Год у персонажей чаще всего не указан вовсе. */
function dateText(raw: DateReply | null | undefined): string | null {
  if (!raw) return null

  const day = typeof raw.day === 'number' ? raw.day : null
  const month = typeof raw.month === 'number' ? raw.month : null
  const year = typeof raw.year === 'number' ? raw.year : null

  const dayText = day !== null && month !== null ? `${day} ${MONTHS[month - 1] ?? ''}`.trim() : null

  if (dayText !== null && year !== null) return `${dayText} ${year}`
  if (dayText !== null) return dayText
  return year !== null ? String(year) : null
}

/** Годы работы: второго числа нет, пока человек работает до сих пор. */
function yearsText(raw: Array<number | null> | null | undefined): string | null {
  const years = (raw ?? []).filter((value): value is number => typeof value === 'number')
  if (years.length === 0) return null

  return years.length > 1 ? `${years[0]}—${years[1]}` : `с ${years[0]}`
}

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

function pushFact(facts: PersonFact[], name: string, value: string | null): void {
  if (value !== null && value !== '') facts.push({ name, value })
}

/** Факты человека. У персонажа и автора они разные. */
function readFacts(kind: PersonKind, raw: PersonReply): PersonFact[] {
  const facts: PersonFact[] = []
  const gender = textOrNull(raw.gender)
  const age = typeof raw.age === 'number' ? String(raw.age) : textOrNull(raw.age)

  if (kind === 'staff') {
    const jobs = (raw.primaryOccupations ?? [])
      .map((job) => textOrNull(job))
      .filter((job): job is string => job !== null)

    pushFact(facts, 'Занятие', jobs.length > 0 ? jobs.join(', ') : null)
  }

  pushFact(facts, 'Пол', gender === null ? null : (GENDER_WORDS[gender] ?? gender))
  pushFact(facts, 'Возраст', age)
  pushFact(facts, 'Рожден', dateText(raw.dateOfBirth))

  if (kind === 'character') {
    pushFact(facts, 'Кровь', textOrNull(raw.bloodType))
  } else {
    pushFact(facts, 'Родом из', textOrNull(raw.homeTown))
    pushFact(facts, 'В работе', yearsText(raw.yearsActive))
  }

  pushFact(facts, 'В избранном', typeof raw.favourites === 'number' ? String(raw.favourites) : null)

  return facts
}

/**
 * Голоса персонажа по всем его ролям. Один и тот же сэйю встречается
 * в каждом сезоне, поэтому повторы отбрасываются по номеру.
 */
function readVoices(raw: PersonReply): PersonRef[] {
  const seen = new Set<number>()
  const voices: PersonRef[] = []

  for (const edge of raw.media?.edges ?? []) {
    for (const actor of edge?.voiceActors ?? []) {
      const person = readPerson(actor)
      if (person === null || seen.has(person.personId)) continue

      seen.add(person.personId)
      voices.push(person)
      if (voices.length >= VOICE_LIMIT) return voices
    }
  }

  return voices
}

/** Память запуска: окно того же человека открывается без запроса. */
const known = new Map<string, PersonCard>()

/** Снять готовое без ожидания: для мгновенной отрисовки окна. */
export function peekPersonCard(kind: PersonKind, personId: number): PersonCard | null {
  return known.get(`${kind}:${personId}`) ?? null
}

/** Один человек целиком. Ключ не нужен: своего в этом ответе нет. */
export async function fetchPersonCard(
  kind: PersonKind,
  personId: number,
): Promise<PersonCard | null> {
  const key = `${kind}:${personId}`
  const ready = known.get(key)
  if (ready) return ready

  const raw =
    kind === 'character'
      ? (await anilistQuery<CharacterReply>(CHARACTER_QUERY, { id: personId, media: MEDIA_LIMIT }))
          .data?.Character
      : (await anilistQuery<StaffReply>(STAFF_QUERY, { id: personId })).data?.Staff

  if (!raw || typeof raw.id !== 'number') {
    Logger('WARN', `Человек ${key}: сервер ответил пустотой`)
    return null
  }

  const card: PersonCard = {
    personId: raw.id,
    kind,
    name: textOrNull(raw.name?.full) ?? String(raw.id),
    native: textOrNull(raw.name?.native),
    image: textOrNull(raw.image?.large) ?? textOrNull(raw.image?.medium),
    siteUrl: textOrNull(raw.siteUrl),
    about: cleanText(raw.description),
    facts: readFacts(kind, raw),
    voices: kind === 'character' ? readVoices(raw) : [],
  }

  known.set(key, card)
  Logger('API', `Человек ${key}: ${card.facts.length} фактов, ${card.voices.length} голосов`)

  return card
}
