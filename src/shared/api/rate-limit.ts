// Общий ограничитель темпа обращений к внешним источникам.
// Один на источник, а не на домен: лимит считается по IP, зеркала делят бюджет.
// Про HTTP и коды ответа модуль не знает: выдаёт разрешение отправить и хранит паузу.
//
// СКЛЕЙКА ОДИНАКОВЫХ ВОПРОСОВ
// Здесь же живёт once(): пока один вопрос в пути, второй такой же в сеть не
// уходит, а ждёт первого ответа. Место выбрано по смыслу — это тот же разговор
// о темпе, только с другой стороны: ограничитель растягивает неизбежные
// запросы во времени, а склейка убирает избыточные вовсе.
//
// Прежде каждый модуль писал свою пару «карта незавершённых плюс проверка»
// заново, и каждая была написана чуть иначе. Одна забывала ключ только на
// успехе, и первый же отказ запирал вопрос до перезапуска. Другая проверяла
// и записывала в разных тиках, так что два одновременных вызова успевали
// увидеть пустоту оба и уходили в сеть вдвоём — именно та ошибка, от которой
// склейка и должна была защищать.

/**
 * Потолок повторов запроса, упёршегося в 429: без него повтор был бесконечным.
 *
 * Было три, стало один. Три повтора при паузе в пять секунд превращали один
 * вопрос к серверу в четыре запроса и двадцать секунд ожидания — и делалось
 * это ровно в тот момент, когда сервер уже сказал «слишком часто». Один
 * повтор покрывает случайное совпадение с чужим всплеском; всё, что дольше,
 * — это уже отступ, и держать его должна пауза, а не череда попыток.
 */
export const MAX_RATE_RETRIES = 1

/**
 * Единый режим темпа: пять запросов в секунду и шестьдесят в минуту.
 * Ниже потолков Shikimori (5/сек и 90/мин): запас держится сознательно.
 */
export const API_MIN_INTERVAL_MS = 300
export const API_WINDOW_MS = 60000
export const API_MAX_PER_WINDOW = 60

/**
 * Начало и предохранитель для AniList: настоящий потолок придёт в заголовках.
 * Сейчас сервис отдаёт деградированные 30, штатные 90 вернутся без наших правок.
 */
export const ANILIST_START_PER_WINDOW = 30
export const ANILIST_MAX_PER_WINDOW = 90

/** Ниже этого потолок не урезается: иначе серия 429 остановила бы работу вовсе. */
export const RATE_FLOOR_PER_WINDOW = 6

/**
 * На сколько закрывается рост потолка после урезания.
 * Ответ во время техработ может назвать прежний потолок и тут же ответить 429.
 */
export const CEILING_RECOVERY_MS = 300000

/**
 * Отказ по исчерпанию повторов на 429.
 * Отдельный тип нужен, чтобы перебор зеркал не проглотил его своим catch.
 */
export class RateLimitError extends Error {
  constructor(source: string, target: string) {
    // Число отдельно от слова: при MAX_RATE_RETRIES = 1 прежняя строка
    // «не отпустил за 1 попытки» читалась бы как опечатка в журнале.
    super(`${source}: лимит запросов не отпустил, повторов было ${MAX_RATE_RETRIES} (${target})`)
    this.name = 'RateLimitError'
  }
}

/**
 * Незавершённые вопросы по ключу. Значение хранится как Promise<unknown>:
 * ключи ведут к разным видам ответа, и общего типа у них нет. Приведение
 * делается в once() — там ключ и вид ответа известны вместе.
 */
const inFlight = new Map<string, Promise<unknown>>()

/**
 * Один поход за раз на один ключ. Второй такой же вопрос получает тот же
 * промис вместо своего запроса.
 *
 * Ключ задаёт вызывающий: он единственный знает, что считать «тем же самым
 * вопросом». Карточка тайтла — это номер, поиск — слово и страница, справочник
 * тэгов — сам себя, и ключ у него без переменной части.
 *
 * Отказ склеивается вместе с успехом: если сервер отказал одному спросившему,
 * он отказал бы и остальным, а четыре одинаковых отказа вместо одного — это
 * четыре запроса в закрытую дверь. Ключ отпускается в любом исходе, так что
 * следующая попытка снова пойдёт в сеть.
 */
export function once<T>(key: string, task: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key)
  if (running !== undefined) return running as Promise<T>

  let started: Promise<T>
  try {
    started = task()
  } catch (e) {
    // Задача, упавшая до первого ожидания, ключ за собой не запирает.
    return Promise.reject(e)
  }

  // Тип указан явно: без него вывод пошёл бы по кругу через собственный
  // обработчик завершения, и получилась бы неявная any.
  const guarded: Promise<T> = started.finally(() => {
    // Сравнение обязательно: пока мы ждали, в карте мог оказаться уже другой,
    // более свежий поход с тем же ключом, и стирать его нельзя.
    if (inFlight.get(key) === guarded) inFlight.delete(key)
  })

  inFlight.set(key, guarded)
  return guarded
}

