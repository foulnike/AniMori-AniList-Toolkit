<script setup lang="ts">
// Плитка аниме: постер, название и метки поверх картинки.
// Одна на списки, поиск и полки главной: вид аниме везде один.
// Своих данных не добывает: сотня плиток ушла бы в сеть сотню раз.
// Метка доступности приходит готовой из core/playable по той же причине:
// спрашивать источники сама плитка не вправе.
//
// НАВЕДЕНИЕ ЖИВЁТ НА ВСЕЙ ПЛИТКЕ, А НЕ НА КНОПКЕ ОТКРЫТИЯ
// Крестик «не интересует» лежит рядом с кнопкой открытия, а не внутри неё:
// кнопку в кнопку вложить нельзя. Пока правила наведения висели на кнопке
// открытия, движок считал переход курсора на крестик уходом с плитки: постер
// оседал, блик откатывался, название теряло цвет ровно в тот миг, когда до
// крестика оставался пиксель. Теперь весь отклик висит на самом <li>: он занимает
// ту же коробку, что кнопка открытия, и накрывает крестик заодно.
// Клавиатурный случай — :has(:focus-visible), а не :focus-within: последний срабатывал
// бы и на обычном нажатии мышью, оставляя постер приподнятым после ухода
// курсора.
//
// ПРАВКА ЗАПИСИ — В ПРАВОМ УГЛУ, КРЕСТИК — В ЛЕВОМ
// Две кнопки разведены по углам сознательно и вместе не встречаются:
// крестик — только в витрине главной, правка — только в своих списках.
// На время наведения оценка каталога и точка идущего сезона уступают
// правке место точно так же, как метки слева уступают крестику.
import { computed, ref, watch } from 'vue'

import type { PlayState } from '@/core/playable'

import { soonHint, soonWord } from '../labels'
import SakuraBloom from './SakuraBloom.vue'

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
  /** Сколько раз пройдено повторно: знак без цифры, счёт — в подсказке. */
  repeat?: number
  /** Свой комментарий: знак с текстом в подсказке. */
  note?: string | null
  /** Идёт ли сезон прямо сейчас: тихая точка в углу. */
  ongoing?: boolean
  /** Ни одной части ещё не вышло: метка анонса. */
  soon?: boolean
  /** Есть ли аниме у источников видео. null — ещё не спрашивали, и метки не будет. */
  play?: PlayState | null
  /** Свой счёт частей строкой вида «7 / 12». */
  own?: string | null
  /** Доля пройденного от нуля до единицы: полоса внизу постера. */
  done?: number
  adult?: boolean
  /** Крестик «не интересует» поверх постера: только для плиток витрины. */
  hidable?: boolean
  /** Кнопка правки записи: только там, где запись уже есть. */
  editable?: boolean
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
  soon: false,
  play: null,
  own: null,
  done: 0,
  adult: false,
  hidable: false,
  editable: false,
})

const emit = defineEmits<{ (e: 'open'): void; (e: 'hide'): void; (e: 'edit'): void }>()

const imageFailed = ref(false)

watch(
  () => props.cover,
  () => {
    imageFailed.value = false
  },
)

/** Подложка в тон обложки: серый прямоугольник на месте картинки выглядит брошенным. */
const artStyle = computed(() => ({
  background: props.color ?? 'linear-gradient(160deg, var(--am-panel-2), var(--am-bg-2))',
}))

/** Первая буква названия — для аниме без обложки. */
const letter = computed(() => props.title.trim().charAt(0).toUpperCase() || '?')

/** Ширина полосы счёта. За края шкалы не выходим даже при чужом странном счёте. */
const donePart = computed(() => `${Math.round(Math.min(1, Math.max(0, props.done)) * 100)}%`)

/**
 * Подсказка отметки повторов. Сам счёт живёт только здесь: цифра рядом
 * со знаком читалась в сетке как вторая оценка.
 */
const repeatHint = computed(() => `Повторных проходов: ${props.repeat}`)

/**
 * Метка доступности. У анонса её нет вовсе: там смотреть нечего по самой
 * природе аниме, и об этом уже сказано меткой анонса. Две метки об одном
 * рядом читались бы как спор.
 *
 * Сидит она в правом нижнем углу постера, а не среди меток слева: там
 * говорят о самом аниме, а доступность — про наш плеер, и её место рядом
 * с кнопкой просмотра, а не рядом с оценкой.
 */
