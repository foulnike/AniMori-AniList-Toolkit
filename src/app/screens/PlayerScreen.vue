<script setup lang="ts">
// Пункт 4.2: экран просмотра. Номер аниме из адреса, всё остальное —
// из player-view.ts. Здесь разметка, своя панель и связь с тегом <video>.
//
// Родных элементов управления нет намеренно: полоса WebView2 не красится
// темой и не проходится пультом. Своя умеет и то и другое, а заодно показывает
// край буфера. Клавиши и пульт разбирает player-input.ts.
//
// Полный экран собран из двух шагов, и каждый закрывает свою дыру. Театр
// переезжает в body: внутри рамки приложения он оставался в чужих контекстах
// наложения, и рельс, шапка и подложка окна просвечивали сквозь кадр. Окно
// оболочки уходит в полный экран через мост: только он убирает шапку окна
// и панель задач Windows.
//
// Родной полный экран элемента (requestFullscreen) отсюда убран совсем.
// Оболочка сама разворачивала окно в ответ на него, и следующий шаг видел
// «уже развёрнуто» и складывал окно обратно: шапка и панель задач оставались
// на месте. Верхний слой, который он давал, театру в body не нужен.
//
// Ссылка меняется в трёх случаях: другая серия, другая озвучка, другое
// качество. Первые два начинают с запомненного места, третий — с текущей
// секунды: иначе переключение на 480p выглядело бы как потеря просмотра.
//
// ЗАСЛОНКА ГОВОРИТ ПРАВДУ И ГАСИТ КАДР
// Отсутствие ссылки раньше читалось одним способом — «Серия не выбрана», —
// а случаев три: ещё не спрашивали, уже спрашиваем и спросить нечего.
// Смена озвучки — второй случай, и надпись врала: серия выбрана, просто
// ссылка ещё не приехала.
//
// Вторая половина того же краевого случая: под заслонкой продолжал играть
// прежний поток. Панель и нажатие по кадру в это время спрятаны, то есть
// остановить звук было нечем вовсе. Теперь поднявшаяся заслонка гасит кадр
// и сбрасывает часы: полоса времени больше не показывает длину прошлой
// серии. Запускать новый поток руками не надо: player-hls сам жмёт play()
// после разбора манифеста.
//
// Место остановки записывается до сброса, а ключ забывается после: тогда
// «Переспросить» садится на только что записанную секунду, а не на ноль
// от погашенного тега.
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
  NORMAL_RATE,
  RATES,
  STEP_SEC,
  VOLUME_STEP,
  moveFocus,
  type PlayerIntent,
  peekRate,
  peekVolume,
  rateLabel,
  readIntent,
  rememberRate,
  rememberVolume,
  stepRate,
  toggleWindowFullscreen,
} from './player-input'
import {
  flushWatchKeep,
  forgetSpot,
  peekShare,
  peekSpot,
  rememberSpot,
  spotKey,
  whenWatchReady,
} from './player-keep'
import { episodeLabel, usePlayer } from './player-view'

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

/** Сколько держится плашка продолжения. Дальше она мешает смотреть. */
const RESUME_SHOW_MS = 7000

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

/** Скорость видеоряда. Своя, а не родная полоса: та в WebView2 не красится. */
const rate = ref(peekRate())

/** Кадр во весь экран: театр в body и полный экран окна оболочки. */
const wide = ref(false)

/** Панель уехала: несколько секунд тишины и только во время игры. */
const calm = ref(false)

/** Указатель на панели: пока он там, тишина не считается. */
const deckHot = ref(false)

/** Какое меню панели открыто. Одно за раз: два перекрывали бы друг друга. */
const menu = ref<'' | 'quality' | 'rate'>('')

/** Открыт ящик со списками: в театре они прячутся до нажатия. */
const listOpen = ref(false)

/** Кадр встал посреди серии: сеть не поспевает, но ошибки ещё нет. */
const stalled = ref(false)

/** Доля полосы под указателем, -1 — указателя на ней нет. */
const hoverShare = ref(-1)

/** С какой секунды продолжили. Ноль — начали сначала, плашки не будет. */
const resumeAt = ref(0)

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

/** Таймер плашки продолжения. */
let resumeTimer = 0

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

/**
 * Что написано на заслонке. Случаев без ссылки три, и путать их нельзя:
 * при смене озвучки серия выбрана и ждёт ссылки, а надпись «Серия
 * не выбрана» читалась как сброс выбора.
 */