/** Сколько вопросов сейчас в пути. Только для сводки: в решениях не участвует. */
export function inFlightCount(): number {
  return inFlight.size
}

export interface RateLimiterOptions {
  /** Имя источника — попадает в текст ошибок. */
  name: string
  /** Минимальный промежуток между стартами двух запросов. */
  minIntervalMs: number
  /** Длина скользящего окна учёта. */
  windowMs: number
  /** Сколько запросов допускается внутри окна до первого ответа сервера. */
  maxPerWindow: number
  /** Предохранитель: выше этого не подниматься, что бы ни сказал сервер. */
  maxCeiling?: number
  /** Считать интервал от потолка, а не брать из minIntervalMs. */
  deriveInterval?: boolean
}

/**
 * Снимок состояния одного источника. Полей больше, чем было: прежние четыре
 * числа отвечали на вопрос «жив ли тормоз», а спрашивают у него другое —
 * «сколько мы уже потратили и сколько осталось». Именно это показывает
 * читатель бюджета на экране журнала.
 */
export interface RateLimiterStats {
  /** Имя источника — то же, что в текстах ошибок. */
  name: string
  /** Запросов внутри окна учёта прямо сейчас. */
  inWindow: number
  /** Действующий потолок за окно: меняется по заголовкам и после 429. */
  ceiling: number
  /** Сколько ещё можно отправить до конца окна. */
  remaining: number
  /** Длина окна учёта: без неё остаток нечем истолковать. */
  windowMs: number
  /** Действующий промежуток между стартами двух запросов. */
  intervalMs: number
  /** Осталось до конца паузы; ноль — паузы нет. */
  pauseRemaining: number
  /** Слотов выдано с запуска программы. Это и есть счёт нашего расхода. */
  sentTotal: number
  /** Когда уходил последний запрос. Ноль — ни одного за сессию. */
  lastSentAt: number
}

export interface RateLimiter {
  readonly name: string
  /** Ждёт своей очереди на отправку. Возврат = разрешение отправить один запрос. */
  acquireSlot: () => Promise<void>
  /** Ставит источник на паузу (обычно после 429). Паузы не сокращаются, только продлеваются. */
  pause: (ms: number) => void
  /** Активна ли пауза. Очередь перевода спрашивает это перед каждой пачкой. */
  isPaused: () => boolean
  /** Сколько миллисекунд осталось до конца паузы. */
  pauseRemaining: () => number
  /**
   * Принимает потолок, названный сервером в заголовках ответа.
   * Выше предохранителя обрезается, а во время восстановления рост игнорируется.
   */
  applyCeiling: (limit: number) => void
  /** Урезает потолок вдвое после 429 и закрывает его рост на время восстановления. */
  reduceCeiling: () => void
  /** Снимок состояния, только чтение. Читатель — экран журнала (#/log). */
  stats: () => RateLimiterStats
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Перечень созданных ограничителей в порядке появления.
 *
 * Нужен читателю бюджета: без перечня экран журнала пришлось бы держать
 * в курсе каждого нового источника руками, а забытый источник — это ровно
 * тот случай, когда сводка показывает ноль и выглядит правдой. Раз запись
 * идёт из самой мастерской, забыть источник нельзя.
 */
const allLimiters: RateLimiter[] = []

/** Снимок по всем источникам сразу. Порядок — как создавались. */
export function collectRateStats(): RateLimiterStats[] {
  return allLimiters.map((limiter) => limiter.stats())
}

/** Создаёт независимый ограничитель темпа для одного источника. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { name, minIntervalMs, windowMs, maxPerWindow, maxCeiling, deriveInterval } = options

  /** Выше этого потолок не поднимется даже по словам сервера. */
  const hardMax = Math.max(maxPerWindow, maxCeiling ?? maxPerWindow)

  /** Действующий потолок за окно: меняется по заголовкам и после 429. */
  let ceiling = maxPerWindow
  /** До этого времени потолок не повышается после урезания. */
  let ceilingLockedUntil = 0
  /** Unix-время, до которого запросы к источнику приостановлены. */
  let pausedUntil = 0
  /** Время последней выдачи слота. */
  let lastSentAt = 0
  /** Сколько слотов выдано за всю сессию. Только для сводки, в решениях не участвует. */
  let sentTotal = 0
  /** Отметки выдач за последнее окно. */
  const recentSends: number[] = []
  /**
   * Очередь ожидающих: без шлюза два параллельных вызова займут один слот.
   * Ответа не ждём — иначе один медленный запрос застопорит всех остальных.
   */
  let gate: Promise<void> = Promise.resolve()

  /** Действующий промежуток: при deriveInterval он размазывает потолок по окну. */
  function currentInterval(): number {
    if (!deriveInterval) return minIntervalMs
    return Math.max(minIntervalMs, Math.ceil(windowMs / Math.max(1, ceiling)))
  }

