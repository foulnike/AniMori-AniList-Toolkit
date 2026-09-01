<script setup lang="ts">
// Пункт 4.2: экран просмотра. Номер тайтла из адреса, всё остальное —
// из player-view.ts. Здесь разметка, своя панель и связь с тегом <video>.
//
// Родных элементов управления нет намеренно: полоса WebView2 не красится
// темой и не проходится пультом. Своя умеет и то и другое, а заодно показывает
// край буфера. Клавиши и пульт разбирает player-input.ts.
//
// Полный экран собран из трёх шагов, и каждый закрывает свою дыру. Театр
// переезжает в body: внутри рамки приложения он оставался в чужих контекстах
// наложения, и рельс, шапка и подложка окна просвечивали сквозь кадр. Кадр
// просит родной полный экран: его верхний слой не перекрыть ничем со страницы,
// включая наши подсказки из body и окошко человека. Окно оболочки уходит
// в полный экран через мост: родной растягивает кадр на окно, а не на монитор.
// Раньше был только третий шаг.
//
// Ссылка меняется в трёх случаях: другая серия, другая озвучка, другое
// качество. Первые два начинают с запомненного места, третий — с текущей
// секунды: иначе переключение на 480p выглядело бы как потеря просмотра.
import {
  computed,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type FunctionalComponent,
} from 'vue'

import { Logger } from '@/utils/logger'

import { currentRoute } from '../router'

import { attachPlayback, type Playback } from './player-hls'
import {
  CALM_DELAY_MS,
  JUMP_SEC,
  STEP_SEC,
  VOLUME_STEP,
  moveFocus,
  type PlayerIntent,
  peekVolume,
  readIntent,
  rememberVolume,
  toggleWindowFullscreen,
} from './player-input'
import { episodeLabel, peekSpot, rememberSpot, spotKey, usePlayer } from './player-view'

/**
 * Знак кнопки — рисунок в квадрате 24×24, а не символ шрифта.
 *
 * Символами панель и была: ▶, ❚❚, ↺, ⤢, ♪. У каждого своя ширина и свой наплыв
 * над базовой линией, оттого знаки и стояли в кнопках вкривь, каждый по-своему.
 * Рисунок занимает квадрат целиком и центрируется сеткой кнопки.
 *
 * Два пути вместо одного: d — залитая фигура, line — обводка. Половина знаков
 * состоит из обоих сразу: у звука залитый рупор и обведённые волны.
 */
