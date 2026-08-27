// Очередь неотправленных правок списка: данные, которые негде взять заново.
// Снимок списка живёт в snapshot.ts, склад ответов сети — в db.ts.
// Отправкой на сервер занимается edit-sender.ts, здесь хранение и порядок.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'
import { serialWrite } from './store-chain'

/** Ключ хранилища моста. Приставка AM_ занята только нашими записями. */
const QUEUE_KEY = 'AM_EDIT_QUEUE'

/**
 * Потолок очереди правок. Без него сеть, лежащая сутки, накопит очередь
 * размером со всю коллекцию, а пишется она целиком на каждую правку.
 */
const QUEUE_LIMIT = 500

/**
 * Что именно правили в записи списка. Удаление — тоже правка, её нельзя терять.
 *
 * Поля пересчётом не сводятся в одну правку «всё сразу»: отказ сервера по одному
 * полю не должен уронить остальные, а порядок очередь и так соблюдает.
 *
 * Тома из видов ушли вместе с мангой. Залежавшаяся правка томов из прежних
 * версий очередь не запирает: отправщик не знает такого вида и выбрасывает
 * её с записью в журнал.
 */
export type EditKind =
  'status' | 'score' | 'progress' | 'repeat' | 'startedAt' | 'completedAt' | 'notes' | 'remove'

/**
 * Неотправленная правка. `id` свой, а не серверный: отметить принятой
 * надо именно ту запись, которую отправляли, а не похожую по полям.
 */
export interface PendingEdit {
  id: string
  /** AniList ID тайтла, а не записи списка: запись ещё может не существовать. */
  mediaId: number
  kind: EditKind
  /** Значение правки; для 'remove' всегда null. */
  value: string | number | null
  createdAt: number
  /** Сколько раз пытались отправить. Решает отправщик, хранится здесь. */
  attempts: number
}

/** Годна ли запись очереди. Битые правки отправлять нельзя и держать бессмысленно. */
function isEdit(value: unknown): value is PendingEdit {
  if (typeof value !== 'object' || value === null) return false

  const edit = value as Partial<PendingEdit>
  return typeof edit.id === 'string' && typeof edit.mediaId === 'number' && !!edit.kind
}

/** Читает очередь правок. Порядок соблюдается: две правки одного тайтла не коммутируют. */
export async function readEditQueue(): Promise<PendingEdit[]> {
  try {
    const raw = await Bridge.storage.get<unknown>(QUEUE_KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter(isEdit)
  } catch (e) {
    Logger('ERROR', 'Очередь правок: ошибка чтения', e)
    return []
  }
}

/**
 * Перезаписывает очередь целиком и дожидается диска.
 * Очередь крошечная, поэтому частичная запись не нужна и только мешала бы.
 */
async function writeQueue(edits: PendingEdit[]): Promise<void> {
  return serialWrite(async () => {
    try {
      await Bridge.storage.set(QUEUE_KEY, edits)
      await Bridge.storage.flush()
    } catch (e) {
      Logger('ERROR', 'Очередь правок: ошибка записи', e)
    }
  })
}

/**
 * Кладёт правку в очередь и возвращает её в готовом виде. Запись немедленная.
 * Задержек здесь нет сознательно: это единственные данные, которые негде взять заново.
 */
export async function enqueueEdit(
  mediaId: number,
  kind: EditKind,
  value: string | number | null,
): Promise<PendingEdit> {
  const edit: PendingEdit = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    mediaId,
    kind,
    value: kind === 'remove' ? null : value,
    createdAt: Date.now(),
    attempts: 0,
  }

  const queue = await readEditQueue()

  // Переполнение решается в пользу свежих правок: старые уже перекрыты новыми.
  if (queue.length >= QUEUE_LIMIT) {
    const dropped = queue.length - QUEUE_LIMIT + 1
    queue.splice(0, dropped)
    Logger('WARN', `Очередь правок переполнена: отброшено старых правок ${dropped}`)
  }

  queue.push(edit)
  await writeQueue(queue)
  Logger('DB', `Правка в очереди: ${kind} для ${mediaId}, всего ${queue.length}`)

  return edit
}

/** Убирает принятую сервером правку. Неизвестный идентификатор ошибкой не считается. */
export async function markEditAccepted(id: string): Promise<void> {
  const queue = await readEditQueue()
  const left = queue.filter((edit) => edit.id !== id)
  if (left.length === queue.length) return

  await writeQueue(left)
}

/**
 * Выбрасывает очередь целиком и возвращает число выброшенных правок.
 * Нужно при отвязке счёта: правки адресованы прежнему счёту, отправлять их
 * после отвязки некуда, а при следующем входе они улетели бы на сервер сами.
 *
 * Сами записи списка при этом остаются: правки уже накачены на память,
 * и человек теряет не свои данные, а только их доставку на сайт.
 */
export async function clearEditQueue(): Promise<number> {
  const queue = await readEditQueue()
  if (queue.length === 0) return 0

  await writeQueue([])
  Logger('DB', `Очередь правок выброшена: правок ${queue.length}`)

  return queue.length
}

/**
 * Считает неудачную попытку отправки и возвращает новое число попыток.
 * Сама правка остаётся в очереди: бросать её или нет, решает отправщик.
 */
export async function bumpEditAttempt(id: string): Promise<number> {
  const queue = await readEditQueue()
  const edit = queue.find((item) => item.id === id)
  if (!edit) return 0

  edit.attempts++
  await writeQueue(queue)

  return edit.attempts
}
