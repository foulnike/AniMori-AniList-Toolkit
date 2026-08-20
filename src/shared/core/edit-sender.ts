// Отправщик очереди правок: единственный путь изменений на сервер.
// Экраны зовут только queueEdit и сразу видят правку в памяти.
// Отказ сервера память не откатывает: правда восстановится обновлением списка.

import { anilistPauseRemaining, canSignAniList, isAniListRateLimited } from '../api/anilist'
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
  type SnapshotEntry,
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

/**
 * Облик тайтла: то, что запись о себе знать не может, а показ требует.
 * Экран берёт его из карточки или плитки и передаёт с правкой, иначе
 * запись, созданная без входа, навсегда осталась бы «Тайтл #id».
 *
 * Поле вида — остаток от времён манги: его ещё передают уже записанные
 * вызовы, а выбирать больше не из чего.
 */
export type EntryLook = {
  type?: 'ANIME'
  romaji: string | null
  english: string | null
  isAdult: boolean
}

/**
 * Строка правки в значение снимка. Пустая строка — это «стереть»:
 * очередь везёт только строки и числа, а null у нас занят удалением записи.
 */
function orNull(value: string): string | null {
  return value === '' ? null : value
}

/**
 * Кладёт правку в память, чтобы экран обновился до ответа сервера.
 *
 * @param look Облик тайтла, если экран его знает. Новой записи он даёт имя,
 * известной — заполняет пустоты. Занятые поля не трогаются: ответ
 * сервера точнее плитки, с которой пришла правка.
 */
function applyToMemory(
  mediaId: number,
  kind: EditKind,
  value: string | number | null,
  look?: EntryLook,
): void {
  if (kind === 'remove') {
    dropEntry(mediaId)
    return
  }

  const known = getEntry(mediaId)

  // Поля перечислены явно: новое поле снимка должно ломать сборку здесь,
  // а не живой запуск. Поля type и volumes — остатки от манги: они уйдут
  // вместе с поднятием версии снимка.
  const entry: SnapshotEntry = known
    ? { ...known }
    : {
        mediaId,
        type: 'ANIME',
        status: null,
        score10: 0,
        progress: 0,
        volumes: 0,
        repeat: 0,
        startedAt: null,
        completedAt: null,
        notes: null,
        updatedAt: Date.now(),
        isAdult: look?.isAdult ?? false,
        romaji: look?.romaji ?? null,
        english: look?.english ?? null,
      }

  // Известной записи облик только дополняет пустоты: имя с плитки не должно
  // затирать имя из ответа сервера.
  if (known && look) {
    if (entry.romaji === null) entry.romaji = look.romaji
    if (entry.english === null) entry.english = look.english
  }

  if (kind === 'status' && typeof value === 'string') entry.status = value
  if (kind === 'score' && typeof value === 'number') entry.score10 = value
  if (kind === 'progress' && typeof value === 'number') entry.progress = value
  if (kind === 'repeat' && typeof value === 'number') entry.repeat = value
  if (kind === 'startedAt' && typeof value === 'string') entry.startedAt = orNull(value)
  if (kind === 'completedAt' && typeof value === 'string') entry.completedAt = orNull(value)
  if (kind === 'notes' && typeof value === 'string') entry.notes = orNull(value)

  entry.updatedAt = Date.now()
  putEntry(entry)
}

/**
 * Отправляет одну правку. Вид правки решает, какой запрос пойдёт.
 *
 * Правки томов среди видов больше нет. Залежавшаяся с прежних версий
 * уйдёт по общему правилу ниже: с записью в журнал и без повторов,
 * иначе она заперла бы очередь позади себя навечно.
 */
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
  if (edit.kind === 'repeat' && typeof edit.value === 'number') {
    return saveEntry(edit.mediaId, { repeat: edit.value })
  }
  // Ключ передаётся всегда, даже со значением null: именно так дата стирается.
  if (edit.kind === 'startedAt' && typeof edit.value === 'string') {
    return saveEntry(edit.mediaId, { startedAt: orNull(edit.value) })
  }
  if (edit.kind === 'completedAt' && typeof edit.value === 'string') {
    return saveEntry(edit.mediaId, { completedAt: orNull(edit.value) })
  }
  // Комментарий стирается пустой строкой, так что её и шлём как есть.
  if (edit.kind === 'notes' && typeof edit.value === 'string') {
    return saveEntry(edit.mediaId, { notes: edit.value })
  }

  // Значение не того вида или вид, которого больше нет: отправлять
  // нечего, держать тоже незачем.
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
      // Без входа отправлять некуда: сервер отверг бы каждую правку, а попытки
      // у них считаные. Очередь ждёт входа целиком.
      if (!canSignAniList()) return

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
 *
 * Без входа правка дальше памяти и снимка не идёт: пункт 3.14, свой список
 * ведётся без учётной записи. Складывать её в очередь нельзя — к моменту
 * входа она была бы уже выброшена по числу попыток, а перенос списка
 * с сервера всё равно делается отдельным действием и заменяет местное.
 *
 * @param look Облик тайтла, если экран его знает: имена и метка взрослого.
 */
export async function queueEdit(
  mediaId: number,
  kind: EditKind,
  value: string | number | null,
  look?: EntryLook,
): Promise<void> {
  applyToMemory(mediaId, kind, value, look)

  if (!canSignAniList()) {
    Logger('DB', `Правка тайтла ${mediaId} сохранена местно: вход не выполнен`)
    return
  }

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