const veilWord = computed<string>(() => {
  if (trouble.value !== '') return trouble.value
  if (busy.value) return 'Ищу источники…'
  if (stream.value !== null) return ''
  if (episodes.value.length === 0) return 'У этой озвучки нет готовых серий.'
  return 'Беру ссылку на серию…'
})

/**
 * Крутится ли колесо на заслонке. Не только при поиске источников: ждание
 * ссылки после смены озвучки тоже ожидание, и без колеса экран выглядел
 * замёрзшим.
 */
const veilSpin = computed<boolean>(
  () => trouble.value === '' && (busy.value || stream.value === null),
)

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

/**
 * Доля просмотренного у серии в полке. Считается на каждой перерисовке: метки
 * лежат обычным объектом, а не ref, зато полоска обновляется вместе с часами.
 */
function seenShare(number: number): number {
  return Math.round(peekShare(spotKey(mediaId.value, voiceKey.value, number)) * 100)
}

/** Громкость и звук ставим на тег сами: своя панель — свой источник правды. */
function applySound(): void {
  const el = videoEl.value
  if (el === null) return

  el.volume = volume.value
  el.muted = muted.value
}

/**
 * Скорость ставим в оба поля. defaultPlaybackRate обязателен: алгоритм загрузки
 * нового ресурса сбрасывает playbackRate именно к нему, и без этой строки
 * скорость терялась на каждой смене серии.
 */
function applyRate(): void {
  const el = videoEl.value
  if (el === null) return

  el.defaultPlaybackRate = rate.value
  el.playbackRate = rate.value
}

function setVolume(next: number): void {
  const value = Math.min(1, Math.max(0, Math.round(next * 100) / 100))
  volume.value = value
  muted.value = value === 0
  rememberVolume(value)
  applySound()
}

