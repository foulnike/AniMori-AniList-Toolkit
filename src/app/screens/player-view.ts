// Данные экрана просмотра: карточка аниме, перебор источников, озвучки,
// серии и ссылки. За экраном остаётся разметка и само воспроизведение.
//
// О источниках здесь знают только то, что они есть в реестре: ни Aniliberty,
// ни Kodik по имени не упоминаются. Добавить третий источник = одна строка
// в api/video-sources.ts, и ни одной правки здесь.
//
// Ссылки не кэшируются нигде: у Kodik они живут часы, и отдавать
// протухшую вместо отказа хуже, чем спросить заново. А вот выбор человека —
// озвучка, серия, качество — живёт в player-keep и переживает закрытие окна.
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { fetchMediaCard, type MediaCard } from '@/api/anilist-media'
import { setupVideoSources } from '@/api/video-sources'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import {
  getVideoSource,
  isStreamFresh,
  listVideoSources,
  pickTrack,
  type VideoEpisode,
  type VideoRequest,
  type VideoSourceId,
  type VideoStream,
} from '@/core/video'
import { Logger } from '@/utils/logger'

import { goBack, navigate, peekPrevious } from '../router'

import { peekPick, rememberPick, whenWatchReady } from './player-keep'

/** Озвучка в выборке: источник и его ключ едут вместе с подписью. */
export interface VoiceRow {
  /** Ключ вида aniliberty:9000 — имена озвучек у источников пересекаются. */
  key: string
  sourceId: VideoSourceId
  sourceLabel: string
  voiceId: string
  label: string
  episodes: number
}

/** Кнопка качества. */
export interface QualityRow {
  height: number
  label: string
  on: boolean
}

/** Всё, что разметка плеера берёт готовым. */
export interface PlayerView {
  busy: Ref<boolean>
  trouble: Ref<string>
  mainTitle: ComputedRef<string>
  cover: ComputedRef<string | null>
  voices: Ref<VoiceRow[]>
  voiceKey: Ref<string>
  episodes: Ref<VideoEpisode[]>
  episode: Ref<number>
  stream: Ref<VideoStream | null>
  height: Ref<number>
  qualities: ComputedRef<QualityRow[]>
  current: ComputedRef<VideoEpisode | null>
  sourceLabel: ComputedRef<string>
  hasNext: ComputedRef<boolean>
  load: () => Promise<void>
  pickVoice: (key: string) => void
  pickEpisode: (number: number) => void
  pickHeight: (height: number) => void
  nextEpisode: () => void
  refresh: () => void
  openCard: () => void
}

/** Начальное качество: выше 720 без спроса не берём — канал бывает узким. */
const DEFAULT_HEIGHT = 720

