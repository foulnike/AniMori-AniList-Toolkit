// Отправщик очереди правок: единственный путь изменений на сервер.
// Экраны зовут только queueEdit и сразу видят правку в памяти.
// Отказ сервера память не откатывает: правда восстановится обновлением списка.

import { anilistPauseRemaining, isAniListRateLimited } from '../api/anilist'
import { removeEntry, saveEntry, type EditOutcome } from '../api/anilist-edit'
import { Logger } from '../utils/logger'
import { dropEntry, getEntry, putEntry } from './collection'
import {
  bumpEditAttempt,
  enqueueEdit,
  markEditAccepted,
  readEditQueue,
  type EditKind,
  type PendingEdit,
} from './snapshot'

/**
 * Потолок попыток. После него правка выкидывается: вечная правка
 * стопорит всю очередь позади себя, а порядок нарушать нельзя.
 */
const MAX_ATTEMPTS = 5

/** Период фонового разбора очереди. Чаще нет смысла: темп всё равно свой. */
const SWEEP_MS = 60000

/** Идущий разбор. Два одновременных отправили бы одну правку дважды. */
let sweepInFlight: Promise<void> | null = null

/** Таймер фонового разбора. */
let sweepTimer: number | undefined

/** Кладёт правку в память, чтобы экран обновился до ответа сервера. */
function applyToMemory(mediaId: number, kind: EditKind, value: string | number | null): void {
  if (kind === 'remove') {
    dropEntry(mediaId)
    return
  }

  const known = getEntry(mediaId)
  const entry = known
    ? { ...known }
    : { mediaId, status: null, score10: 0, progress: 0, updatedAt: Date.now() }

  if (kind === 'status' && typeof value === 'string') entry.status = value
  if (kind === 'score' && typeof value === 'number') entry.score10 = value
  if (kind === 'progress' && typeof value === 'number') entry.progress = value

  entry.updatedAt = Date.now()
  putEntry(entry)
}

/** Отправляет одну правку. Вид правки решает, какой запрос пойдёт. */
function sendOne(edit: PendingEdit): Promise<EditOutcome> {
  if (edit.kind === 'remove') return removeEntry(edit.mediaId)
  if (edit.kind === 'status' && typeof edit.value === 'string') {
    return saveEntry(edit.mediaId, { status: edit.value })
  }
  if (edit.kind === 'score' && typeof edit.value === 'number') {
    return saveEntry(edit.mediaId, { score10: edit.value })
  }
  if (edit.kind === 'progress' && typeof edit.value === 'number') {
    return saveEntry(edit.mediaId, { progress: edit.value })
  }

  // Значение не того вида: отправлять нечего, держать тоже незачем.
  Logger('WARN', `Правка ${edit.id}: значение не подходит к виду ${edit.kind}`)
  return Promise.resolve({ ok: false, retry: false })
}

/**
 * Разбирает очередь от головы. Не отклоняется и не бросает исключений:
 * звать её будут из обработчиков событий, где ошибку некому ловить.
 */
export function flushEdits(): Promise<void> {
  if (sweepInFlight) return sweepInFlight

  sweepInFlight = (async () => {
    try {
      // Сервер закрыт целиком — ходить некуда, и попытки тратить не на что.
      if (isAniListRateLimited()) {
        const left = Math.ceil(anilistPauseRemaining() / 1000)
        Logger('QUEUE', `Очередь правок ждёт: AniList недоступен ещё ${left}с`)
        return
      }

      const queue = await readEditQueue()
      if (!queue.length) return

      Logger('QUEUE', `Очередь правок: к отправке ${queue.length}`)

      for (const edit of queue) {
        const outcome = await sendOne(edit)

        if (outcome.ok) {
          await markEditAccepted(edit.id)
          continue
        }

        if (!outcome.retry) {
          // Отказ по содержанию: держать такую правку — запереть очередь навсегда.
          await markEditAccepted(edit.id)
          Logger('QUEUE', `Правка ${edit.id} брошена: сервер её не примет`)
          continue
        }

        // Сервер отказал всем сразу: правка не виновата, попытка не считается.
        if (isAniListRateLimited()) {
          const left = Math.ceil(anilistPauseRemaining() / 1000)
          Logger('QUEUE', `Отправка отложена: AniList недоступен ещё ${left}с`)
          return
        }

        const attempts = await bumpEditAttempt(edit.id)
        if (attempts >= MAX_ATTEMPTS) {
          await markEditAccepted(edit.id)
          Logger('QUEUE', `Правка ${edit.id} брошена после ${attempts} попыток`)
          continue
        }

        // Помеха общая, а не в этой правке: остальные ждут следующего захода.
        Logger('QUEUE', `Отправка отложена на правке ${edit.id}, попытка ${attempts}`)
        return
      }
    } catch (e) {
      Logger('ERROR', 'Очередь правок: разбор сорвался', e)
    } finally {
      sweepInFlight = null
    }
  })()

  return sweepInFlight
}

/**
 * Единственная точка входа для экранов. Память меняется сразу,
 * очередь пишется немедленно, отправка идёт своим ходом.
 */
export async function queueEdit(
  mediaId: number,
  kind: EditKind,
  value: string | number | null,
): Promise<void> {
  applyToMemory(mediaId, kind, value)
  await enqueueEdit(mediaId, kind, value)
  void flushEdits()
}

/**
 * Запускает фоновый разбор очереди. Зовётся один раз на старте,
 * сразу после подъёма коллекции: до неё в памяти править нечего.
 */
export function startEditSender(): void {
  if (sweepTimer !== undefined) return

  sweepTimer = window.setInterval(() => {
    void flushEdits()
  }, SWEEP_MS)

  // Возврат сети — лучший момент для повтора: ждать таймер незачем.
  window.addEventListener('online', () => {
    void flushEdits()
  })

  void flushEdits()
}

/** Гасит фоновый разбор. Нужен при выходе из учётной записи. */
export function stopEditSender(): void {
  if (sweepTimer === undefined) return

  window.clearInterval(sweepTimer)
  sweepTimer = undefined
}