const playMark = computed<PlayState | null>(() => (props.soon ? null : props.play))

/** Подсказка метки: сам знак без подписи, всё словами говорится здесь. */
const playHint = computed(() =>
  playMark.value === 'yes' ? 'Можно посмотреть' : 'Нет в каталоге',
)

/** Есть ли вообще что показывать в левом верхнем углу. */
const hasTags = computed(
  () =>
    props.mark !== null ||
    props.adult ||
    props.soon ||
    props.repeat > 0 ||
    props.note !== null,
)
</script>

<template>
  <li class="am-tile" :class="{ 'am-tile--hidable': hidable, 'am-tile--edit': editable }">
    <button v-tip="title" class="am-tile__hit" type="button" @click="emit('open')">
      <span class="am-tile__art" :style="artStyle">
        <img
          v-if="cover && !imageFailed"
          class="am-tile__img"
          :src="cover"
          alt=""
          loading="lazy"
          decoding="async"
          @error="imageFailed = true"
        />
        <span v-else class="am-tile__letter" aria-hidden="true">{{ letter }}</span>

        <span class="am-tile__shade" aria-hidden="true" />
        <span class="am-tile__sheen" aria-hidden="true" />

        <span v-if="hasTags" class="am-tile__tags">
          <span v-if="soon" v-tip="soonHint()" class="am-tile__tag am-tile__tag--soon">
            {{ soonWord() }}
          </span>

          <span v-if="mark" class="am-tile__tag">{{ mark }}</span>

          <span v-if="repeat > 0" v-tip="repeatHint" class="am-tile__tag am-tile__tag--sign">
            ↻
          </span>

          <span v-if="note" v-tip="note" class="am-tile__tag am-tile__tag--sign">✎</span>

          <span v-if="adult" class="am-tile__tag am-tile__tag--adult">18+</span>
        </span>

        <span v-if="score" class="am-tile__score">{{ score }}</span>

        <span
          v-if="ongoing"
          v-tip="'Сезон идёт: части ещё выходят'"
          class="am-tile__live"
          :class="{ 'am-tile__live--low': score !== null }"
        />

        <span
          v-if="own"
          class="am-tile__own"
          :class="{ 'am-tile__own--play': playMark !== null }"
        >
          {{ own }}
        </span>

        <span
          v-if="playMark !== null"
          v-tip="playHint"
          class="am-tile__play"
          :class="{ 'am-tile__play--none': playMark === 'no' }"
          role="img"
          :aria-label="playHint"
        />

        <span v-if="done > 0" class="am-tile__line">
          <span class="am-tile__fill" :style="{ width: donePart }" />
        </span>
      </span>

      <span class="am-tile__name">{{ title }}</span>
      <span v-if="facts" class="am-tile__facts">{{ facts }}</span>
    </button>

    <!-- Знак «✕» спрятан от чтения с экрана, а подсказка v-tip рисуется своей
         плашкой в body и имени кнопке не даёт — отсюда явный aria-label.
         Подложка кнопки — не фон и не рамка, а цветок: см. SakuraBloom.vue. -->
    <button
      v-if="hidable"
      v-tip="'Не интересует'"
      class="am-tile__hide"
      type="button"
      aria-label="Не интересует"
      @click="emit('hide')"
    >
      <SakuraBloom />
      <span class="am-tile__hide-sign" aria-hidden="true">✕</span>
    </button>

    <!-- Знак ползунков, а не карандаш: правятся параметры записи —
         закладка, оценка, счёт серий, — а не текст. Карандаш занят знаком
         своего комментария в метках слева. -->
    <button
      v-if="editable"
      v-tip="'Изменить запись'"
      class="am-tile__edit"
      type="button"
      aria-label="Изменить запись"
      @click="emit('edit')"
    >
      <SakuraBloom />
      <svg class="am-tile__edit-sign" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.2 5.4h6.1M11.3 5.4h2.5M2.2 10.6h2.5M7.6 10.6h6.2" />
        <circle cx="9.8" cy="5.4" r="1.7" />
        <circle cx="6.1" cy="10.6" r="1.7" />
      </svg>
    </button>
  </li>
</template>