/** Строка серии для полки и заголовка. */
export function episodeLabel(item: VideoEpisode): string {
  const name = item.title?.trim() ?? ''
  return name === '' ? `Серия ${item.number}` : `${item.number}. ${name}`
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Собирает состояние просмотра вокруг номера аниме из адреса.
 * Номер показа гасит ответы, пришедшие уже к другому выбору.
 */
export function usePlayer(mediaId: Ref<number>): PlayerView {
  const card = ref<MediaCard | null>(null)
  const busy = ref(true)
  const trouble = ref('')
  const voices = ref<VoiceRow[]>([])
  const voiceKey = ref('')
  const episodes = ref<VideoEpisode[]>([])
  const episode = ref(0)
  const stream = ref<VideoStream | null>(null)
  const height = ref(DEFAULT_HEIGHT)

  /** Счётчик добора русского имени: без него заголовок не пересчитается. */
  const nameStamp = ref(0)

  /** Номер показа: ответ на прошлый выбор пришёл не вовремя. */
  let run = 0

  const mainTitle = computed<string>(() => {
    void nameStamp.value
    return (
      peekRussianName(mediaId.value) ??
      card.value?.romaji ??
      card.value?.english ??
      `Аниме #${mediaId.value}`
    )
  })

  const cover = computed<string | null>(() => card.value?.cover ?? null)

  const current = computed<VideoEpisode | null>(
    () => episodes.value.find((e) => e.number === episode.value) ?? null,
  )

  const sourceLabel = computed<string>(
    () => voices.value.find((v) => v.key === voiceKey.value)?.sourceLabel ?? '',
  )

  const hasNext = computed<boolean>(() => episodes.value.some((e) => e.number > episode.value))

  const qualities = computed<QualityRow[]>(() => {
    const tracks = stream.value?.tracks ?? []
    return tracks.map((track) => ({
      height: track.height,
      label: `${track.height}p`,
      on: track.url === (stream.value?.preferred.url ?? ''),
    }))
  })

  /** Что известно об аниме до обращения к источникам. */
  function request(): VideoRequest | null {
    const found = card.value
    if (found === null) return null

    const titles = [found.romaji, found.english, found.native, peekRussianName(found.mediaId)]

    return {
      anilistId: found.mediaId,
      malId: found.malId,
      // У аниме номер Шикимори равен номеру MAL — на этом держатся и наши ссылки.
      shikimoriId: found.malId,
      titles: titles.filter((t): t is string => typeof t === 'string' && t.trim() !== ''),
      year: found.seasonYear ?? undefined,
      episodesTotal: found.episodes ?? undefined,
    }
  }

  /** Ссылки на выбранную серию. Запрашиваются в последний момент. */
  async function resolve(mine: number): Promise<void> {
    const req = request()
    const row = voices.value.find((v) => v.key === voiceKey.value)
    if (req === null || !row || episode.value === 0) return

    const source = getVideoSource(row.sourceId)
    if (source === null) return

    stream.value = null

    try {
      const found = await source.resolve(req, row.voiceId, episode.value)
      if (mine !== run) return

      if (found === null) {
        trouble.value = 'Источник не дал ссылку на эту серию. Попробуйте другую озвучку.'
        return
      }

      // Протухшая ссылка до плеера не дойдёт: чёрный экран хуже отказа.
      if (!isStreamFresh(found)) {
        Logger('WARN', `Плеер: источник ${row.sourceId} отдал ссылку на исходе срока`)
        trouble.value = 'Ссылка источника успела устареть. Нажмите «Переспросить».'
        return
      }

      const track = pickTrack(found.tracks, height.value)
      stream.value = track === null ? found : { ...found, preferred: track }
      trouble.value = ''
    } catch (e) {
      if (mine !== run) return
      trouble.value = describe(e)
    }
  }

  /** Серии выбранной озвучки, затем ссылки на нужную из них. */
  async function openVoice(mine: number, wanted: number): Promise<void> {
    const req = request()
    const row = voices.value.find((v) => v.key === voiceKey.value)
    if (req === null || !row) return

    const source = getVideoSource(row.sourceId)
    if (source === null) return

    episodes.value = []
    episode.value = 0
    stream.value = null

    try {
      const list = await source.listEpisodes(req, row.voiceId)
      if (mine !== run) return

      episodes.value = [...list].sort((a, b) => a.number - b.number)
      if (episodes.value.length === 0) {
        trouble.value = 'У этой озвучки нет ни одной готовой серии.'
        return
      }

      const has = episodes.value.some((e) => e.number === wanted)
      episode.value = has ? wanted : (episodes.value[0]?.number ?? 0)
      remember()

      await resolve(mine)
    } catch (e) {
      if (mine !== run) return
      trouble.value = describe(e)
    }
  }

  /** Спрашивает все источники разом: медленный не держит быстрого. */
  async function askSources(mine: number, req: VideoRequest): Promise<VoiceRow[]> {
    setupVideoSources()

    const packs = await Promise.all(
      listVideoSources().map(async (source) => {
        try {
          const list = await source.listVoices(req)
          return list.map((voice) => ({
            key: `${source.id}:${voice.id}`,
            sourceId: source.id,
            sourceLabel: source.label,
            voiceId: voice.id,
            label: voice.label,
            episodes: voice.episodes,
          }))
        } catch (e) {
          // Отказ одного источника не повод оставлять человека без остальных.
          Logger('WARN', `Плеер: источник ${source.id} не ответил`, e)
          return []
        }
      }),
    )

    return mine === run ? packs.flat() : []
  }

  function remember(): void {
    rememberPick(mediaId.value, voiceKey.value, episode.value, height.value)
  }

  /** Полный заход: карточка, источники, серии, ссылки. */
  async function load(): Promise<void> {
    const mine = ++run
    const id = mediaId.value

    card.value = null
    voices.value = []
    voiceKey.value = ''
    episodes.value = []
    episode.value = 0
    stream.value = null
    trouble.value = ''

    if (id === 0) {
      busy.value = false
      return
    }

    busy.value = true

    // Имя фоном: заголовка ждать некогда, первый кадр важнее.
    void prefetchRussianNames([id])
      .then(() => {
        if (mine === run) nameStamp.value += 1
      })
      .catch((e: unknown) => {
        Logger('WARN', `Плеер ${id}: фоновое имя не добралось`, e)
      })

    try {
      const found = await fetchMediaCard(id)
      if (mine !== run) return

      if (!found) {
        trouble.value = 'Сервер не отдал это аниме. Попробуйте позже.'
        return
      }

      card.value = found

      const req = request()
      if (req === null) return

      const rows = await askSources(mine, req)
      if (mine !== run) return

      voices.value = rows
      if (rows.length === 0) {
        trouble.value = 'Ни один источник не знает этого аниме.'
        return
      }

      // Прошлый выбор главнее первой строки выборки. Ждём хранилище здесь,
      // а не на входе: к этой строке оно давно ответило пока шла сеть.
      await whenWatchReady()
      if (mine !== run) return

      const seen = peekPick(id)
      const kept = rows.find((r) => r.key === seen?.voiceKey)
      voiceKey.value = kept?.key ?? rows[0]?.key ?? ''
      if (seen !== null && seen.height > 0) height.value = seen.height

      await openVoice(mine, seen?.episode ?? 1)
    } catch (e) {
      if (mine !== run) return
      trouble.value = describe(e)
    } finally {
      if (mine === run) busy.value = false
    }
  }

  function pickVoice(key: string): void {
    if (key === voiceKey.value) return

    voiceKey.value = key
    trouble.value = ''
    remember()

    // Номер серии сохраняется: смена озвучки посреди сезона — дело частое.
    void openVoice(++run, episode.value === 0 ? 1 : episode.value)
  }

  function pickEpisode(number: number): void {
    if (number === episode.value) return

    episode.value = number
    trouble.value = ''
    remember()
    void resolve(++run)
  }

  function pickHeight(next: number): void {
    height.value = next
    remember()

    const found = stream.value
    if (found === null) return

    // Спрашивать источник заново незачем: все дорожки уже в руках.
    const track = pickTrack(found.tracks, next)
    if (track !== null) stream.value = { ...found, preferred: track }
  }

  function nextEpisode(): void {
    const next = episodes.value.find((e) => e.number > episode.value)
    if (next) pickEpisode(next.number)
  }

  /** Переспросить ссылки: цепочка могла рассыпаться, а срок — выйти. */
  function refresh(): void {
    trouble.value = ''
    void resolve(++run)
  }

  /**
   * Уход на карточку аниме.
   *
   * Пришли с неё — делаем шаг назад, а не шаг вперёд на тот же адрес:
   * иначе в истории копится «карточка → плеер → карточка», и кнопка «назад»
   * возвращает в плеер, из которого только что вышли.
   *
   * Пришли иначе (ссылка, продолжение с главной) — меняем запись плеера
   * на карточку: плеер — конечная точка, и возвращаться в него кнопкой
   * «назад» человек не просит.
   */
  function openCard(): void {
    const id = mediaId.value
    if (id === 0) return

    const back = peekPrevious()
    if (back !== null && back.name === 'media' && back.params.id === String(id)) {
      goBack()
      return
    }

    navigate('media', { id: String(id) }, { replace: true })
  }

  return {
    busy,
    trouble,
    mainTitle,
    cover,
    voices,
    voiceKey,
    episodes,
    episode,
    stream,
    height,
    qualities,
    current,
    sourceLabel,
    hasNext,
    load,
    pickVoice,
    pickEpisode,
    pickHeight,
    nextEpisode,
    refresh,
    openCard,
  }
}
