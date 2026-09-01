<script setup lang="ts">
// Пункт 3.2: постоянная рамка окна — рельс меню слева, шапка сверху,
// сменный экран внутри. Сама рамка о экранах не знает ничего,
// кроме имён и подписей из routes.ts.
//
// Рельс и шапка — плавающее стекло: подложка окна из theme.css должна
// просвечивать, иначе она читается картинкой за глухими панелями.
import { computed } from 'vue'

import { APPEARANCES, appearance, setAppearance } from '../appearance'
import { currentRoute, goBack, navigate } from '../router'
import { MENU, SCREEN_TITLES } from '../router/routes'

import AppMark from './AppMark.vue'

const version = __ANIMORI_VERSION__

const active = computed(() => currentRoute.value.name)
const title = computed(() => SCREEN_TITLES[active.value])

// «Назад» нужен только там, куда пришли изнутри приложения:
// на экранах из меню он увёл бы в пустую историю окна.
// Кнопка живёт только здесь: вторая в карточке была дублём.
//
// Журнал в этом списке обязателен: в меню его нет, ведёт на него кнопка
// из настроек, и без «Назад» из журнала не выйти вовсе.
const BACK_SCREENS: ReadonlyArray<string> = ['media', 'studio', 'log']

const canGoBack = computed(() => BACK_SCREENS.includes(active.value))

/** Обновление окна целиком, как в браузере: одна кнопка на все экраны. */
function onReload(): void {
  window.location.reload()
}
</script>

<template>
  <div class="am-shell">
    <aside class="am-side">
      <div class="am-side__brand">
        <!-- Знак приложения отдельным компонентом: три темы ему нужны всегда,
             и держать их в разметке рельса было не место. -->
        <AppMark class="am-side__logo" />

        <span class="am-side__name">AniMori</span>
      </div>

      <nav class="am-side__menu">
        <button
          v-for="item in MENU"
          :key="item.name"
          v-tip="item.title"
          class="am-side__item"
          :class="{ 'am-side__item--on': item.name === active }"
          type="button"
          @click="navigate(item.name)"
        >
          <span class="am-side__icon" aria-hidden="true">{{ item.icon }}</span>
          <span class="am-side__text">{{ item.title }}</span>
        </button>
      </nav>

      <span class="am-side__foot">{{ version }}</span>
    </aside>

    <div class="am-body">
      <header class="am-top">
        <button v-if="canGoBack" class="am-top__back" type="button" @click="goBack">
          <span class="am-top__sign" aria-hidden="true">←</span>
          <span class="am-top__word">Назад</span>
        </button>
        <h1 class="am-top__title">{{ title }}</h1>

        <span class="am-top__gap" />

        <div class="am-skin" role="group" aria-label="Тема оформления">
          <button
            v-for="item in APPEARANCES"
            :key="item.name"
            v-tip="item.title"
            class="am-skin__btn"
            :class="{ 'am-skin__btn--on': item.name === appearance }"
            type="button"
            :aria-pressed="item.name === appearance"
            @click="setAppearance(item.name)"
          >
            <span aria-hidden="true">{{ item.mark }}</span>
          </button>
        </div>

        <button v-tip="'Обновить окно'" class="am-top__icon" type="button" @click="onReload">
          <span aria-hidden="true">⟳</span>
        </button>
      </header>

      <main class="am-view">
        <div :key="active" class="am-view__hold">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.am-shell {
  display: grid;
  grid-template-columns: var(--am-side) minmax(0, 1fr);
  min-height: 100vh;
}

/* Рельс меню оторван от краёв окна: стекло видно только там, где есть что
   размывать вокруг. Прижатый к краю он оставался бы просто тёмной полосой. */
.am-side {
  position: sticky;
  top: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: calc(100vh - 28px);
  margin: 14px 0 14px 14px;
  padding: 18px 12px 16px;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-xl);
  box-shadow: var(--am-sh-1), inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur-strong)) saturate(1.3);
}

.am-side__brand {
  display: flex;
  gap: 11px;
  align-items: center;
  padding: 2px 8px 6px;
}

/* Здесь только размер и ореол: сам знак и его темы живут в AppMark.vue. */
.am-side__logo {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 12px;
  box-shadow: 0 8px 22px rgb(var(--am-accent-rgb) / 0.35);
}

/* На AMOLED ореол убирается: знак там сам тёмный, и свечение вокруг него
   на чистом чёрном читается грязным пятном. */
:global([data-am-skin='amoled']) .am-side__logo {
  box-shadow: none;
}