  /**
   * Сколько отметок попадает в окно на данный момент.
   *
   * Считается заново, а не берётся длиной массива: чистка отметок идёт только
   * внутри выдачи слота, и в тишине там остаётся вчерашний хвост. Выдача из-за
   * этого не страдала — она чистит перед проверкой, — а вот сводка показывала
   * израсходованным окно, в котором давно никого нет.
   */
  function countInWindow(now: number): number {
    let count = 0
    for (const at of recentSends) {
      if (now - at < windowMs) count++
    }
    return count
  }

  async function acquireSlot(): Promise<void> {
    const previous = gate
    let release: () => void = () => undefined
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    try {
      for (;;) {
        const now = Date.now()

        // Чистим отметки, вышедшие за окно.
        while (recentSends.length > 0 && now - (recentSends[0] ?? 0) >= windowMs) {
          recentSends.shift()
        }

        const waits: number[] = []
        const interval = currentInterval()
        const sinceLast = now - lastSentAt
        if (sinceLast < interval) waits.push(interval - sinceLast)
        if (now < pausedUntil) waits.push(pausedUntil - now)
        if (recentSends.length >= ceiling) {
          waits.push(windowMs - (now - (recentSends[0] ?? now)) + 50)
        }

        if (waits.length === 0) {
          lastSentAt = Date.now()
          recentSends.push(lastSentAt)
          sentTotal++
          return
        }

        await sleep(Math.max(...waits))
      }
    } finally {
      release()
    }
  }

  const limiter: RateLimiter = {
    name,
    acquireSlot,
    pause(ms: number): void {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms)
    },
    isPaused(): boolean {
      return Date.now() < pausedUntil
    },
    pauseRemaining(): number {
      return Math.max(0, pausedUntil - Date.now())
    },
    applyCeiling(limit: number): void {
      if (!Number.isFinite(limit) || limit <= 0) return

      const next = Math.min(Math.floor(limit), hardMax)
      if (next === ceiling) return

      // Снижение принимаем всегда, рост — только когда восстановление закончилось.
      if (next > ceiling && Date.now() < ceilingLockedUntil) return

      ceiling = Math.max(RATE_FLOOR_PER_WINDOW, next)
    },
    reduceCeiling(): void {
      ceiling = Math.max(RATE_FLOOR_PER_WINDOW, Math.floor(ceiling / 2))
      ceilingLockedUntil = Date.now() + CEILING_RECOVERY_MS
    },
    stats(): RateLimiterStats {
      const now = Date.now()
      const inWindow = countInWindow(now)

      return {
        name,
        inWindow,
        ceiling,
        remaining: Math.max(0, ceiling - inWindow),
        windowMs,
        intervalMs: currentInterval(),
        pauseRemaining: Math.max(0, pausedUntil - now),
        sentTotal,
        lastSentAt,
      }
    },
  }

  allLimiters.push(limiter)

  return limiter
}

/**
 * Общий для shikimori.ts и shikimori-people.ts — ради этого модуль и появился.
 * shikimori-user.ts идёт мимо: там единичные запросы по кнопке, а не поток очереди.
 */
export const shikiLimiter = createRateLimiter({
  name: 'Shikimori',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/**
 * Режим тот же, что у Shikimori: источники стоят в одной цепочке резолва названий.
 * Иначе фоллбэк обгоняет основной источник и первым ловит блокировку.
 */
export const anime365Limiter = createRateLimiter({
  name: 'anime365',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/**
 * Бюджет отдельный от Shikimori: другой сервис со своим счётом по IP.
 * Темп здесь низкий: это страховка от всплеска при быстром переборе страниц.
 */
export const animeThemesLimiter = createRateLimiter({
  name: 'AnimeThemes',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/**
 * Единственный ограничитель с плавающим потолком: только AniList их присылает.
 * Интервал считается от потолка: всплеск в одну секунду ловит 429 даже в лимите.
 */
export const anilistLimiter = createRateLimiter({
  name: 'AniList',
  minIntervalMs: 100,
  windowMs: API_WINDOW_MS,
  maxPerWindow: ANILIST_START_PER_WINDOW,
  maxCeiling: ANILIST_MAX_PER_WINDOW,
  deriveInterval: true,
})

/**
 * Опись и файлы датасета названий: до трёх запросов на запуск программы.
 * Отдельный источник держится ради инварианта 1: слот берёт каждый сетевой
 * вызов, даже редкий.
 */
export const githubLimiter = createRateLimiter({
  name: 'GitHub',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/**
 * Aniliberty: открытый API без ключа и без объявленного потолка. Темп общий
 * с остальными и держится из вежливости, а не по документу: открытие плеера
 * стоит двух запросов подряд, а при переборе названий их бывает больше.
 */
export const anilibertyLimiter = createRateLimiter({
  name: 'Aniliberty',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/**
 * Kodik: ключ общий на всех, потолок нигде не объявлен. Одна серия стоит
 * трёх запросов подряд: поиск, страница серии и /ftor. Свой бюджет держится
 * ради соседей: иначе открытие плеера тормозит перевод имён на другом экране.
 */
export const kodikLimiter = createRateLimiter({
  name: 'Kodik',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})
