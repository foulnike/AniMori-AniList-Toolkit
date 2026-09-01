// Общий слой источников видео. Экран плеера знает только этот файл: чем бы ни был
// источник — открытым API Aniliberty или расшифрованной цепочкой Kodik, — наружу
// он отдаёт одно и то же: озвучки, эпизоды, дорожки качества и срок годности ссылок.
//
// Сети здесь нет ни строки: только типы, реестр и проверка срока. Резолверы живут
// в api/ и складываются в реестр там же: иначе ядро знало бы своих потребителей,
// а зависимости в проекте направлены наоборот: api знает core.

import { Logger } from '../utils/logger'

/** Имя источника: ключ реестра, подпись в журнале и значение в настройках. */
export type VideoSourceId = 'aniliberty' | 'kodik'

/** Одно качество одного эпизода. */
export interface VideoTrack {
  /** Высота кадра: 480, 720, 1080. И ключ выбора, и подпись кнопки. */
  height: number
  /** Прямой адрес манифеста HLS. */
  url: string
}

/** Отрезок, который человек вправе пропустить одним нажатием. */
export interface VideoSkip {
  startSec: number
  stopSec: number
}

/** Эпизод в том виде, в каком его знает источник. */
export interface VideoEpisode {
  /** Номер эпизода у источника. Нумерация чужая: бывают дубли и пропуски. */
  number: number
  title?: string
  durationSec?: number
  /** Заставка и титры, если источник их знает. Кнопку пропуска рисует экран. */
  opening?: VideoSkip
  ending?: VideoSkip
}

/** Озвучка: у Aniliberty она одна, у Kodik их пять и больше. */
export interface VideoVoice {
  /** Ключ источника, а не наш: он же уедет обратно в listEpisodes и resolve. */
  id: string
  label: string
  /** Сколько серий озвучено. Ноль читается как «источник не сказал». */
  episodes: number
}

/** Готовый к воспроизведению эпизод. */
export interface VideoStream {
  source: VideoSourceId
  /** Дорожки по убыванию высоты кадра. Пустым список не бывает. */
  tracks: VideoTrack[]
  /** С какой дорожки начинать. Всегда одна из tracks. */
  preferred: VideoTrack
  /**
   * Момент, после которого адреса протухают, в миллисекундах эпохи.
   * null — источник срока не сообщает и переспрашивать ссылку незачем.
   */
  expiresAt: number | null
}

/**
 * Что известно о тайтле до обращения к источнику. Номера идут все сразу: у Kodik
 * вход по номеру Шикимори, а у Aniliberty чужих номеров нет вовсе и остаются
 * названия — поэтому и они здесь.
 */
export interface VideoRequest {
  anilistId: number
  malId: number | null
  shikimoriId: number | null
  /** Названия по убыванию пригодности для поиска: романдзи, английское, русское. */
  titles: string[]
  year?: number
  episodesTotal?: number
}

/**
 * Источник видео. Три шага раздельны намеренно: список озвучек показывается
 * человеку, список эпизодов рисует полку, а ссылки берутся в последний момент и
 * в кэш не кладутся: у Kodik они живут считанные часы.
 */
export interface VideoSource {
  readonly id: VideoSourceId
  readonly label: string
  /** Пустой список означает честное «этого тайтла у источника нет». */
  listVoices(req: VideoRequest): Promise<VideoVoice[]>
  listEpisodes(req: VideoRequest, voiceId: string): Promise<VideoEpisode[]>
  /** null — эпизода нет или цепочка не прошла. Причину в журнал пишет резолвер. */
  resolve(req: VideoRequest, voiceId: string, episode: number): Promise<VideoStream | null>
}

const sources = new Map<VideoSourceId, VideoSource>()

/** Кладёт источник в реестр. Повтор — не отказ, а замена с записью в журнал. */
export function registerVideoSource(source: VideoSource): void {
  if (sources.has(source.id)) {
    Logger('WARN', `Источник видео ${source.id} зарегистрирован повторно, беру последний`)
  }
  sources.set(source.id, source)
}

/** Все источники в порядке добавления: он же порядок перебора при отказе. */
export function listVideoSources(): VideoSource[] {
  return [...sources.values()]
}

export function getVideoSource(id: VideoSourceId): VideoSource | null {
  return sources.get(id) ?? null
}

/** Только для проверок: реестр общий на весь запуск и сам себя не чистит. */
export function forgetVideoSources(): void {
  sources.clear()
}

/** Запас перед сроком: минута на цепочку и минута на первый буфер. */
export const STREAM_MARGIN_MS = 120000

/**
 * Годится ли поток к запуску прямо сейчас. Ссылка без срока годна всегда,
 * со сроком — пока до него больше запаса: промах означает чёрный экран
 * на первой же секунде вместо внятного отказа.
 */
export function isStreamFresh(stream: VideoStream, now = Date.now()): boolean {
  if (stream.expiresAt === null) return true
  return stream.expiresAt - now > STREAM_MARGIN_MS
}

/** Дорожка нужной высоты или ближайшая снизу, а если таких нет — самая мелкая. */
export function pickTrack(tracks: VideoTrack[], height: number): VideoTrack | null {
  const sorted = [...tracks].sort((a, b) => b.height - a.height)
  const fits = sorted.find((t) => t.height <= height)
  return fits ?? sorted.at(-1) ?? null
}