function setRate(next: number): void {
  rate.value = next
  rememberRate(next)
  applyRate()
  wake()
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

/** Плашка «продолжили с…»: живёт несколько секунд и уходит сама. */
function showResume(from: number): void {
  if (resumeTimer !== 0) window.clearTimeout(resumeTimer)
  resumeTimer = 0
  resumeAt.value = from > 0 ? Math.floor(from) : 0
  if (resumeAt.value === 0) return

  resumeTimer = window.setTimeout(() => {
    resumeTimer = 0
    resumeAt.value = 0
  }, RESUME_SHOW_MS)
}

/** Открывает манифест. Та же серия — продолжаем с текущей секунды. */
function start(url: string): void {
  const el = videoEl.value
  if (el === null || playback === null) return

  const key = spotKey(mediaId.value, voiceKey.value, episode.value)
  const same = key === spot
  const from = same ? el.currentTime : peekSpot(key)
  spot = key
  playback.open(url, from)
  applyRate()

  // Про смену качества плашка молчит: место не менялось, менялась картинка.
  if (!same) showResume(from)
}

/**
 * Поднялась заслонка — кадру играть нечего. Звук из-за заслонки был
 * самым заметным из краевых случаев: органы управления в это время
 * спрятаны, и остановить его человеку было нечем.
 *
 * Порядок важен: сначала записываем место остановки — для этого нужны
 * живые секунда и длина, — и только потом гасим тег и числа. Ключ
 * забывается последним: иначе «Переспросить» счёл бы серию той же
 * и сел на ноль погашенного тега.
 */
function stopFrame(): void {
  const el = videoEl.value

  if (el !== null && spot !== '') rememberSpot(spot, Math.floor(el.currentTime), total.value)

  playback?.close()
  spot = ''

  at.value = 0
  total.value = 0
  ready.value = 0
  playing.value = false
  stalled.value = false
  resumeAt.value = 0
  hoverShare.value = -1

  if (resumeTimer !== 0) {
    window.clearTimeout(resumeTimer)
    resumeTimer = 0
  }

  // Панель возвращается на место и меню гаснут: иначе после заслонки
  // она осталась бы уехавшей до первого движения мыши.
  calm.value = false
  menu.value = ''
}

/** «Сначала»: человек не согласен с меткой. Забываем её, чтобы не спорить. */
function doRestart(): void {
  if (veil.value) return

  resumeAt.value = 0
  if (resumeTimer !== 0) {
    window.clearTimeout(resumeTimer)
    resumeTimer = 0
  }

  if (spot !== '') forgetSpot(spot)

  const el = videoEl.value
  if (el === null) return

  el.currentTime = 0
  at.value = 0
  wake()
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
  if (spot !== '') rememberSpot(spot, now, total.value)
}

/** Длина у HLS приезжает позже кадра, и бесконечность тоже бывает. */
function onMeta(): void {
  const el = videoEl.value
  if (el === null) return

  total.value = Number.isFinite(el.duration) ? el.duration : 0
  applySound()
  applyRate()
}

/** Конец серии: следующая сама. Смотренное забывается: оно пройдено. */
function onEnded(): void {
  if (spot !== '') forgetSpot(spot)
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
  if (el === null || veil.value) return

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
  if (el === null || veil.value) return

  const edge = total.value > 0 ? total.value - 0.5 : el.currentTime + Math.abs(delta)
  el.currentTime = Math.min(edge, Math.max(0, el.currentTime + delta))
  at.value = Math.floor(el.currentTime)
  wake()
}

/** Прыжок на долю серии: так говорит полоса, когда её тянут мышью. */
function seekShare(share: number): void {
  const el = videoEl.value
  if (el === null || veil.value || total.value <= 0) return

  el.currentTime = Math.min(total.value - 0.5, Math.max(0, share * total.value))
  at.value = Math.floor(el.currentTime)
}

function doSkip(): void {
  const el = videoEl.value
  const jump = skip.value
  if (el === null || veil.value || jump === null) return

  el.currentTime = jump.to
  wake()
}

function doPrev(): void {
  if (prevNumber.value > 0) pickEpisode(prevNumber.value)
}

/** Выбор закрывает своё меню сам: меню, которое надо гасить, раздражает. */
function takeHeight(height: number): void {
  menu.value = ''
  pickHeight(height)
}

function takeRate(next: number): void {
  menu.value = ''
  setRate(next)
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
  if (deckHot.value || menu.value !== '' || listOpen.value) return

  calm.value = true

  // Фокус не остаётся на спрятанной кнопке: уйти с неё пультом уже нельзя.
  const here = document.activeElement
  if (here instanceof HTMLElement && here.closest('.am-play__deck') !== null) here.blur()
}

/** Полный экран окна оболочки. Мост умеет переключать, поэтому спрашиваем себя. */
async function wantWindowWide(next: boolean): Promise<void> {
  if (windowWide === next) return
  windowWide = await toggleWindowFullscreen()
}

/**
 * Два шага в одном. Порядок обязателен: сначала Vue переносит узел в body
 * и раскладывает театр, и только потом окно меняет размер — иначе разметка
 * пересчитывается дважды и первый кадр после нажатия дёргается.
 */
async function setWide(next: boolean): Promise<void> {
  wide.value = next
  wake()

  if (!next) {
    listOpen.value = false
    menu.value = ''
  }

  await nextTick()
  await wantWindowWide(next)
}

function doFullscreen(): void {
  void setWide(!wide.value)
}

/** Нажатие мимо меню закрывает его: так ведёт себя любое меню. */
function onDown(event: PointerEvent): void {
  if (menu.value === '') return

  const aim = event.target
  if (aim instanceof Element && aim.closest('.am-play__pick') !== null) return

  menu.value = ''
}

/** «Назад»: сначала закрываем открытое, потом театр и только потом экран. */
function doExit(): void {
  if (menu.value !== '' || listOpen.value) {
    menu.value = ''
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
  // Под заслонкой играть нечего: пускаем только выход и размер кадра.
  // Клавиши доходят с окна, а не с кнопок, и скрытая панель их не держит.
  if (veil.value && intent !== 'exit' && intent !== 'fullscreen') return

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
    case 'slower':
      setRate(stepRate(rate.value, -1))
      return
    case 'faster':
      setRate(stepRate(rate.value, 1))
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
    applyRate()
  }

  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onDown)

  // Метки нужны и полке серий, и первому кадру: просим их пораньше.
  void whenWatchReady()
  void load()
})

// Новый адрес — новое аниме: экран не пересобирается, грузим сами.
watch(mediaId, () => {
  playback?.close()
  spot = ''
  at.value = 0
  total.value = 0
  ready.value = 0
  playing.value = false
  stalled.value = false
  resumeAt.value = 0
  menu.value = ''
  void load()
})

// Заслонка поднялась — гаси