<script setup lang="ts">
// Пункт 3.9а: окно правки записи списка. Своего состояния не держит:
// значения приходят сверху, а наружу уходят просьбы поправить.
// Отправкой занимается карточка: окну о сети и очереди знать незачем.
import { computed, onBeforeUnmount, onMounted } from 'vue'

import type { MediaType } from '@/core/types'

import { partsWord, statusList, statusWord } from '../labels'

/** Шаг оценки. Десятибалльная шкала у AniList дробная, половины достаточно. */
const SCORE_STEP = 0.5

/** Быстрые оценки одним нажатием: целые баллы шкалы. */
const QUICK_MARKS: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

const props = defineProps<{
  type: MediaType
  title: string
  status: string
  score10: number
  progress: number
  volumes: number
  partsTotal: number | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'status', value: string): void
  (e: 'score', value: number): void
  (e: 'progress', value: number): void
}>()

/** Закладки и подписи зависят только от типа тайтла. */
const statuses = computed(() => statusList(props.type))
const partsName = computed(() => partsWord(props.type))
const nowStatus = computed(() => statusWord(props.type, props.status === '' ? null : props.status))

/** Строка счёта вида «7 из 12». Неизвестный итог не выдумывается. */
const partsText = computed(() =>
  props.partsTotal === null ? String(props.progress) : `${props.progress} из ${props.partsTotal}`,
)

/** Доля пройденного для полосы. */
const donePart = computed(() => {
  const total = props.partsTotal
  if (total === null || total <= 0) return props.status === 'COMPLETED' ? '100%' : '0%'

  const part = Math.min(1, Math.max(0, props.progress / total))
  return `${Math.round(part * 100)}%`
})

function markText(value: number): string {
  return value > 0 ? value.toFixed(1) : '—'
}

/** Оценка шагом шкалы, с обрезкой по краям: сервер знает только 0—10. */
function bumpScore(delta: number): void {
  const next = Math.round((props.score10 + delta) / SCORE_STEP) * SCORE_STEP
  const fixed = Math.min(10, Math.max(0, Math.round(next * 10) / 10))
  if (fixed !== props.score10) emit('score', fixed)
}

function setScore(value: number): void {
  if (value !== props.score10) emit('score', value)
}

/** Счёт частей. Выше известного итога не пускаем: такую правку сервер отвергнет. */
function bumpProgress(delta: number): void {
  const next = props.progress + delta
  const fixed = Math.max(0, props.partsTotal === null ? next : Math.min(props.partsTotal, next))
  if (fixed !== props.progress) emit('progress', fixed)
}

/** Отметка пройденного: счёт до итога и закладка в одно нажатие. */
function markDone(): void {
  if (props.partsTotal !== null && props.partsTotal > props.progress) {
    emit('progress', props.partsTotal)
  }

  if (props.status !== 'COMPLETED') emit('status', 'COMPLETED')
}

function onClose(): void {
  emit('close')
}

/** Закрытие по Escape: окно поверх экрана без этого раздражает. */
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="am-sheet" role="dialog" aria-modal="true" @click.self="onClose">
    <div class="am-sheet__box">
      <header class="am-sheet__top">
        <div class="am-sheet__text">
          <span class="am-sheet__kicker">{{ nowStatus ?? 'Не в списке' }}</span>
          <h3 class="am-sheet__name">{{ title }}</h3>
        </div>

        <button class="am-sheet__close" type="button" title="Закрыть" @click="onClose">
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div class="am-sheet__body">
        <div class="am-row">
          <span class="am-row__name">Закладка</span>
          <div class="am-marks">
            <button
              v-for="item in statuses"
              :key="item.key"
              class="am-mark"
              :class="{ 'am-mark--on': item.key === status }"
              type="button"
              @click="emit('status', item.key)"
            >
              {{ item.title }}
            </button>
          </div>
        </div>

        <div class="am-row">
          <span class="am-row__name">Оценка</span>
          <div class="am-step-row">
            <button class="am-step" type="button" @click="bumpScore(-SCORE_STEP)">−</button>
            <span class="am-step__value">{{ markText(score10) }}</span>
            <button class="am-step" type="button" @click="bumpScore(SCORE_STEP)">+</button>
          </div>

          <div class="am-marks">
            <button
              v-for="mark in QUICK_MARKS"
              :key="mark"
              class="am-mark am-mark--num"
              :class="{ 'am-mark--on': mark === score10 }"
              type="button"
              @click="setScore(mark)"
            >
              {{ mark }}
            </button>
          </div>
        </div>

        <div class="am-row">
          <span class="am-row__name">{{ partsName }}</span>
          <div class="am-step-row">
            <button class="am-step" type="button" @click="bumpProgress(-1)">−</button>
            <span class="am-step__value">{{ partsText }}</span>
            <button class="am-step" type="button" @click="bumpProgress(1)">+</button>
          </div>

          <span class="am-line">
            <span class="am-line__fill" :style="{ width: donePart }" />
          </span>
        </div>

        <p v-if="type === 'MANGA'" class="am-meta">Прочитано томов: {{ volumes }}</p>
      </div>

      <footer class="am-sheet__foot">
        <button
          v-if="partsTotal !== null"
          class="am-btn am-btn--soft"
          type="button"
          @click="markDone"
        >
          Всё пройдено
        </button>

        <span class="am-bar__gap" />

        <button class="am-btn" type="button" @click="onClose">Готово</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Окно поверх экрана: затемнение гасит всё лишнее. */
.am-sheet {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(4, 7, 12, 0.68);
  backdrop-filter: blur(6px);
}

.am-sheet__box {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 560px;
  max-height: 88vh;
  overflow-y: auto;
  padding: 22px;
  background: linear-gradient(180deg, var(--am-panel-2), var(--am-panel));
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-l);
  box-shadow: var(--am-sh-2);
}

.am-sheet__top {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.am-sheet__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.am-sheet__kicker {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--am-accent);
  text-transform: uppercase;
}

.am-sheet__name {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  line-height: 1.25;
}

.am-sheet__close {
  flex: none;
  width: 32px;
  height: 32px;
  margin-left: auto;
  font: inherit;
  font-size: 20px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--am-line);
  border-radius: 999px;
}

.am-sheet__close:hover {
  color: var(--am-text);
  background: var(--am-hover);
}

.am-sheet__body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.am-row {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.am-row__name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--am-dim);
}

.am-marks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.am-mark {
  padding: 7px 13px;
  font: inherit;
  font-size: 13px;
  color: var(--am-dim);
  cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--am-line);
  border-radius: 999px;
  transition:
    color 0.12s ease,
    background 0.12s ease,
    border-color 0.12s ease;
}

.am-mark:hover {
  color: var(--am-text);
  background: var(--am-hover);
}

.am-mark--on {
  color: #071018;
  background: linear-gradient(135deg, var(--am-accent), var(--am-accent-2));
  border-color: transparent;
}

.am-mark--num {
  min-width: 38px;
  text-align: center;
}

.am-step-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.am-step {
  width: 34px;
  height: 34px;
  font: inherit;
  font-size: 17px;
  color: var(--am-text);
  cursor: pointer;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-s);
}

.am-step:hover {
  background: var(--am-hover);
  border-color: var(--am-accent);
}

.am-step__value {
  min-width: 96px;
  font-size: 15px;
  font-weight: 650;
}

.am-sheet__foot {
  display: flex;
  gap: 10px;
  align-items: center;
}
</style>
