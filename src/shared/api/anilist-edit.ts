// Мутации записи списка: отправка одной правки на сервер.
// Очередью и повторами здесь не занимаемся: это дело отправщика.
// Всё сюда входящее требует входа: без ключа сервер ответит отказом.

import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'

/**
 * Итог отправки. Главный вопрос не «что случилось», а «повторять ли»:
 * сеть лечится временем, отказ по содержанию не вылечится никогда.
 */
export interface EditOutcome {
  ok: boolean
  retry: boolean
}

/**
 * Что меняем в записи. Незаданное сервер оставляет как было.
 *
 * У дат три состояния, а не два: ключа нет — не трогаем, строка — ставим,
 * null — стираем. Поэтому они разбираются через наличие ключа, а не типа.
 *
 * Прочитанных томов среди полей нет: у аниме их не бывает, а единственный
 * вызывающий — отправщик очереди — такой вид правки больше не знает.
 */
export interface EntryPatch {
  status?: string
  score10?: number
  progress?: number
  /** Сколько раз пересмотрели. */
  repeat?: number
  /** Дата вида ГГГГ-ММ-ДД или null, чтобы стереть. */
  startedAt?: string | null
  completedAt?: string | null
  /** Личный комментарий. Пустая строка стирает его на сервере. */
  notes?: string
}

const SAVE_MUTATION = `
mutation (
  $mediaId: Int!
  $status: MediaListStatus
  $score: Float
  $progress: Int
  $repeat: Int
  $startedAt: FuzzyDateInput
  $completedAt: FuzzyDateInput
  $notes: String
) {
  SaveMediaListEntry(
    mediaId: $mediaId
    status: $status
    score: $score
    progress: $progress
    repeat: $repeat
    startedAt: $startedAt
    completedAt: $completedAt
    notes: $notes
  ) {
    id
    mediaId
  }
}`

// Сервер удаляет запись списка по её номеру, а не по номеру тайтла.
const ENTRY_ID_QUERY = `
query ($mediaId: Int!) {
  Media(id: $mediaId) {
    mediaListEntry {
      id
    }
  }
}`

const DELETE_MUTATION = `
mutation ($id: Int!) {
  DeleteMediaListEntry(id: $id) {
    deleted
  }
}`

interface SaveReply {
  SaveMediaListEntry?: { id?: number } | null
}

interface EntryIdReply {
  Media?: { mediaListEntry?: { id?: number } | null } | null
}

interface DeleteReply {
  DeleteMediaListEntry?: { deleted?: boolean } | null
}

/** Нечёткая дата сервера: тройка чисел, любое из них может быть пустым. */
interface FuzzyDate {
  year: number | null
  month: number | null
  day: number | null
}

/** Пустая нечёткая дата — именно она стирает дату на сервере. */
const BLANK_DATE: FuzzyDate = { year: null, month: null, day: null }

/**
 * Переводит ГГГГ-ММ-ДД в тройку чисел. Без меток времени сознательно:
 * это календарный день, и прогон через Date сдвинул бы его на сутки
 * у всех, кто западнее Гринвича. Непонятная строка считается очисткой.
 */
function toFuzzy(value: string | null): FuzzyDate {
  if (!value) return BLANK_DATE

  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!parts) {
    Logger('WARN', `Правка: дата непонятного вида «${value}» — шлём очистку`)
    return BLANK_DATE
  }

  return {
    year: Number(parts[1]),
    month: Number(parts[2]),
    day: Number(parts[3]),
  }
}

/**
 * Отправляет одну правку записи. Незаданные поля не шлём вовсе:
 * переданный null стёр бы чужое поле, которого пользователь не трогал.
 *
 * Даты проверяются по наличию ключа, а не по типу значения: только так можно
 * отличить «не задано» от «стереть».
 */
export async function saveEntry(mediaId: number, patch: EntryPatch): Promise<EditOutcome> {
  const variables: Record<string, unknown> = { mediaId }
  if (typeof patch.status === 'string') variables.status = patch.status
  if (typeof patch.score10 === 'number') variables.score = patch.score10
  if (typeof patch.progress === 'number') variables.progress = patch.progress
  if (typeof patch.repeat === 'number') variables.repeat = patch.repeat
  if ('startedAt' in patch) variables.startedAt = toFuzzy(patch.startedAt ?? null)
  if ('completedAt' in patch) variables.completedAt = toFuzzy(patch.completedAt ?? null)
  if (typeof patch.notes === 'string') variables.notes = patch.notes

  try {
    const reply = await anilistQuery<SaveReply>(SAVE_MUTATION, variables, true)

    if (reply.errors) {
      Logger('WARN', `Правка ${mediaId} отклонена сервером`, reply.errors)
      return REFUSED
    }

    if (!reply.data?.SaveMediaListEntry) return LATER

    Logger('API', `Правка ${mediaId} принята сервером`)
    return DONE
  } catch (e) {
    Logger('WARN', `Правка ${mediaId} не ушла, повторим позже`, e)
    return LATER
  }
}

/** Принято без оговорок. */
const DONE: EditOutcome = { ok: true, retry: false }

/** Отказ по содержанию: повтор даст тот же ответ, правку надо бросить. */
const REFUSED: EditOutcome = { ok: false, retry: false }

/** Временная помеха: сеть, темп или падение сервера. Повторим позже. */
const LATER: EditOutcome = { ok: false, retry: true }

/**
 * Убирает запись из списка. Два запроса: сначала номер записи,
 * потом само удаление. Записи нет — считаем дело сделанным.
 */
export async function removeEntry(mediaId: number): Promise<EditOutcome> {
  try {
    const found = await anilistQuery<EntryIdReply>(ENTRY_ID_QUERY, { mediaId }, true)

    if (found.errors) {
      Logger('WARN', `Удаление ${mediaId}: сервер не назвал запись`, found.errors)
      return REFUSED
    }

    const entryId = found.data?.Media?.mediaListEntry?.id
    if (typeof entryId !== 'number') {
      Logger('API', `Удаление ${mediaId}: записи в списке уже нет`)
      return DONE
    }

    const reply = await anilistQuery<DeleteReply>(DELETE_MUTATION, { id: entryId }, true)

    if (reply.errors) {
      Logger('WARN', `Удаление ${mediaId} отклонено сервером`, reply.errors)
      return REFUSED
    }

    if (!reply.data?.DeleteMediaListEntry) return LATER

    Logger('API', `Запись ${mediaId} удалена с сервера`)
    return DONE
  } catch (e) {
    Logger('WARN', `Удаление ${mediaId} не ушло, повторим позже`, e)
    return LATER
  }
}