<style scoped>
/* Цвет текста и меток поверх постера не тематический: завеса под ними
   тёмная во всех трёх темах. Объявлен один раз и дальше берётся только var().
   --am-art-deep — то же самое, но плотное: для фигур, которые накладываются
   сами на себя и от полупрозрачности пошли бы швами. */
.am-tile {
  --am-on-art: #eef3fb;
  --am-art-deep: #0b1017;

  position: relative;
  min-width: 0;
}

.am-tile__hit {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  padding: 0;
  font: inherit;
  color: var(--am-text);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
}

/* Форма «листа»: три угла круглые, один почти острый. Ряд таких плиток
   читается ритмом, а не сеткой одинаковых прямоугольников. */
.am-tile__art {
  position: relative;
  display: block;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-leaf);
  box-shadow: var(--am-sh-2);
  transition:
    transform var(--am-mid) var(--am-ease),
    box-shadow var(--am-mid) var(--am-ease),
    border-color var(--am-mid) var(--am-ease),
    border-radius var(--am-slow) var(--am-ease);
}

/* Под курсором форма перетекает в «каплю»: движение самого края заметнее
   любой тени и не требует ни одного лишнего слова. */
.am-tile:hover .am-tile__art,
.am-tile:has(:focus-visible) .am-tile__art {
  border-color: color-mix(in srgb, var(--am-accent) 55%, transparent);
  border-radius: var(--am-r-drop);
  box-shadow:
    var(--am-sh-2),
    0 20px 46px rgb(var(--am-accent-rgb) / 0.26);
  transform: translateY(-6px) scale(1.015);
}

.am-tile:hover .am-tile__name {
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
  color: color-mix(in srgb, var(--am-on-art) 30%, transparent);
}

/* Завеса сверху и снизу — под метки и счёт, середина обложки свободна. */
.am-tile__shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--am-veil) 55%, transparent) 0%,
    transparent 32%,
    transparent 50%,
    color-mix(in srgb, var(--am-veil) 92%, transparent) 100%
  );
}

/* Блик пробегает по постеру один раз на наведение: постоянное свечение
   в сетке на сотню плиток было бы рябью. */
.am-tile__sheen {
  position: absolute;
  inset: -40% -20%;
  background: linear-gradient(
    104deg,
    transparent 44%,
    color-mix(in srgb, var(--am-on-art) 20%, transparent) 50%,
    transparent 56%
  );
  transform: translateX(-130%);
  transition: transform var(--am-slow) var(--am-ease);
  pointer-events: none;
}

.am-tile:hover .am-tile__sheen {
  transform: translateX(130%);
}

.am-tile__tags {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  gap: 4px;
  align-items: center;
  max-width: calc(100% - 46px);
  transition:
    opacity var(--am-fast) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
}

/* Крестик витрины занимает тот же левый угол, что метки, поэтому на
   время наведения метки уступают ему место: две стеклянные пилюли
   внахлёст не читаются ни одна. Уходят они влево, а не вверх: так это
   читается «метки посторонились», а не «метки улетели». */
.am-tile--hidable:hover .am-tile__tags,
.am-tile--hidable:has(:focus-visible) .am-tile__tags {
  opacity: 0;
  transform: translateX(-6px);
}

/* Метки — стекло, а не плотные пилюли: на светлых обложках чёрные плашки
   читались как грязь на картинке. */
.am-tile__tag {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--am-on-art);
  text-overflow: ellipsis;
  white-space: nowrap;
  background: color-mix(in srgb, var(--am-veil) 62%, transparent);
  border: 1px solid color-mix(in srgb, var(--am-on-art) 14%, transparent);
  border-radius: var(--am-r-cap);
  backdrop-filter: blur(8px) saturate(1.2);
}

/* Метка анонса: единственная цветная в ряду, и только потому, что говорит
   об аниме главное: смотреть пока нечего. */
.am-tile__tag--soon {
  color: var(--am-on-art);
  background: color-mix(in srgb, var(--am-accent) 58%, transparent);
  border-color: color-mix(in srgb, var(--am-accent) 66%, transparent);
}

/* Знаки пересмотра и заметки — круглые монетки без подписей: ряд пилюль
   разной длины читался как список оценок. Счёт и текст — в подсказке. */
