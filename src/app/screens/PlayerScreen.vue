<script setup lang="ts">
// Пункт 4.2: экран просмотра. Номер тайтла из адреса, всё остальное —
// из player-view.ts. Здесь разметка, своя панель и связь с тегом <video>.
//
// Родных элементов управления нет намеренно: полоса WebView2 не красится
// темой и не проходится пультом. Своя умеет и то и другое, а заодно показывает
// край буфера. Клавиши и пульт разбирает player-input.ts.
//
// Ссылка меняется в трёх случаях: другая серия, другая озвучка, другое
// качество. Первые два начинают с запомненного места, третий — с текущей
// секунды: иначе переключение на 480p выглядело бы как потеря просмотра.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

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

/** Кадр во весь экран: наш театр и полный экран окна ходят вместе. */
const wide = ref(false)

/** Панель уехала: несколько секунд тишины и только во время игры. */
const calm = ref(false)

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
  wake()
}

function onPause(): void {
  playing.value = false
  calm.value = false
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

/** Тянут ли полосу: без нажатой кнопки это просто пролёт мыши. */
function onLineMove(event: PointerEvent): void {
  if (event.buttons === 0) return

  wake()
  seekShare(shareOfPointer(event))
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

/** Панель уезжает только во время игры: на паузе она нужна на месте. */
function sleep(): void {
  calmTimer = 0
  if (!playing.value || veil.value) return

  calm.value = true

  // Фокус не остаётся на спрятанной кнопке: уйти с неё пультом уже нельзя.
  const here = document.activeElement
  if (here instanceof HTMLElement && here.closest('.am-play__deck') !== null) here.blur()
}

/**
 * Полный экран: наш театр и окно оболочки идут вместе. Расхождение возможно
 * только в браузере, где окна у нас нет: там остаётся один театр.
 */
async function doFullscreen(): Promise<void> {
  wide.value = !wide.value
  wake()
  await toggleWindowFullscreen()
}

/** «Назад»: сначала выходим из полного экрана и только потом — с экрана. */
function doExit(): void {
  if (wide.value) {
    void doFullscreen()
    return
  }

  openCard()
}

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
      void doFullscreen()
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
    applySound()
  }

  window.addEventListener('keydown', onKey)
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
  void load()
})

watch(
  () => stream.value?.preferred.url ?? '',
  (url) => {
    if (url !== '') start(url)
  },
)

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
  }

  window.removeEventListener('keydown', onKey)
  if (calmTimer !== 0) window.clearTimeout(calmTimer)

  // Уходим с экрана — возвращаем окно: полный экран был нужен кадру, не спискам.
  if (wide.value) void toggleWindowFullscreen()

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

    <div
      v-else
      ref="rootEl"
      class="am-play"
      :class="{ 'am-play--wide': wide, 'am-play--calm': calm }"
      @pointermove="wake"
    >
      <div class="am-play__main">
        <div class="am-play__head" data-zone="head">
          <button v-tip="'Назад к карточке'" class="am-play__back" type="button" @click="doExit">
            <span aria-hidden="true">←</span>
            <span>Карточка</span>
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

          <span v-if="!veil && !playing" class="am-play__hold" aria-hidden="true">▶</span>

          <div v-if="veil" class="am-play__veil">
            <span v-if="cover" class="am-play__blur" :style="coverStyle" aria-hidden="true" />
            <span v-if="busy" class="am-play__spin" aria-hidden="true" />
            <p v-if="veilWord" class="am-play__word">{{ veilWord }}</p>
            <button v-if="trouble && !busy" class="am-play__act" type="button" @click="refresh">
              Переспросить
            </button>
          </div>

          <button v-if="skip" class="am-play__skip" type="button" @click="doSkip">
            {{ skip.label }}
          </button>

          <div v-show="!veil" class="am-play__deck" data-zone="bar">
            <button
              class="am-play__key"
              type="button"
              :aria-label="playing ? 'Пауза' : 'Смотреть'"
              @click="doToggle"
            >
              <span aria-hidden="true">{{ playing ? '❚❚' : '▶' }}</span>
            </button>

            <button
              class="am-play__key"
              type="button"
              aria-label="Назад на десять секунд"
              @click="nudge(-STEP_SEC)"
            >
              <span aria-hidden="true">↺</span>
            </button>

            <button
              class="am-play__key"
              type="button"
              aria-label="Вперёд на десять секунд"
              @click="nudge(STEP_SEC)"
            >
              <span aria-hidden="true">↻</span>
            </button>

            <span class="am-play__clock">{{ clockText(at) }}</span>

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
              @keydown="onLineKey"
              @keydown.space.prevent.stop="doToggle"
              @keydown.enter.prevent.stop="doToggle"
            >
              <span class="am-play__buf" :style="{ width: shareReady + '%' }" />
              <span class="am-play__fill" :style="{ width: shareAt + '%' }" />
              <span class="am-play__knob" :style="{ left: shareAt + '%' }" />
            </div>

            <span class="am-play__clock">{{ clockText(total) }}</span>

            <button
              class="am-play__key"
              type="button"
              :aria-label="muted ? 'Включить звук' : 'Заглушить'"
              @click="toggleMute"
            >
              <span class="am-play__note" :class="{ 'am-play__note--off': muted }">♪</span>
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
            </div>

            <div v-if="qualities.length > 0" class="am-play__group">
              <button
                v-for="quality in qualities"
                :key="quality.height"
                class="am-play__q"
                :class="{ 'am-play__q--on': quality.on }"
                type="button"
                @click="pickHeight(quality.height)"
              >
                {{ quality.label }}
              </button>
            </div>

            <button
              class="am-play__key am-play__key--word"
              type="button"
              :disabled="!hasNext"
              @click="nextEpisode"
            >
              Следующая
            </button>

            <button
              v-tip="'Взять ссылку заново: у источников она живёт часами'"
              class="am-play__key am-play__key--word"
              type="button"
              @click="refresh"
            >
              Переспросить
            </button>

            <button
              class="am-play__key"
              type="button"
              :aria-label="wide ? 'Свернуть кадр' : 'Во весь экран'"
              @click="doFullscreen"
            >
              <span aria-hidden="true">{{ wide ? '⤡' : '⤢' }}</span>
            </button>
          </div>
        </div>
      </div>

      <aside class="am-play__side">
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
  </section>
</template>

<style scoped src="./player-screen.css"></style>
