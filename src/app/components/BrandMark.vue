<script setup lang="ts">
// Знак сервиса: плита фирменного цвета и вектор поверх неё.
//
// Вектор берётся из файлов в src/app/brand, а не рисуется здесь руками.
// Прежде знаки были нарисованы на глаз прямо в разметке экранов, и это было
// видно: «AL» стояла кривовато, «Я» Яндекса не совпадала с фирменной,
// иероглиф 示 был приблизительным. Логотипы уже нарисованы теми, кому они
// принадлежат, и дело оболочки — показать их, а не перерисовать.
//
// Откуда что взято:
//   anilist.svg, shikimori.svg — simple-icons, CC0 1.0. Файлы лежат без
//     единой правки, поэтому обновление сводится к замене файла.
//   yandex-disk.svg — глиф диска из lucide, ISC. Фирменного вектора
//     Яндекс Диска в открытых наборах нет, а знак «Яндекс Облака» —
//     другой продукт, и ставить его под «Диск» неверно. Узнаваемость
//     здесь даёт фирменная плита, а глиф взят нейтральный и в один штрих
//     с остальными значками приложения.
//
// Почему не PNG: знак живёт на плите 24-28 пикселей, на трёх темах
// и при дробном масштабе окна. Растр пришлось бы класть в двух-трёх
// размерах и всё равно мылить между ними. Единственная растровая
// картинка в оболочке — иконка самого приложения (AppMark.vue): она одна,
// её рисовали не мы, и она уже лежит в репозитории иконкой окна.
//
// ?raw, а не <img src>: файл встраивается в разметку, и цвет знака
// задаётся отсюда. Через <img> он остался бы чёрным, как лежит в файле.
import { computed } from 'vue'

import anilistGlyph from '../brand/anilist.svg?raw'
import shikimoriGlyph from '../brand/shikimori.svg?raw'
import yandexDiskGlyph from '../brand/yandex-disk.svg?raw'

type BrandName = 'anilist' | 'shikimori' | 'yandex-disk'

type Brand = {
  /** Содержимое файла знака: вставляется в разметку как есть. */
  glyph: string
  /** Плита под знаком — фирменный цвет сервиса. */
  plate: string
  /** Сам знак поверх плиты. */
  ink: string
  /**
   * Доля плиты под знак. Оптический размер у знаков разный: плотная
   * «AL» требует полей больше, чем воздушный 示 с деревьями.
   */
  size: string
  /** Знак нарисован штрихом, а не заливкой. */
  stroke?: boolean
}

const BRANDS: Record<BrandName, Brand> = {
  anilist: {
    glyph: anilistGlyph,
    plate: '#02a9ff',
    ink: '#ffffff',
    size: '58%',
  },
  shikimori: {
    glyph: shikimoriGlyph,
    plate: '#aad3e7',
    ink: '#16202c',
    size: '78%',
  },
  'yandex-disk': {
    glyph: yandexDiskGlyph,
    plate: '#fc3f1d',
    ink: '#ffffff',
    size: '64%',
    stroke: true,
  },
}

const props = defineProps<{ name: BrandName }>()

const brand = computed<Brand>(() => BRANDS[props.name])
</script>

<template>
  <!-- aria-hidden: название сервиса всегда стоит текстом рядом,
       и знак второй раз его не проговаривает. -->
  <span
    class="am-brand"
    :class="{ 'am-brand--stroke': brand.stroke === true }"
    :style="{
      '--am-brand-plate': brand.plate,
      '--am-brand-ink': brand.ink,
      '--am-brand-size': brand.size,
    }"
    aria-hidden="true"
    v-html="brand.glyph"
  />
</template>

<style scoped>
/* Размер приходит снаружи: в панели импорта знак 28 пикселей,
   в строке облака — 24. Здесь только форма, цвет и центровка.

   overflow: hidden обязателен: знаки нарисованы во всю ширину своего
   квадрата, и без обрезки заливка вылезала бы за скругление плиты. */
.am-brand {
  display: grid;
  flex: none;
  place-items: center;
  overflow: hidden;
  color: var(--am-brand-ink);
  background: var(--am-brand-plate);
  border-radius: 26%;
}

/* :deep обязателен: вектор встроен через v-html и метки области
   видимости не получает. */
.am-brand :deep(svg) {
  display: block;
  width: var(--am-brand-size);
  height: var(--am-brand-size);
  fill: currentColor;
}

/* Штриховой знак заливать нельзя: она слепила бы контур в пятно. */
.am-brand--stroke :deep(svg) {
  fill: none;
  stroke: currentColor;
}
</style>
