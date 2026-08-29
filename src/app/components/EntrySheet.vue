<script setup lang="ts">
// Пункт 3.9а: окно правки записи списка. Своего состояния почти не держит:
// значения приходят сверху, а наружу уходят просьбы поправить.
// Исключение — черновик комментария: отдавать его на каждую букву нельзя.
// Отправкой занимается карточка: окну о сети и очереди знать незачем.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { partsWord, statusList, statusWord } from '../labels'

/** Шаг оценки. Десятибалльная шкала у AniList дробная, половины достаточно. */
const SCORE_STEP = 0.5

/** Быстрые оценки одним нажатием: целые баллы шкалы. */
const QUICK_MARKS: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

/** Крайние тона шкалы оценок: единица красная, десятка зелёная. */
const MARK_TONE_MAX = 132

const props = defineProps<{
  title: string
  status: string
  score10: number
  progress: number
  partsTotal: number | null
  repeat: number
  startedAt: string | null
  completedAt: string | null
  notes: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'status', value: string): void
  (e: 'score', value: number): void
  (e: 'progress', value: number): void
  (e: 'repeat', value: number): void
  (e: 'startedAt', value: string): void
  (e: 'completedAt', value: string): void
  (e: 'notes', value: string): void
}>()

// Закладки и подпись счёта теперь одни и те же: выбора вида больше нет,
// и пересчитывать их на каждую правку нечего.
const statuses = statusList()
const partsName = partsWord()

const nowStatus = computed(() => statusWord(props.status === '' ? null : props.status))

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

/**
 * Черновик комментария. Поле правится часто и мелко, а каждая буква наружу —
 * это правка в очередь и запрос к серверу, поэтому отдаём по уходу из поля.
 */
const draft = ref(props.notes ?? '')

// Значение сверху могло измениться обновлением списка: подхватываем, но не
// затираем то, что человек уже набрал в поле.
watch(
  () => props.notes,
  (fresh) => {
    const known = fresh ?? ''
    if (known !== draft.value.trim()) draft.value = known
  },
)

function markText(value: number): string {
  return value > 0 ? value.toFixed(1) : '—'
}

/**
 * Цвет балла: тон идёт от красного к зелёному по шкале.
 * Считается на месте, чтобы не держать в стилях десять почти одинаковых правил.
 */