.am-tile__tag--sign {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 11.5px;
  color: color-mix(in srgb, var(--am-on-art) 78%, transparent);
  transition:
    color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease),
    border-radius var(--am-mid) var(--am-ease);
}

.am-tile:hover .am-tile__tag--sign {
  color: var(--am-on-art);
  border-color: color-mix(in srgb, var(--am-on-art) 26%, transparent);
  border-radius: var(--am-r-drop);
}

.am-tile__tag--adult {
  color: var(--am-on-art);
  background: color-mix(in srgb, var(--am-bad) 62%, transparent);
  border-color: color-mix(in srgb, var(--am-bad) 70%, transparent);
}

/* Оценка каталога: стекло с тёплым текстом. Заливка жёлтым кричала
   громче самого постера. */
.am-tile__score {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 700;
  color: var(--am-warn);
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--am-veil) 62%, transparent);
  border: 1px solid color-mix(in srgb, var(--am-warn) 30%, transparent);
  border-radius: var(--am-r-cap);
  backdrop-filter: blur(8px);
  transition:
    opacity var(--am-fast) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
}

/* Идущий сезон — одна точка в углу: надпись шумела бы на всю сетку. */
.am-tile__live {
  position: absolute;
  top: 11px;
  right: 11px;
  width: 8px;
  height: 8px;
  background: var(--am-good);
  border-radius: var(--am-r-cap);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--am-good) 22%, transparent);
  animation: am-pulse 2.6s var(--am-ease-soft) infinite;
  transition:
    opacity var(--am-fast) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
}

@keyframes am-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--am-good) 22%, transparent);
  }
  50% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--am-good) 8%, transparent);
  }
}

/* Если в том же углу оценка каталога, точка садится под неё. */
.am-tile__live--low {
  top: 36px;
}

/* Правка стоит в том же правом углу, что оценка каталога и точка
   идущего сезона, и на время наведения те уступают ей место —
   зеркально тому, как метки слева уступают крестику витрины. */
.am-tile--edit:hover .am-tile__score,
.am-tile--edit:has(:focus-visible) .am-tile__score,
.am-tile--edit:hover .am-tile__live,
.am-tile--edit:has(:focus-visible) .am-tile__live {
  opacity: 0;
  transform: translateX(6px);
}

.am-tile__own {
  position: absolute;
  right: 10px;
  bottom: 11px;
  left: 10px;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  color: var(--am-on-art);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 4px var(--am-veil);
}

/* Счёт частей и метка доступности стоят в одной строке, поэтому счёт
   уступает ей полосу справа: иначе «12 / 24» уезжало бы под знак. */
.am-tile__own--play {
  right: 28px;
}

/* Метка доступности: маленький Play в правом нижнем углу. Слов нет вовсе:
   треугольник понятен без подписи, а пилюля «Есть видео» отнимала бы
   половину верхнего ряда у меток о самом аниме.

   ОПРАВЫ НЕТ НАРОЧНО
   Раньше здесь сидела стеклянная монета с акцентным градиентом, оправой
   и цветным свечением — единственный объёмный предмет на плоском постере,
   и в полке из четырнадцати плиток глаз цеплялся за ряд кружков раньше,
   чем за сами обложки. Оправа бралась от знаков повтора и заметки, но те
   стоят в другом углу и в другом ряду. Ближайший сосед метки — счёт частей
   слева в той же строке, а он без всякой подложки и держится на тени.
   Знак теперь собран так же: голый треугольник с мягкой тенью. Тень закрывает
   старую претензию к голому знаку — потерю на светлых кадрах, — но не добавляет
   на картинку ни одной лишней границы.

   Отклик ушёл в наведение: в покое знак молчит, под курсором наливается
   светом и берёт акцентный ореол. Акцент именно ореолом, а не цветом самого
   знака: --am-accent в светлой теме тёмно-синий и на тёмной завесе сел бы
   по контрасту. */
.am-tile__play {
  --am-play-shade: drop-shadow(0 1px 3px var(--am-veil));

  position: absolute;
  right: 10px;
  bottom: 13px;
  display: grid;
  place-items: center;
  width: 12px;
  height: 14px;
  color: color-mix(in srgb, var(--am-on-art) 86%, transparent);
  filter: var(--am-play-shade);
  transition:
    color var(--am-fast) var(--am-ease),
    filter var(--am-mid) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
}

