<script setup lang="ts">
// Пункт 3.2: постоянная рамка окна — меню слева, шапка сверху,
// сменный экран внутри. Сама рамка о экранах не знает ничего,
// кроме имён и подписей из routes.ts.
import { computed } from 'vue'

import { currentRoute, goBack, navigate } from '../router'
import { MENU, SCREEN_TITLES } from '../router/routes'

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
        <svg class="am-side__logo" viewBox="0 0 32 32" role="img" aria-label="AniMori">
          <defs>
            <linearGradient id="am-logo-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#58a6ff" />
              <stop offset="1" stop-color="#a486ff" />
            </linearGradient>
          </defs>

          <rect width="32" height="32" rx="9" fill="url(#am-logo-grad)" />
          <path d="M16 5.5 22 15.5 10 15.5Z" fill="#08111c" />
          <path d="M16 11.5 25.5 25 6.5 25Z" fill="#08111c" />
        </svg>

        <span class="am-side__name">AniMori</span>
      </div>

      <nav class="am-side__menu">
        <button
          v-for="item in MENU"
          :key="item.name"
          class="am-side__item"
          :class="{ 'am-side__item--on': item.name === active }"
          type="button"
          :title="item.title"
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
          <span aria-hidden="true">←</span>
          <span>Назад</span>
        </button>
        <h1 class="am-top__title">{{ title }}</h1>

        <span class="am-top__gap" />

        <button class="am-top__icon" type="button" title="Обновить окно" @click="onReload">
          <span aria-hidden="true">⟳</span>
        </button>
      </header>

      <main class="am-view">
        <div class="am-view__hold">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.am-shell {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  min-height: 100vh;
}

.am-side {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100vh;
  padding: 20px 14px;
  background: linear-gradient(180deg, rgba(21, 29, 41, 0.92), rgba(11, 16, 24, 0.92));
  border-right: 1px solid var(--am-line);
}

.am-side__brand {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 0 6px;
}

.am-side__logo {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  box-shadow: 0 6px 16px rgba(88, 166, 255, 0.35);
}

.am-side__name {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.am-side__menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.am-side__item {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  font: inherit;
  font-weight: 550;
  color: var(--am-dim);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-m);
  transition:
    color 0.12s ease,
    background 0.12s ease;
}

.am-side__item:hover {
  color: var(--am-text);
  background: rgba(255, 255, 255, 0.05);
}

.am-side__item--on {
  color: var(--am-text);
  background: var(--am-accent-soft);
  box-shadow: inset 2px 0 0 var(--am-accent);
}

.am-side__icon {
  width: 18px;
  font-size: 16px;
  text-align: center;
}

.am-side__foot {
  margin-top: auto;
  padding: 0 8px;
  font-size: 12px;
  color: var(--am-faint);
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
  gap: 14px;
  align-items: center;
  padding: 14px 32px;
  background: rgba(8, 11, 17, 0.82);
  border-bottom: 1px solid var(--am-line);
  backdrop-filter: blur(10px);
}

.am-top__back {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  padding: 7px 14px;
  font: inherit;
  font-size: 13px;
  color: var(--am-dim);
  cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--am-line);
  border-radius: 999px;
}

.am-top__back:hover {
  color: var(--am-text);
  background: var(--am-hover);
}

.am-top__title {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.am-top__gap {
  flex: 1;
}

/* Круглая кнопка справа: обновляет окно целиком. */
.am-top__icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  font: inherit;
  font-size: 16px;
  color: var(--am-dim);
  cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--am-line);
  border-radius: 999px;
}

.am-top__icon:hover {
  color: var(--am-text);
  background: var(--am-hover);
  border-color: var(--am-accent);
}

.am-view {
  flex: 1;
  width: 100%;
  padding: 26px 32px 64px;
}

/* Потолок ширины с центровкой: без него на широком окне
   строка текста тянулась бы метрами. */
.am-view__hold {
  width: 100%;
  max-width: var(--am-page-max);
  margin: 0 auto;
}

/* Узкое окно: меню сжимается до значков, содержимое остаётся главным. */
@media (max-width: 1080px) {
  .am-shell {
    grid-template-columns: 72px minmax(0, 1fr);
  }

  .am-side {
    padding: 20px 10px;
  }

  .am-side__name,
  .am-side__text,
  .am-side__foot {
    display: none;
  }

  .am-side__item {
    justify-content: center;
    padding: 11px 0;
  }

  .am-top,
  .am-view {
    padding-right: 20px;
    padding-left: 20px;
  }
}
</style>