function markStyle(mark: number): Record<string, string> {
  const tone = Math.round(((mark - 1) / (QUICK_MARKS.length - 1)) * MARK_TONE_MAX)

  return {
    '--am-mark': `hsl(${tone} 64% 46%)`,
    '--am-mark-deep': `hsl(${tone} 68% 34%)`,
  }
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

/** Счёт серий. Выше известного итога не пускаем: такую правку сервер отвергнет. */
function bumpProgress(delta: number): void {
  const next = props.progress + delta
  const fixed = Math.max(0, props.partsTotal === null ? next : Math.min(props.partsTotal, next))
  if (fixed !== props.progress) emit('progress', fixed)
}

/** Пересмотры. Потолка у них нет, а ниже нуля уходить бессмысленно. */
function bumpRepeat(delta: number): void {
  const fixed = Math.max(0, props.repeat + delta)
  if (fixed !== props.repeat) emit('repeat', fixed)
}

/** Сегодняшний день в виде ГГГГ-ММ-ДД. Через метку времени день съезжал бы. */
function today(): string {
  const now = new Date()
  const month = now.getMonth() + 1
  const day = now.getDate()
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${now.getFullYear()}-${pad(month)}-${pad(day)}`
}

/** Пустая строка наружу значит «стереть дату»: так договорились с очередью. */
function onStarted(event: Event): void {
  emit('startedAt', (event.target as HTMLInputElement).value)
}

function onCompleted(event: Event): void {
  emit('completedAt', (event.target as HTMLInputElement).value)
}

function sendNotes(): void {
  const asked = draft.value.trim()
  if (asked !== (props.notes ?? '')) emit('notes', asked)
}

/**
 * Отметка пройденного: счёт до итога, закладка и дата конца в одно нажатие.
 * Дату ставим только когда её нет: чужую отметку затирать нельзя.
 */
function markDone(): void {
  if (props.partsTotal !== null && props.partsTotal > props.progress) {
    emit('progress', props.partsTotal)
  }

  if (props.status !== 'COMPLETED') emit('status', 'COMPLETED')
  if (props.completedAt === null) emit('completedAt', today())
}

function onClose(): void {
  sendNotes()
  emit('close')
}

/** Закрытие по Escape: окно поверх экрана без этого раздражает. */
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') onClose()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  // Уход мимо кнопки «Готово» тоже не должен терять набранный текст.
  sendNotes()
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
        <section class="am-field am-field--wide">
          <span class="am-field__name">Закладка</span>
          <div class="am-picks">
            <button
              v-for="item in statuses"
              :key="item.key"
              class="am-pick"
              :class="{ 'am-pick--on': item.key === status }"
              type="button"
              @click="emit('status', item.key)"
            >
              {{ item.title }}
            </button>
          </div>
        </section>

        <section class="am-field am-field--wide">
          <span class="am-field__name">Оценка</span>
          <div class="am-step-row">
            <button class="am-step" type="button" title="Меньше" @click="bumpScore(-SCORE_STEP)">
              −
            </button>
            <span class="am-step__value">{{ markText(score10) }}</span>
            <button class="am-step" type="button" title="Больше" @click="bumpScore(SCORE_STEP)">
              +
            </button>
          </div>

          <div class="am-picks am-picks--mid">
            <button
              v-for="mark in QUICK_MARKS"
              :key="mark"
              class="am-pick am-pick--num"
              :class="{ 'am-pick--on': mark === score10 }"
              :style="markStyle(mark)"
              type="button"
              @click="setScore(mark)"
            >
              {{ mark }}
            </button>
          </div>
        </section>

        <section class="am-field">
          <span class="am-field__name">{{ partsName }}</span>
          <div class="am-step-row">
            <button class="am-step" type="button" title="Меньше" @click="bumpProgress(-1)">
              −
            </button>
            <span class="am-step__value">{{ partsText }}</span>
            <button class="am-step" type="button" title="Больше" @click="bumpProgress(1)">+</button>
          </div>

          <span class="am-line">
            <span class="am-line__fill" :style="{ width: donePart }" />
          </span>
        </section>

        <section class="am-field">
          <span class="am-field__name">Пересмотры</span>
          <div class="am-step-row">
            <button class="am-step" type="button" title="Меньше" @click="bumpRepeat(-1)">−</button>
            <span class="am-step__value">{{ repeat }}</span>
            <button class="am-step" type="button" title="Больше" @click="bumpRepeat(1)">+</button>
          </div>
        </section>

        <section class="am-field">
          <span class="am-field__name">Начато</span>
          <div class="am-date-row">
            <input
              class="am-input am-date"
              type="date"
              :value="startedAt ?? ''"
              @change="onStarted"
            />
            <button class="am-btn am-btn--ghost" type="button" @click="emit('startedAt', today())">
              Сегодня
            </button>
          </div>
        </section>

        <section class="am-field">
          <span class="am-field__name">Закончено</span>
          <div class="am-date-row">
            <input
              class="am-input am-date"
              type="date"
              :value="completedAt ?? ''"
              @change="onCompleted"
            />
            <button
              class="am-btn am-btn--ghost"
              type="button"
              @click="emit('completedAt', today())"
            >
              Сегодня
            </button>
          </div>
        </section>

        <section class="am-field am-field--wide">
          <span class="am-field__name">Комментарий</span>
          <textarea
            v-model="draft"
            class="am-input am-note"
            rows="3"
            placeholder="Личная заметка, её видно на AniList"
            @blur="sendNotes"
          />
        </section>
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

/* Окно шире прежнего: поля встают в два столбца, а не в длинный свиток. */
.am-sheet__box {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
  max-width: 860px;
  max-height: 90vh;
  overflow-y: auto;
  padding: 26px;
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
  gap: 4px;
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
  font-size: 20px;
  font-weight: 650;
  line-height: 1.25;
}

/* Круглая цель, но не мелкая: на телевизоре мелкое просто не поймать. */
.am-sheet__close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-left: auto;
  padding: 0;
  font: inherit;
  font-size: 22px;
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

/* Сетка полей: на широком окне два столбца, на узком один. */
.am-sheet__body {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

/* Закладки, оценка и комментарий занимают всю ширину: рядов там много. */
.am-field--wide {
  grid-column: 1 / -1;
}

/* Панель поля: подпись сверху, содержимое под ней. */
.am-field {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-field__name {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--am-dim);
  text-transform: uppercase;
}

.am-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Своя обёртка для шкалы оценок: ряд закладок остаётся прижатым влево. */
.am-picks--mid {
  justify-content: center;
}

/* Цель нажатия 44 пикселя по высоте: правило пульта и пальца заодно. */
.am-pick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 18px;
  font: inherit;
  font-size: 14px;
  line-height: 1;
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

.am-pick:hover {
  color: var(--am-text);
  background: var(--am-hover);
}

.am-pick--on {
  color: #071018;
  background: linear-gradient(135deg, var(--am-accent), var(--am-accent-2));
  border-color: transparent;
}

/* Балл красится своим тоном шкалы: правила ниже перебивают общую заливку. */
.am-pick--num {
  min-width: 52px;
  font-weight: 650;
  color: rgba(255, 255, 255, 0.92);
  background: linear-gradient(180deg, var(--am-mark), var(--am-mark-deep));
  border-color: rgba(255, 255, 255, 0.1);
  opacity: 0.6;
  transition:
    opacity 0.12s ease,
    box-shadow 0.12s ease;
}

.am-pick--num:hover {
  color: #fff;
  background: linear-gradient(180deg, var(--am-mark), var(--am-mark-deep));
  opacity: 0.85;
}

.am-pick--num.am-pick--on {
  color: #fff;
  background: linear-gradient(180deg, var(--am-mark), var(--am-mark-deep));
  border-color: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.16);
  opacity: 1;
}

.am-step-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.am-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  font: inherit;
  font-size: 20px;
  line-height: 1;
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
  flex: 1;
  font-size: 17px;
  font-weight: 650;
  text-align: center;
}

.am-date-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

/* Поле даты одето под панель. Сам выпадающий календарь рисует движок. */
.am-date {
  flex: 1;
  min-height: 44px;
  padding: 9px 14px;
  color: var(--am-text);
  background: var(--am-panel-2);
  border-radius: var(--am-r-m);
}

.am-date:hover {
  background: var(--am-hover);
  border-color: var(--am-accent);
}

.am-date::-webkit-datetime-edit {
  color: var(--am-text);
}

.am-date::-webkit-datetime-edit-fields-wrapper {
  padding: 0;
}

.am-date::-webkit-datetime-edit-text {
  padding: 0 2px;
  color: var(--am-faint);
}

/* Значок вызова календаря светлый: родной чёрный на тёмном поле не виден. */
.am-date::-webkit-calendar-picker-indicator {
  padding: 4px;
  cursor: pointer;
  border-radius: var(--am-r-s);
  filter: invert(1) brightness(1.4);
  opacity: 0.55;
}

.am-date::-webkit-calendar-picker-indicator:hover {
  background: rgba(255, 255, 255, 0.12);
  opacity: 1;
}

/* Заметка не круглая: скругление полей ввода на большом поле смотрится нелепо. */
.am-note {
  min-height: 96px;
  padding: 12px 14px;
  font: inherit;
  line-height: 1.5;
  border-radius: var(--am-r-m);
  resize: vertical;
}

.am-sheet__foot {
  display: flex;
  gap: 10px;
  align-items: center;
}

/* Узкое окно: столбец один, иначе поля сжимаются до нечитаемых. */
@media (max-width: 760px) {
  .am-sheet__body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
