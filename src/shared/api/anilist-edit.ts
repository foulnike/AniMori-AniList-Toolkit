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

/** Что меняем в записи. Незаданное сервер оставляет как было. */
export interface EntryPatch {
  status?: string
  score10?: number
  progress?: number
}

const SAVE_MUTATION = `
mutation ($mediaId: Int!, $status: MediaListStatus, $score: Float, $progress: Int) {
  SaveMediaListEntry(mediaId: $mediaId, status: $status, score: $score, progress: $progress) {
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

/** Принято без оговорок. */
const DONE: EditOutcome = { ok: true, retry: false }

/** Отказ по содержанию: повтор даст тот же ответ, правку надо бросить. */
const REFUSED: EditOutcome = { ok: false, retry: false }

/** Временная помеха: сеть, темп или падение сервера. Повторим позже. */
const LATER: EditOutcome = { ok: false, retry: true }

/**
 * Отправляет одну правку записи. Незаданные поля не шлём вовсе:
 * переданный null стёр бы чужое поле, которого пользователь не трогал.
 */
export async function saveEntry(mediaId: number, patch: EntryPatch): Promise<EditOutcome> {
  const variables: Record<string, unknown> = { mediaId }
  if (typeof patch.status === 'string') variables.status = patch.status
  if (typeof patch.score10 === 'number') variables.score = patch.score10
  if (typeof patch.progress === 'number') variables.progress = patch.progress

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
