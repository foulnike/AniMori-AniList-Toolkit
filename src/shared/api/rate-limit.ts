// Общий ограничитель темпа обращений к внешним источникам.
// Один на источник, а не на домен: лимит считается по IP, зеркала делят бюджет.
// Про HTTP и коды ответа модуль не знает: выдаёт разрешение отправить и хранит паузу.

/** Потолок повторов запроса, упёршегося в 429: без него повтор был бесконечным. */
export const MAX_RATE_RETRIES = 3

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
    super(`${source}: лимит запросов не отпустил за ${MAX_RATE_RETRIES} попытки (${target})`)
    this.name = 'RateLimitError'
  }
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
  /** Снимок состояния для инспектора логгера (только чтение). */
  stats: () => { inWindow: number; pauseRemaining: number; ceiling: number; intervalMs: number }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
          return
        }

        await sleep(Math.max(...waits))
      }
    } finally {
      release()
    }
  }

  return {
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
    stats() {
      return {
        inWindow: recentSends.length,
        pauseRemaining: Math.max(0, pausedUntil - Date.now()),
        ceiling,
        intervalMs: currentInterval(),
      }
    },
  }
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