const Icon: FunctionalComponent<{ d?: string; line?: string }> = (props) =>
  h('svg', { class: 'am-play__ico', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
    props.d === undefined ? null : h('path', { d: props.d, fill: 'currentColor' }),
    props.line === undefined
      ? null
      : h('path', {
          d: props.line,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': '2',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
  ])

/** Залитые знаки. Все нарисованы симметрично относительно центра квадрата. */
const SIGN = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  prev: 'M6 6h2.4v12H6zm12 0v12l-8.6-6z',
  next: 'M15.6 6H18v12h-2.4zM6 6l8.6 6L6 18z',
  rewind: 'M11.4 6v12L3 12zm9.6 0v12l-8.4-6z',
  ahead: 'M3 6l8.4 6L3 18zm9.6 0 8.4 6-8.4 6z',
  sound: 'M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z',
  againHead: 'M12 1.2l3.4 2.8L12 6.8z',
} as const

/** Обведённые знаки: тонкие фигуры заливкой читаются пятном. */
const LINE = {
  waves: 'M15.2 9.2a4 4 0 0 1 0 5.6M18 6.8a7.6 7.6 0 0 1 0 10.4',
  cross: 'M15.6 9.6l4.8 4.8m0-4.8-4.8 4.8',
  full: 'M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5',
  small: 'M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5',
  again: 'M20 12a8 8 0 1 1-8-8',
  tick: 'M5 12.5l4.5 4.5L19 7.5',
  rows: 'M4 7h16M4 12h16M4 17h10',
  left: 'M15 5l-7 7 7 7',
} as const

/** Кнопка панели: подпись, знак и что делать. Разметка из этого списка одна. */
interface Key {
  tip: string
  sign?: string
  line?: string
  main?: boolean
  off?: boolean
  run: () => void
}

const videoEl = ref<HTMLVideoElement | null>(null)
const rootEl = ref<HTMLElement | null>(null)

/** Где мы сейчас по времени: число меняется раз в секунду, не чаще. */
const at = ref(0)

/** Длина серии и край буфера: от них рисуются обе полосы. */
const total = ref(0)
const ready = ref(0)

const playing = ref(false)
const volume = ref(peekVolume())
const muted = ref(false)

/** Кадр во весь экран: театр, верхний слой окна и полный экран оболочки. */
const wide = ref(false)

/** Панель уехала: несколько секунд тишины и только во время игры. */
const calm = ref(false)

/** Указатель на панели: пока он там, тишина не считается. */
const deckHot = ref(false)

/** Открыт выбор качества. */
const pickOpen = ref(false)

/** Открыт ящик со списками: в театре они прячутся до нажатия. */
const listOpen = ref(false)

/** Кадр встал посреди серии: сеть не поспевает, но ошибки ещё нет. */
const stalled = ref(false)

/** Доля полосы под указателем, -1 — указателя на ней нет. */
const hoverShare = ref(-1)

const mediaId = computed<number>(() => {
  const raw = Number(currentRoute.value.params.id ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
})

const {
  busy,
  trouble,
  mainTitle,
  cover,
  voices,
  voiceKey,
  episodes,
  episode,
  stream,
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
} = usePlayer(mediaId)

/** Связь с hls.js живёт всю жизнь экрана: буферы тяжёлые. */
let playback: Playback | null = null

/** Ключ места остановки того, что сейчас открыто. */
let spot = ''

/** Таймер тишины, после которого панель уезжает с кадра. */
let calmTimer = 0

/** Полный экран окна: мост умеет только переключать, поэтому помним сами. */
let windowWide = false

const voiceLabel = computed<string>(
  () => voices.value.find((v) => v.key === voiceKey.value)?.label ?? '',
)

/** Подзаголовок: источник, озвучка и серия одной строкой. */
const subLine = computed<string>(() => {
  const parts = [sourceLabel.value, voiceLabel.value]
  const ep = current.value
  if (ep !== null) parts.push(episodeLabel(ep))
  return parts.filter((p) => p !== '').join(' · ')
})

const coverStyle = computed<{ backgroundImage: string }>(() => ({
  backgroundImage: cover.value === null ? 'none' : `url("${cover.value}")`,
}))

/** Заслонка нужна, пока кадра нет: чёрный прямоугольник ничего не говорит. */
const veil = computed<boolean>(() => busy.value || trouble.value !== '' || stream.value === null)

const veilWord = computed<string>(() => {
  if (trouble.value !== '') return trouble.value
  if (busy.value) return 'Ищу источники…'
  return stream.value === null ? 'Серия не выбрана.' : ''
})

/** Подпись кнопки качества: то, что играет сейчас. */
const qualityNow = computed<string>(
  () => qualities.value.find((quality) => quality.on)?.label ?? 'Качество',
)

/** Кнопка пропуска: показывается только внутри своего отрезка. */
const skip = computed<{ label: string; to: number } | null>(() => {
  const ep = current.value
  if (ep === null) return null

  const now = at.value
  const opening = ep.opening
  if (opening && now >= opening.startSec && now < opening.stopSec - 1) {
    return { label: 'Пропустить заставку', to: opening.stopSec }
  }

  const ending = ep.ending
  if (ending && now >= ending.startSec && now < ending.stopSec - 1) {
    return { label: 'Пропустить титры', to: ending.stopSec }
  }

  return null
})

/** Предыдущая серия — ближайшая снизу, а не номер минус один: бывают дыры. */
const prevNumber = computed<number>(() => {
  const below = episodes.value.filter((row) => row.number < episode.value)
  return below.length === 0 ? 0 : (below[below.length - 1]?.number ?? 0)
})

/** Целые секунды для подписей доступности: дроби читалке ни к чему. */
const totalWhole = computed<number>(() => Math.round(total.value))

function shareOf(seconds: number): number {
  if (total.value <= 0) return 0
  return Math.min(100, Math.max(0, (seconds / total.value) * 100))
}

const shareAt = computed<number>(() => shareOf(at.value))
const shareReady = computed<number>(() => shareOf(ready.value))
const volumeShare = computed<number>(() => (muted.value ? 0 : volume.value * 100))

/** Громкость и звук ставим на тег сами: своя панель — свой источник правды. */
function applySound(): void {
  const el = videoEl.value
  if (el === null) return

  el.volume = volume.value
  el.muted = muted.value
}

function setVolume(next: number): void {
  const value = Math.min(1, Math.max(0, Math.round(next * 100) / 100))
  volume.value = value
  muted.value = value === 0
  rememberVolume(value)
  applySound()
}

function toggleMute(): void {
  muted.value = !muted.value

  // Снять глушение при нулевой громкости нечем: поднимаем на один шаг.
  if (!muted.value && volume.value === 0) {
    setVolume(VOLUME_STEP)
    return
  }

  applySound()
}

/** Время в кадре: 7:05 и 1:07:05. Часы появляются, только когда они есть. */
function clockText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = String(Math.floor((whole % 3600) / 60))
  const rest = String(whole % 60).padStart(2, '0')

  return hours > 0 ? `${hours}:${minutes.padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** Время под указателем на полосе: подпись всплывает над ним. */
const hoverText = computed<string>(() => clockText((hoverShare.value / 100) * total.value))

/** Длительность серии короткой строкой; неизвестная не выдумывается. */
function timeText(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return ''
  return `${Math.round(seconds / 60)} мин`
}

/** Открывает манифест. Та же серия — продолжаем с текущей секунды. */
function start(url: string): void {
  const el = videoEl.value
  if (el === null || playback === null) return

  const key = spotKey(mediaId.value, voiceKey.value, episode.value)
  const from = key === spot ? el.currentTime : peekSpot(key)
  spot = key
  playback.open(url, from)
}

/** Край буфера вокруг текущей секунды: остальные куски полосе неинтересны. */
function onProgress(): void {
  const el = videoEl.value
  if (el === null) return

  const now = el.currentTime
  for (let i = 0; i < el.buffered.length; i += 1) {
    if (el.buffered.start(i) <= now && now <= el.buffered.end(i)) {
      ready.value = el.buffered.end(i)
      return
    }
  }

  ready.value = now
}

function onTime(): void {
  const el = videoEl.value
  if (el === null) return

  const now = Math.floor(el.currentTime)
  if (now === at.value) return

  at.value = now
  onProgress()
  if (spot !== '') rememberSpot(spot, now)
}

/** Длина у HLS приезжает позже кадра, и бесконечность тоже бывает. */
function onMeta(): void {
  const el = videoEl.value
  if (el === null) return

  total.value = Number.isFinite(el.duration) ? el.duration : 0
  applySound()
}

/** Конец серии: следующая сама. Смотренное забывается: оно пройдено. */
function onEnded(): void {
  if (spot !== '') rememberSpot(spot, 0)
  if (hasNext.value) nextEpisode()
}

function onPlay(): void {
  playing.value = true
  stalled.value = false
  wake()
}

function onPause(): void {
  playing.value = false
  calm.value = false
}

/**
 * Кадр встал посреди серии. Своё колесо здесь обязательно: без него встают
 * и кадр, и панель, и человеку кажется, что приложение умерло.
 */
function onWaiting(): void {
  stalled.value = true
}

function onRolling(): void {
  stalled.value = false
}

function doToggle(): void {
  const el = videoEl.value
  if (el === null || stream.value === null) return

  wake()

  if (!el.paused) {
    el.pause()
    return
  }

  void el.play().catch((e: unknown) => {
    Logger('WARN', 'Плеер: запуск не случился', e)
  })
}

/** Перемотка от текущего места, не вылезая за края серии. */
function nudge(delta: number): void {
  const el = videoEl.value
  if (el === null) return

  const edge = total.value > 0 ? total.value - 0.5 : el.currentTime + Math.abs(delta)
  el.currentTime = Math.min(edge, Math.max(0, el.currentTime + delta))
  at.value = Math.floor(el.currentTime)
  wake()
}

/** Прыжок на долю серии: так говорит полоса, когда её тянут мышью. */
function seekShare(share: number): void {
  const el = videoEl.value
  if (el === null || total.value <= 0) return

  el.currentTime = Math.min(total.value - 0.5, Math.max(0, share * total.value))
  at.value = Math.floor(el.currentTime)
}

function doSkip(): void {
  const el = videoEl.value
  const jump = skip.value
  if (el === null || jump === null) return

  el.currentTime = jump.to
  wake()
}

function doPrev(): void {
  if (prevNumber.value > 0) pickEpisode(prevNumber.value)
}

/** Выбор качества закрывает список сам: меню, которое надо гасить, раздражает. */
function takeHeight(height: number): void {
  pickOpen.value = false
  pickHeight(height)
}

/** Доля ширины, на которую пришёлся указатель. */
function shareOfPointer(event: PointerEvent): number {
  const line = event.currentTarget
  if (!(line instanceof HTMLElement)) return 0

  const box = line.getBoundingClientRect()
  if (box.width <= 0) return 0

  return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
}

function onLineDown(event: PointerEvent): void {
  const line = event.currentTarget
  if (line instanceof HTMLElement) line.setPointerCapture(event.pointerId)

  wake()
  seekShare(shareOfPointer(event))
}

/**
 * Пролёт мыши над полосой показывает время под указателем, нажатая кнопка —
 * ещё и перематывает. Одно событие на оба дела: врозь они считали бы одну
 * и ту же долю дважды за движение.
 */
function onLineMove(event: PointerEvent): void {
  const share = shareOfPointer(event)
  hoverShare.value = share * 100

  if (event.buttons === 0) return

  wake()
  seekShare(share)
}

function onLineOut(): void {
  hoverShare.value = -1
}

/**
 * Полоса времени забирает стрелки вдоль себя: пока фокус на ней, влево и вправо
 * перематывают, а уйти с неё можно вверх и вниз.
 */
function onLineKey(event: KeyboardEvent): void {
  const key = event.key
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return

  event.preventDefault()
  event.stopPropagation()

  const step = key === 'ArrowLeft' ? -1 : 1
  nudge(step * (event.shiftKey ? JUMP_SEC : STEP_SEC))
}

function onVolumeDown(event: PointerEvent): void {
  const line = event.currentTarget
  if (line instanceof HTMLElement) line.setPointerCapture(event.pointerId)

  wake()
  setVolume(shareOfPointer(event))
}

function onVolumeMove(event: PointerEvent): void {
  if (event.buttons === 0) return

  wake()
  setVolume(shareOfPointer(event))
}

function onVolumeKey(event: KeyboardEvent): void {
  const key = event.key
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return

  event.preventDefault()
  event.stopPropagation()
  wake()
  setVolume(volume.value + (key === 'ArrowLeft' ? -VOLUME_STEP : VOLUME_STEP))
}

/** Любой ввод возвращает панель и заново заводит отсчёт тишины. */
function wake(): void {
  calm.value = false
  if (calmTimer !== 0) window.clearTimeout(calmTimer)
  calmTimer = window.setTimeout(sleep, CALM_DELAY_MS)
}

/**
 * Панель уезжает только во время игры и только когда её никто не держит:
 * на паузе она нужна на месте, под указателем — тем более, а с открытым
 * списком уехала бы вместе с ним прямо из-под руки.
 */
function sleep(): void {
  calmTimer = 0
  if (!playing.value || veil.value) return
  if (deckHot.value || pickOpen.value || listOpen.value) return

  calm.value = true

  // Фокус не остаётся на спрятанной кнопке: уйти с неё пультом уже нельзя.
  const here = document.activeElement
  if (here instanceof HTMLElement && here.closest('.am-play__deck') !== null) here.blur()
}

/**
 * Родной полный экран. Просим его у театра, а не у тега <video>: у тега вместе
 * с кадром уехала бы наша панель, а WebView2 нарисовал бы поверх свою —
 * некрашеную и непроходимую пультом.
 */
async function wantNativeWide(next: boolean): Promise<void> {
  const root = rootEl.value

  try {
    if (next) {
      if (root !== null && document.fullscreenElement === null) await root.requestFullscreen()
      return
    }

    if (document.fullscreenElement !== null) await document.exitFullscreen()
  } catch (e) {
    Logger('WARN', 'Плеер: окно не дало родной полный экран', e)
  }
}

/** Полный экран окна оболочки. Мост умеет переключать, поэтому спрашиваем себя. */
async function wantWindowWide(next: boolean): Promise<void> {
  if (windowWide === next) return
  windowWide = await toggleWindowFullscreen()
}

/**
 * Три шага в одном. Порядок обязателен: сначала Vue переносит узел в body,
 * и только потом этот узел просит верхний слой — перенос уже поднятого узла
 * его сбрасывает.
 */
async function setWide(next: boolean): Promise<void> {
  wide.value = next
  wake()

  if (!next) {
    listOpen.value = false
    pickOpen.value = false
  }

  await nextTick()
  await wantNativeWide(next)
  await wantWindowWide(next)
}

function doFullscreen(): void {
  void setWide(!wide.value)
}

/**
 * Родной полный экран гасится и мимо наших кнопок: Esc, F11, кнопка окна.
 * Без этого слушателя окно оставалось развёрнутым, а рамка приложения
 * возвращалась в кадр поверх видео.
 */
function onNativeChange(): void {
  const on = document.fullscreenElement !== null
  if (on === wide.value) return

  wide.value = on
  if (!on) {
    listOpen.value = false
    pickOpen.value = false
  }

  wake()
  void wantWindowWide(on)
}

/** Нажатие мимо списка качеств закрывает его: так ведёт себя любое меню. */
function onDown(event: PointerEvent): void {
  if (!pickOpen.value) return

  const aim = event.target
  if (aim instanceof Element && aim.closest('.am-play__pick') !== null) return

  pickOpen.value = false
}

/** «Назад»: сначала закрываем открытое, потом театр и только потом экран. */
function doExit(): void {
  if (pickOpen.value || listOpen.value) {
    pickOpen.value = false
    listOpen.value = false
    return
  }

  if (wide.value) {
    void setWide(false)
    return
  }

  openCard()
}

/** Левый кластер: серии, перемотка и пуск. Порядок тот же, что у всех плееров. */
const leftKeys = computed<Key[]>(() => [
  { tip: 'Предыдущая серия', sign: SIGN.prev, off: prevNumber.value === 0, run: doPrev },
  { tip: 'Назад 10 секунд', sign: SIGN.rewind, run: () => nudge(-STEP_SEC) },
  {
    tip: playing.value ? 'Пауза' : 'Смотреть',
    sign: playing.value ? SIGN.pause : SIGN.play,
    main: true,
    run: doToggle,
  },
  { tip: 'Вперёд 10 секунд', sign: SIGN.ahead, run: () => nudge(STEP_SEC) },
  { tip: 'Следующая серия', sign: SIGN.next, off: !hasNext.value, run: nextEpisode },
])

/** Правый кластер: ссылка и полный экран. Полный экран всегда последний. */
const rightKeys = computed<Key[]>(() => [
  { tip: 'Взять ссылку заново', sign: SIGN.againHead, line: LINE.again, run: refresh },
  {
    tip: wide.value ? 'Свернуть кадр' : 'Во весь экран',
    line: wide.value ? LINE.small : LINE.full,
    run: doFullscreen,
  },
])

/** Одно место, где желание превращается в действие. */
function act(intent: PlayerIntent): void {
  switch (intent) {
    case 'toggle':
      doToggle()
      return
    case 'seekBack':
      nudge(-STEP_SEC)
      return
    case 'seekAhead':
      nudge(STEP_SEC)
      return
    case 'jumpBack':
      nudge(-JUMP_SEC)
      return
    case 'jumpAhead':
      nudge(JUMP_SEC)
      return
    case 'louder':
      setVolume(volume.value + VOLUME_STEP)
      return
    case 'quieter':
      setVolume(volume.value - VOLUME_STEP)
      return
    case 'mute':
      toggleMute()
      return
    case 'prevEpisode':
      doPrev()
      return
    case 'nextEpisode':
      if (hasNext.value) nextEpisode()
      return
    case 'skip':
      doSkip()
      return
    case 'fullscreen':
      doFullscreen()
      return
    case 'exit':
      doExit()
      return
    default:
      // Стрелки сюда не доходят: их разбирает moveFocus.
      return
  }
}

/** Клавиатура и пульт: слушаем окно, потому что фокус бывает нигде. */
function onKey(event: KeyboardEvent): void {
  if (mediaId.value === 0) return

  const here = document.activeElement
  const inList = here instanceof HTMLElement && here.closest('[data-zone]') !== null
  const intent = readIntent(event, inList)
  if (intent === null) return

  event.preventDefault()
  wake()

  if (intent.startsWith('focus')) {
    const root = rootEl.value
    if (root !== null) moveFocus(root, intent)
    return
  }

  act(intent)
}

onMounted(() => {
  const el = videoEl.value
  if (el !== null) {
    playback = attachPlayback(el, {
      onFatal: (text) => {
        trouble.value = text
      },
    })
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('ended', onEnded)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('progress', onProgress)
    el.addEventListener('waiting', onWaiting)
    el.addEventListener('playing', onRolling)
    el.addEventListener('seeked', onRolling)
    applySound()
  }

  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onDown)
  document.addEventListener('fullscreenchange', onNativeChange)
  void load()
})

// Новый адрес — новый тайтл: экран не пересобирается, грузим сами.
watch(mediaId, () => {
  playback?.close()
  spot = ''
  at.value = 0
  total.value = 0
  ready.value = 0
  playing.value = false
  stalled.value = false
  void load()
})

watch(
  () => stream.value?.preferred.url ?? '',
  (url) => {
    if (url !== '') start(url)
  },
)

// Прокрутка страницы под театром: колесо мыши уводило бы её вслепую,
// и, выйдя из полного экрана, человек оказывался бы не там, где ушёл.
watch(wide, (on) => {
  document.body.style.overflow = on ? 'hidden' : ''
})

onBeforeUnmount(() => {
  const el = videoEl.value
  if (el !== null) {
    if (spot !== '') rememberSpot(spot, Math.floor(el.currentTime))
    el.removeEventListener('timeupdate', onTime)
    el.removeEventListener('ended', onEnded)
    el.removeEventListener('play', onPlay)
    el.removeEventListener('pause', onPause)
    el.removeEventListener('durationchange', onMeta)
    el.removeEventListener('progress', onProgress)
    el.removeEventListener('waiting', onWaiting)
    el.removeEventListener('playing', onRolling)
    el.removeEventListener('seeked', onRolling)
  }

  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onDown)
  document.removeEventListener('fullscreenchange', onNativeChange)
  if (calmTimer !== 0) window.clearTimeout(calmTimer)
  document.body.style.overflow = ''

  // Уходим с экрана — возвращаем окно: полный экран был нужен кадру, не спискам.
  void wantNativeWide(false)
  void wantWindowWide(false)

  playback?.close()
  playback = null
})
</script>

<template>
  <section class="am-page">
    <div v-if="mediaId === 0" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⊛</span>
      <span>Смотреть нечего: в адресе нет номера тайтла.</span>
      <span>Откройте карточку и нажмите «Смотреть».</span>
    </div>

    <!-- В театре узел уезжает в body: рамка приложения перестаёт быть его
         предком, и её стёкла со своими слоями в кадр больше не попадают. -->
    <Teleport to="body" :disabled="!wide">
      <div
        v-if="mediaId !== 0"
        ref="rootEl"
        class="am-play"
        :class="{ 'am-play--wide': wide, 'am-play--calm': calm }"
        @pointermove="wake"
      >
        <div class="am-play__main">
          <div class="am-play__head" data-zone="head">
            <button class="am-play__back" type="button" data-tip="Назад к карточке" @click="doExit">
              <Icon :line="LINE.left" />
              <span class="am-play__back-word">Карточка</span>
            </button>

            <div class="am-play__title">
              <h2 class="am-play__name">{{ mainTitle }}</h2>
              <p v-if="subLine" class="am-play__sub">{{ subLine }}</p>
            </div>
          </div>

          <div class="am-play__stage" @dblclick="doFullscreen">
            <video ref="videoEl" class="am-play__frame" playsinline preload="metadata"></video>

            <button
              v-if="!veil"
              class="am-play__tap"
              type="button"
              :aria-label="playing ? 'Пауза' : 'Смотреть'"
              @click="doToggle"
            ></button>

            <span v-if="!veil && !playing" class="am-play__hold" aria-hidden="true">
              <Icon :d="SIGN.play" />
            </span>

            <span v-if="!veil && playing && stalled" class="am-play__wait" aria-hidden="true" />

            <div v-if="veil" class="am-play__veil">
              <span v-if="cover" class="am-play__blur" :style="coverStyle" aria-hidden="true" />
              <span v-if="busy" class="am-play__spin" aria-hidden="true" />
              <p v-if="veilWord" class="am-play__word">{{ veilWord }}</p>
              <button v-if="trouble && !busy" class="am-play__act" type="button" @click="refresh">
                Переспросить
              </button>
            </div>

            <button v-if="skip && !veil" class="am-play__skip" type="button" @click="doSkip">
              {{ skip.label }}
            </button>

            <div
              v-show="!veil"
              class="am-play__deck"
              data-zone="bar"
              @pointerenter="deckHot = true"
              @pointerleave="deckHot = false"
            >
              <!-- Полоса времени своей строкой во всю ширину: в общем ряду
                   она сжималась до обрубка между кнопками. -->
              <div class="am-play__seek">
                <div
                  class="am-play__line"
                  tabindex="0"
                  role="slider"
                  aria-label="Время серии"
                  :aria-valuemin="0"
                  :aria-valuemax="totalWhole"
                  :aria-valuenow="at"
                  :aria-valuetext="clockText(at)"
                  @pointerdown="onLineDown"
                  @pointermove="onLineMove"
                  @pointerleave="onLineOut"
                  @keydown="onLineKey"
                  @keydown.space.prevent.stop="doToggle"
                  @keydown.enter.prevent.stop="doToggle"
                >
                  <span class="am-play__buf" :style="{ width: shareReady + '%' }" />
                  <span class="am-play__fill" :style="{ width: shareAt + '%' }" />
                  <span class="am-play__knob" :style="{ left: shareAt + '%' }" />
                </div>

                <span
                  v-if="hoverShare >= 0 && total > 0"
                  class="am-play__bubble"
                  :style="{ left: hoverShare + '%' }"
                  aria-hidden="true"
                  >{{ hoverText }}</span
                >
              </div>

              <div class="am-play__row">
                <div class="am-play__clip">
                  <button
                    v-for="key in leftKeys"
                    :key="key.tip"
                    class="am-play__key"
                    :class="{ 'am-play__key--main': key.main === true }"
                    type="button"
                    :data-tip="key.tip"
                    :aria-label="key.tip"
                    :disabled="key.off === true"
                    @click="key.run()"
                  >
                    <Icon :d="key.sign" :line="key.line" />
                  </button>

                  <!-- Ползунок громкости раскрывается по наведению: постоянная
                       полоса рядом с кнопкой звука занимала место молча. -->
                  <div class="am-play__sound">
                    <button
                      class="am-play__key"
                      type="button"
                      :data-tip="muted ? 'Включить звук' : 'Заглушить'"
                      :aria-label="muted ? 'Включить звук' : 'Заглушить'"
                      @click="toggleMute"
                    >
                      <Icon :d="SIGN.sound" :line="muted ? LINE.cross : LINE.waves" />
                    </button>

                    <div
                      class="am-play__vol"
                      tabindex="0"
                      role="slider"
                      aria-label="Громкость"
                      :aria-valuemin="0"
                      :aria-valuemax="100"
                      :aria-valuenow="volumeShare"
                      @pointerdown="onVolumeDown"
                      @pointermove="onVolumeMove"
                      @keydown="onVolumeKey"
                    >
                      <span class="am-play__vol-fill" :style="{ width: volumeShare + '%' }" />
                      <span class="am-play__vol-knob" :style="{ left: volumeShare + '%' }" />
                    </div>
                  </div>

                  <span class="am-play__clock">
                    {{ clockText(at) }}
                    <span class="am-play__clock-all">/ {{ clockText(total) }}</span>
                  </span>
                </div>

                <div class="am-play__clip am-play__clip--end">
                  <div v-if="qualities.length > 0" class="am-play__pick">
                    <ul v-if="pickOpen" class="am-play__menu">
                      <li v-for="quality in qualities" :key="quality.height">
                        <button
                          class="am-play__opt"
                          :class="{ 'am-play__opt--on': quality.on }"
                          type="button"
                          @click="takeHeight(quality.height)"
                        >
                          <span class="am-play__opt-tick">
                            <Icon v-if="quality.on" :line="LINE.tick" />
                          </span>
                          <span>{{ quality.label }}</span>
                        </button>
                      </li>
                    </ul>

                    <button
                      class="am-play__key am-play__key--word"
                      type="button"
                      data-tip="Качество"
                      :aria-expanded="pickOpen"
                      @click="pickOpen = !pickOpen"
                    >
                      {{ qualityNow }}
                    </button>
                  </div>

                  <button
                    v-if="wide"
                    class="am-play__key"
                    :class="{ 'am-play__key--on': listOpen }"
                    type="button"
                    data-tip="Серии и озвучки"
                    aria-label="Серии и озвучки"
                    :aria-pressed="listOpen"
                    @click="listOpen = !listOpen"
                  >
                    <Icon :line="LINE.rows" />
                  </button>

                  <button
                    v-for="key in rightKeys"
                    :key="key.tip"
                    class="am-play__key"
                    type="button"
                    :data-tip="key.tip"
                    :aria-label="key.tip"
                    @click="key.run()"
                  >
                    <Icon :d="key.sign" :line="key.line" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- В театре списки живут ящиком по кнопке, а не поверх кадра: висеть
             на видео всю серию им незачем. Вне театра это обычная колонка. -->
        <aside v-if="!wide || listOpen" class="am-play__side">
          <div class="am-play__box">
            <h3 class="am-play__h">Озвучка</h3>

            <ul v-if="voices.length > 0" class="am-play__list" data-zone="voices">
              <li v-for="voice in voices" :key="voice.key">
                <button
                  class="am-play__item"
                  :class="{ 'am-play__item--on': voice.key === voiceKey }"
                  type="button"
                  @click="pickVoice(voice.key)"
                >
                  <span class="am-play__word-cut">{{ voice.label }}</span>
                  <span class="am-play__src">{{ voice.sourceLabel }}</span>
                  <span v-if="voice.episodes > 0" class="am-play__time">
                    серий: {{ voice.episodes }}
                  </span>
                </button>
              </li>
            </ul>

            <p v-else class="am-play__none">Озвучек нет.</p>
          </div>

          <div class="am-play__box">
            <h3 class="am-play__h">Серии</h3>

            <ul v-if="episodes.length > 0" class="am-play__list" data-zone="episodes">
              <li v-for="item in episodes" :key="item.number">
                <button
                  class="am-play__item"
                  :class="{ 'am-play__item--on': item.number === episode }"
                  type="button"
                  @click="pickEpisode(item.number)"
                >
                  <span class="am-play__num">{{ item.number }}</span>
                  <span class="am-play__word-cut">{{ item.title ?? 'Серия' }}</span>
                  <span v-if="timeText(item.durationSec)" class="am-play__time">
                    {{ timeText(item.durationSec) }}
                  </span>
                </button>
              </li>
            </ul>

            <p v-else class="am-play__none">Серий пока нет.</p>
          </div>
        </aside>
      </div>
    </Teleport>
  </section>
</template>

<style scoped src="./player-screen.css"></style>
