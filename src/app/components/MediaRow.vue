<script setup lang="ts">
// Строка списка: тот же тайтл, что на плитке, но в один этаж.
// Два вида одним компонентом: без постера и с миниатюрой (флажок art).
//
// Отдельный компонент, а не режим MediaTile: плитка стоит на постере во всю
// ширину колонки и держит метки поверх обложки, так что в строку её
// разметка не переворачивается.
const props = withDefaults(
  defineProps<{
    title: string
    facts?: string
    cover?: string | null
    color?: string | null
    mark?: string | null
    repeat?: number
    ongoing?: boolean
    own?: string | null
    done?: number
    adult?: boolean
    /** Показывать ли миниатюру постера слева. */
    art?: boolean
  }>(),
  {
    facts: '',
    cover: null,
    color: null,
    mark: null,
    repeat: 0,
    ongoing: false,
    own: null,
    done: 0,
    adult: false,
    art: false,
  },
)

const emit = defineEmits<{ (e: 'open'): void }>()

/** Ширина полосы пройденного. Зажата в 0..1: пересмотр даёт больше единицы. */
function barWidth(): string {
  const part = Math.min(1, Math.max(0, props.done))
  return `${Math.round(part * 100)}%`
}
</script>

<template>
  <li class="am-row" :class="{ 'am-row--art': art }">
    <button class="am-row__hit" type="button" @click="emit('open')">
      <img
        v-if="art && cover"
        class="am-row__art"
        :src="cover"
        :alt="title"
        loading="lazy"
        decoding="async"
      />
      <span v-else-if="art" class="am-row__art am-row__art--empty" aria-hidden="true">
        {{ title.slice(0, 1) }}
      </span>
      <!-- В компактной строке постера нет, и цвет тайтла остаётся
           единственной приметой, по которой глаз ловит знакомую запись. -->
      <span
        v-else
        class="am-row__dot"
        :style="color ? { background: color } : undefined"
        aria-hidden="true"
      />

      <span class="am-row__text">
        <span class="am-row__name">{{ title }}</span>

        <span class="am-row__facts">
          <span v-if="facts">{{ facts }}</span>
          <span v-if="own">{{ own }}</span>
          <span v-if="repeat > 0">↻ {{ repeat }}</span>
          <span v-if="ongoing" class="am-row__live">идёт</span>
          <span v-if="adult" class="am-row__adult">18+</span>
        </span>

        <span v-if="done > 0" class="am-line am-row__line">
          <span class="am-line__fill" :style="{ width: barWidth() }" />
        </span>
      </span>

      <span v-if="mark" class="am-row__mark">{{ mark }}</span>
    </button>
  </li>
</template>

<style scoped>
.am-row {
  list-style: none;
}

/* Цель нажатия — вся строка: в закладке на сотни записей целиться
   в само название невозможно. */
.am-row__hit {
  display: flex;
  gap: 12px;
  align-items: center;
  width: 100%;
  min-height: 46px;
  padding: 7px 14px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

/* Строка с миниатюрой выше и уже не капсула: капсула высотой в 74 пикселя
   читается таблеткой, и прямоугольный постер в неё не вписывается. */
.am-row--art .am-row__hit {
  min-height: 74px;
  padding: 8px 16px 8px 10px;
  border-radius: var(--am-r-m);
}

.am-row__hit:hover,
.am-row__hit:focus-visible {
  background: var(--am-hover);
  border-color: rgb(var(--am-accent-rgb) / 0.45);
  transform: translateY(-1px);
}

.am-row__hit:hover .am-row__name,
.am-row__hit:focus-visible .am-row__name {
  color: var(--am-accent);
}

.am-row__art {
  flex: none;
  width: 40px;
  height: 58px;
  object-fit: cover;
  background: var(--am-fill-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-s);
}

.am-row__art--empty {
  display: grid;
  place-items: center;
  font-size: 18px;
  color: var(--am-faint);
}

.am-row__dot {
  flex: none;
  width: 8px;
  height: 8px;
  background: var(--am-fill-3);
  border-radius: var(--am-r-cap);
}

.am-row__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

/* Название в одну строку с отсечкой: ровный шаг строк важнее полного
   имени у трёх самых длинных тайтлов. */
.am-row__name {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--am-fast) var(--am-ease);
}

.am-row__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--am-faint);
}

.am-row__live {
  color: var(--am-good);
}

.am-row__adult {
  color: var(--am-bad);
}

/* Полоса пройденного не тянется во всю строку: на широком окне она
   превращалась в линейку через весь экран. */
.am-row__line {
  max-width: 220px;
  height: 3px;
}

.am-row__mark {
  flex: none;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--am-warn);
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .am-row__hit:hover,
  .am-row__hit:focus-visible {
    transform: none;
  }
}
</style>