/* Сам знак. clip-path, а не рамки: так треугольник остаётся ровно в центре
   своей клетки и поверх него можно положить перечёркивание. Полпикселя
   вправо — правка оптическая: у треугольника центр тяжести левее середины. */
.am-tile__play::before {
  grid-area: 1 / 1;
  width: 9px;
  height: 11px;
  content: '';
  background: currentcolor;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  transform: translateX(0.5px);
}

.am-tile:hover .am-tile__play,
.am-tile:has(:focus-visible) .am-tile__play {
  color: var(--am-on-art);
  filter: var(--am-play-shade) drop-shadow(0 0 7px rgb(var(--am-accent-rgb) / 0.55));
  transform: scale(1.12);
}

/* «Нет в каталоге»: тот же знак, только погашенный и перечёркнутый. Это
   отсутствие в нашем плеере, а не свойство аниме: красным здесь кричать
   не о чем, и в ряду плиток такая метка обязана молчать — оттого у неё нет
   ни акцентного ореола, ни роста под курсором. */
.am-tile__play--none {
  color: color-mix(in srgb, var(--am-on-art) 40%, transparent);
}

.am-tile:hover .am-tile__play--none,
.am-tile:has(:focus-visible) .am-tile__play--none {
  color: color-mix(in srgb, var(--am-on-art) 62%, transparent);
  filter: var(--am-play-shade);
  transform: none;
}

/* Черта идёт по диагонали от края до края: короткий штрих поверх
   треугольника читался царапиной на картинке. Тёмная обводка отделяет её
   от знака под ней: без оправы два светлых слоя одного цвета слиплись бы
   в сплошное пятно. */
.am-tile__play--none::after {
  grid-area: 1 / 1;
  width: 17px;
  height: 1.5px;
  content: '';
  background: currentcolor;
  border-radius: 1px;
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--am-veil) 78%, transparent);
  transform: rotate(-45deg);
}

.am-tile__line {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 3px;
  background: color-mix(in srgb, var(--am-on-art) 18%, transparent);
}

.am-tile__fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--am-accent), var(--am-accent-2));
  box-shadow: 0 0 10px rgb(var(--am-accent-rgb) / 0.5);
  transition: width var(--am-slow) var(--am-ease);
}

.am-tile__name {
  display: -webkit-box;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.35;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  transition: color var(--am-fast) var(--am-ease);
}

