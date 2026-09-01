<script setup lang="ts">
// Пункт 4.2: экран просмотра. Номер тайтла из адреса, всё остальное —
// из player-view.ts. Здесь только разметка и связь с тегом <video>.
//
// Ссылка меняется в трёх случаях: другая серия, другая озвучка, другое
// качество. Первые два начинают с запомненного места, третий — с текущей
// секунды: иначе переключение на 480p выглядело бы как потеря просмотра.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { currentRoute } from '../router'

import { attachPlayback, type Playback } from './player-hls'
import { episodeLabel, peekSpot, rememberSpot, spotKey, usePlayer } from './player-view'

const videoEl = ref<HTMLVideoElement | null>(null)

/** Где мы сейчас по времени: число меняется раз в секунду, не чаще. */
const at = ref(0)

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

function onTime(): void {
  const el = videoEl.value
  if (el === null) return

  const now = Math.floor(el.currentTime)
  if (now === at.value) return

  at.value = now
  if (spot !== '') rememberSpot(spot, now)
}

/** Конец серии: следующая сама. Смотренное забывается: оно пройдено. */
function onEnded(): void {
  if (spot !== '') rememberSpot(spot, 0)
  if (hasNext.value) nextEpisode()
}

function doSkip(): void {
  const el = videoEl.value
  const jump = skip.value
  if (el === null || jump === null) return

  el.currentTime = jump.to
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
  }

  void load()
})

// Новый адрес — новый тайтл: экран не пересобирается, грузим сами.
watch(mediaId, () => {
  playback?.close()
  spot = ''
  at.value = 0
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
  }

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

    <div v-else class="am-play">
      <div class="am-play__main">
        <div class="am-play__head">
          <button v-tip="'Назад к карточке'" class="am-play__back" type="button" @click="openCard">
            <span aria-hidden="true">←</span>
            <span>Карточка</span>
          </button>

          <div class="am-play__title">
            <h2 class="am-play__name">{{ mainTitle }}</h2>
            <p v-if="subLine" class="am-play__sub">{{ subLine }}</p>
          </div>
        </div>

        <div class="am-play__stage">
          <video ref="videoEl" class="am-play__frame" controls playsinline preload="metadata"></video>

          <div v-if="veil" class="am-play__veil">
            <span v-if="cover" class="am-play__blur" :style="coverStyle" aria-hidden="true" />
            <span v-if="busy" class="am-play__spin" aria-hidden="true" />
            <p v-if="veilWord" class="am-play__word">{{ veilWord }}</p>
            <button
              v-if="trouble && !busy"
              class="am-play__act"
              type="button"
              @click="refresh"
            >
              Переспросить
            </button>
          </div>

          <button v-if="skip" class="am-play__skip" type="button" @click="doSkip">
            {{ skip.label }}
          </button>
        </div>

        <div class="am-play__bar">
          <div v-if="qualities.length > 0" class="am-play__group">
            <span class="am-play__cap">Качество</span>
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

          <span class="am-play__space" />

          <button
            v-tip="'Взять ссылку заново: у источников она живёт часами'"
            class="am-play__act"
            type="button"
            @click="refresh"
          >
            Переспросить
          </button>

          <button class="am-play__act" type="button" :disabled="!hasNext" @click="nextEpisode">
            Следующая
          </button>
        </div>
      </div>

      <aside class="am-play__side">
        <div class="am-play__box">
          <h3 class="am-play__h">Озвучка</h3>

          <ul v-if="voices.length > 0" class="am-play__voices">
            <li v-for="voice in voices" :key="voice.key">
              <button
                v-tip="`${voice.sourceLabel}${voice.episodes > 0 ? ` · серий: ${voice.episodes}` : ''}`"
                class="am-play__voice"
                :class="{ 'am-play__voice--on': voice.key === voiceKey }"
                type="button"
                @click="pickVoice(voice.key)"
              >
                {{ voice.label }}
              </button>
            </li>
          </ul>

          <p v-else class="am-play__none">Озвучек нет.</p>
        </div>

        <div class="am-play__box">
          <h3 class="am-play__h">Серии</h3>

          <ul v-if="episodes.length > 0" class="am-play__list">
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