.am-side__name {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.am-side__menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.am-side__item {
  position: relative;
  display: flex;
  gap: 12px;
  align-items: center;
  min-height: var(--am-touch);
  padding: 0 14px;
  font: inherit;
  font-weight: 550;
  color: var(--am-dim);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

.am-side__item:hover {
  color: var(--am-text);
  background: var(--am-fill-1);
}

.am-side__item--on {
  color: var(--am-text);
  background: linear-gradient(
    100deg,
    rgb(var(--am-accent-rgb) / 0.22),
    rgb(var(--am-accent-2-rgb) / 0.1)
  );
}

/* Активный пункт помечен каплей слева, а не рамкой: её видно и в узком
   рельсе, где подписи скрыты. */
.am-side__item--on::before {
  position: absolute;
  top: 50%;
  left: 4px;
  width: 3px;
  height: 18px;
  content: '';
  background: linear-gradient(180deg, var(--am-accent), var(--am-accent-2));
  border-radius: var(--am-r-cap);
  box-shadow: 0 0 10px rgb(var(--am-accent-rgb) / 0.6);
  transform: translateY(-50%);
  animation: am-mark var(--am-mid) var(--am-ease) both;
}

@keyframes am-mark {
  from {
    height: 4px;
    opacity: 0;
  }
  to {
    height: 18px;
    opacity: 1;
  }
}

/* Значок пункта — в своём квадрате с центровкой по двум осям. text-align
   ровнял только по горизонтали, а по вертикали знак стоял на базовой
   линии шрифта: у разных символов она разная, и ряд пунктов плясал. */
.am-side__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  font-size: 16px;
  line-height: 1;
}

.am-side__foot {
  margin-top: auto;
  padding: 0 10px;
  font-size: 12px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

.am-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* Шапка держится сверху: при сетке в тысячу плиток вернуться к ней иначе долго. */
.am-top {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px clamp(18px, 2vw, 44px);
}

/* Граница шапки — перетекание вниз, а не линия: жёсткий край резал
   уезжающие плитки пополам. Слой отдельный: маска на самой шапке съела бы
   и кнопки вместе с фоном. */
.am-top::before {
  position: absolute;
  inset: 0 0 -28px;
  content: '';
  background: linear-gradient(180deg, var(--am-bar) 0%, var(--am-bar) 58%, transparent 100%);
  backdrop-filter: blur(var(--am-blur-strong)) saturate(1.2);
  -webkit-mask-image: linear-gradient(180deg, #000 58%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 58%, transparent 100%);
  pointer-events: none;
}

.am-top > * {
  position: relative;
  z-index: 1;
}

.am-top__back {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  min-height: 34px;
  padding: 0 14px;
  font: inherit;
  font-size: 13px;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-top__back:hover,
.am-top__back:focus-visible {
  color: var(--am-text);
  background: var(--am-fill-2);
  transform: translateX(-2px);
}

/* Стрелка «Назад» в своём квадрате: без него она тянула строку вниз
   и слово рядом стояло на пиксель выше знака. */
.am-top__sign {
  display: grid;
  flex: none;
  place-items: center;
  width: 14px;
  height: 14px;
  font-size: 14px;
  line-height: 1;
}

.am-top__title {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.012em;
}

.am-top__gap {
  flex: 1;
}

/* Переключатель тем: три знака в одной капсуле. Подписи живут в подсказке:
   три слова в шапке шумели бы громче заголовка экрана. */
.am-skin {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
}

/* Знаки тем разной высоты (солнце, луна, круг), поэтому центр считается
   от кнопки, а не от строки текста. */
.am-skin__btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 28px;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  color: var(--am-faint);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-mid) var(--am-ease);
}

.am-skin__btn:hover,
.am-skin__btn:focus-visible {
  color: var(--am-text);
}

.am-skin__btn > span {
  display: block;
  transition: transform var(--am-fast) var(--am-ease);
}

/* Знак поднимается вместо подсветки целой кнопки: подложка здесь
   занята выбранной темой. */
.am-skin__btn:hover > span,
.am-skin__btn:focus-visible > span {
  transform: translateY(-1px);
}

.am-skin__btn--on {
  color: var(--am-text);
  background: var(--am-glass-2);
  box-shadow: var(--am-sh-1), inset 0 1px 0 var(--am-edge);
}

/* Круглая кнопка справа: обновляет окно целиком. */
.am-top__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  font: inherit;
  font-size: 16px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-top__icon:hover,
.am-top__icon:focus-visible {
  color: var(--am-text);
  border-color: var(--am-accent);
}

/* Крутится сам знак, а не кнопка: поворот всей кнопки тащил за собой
   рамку и фокусное кольцо, а они должны стоять на месте. */
.am-top__icon > span {
  display: block;
  transition: transform var(--am-slow) var(--am-ease);
}

.am-top__icon:hover > span,
.am-top__icon:focus-visible > span {
  transform: rotate(180deg);
}

.am-view {
  flex: 1;
  width: 100%;
  padding: clamp(16px, 1.6vw, 30px) clamp(18px, 2vw, 44px) 72px;
}

/* Потолок ширины с центровкой: без него на широком окне
   строка текста тянулась бы метрами. */
.am-view__hold {
  width: 100%;
  max-width: var(--am-page-max);
  margin: 0 auto;
  animation: am-rise var(--am-mid) var(--am-ease) both;
}

/* Смена экрана всплывает, а не моргает: ключ на имени экрана перезапускает
   эту анимацию на каждом переходе. */
@keyframes am-rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Узкое окно: рельс сжимается до значков, содержимое остаётся главным. */
@media (max-width: 1080px) {
  .am-shell {
    grid-template-columns: var(--am-side-slim) minmax(0, 1fr);
  }

  .am-side {
    padding: 16px 8px;
  }

  .am-side__brand {
    justify-content: center;
    padding: 2px 0 6px;
  }

  .am-side__name,
  .am-side__text,
  .am-side__foot,
  .am-top__word {
    display: none;
  }

  .am-side__item {
    justify-content: center;
    padding: 0;
  }

  .am-side__item--on::before {
    left: 2px;
  }
}

/* Спокойное движение: системная просьба сильнее наших красот. */
@media (prefers-reduced-motion: reduce) {
  .am-view__hold,
  .am-side__item--on::before {
    animation: none;
  }

  .am-top__back:hover,
  .am-top__back:focus-visible,
  .am-skin__btn:hover > span,
  .am-skin__btn:focus-visible > span,
  .am-top__icon:hover > span,
  .am-top__icon:focus-visible > span {
    transform: none;
  }
}
</style>