.am-tile__facts {
  overflow: hidden;
  font-size: 12px;
  color: var(--am-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Крестик «не интересует»: виден под курсором и фокусом, а не всегда.
   Сидит слева: в правом углу он закрывал оценку каталога и точку
   идущего сезона — ровно то, по чему выбирают аниме в витрине.
   Показ идёт прозрачностью, а не переключением display: с none на inline-flex
   браузер успевал показать символ по базовой линии — крестик сидел
   на полпикселя ниже центра.

   Появляется он не на месте, а вырастает из самого угла постера: кружок,
   возникший из ничего прямо под курсором, читался случайным попаданием,
   а не предложением действия. Точка роста — верхний левый угол, оттуда
   же уходят метки.

   ФОРМЫ У САМОЙ КНОПКИ БОЛЬШЕ НЕТ
   Ни фона, ни рамки, ни размытия: круг и распускающийся цветок рисует
   вложенный SakuraBloom.vue, а кнопка осталась пустой коробкой под ним.
   Так сделано потому, что лепестки выходят за её край и накладываются друг
   на друга — border-radius вогнутых впадин не умеет вовсе, а clip-path на
   самой кнопке обрезал бы и попадание курсора, и кольцо фокуса.
   border-radius всё же оставлен: он больше ничего не красит, но по нему
   идёт обводка :focus-visible, и без него кольцо вышло бы квадратным
   вокруг круглого предмета. */
.am-tile__hide {
  --am-bloom-deep: var(--am-art-deep);
  --am-bloom-petal: color-mix(in srgb, var(--am-sakura) 34%, var(--am-art-deep));
  --am-bloom-out: 2px;

  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  color: var(--am-on-art);
  visibility: hidden;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  opacity: 0;
  transform: translate(-4px, -4px) scale(0.84);
  transform-origin: top left;
  transition:
    opacity var(--am-fast) var(--am-ease),
    visibility var(--am-fast) var(--am-ease),
    color var(--am-fast) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
}

/* Цель нажатия расширена до 44 пикселей невидимой окантовкой. */
.am-tile__hide::before {
  position: absolute;
  inset: -8px;
  content: '';
}

.am-tile:hover .am-tile__hide,
.am-tile:has(:focus-visible) .am-tile__hide {
  visibility: visible;
  opacity: 1;
  transform: none;
}

/* Символ лежит поверх цветка: сам цветок вынут из потока через absolute,
   а позиционированное рисуется выше обычного — без своего z-index знак
   ушёл бы под лепестки. Центровку держит сетка родителя. */
.am-tile__hide-sign {
  position: relative;
  z-index: 1;
  display: block;
  transition: transform var(--am-fast) var(--am-ease);
}

.am-tile__hide:hover > .am-tile__hide-sign,
.am-tile__hide:focus-visible > .am-tile__hide-sign {
  transform: translateY(-1px);
}

/* Правка записи собрана тем же способом, что крестик витрины, только
   в другом углу и с другой точкой роста: кнопка вырастает из верхнего
   правого угла постера. Всё прочее — отсутствие своей формы, цветок под
   знаком, расширенная цель нажатия — взято оттуда же без изменений. */
.am-tile__edit {
  --am-bloom-deep: var(--am-art-deep);
  --am-bloom-petal: color-mix(in srgb, var(--am-sakura) 34%, var(--am-art-deep));
  --am-bloom-out: 2px;

  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  font: inherit;
  line-height: 1;
  color: var(--am-on-art);
  visibility: hidden;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  opacity: 0;
  transform: translate(4px, -4px) scale(0.84);
  transform-origin: top right;
  transition:
    opacity var(--am-fast) var(--am-ease),
    visibility var(--am-fast) var(--am-ease),
    color var(--am-fast) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
}

.am-tile__edit::before {
  position: absolute;
  inset: -8px;
  content: '';
}

.am-tile:hover .am-tile__edit,
.am-tile:has(:focus-visible) .am-tile__edit {
  visibility: visible;
  opacity: 1;
  transform: none;
}

/* Знак поверх цветка — та же причина, что у крестика. Обводка рисуется
   цветом текста: оттенки знака тогда живут в одном правиле с кнопкой. */
.am-tile__edit-sign {
  position: relative;
  z-index: 1;
  display: block;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentcolor;
  stroke-width: 1.5;
  stroke-linecap: round;
  transition: transform var(--am-fast) var(--am-ease);
}

.am-tile__edit:hover > .am-tile__edit-sign,
.am-tile__edit:focus-visible > .am-tile__edit-sign {
  transform: translateY(-1px);
}

/* Где курсора нет вовсе — правка видна сразу: навести пальцем нельзя,
   а без кнопки правка со списка там была бы недоступна вовсе. Крестик
   витрины сюда не входит нарочно: «не интересует» — действие редкое
   и необратимое, и постоянный крестик на каждой плитке витрины
   ловился бы пальцем случайно. */
@media (hover: none) {
  .am-tile__edit {
    visibility: visible;
    opacity: 1;
    transform: none;
  }
}

/* Спокойное движение: системная просьба сильнее наших красот. */
@media (prefers-reduced-motion: reduce) {
  .am-tile:hover .am-tile__art,
  .am-tile:has(:focus-visible) .am-tile__art,
  .am-tile:hover .am-tile__play,
  .am-tile:has(:focus-visible) .am-tile__play,
  .am-tile--hidable:hover .am-tile__tags,
  .am-tile--hidable:has(:focus-visible) .am-tile__tags,
  .am-tile--edit:hover .am-tile__score,
  .am-tile--edit:has(:focus-visible) .am-tile__score,
  .am-tile--edit:hover .am-tile__live,
  .am-tile--edit:has(:focus-visible) .am-tile__live,
  .am-tile__hide,
  .am-tile__hide:hover > .am-tile__hide-sign,
  .am-tile__hide:focus-visible > .am-tile__hide-sign,
  .am-tile__edit,
  .am-tile__edit:hover > .am-tile__edit-sign,
  .am-tile__edit:focus-visible > .am-tile__edit-sign {
    transform