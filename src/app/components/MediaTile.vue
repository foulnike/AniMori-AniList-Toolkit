<script setup lang="ts">
// Плитка тайтла: постер, название и метки поверх картинки.
// Одна на списки, поиск и полки главной: вид тайтла везде один.
// Своих данных не добывает: сотня плиток ушла бы в сеть сотню раз.
import { computed } from 'vue'

interface Props {
  title: string
  /** Короткая подпись под названием: вид, год, части. */
  facts?: string
  cover?: string | null
  /** Цвет обложки для подложки, пока картинка едет. */
  color?: string | null
  /** Оценка сервера: правый верхний угол постера. */
  score?: string | null
  /** Своя закладка или своя оценка: левый верхний угол. */
  mark?: string | null
  /** Сколько раз пройдено повторно: отметка рядом с оценкой. */
  repeat?: number
  /** Свой комментарий: отметка с текстом во всплывающей подсказке. */
  note?: string | null
  /** Идёт ли сезон прямо сейчас: тихая точка в углу. */
  ongoing?: boolean
  /** Свой счёт частей строкой вида «7 / 12». */
  own?: string | null
  /** Доля пройденного от нуля до единицы: полоса внизу постера. */
  done?: number
  adult?: boolean
  /** Крестик «не интересует» поверх постера: только для плиток витрины. */
  hidable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  facts: '',
  cover: null,
  color: null,
  score: null,
  mark: null,
  repeat: 0,
  note: null,
  ongoing: false,
  own: null,
  done: 0,
  adult: false,
  hidable: false,
})

const emit = defineEmits<{ (e: 'open'): void; (e: 'hide'): void }>()

/** Подложка в тон обложки: серый прямоугольник на месте картинки выглядит брошенным. */
const artStyle = computed(() => ({
  background: props.color ?? 'linear-gradient(160deg, #1b2534, #0f151e)',
}))

/** Первая буква названия — для тайтла без обложки. */
const letter = computed(() => props.title.trim().charAt(0).toUpperCase() || '?')

/** Ширина полосы счёта. За края шкалы не выходим даже при чужом странном счёте. */
const donePart = computed(() => `${Math.round(Math.min(1, Math.max(0, props.done)) * 100)}%`)

/** Подсказка отметки повторов: знак сам за себя не говорит. */
const repeatHint = computed(() => `Повторных проходов: ${props.repeat}`)

/** Есть ли вообще что показывать в левом верхнем углу. */
const hasTags = computed(
  () => props.mark !== null || props.adult || props.repeat > 0 || props.note !== null,
)
</script>

<template>
  <li class="am-tile">
    <button class="am-tile__hit" type="button" :title="title" @click="emit('open')">
      <span class="am-tile__art" :style="artStyle">
        <img
          v-if="cover"
          class="am-tile__img"
          :src="cover"
          alt=""
          loading="lazy"
          decoding="async"
        />
        <span v-else class="am-tile__letter" aria-hidden="true">{{ letter }}</span>

        <span class="am-tile__shade" aria-hidden="true" />

        <span v-if="hasTags" class="am-tile__tags">
          <span v-if="mark" class="am-tile__tag">{{ mark }}</span>

          <span v-if="repeat > 0" class="am-tile__tag am-tile__tag--sign" :title="repeatHint">
            ↻{{ repeat }}
          </span>

          <span v-if="note" class="am-tile__tag am-tile__tag--sign" :title="note">✎</span>

          <span v-if="adult" class="am-tile__tag am-tile__tag--adult">18+</span>
        </span>

        <span v-if="score" class="am-tile__score">{{ score }}</span>

        <span
          v-if="ongoing"
          class="am-tile__live"
          :class="{ 'am-tile__live--low': score !== null }"
          title="Сезон идёт: части ещё выходят"
        />

        <span v-if="own" class="am-tile__own">{{ own }}</span>

        <span v-if="done > 0" class="am-tile__line">
          <span class="am-tile__fill" :style="{ width: donePart }" />
        </span>
      </span>

      <span class="am-tile__name">{{ title }}</span>
      <span v-if="facts" class="am-tile__facts">{{ facts }}</span>
    </button>

    <button
      v-if="hidable"
      class="am-tile__hide"
      type="button"
      title="Не интересует"
      @click="emit('hide')"
    >
      ✕
    </button>
  </li>
</template>

<style scoped>
.am-tile {
  position: relative;
  min-width: 0;
}

.am-tile__hit {
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 100%;
  padding: 0;
  font: inherit;
  color: var(--am-text);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
}

.am-tile__art {
  position: relative;
  display: block;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
  box-shadow: var(--am-sh-2);
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease,
    border-color 0.16s ease;
}

.am-tile__hit:hover .am-tile__art {
  border-color: rgba(88, 166, 255, 0.55);
  box-shadow: 0 22px 46px rgba(2, 5, 10, 0.65);
  transform: translateY(-4px);
}

.am-tile__hit:hover .am-tile__name {
  color: var(--am-accent);
}

.am-tile__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.am-tile__letter {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 34px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.32);
}

.am-tile__shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    rgba(3, 6, 12, 0.55) 0%,
    rgba(3, 6, 12, 0) 34%,
    rgba(3, 6, 12, 0) 52%,
    rgba(3, 6, 12, 0.88) 100%
  );
}

.am-tile__tags {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  gap: 4px;
  max-width: calc(100% - 44px);
}

.am-tile__tag {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  color: #eaf1fb;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: rgba(8, 12, 18, 0.72);
  border-radius: 999px;
}

/* Отметка знаком тише оценки: она рядом, а не вместо неё. */
.am-tile__tag--sign {
  padding: 3px 7px;
  font-size: 10.5px;
  color: #cbd7e8;
}

.am-tile__tag--adult {
  color: #ffd9d9;
  background: rgba(255, 90, 90, 0.6);
}

.am-tile__score {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 700;
  color: #101820;
  background: linear-gradient(180deg, #ffe49a, var(--am-warn));
  border-radius: 999px;
}

/* Идущий сезон — одна точка в углу: надпись шумела бы на всю сетку. */
.am-tile__live {
  position: absolute;
  top: 11px;
  right: 11px;
  width: 8px;
  height: 8px;
  background: var(--am-good);
  border-radius: 999px;
  box-shadow:
    0 0 0 3px rgba(61, 220, 151, 0.18),
    0 1px 3px rgba(0, 0, 0, 0.6);
}

/* Если в том же углу оценка каталога, точка садится под неё. */
.am-tile__live--low {
  top: 34px;
}

.am-tile__own {
  position: absolute;
  right: 10px;
  bottom: 10px;
  left: 10px;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  color: #eef3fb;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
}

.am-tile__line {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.18);
}

.am-tile__fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--am-accent), var(--am-accent-2));
}

.am-tile__name {
  display: -webkit-box;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.35;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.am-tile__facts {
  overflow: hidden;
  font-size: 12px;
  color: var(--am-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Крестик «не интересует»: виден под курсором и фокусом, а не всегда. */
.am-tile__hide {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: #eaf1fb;
  cursor: pointer;
  background: rgba(8, 12, 18, 0.85);
  border: 1px solid var(--am-line-soft);
  border-radius: 999px;
}

/* Цель нажатия расширена до 44 пикселей невидимой окантовкой. */
.am-tile__hide::before {
  position: absolute;
  inset: -8px;
  content: '';
}

.am-tile:hover .am-tile__hide,
.am-tile:focus-within .am-tile__hide {
  display: inline-flex;
}
</style>
