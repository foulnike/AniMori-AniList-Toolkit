<script setup lang="ts">
// Пункт 3.2: постоянная рамка окна — меню слева, шапка сверху,
// сменный экран внутри. Сама рамка о экранах не знает ничего,
// кроме имён и подписей из routes.ts.
import { computed } from 'vue'

import { currentRoute, goBack, navigate } from '../router'
import { MENU, SCREEN_TITLES } from '../router/routes'

const active = computed(() => currentRoute.value.name)
const title = computed(() => SCREEN_TITLES[active.value])

// «Назад» нужен только там, куда пришли изнутри приложения:
// на экранах из меню он увёл бы в пустую историю окна.
const canGoBack = computed(() => active.value === 'media')
</script>

<template>
  <div class="am-shell">
    <nav class="am-shell__menu">
      <span class="am-shell__brand">AniMori</span>
      <button
        v-for="item in MENU"
        :key="item.name"
        class="am-shell__item"
        :class="{ 'am-shell__item--active': item.name === active }"
        type="button"
        @click="navigate(item.name)"
      >
        <span class="am-shell__icon" aria-hidden="true">{{ item.icon }}</span>
        <span>{{ item.title }}</span>
      </button>
    </nav>

    <div class="am-shell__body">
      <header class="am-shell__head">
        <button v-if="canGoBack" class="am-shell__back" type="button" @click="goBack">
          ← Назад
        </button>
        <h1 class="am-shell__title">{{ title }}</h1>
      </header>
      <main class="am-shell__view">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.am-shell {
  display: grid;
  grid-template-columns: 208px 1fr;
  min-height: 100vh;
}

.am-shell__menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 12px;
  background: var(--am-panel);
  border-right: 1px solid var(--am-line);
}

.am-shell__brand {
  padding: 4px 10px 16px;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.am-shell__item {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 9px 10px;
  font: inherit;
  color: var(--am-dim);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: 8px;
}

.am-shell__item:hover {
  color: var(--am-text);
  background: var(--am-hover);
}

.am-shell__item:focus-visible {
  outline: 2px solid var(--am-accent);
  outline-offset: 1px;
}

.am-shell__item--active {
  color: var(--am-text);
  background: var(--am-hover);
}

.am-shell__icon {
  width: 18px;
  text-align: center;
}

.am-shell__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.am-shell__head {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px 24px;
  border-bottom: 1px solid var(--am-line);
}

.am-shell__back {
  padding: 5px 10px;
  font: inherit;
  color: var(--am-dim);
  cursor: pointer;
  background: none;
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-shell__back:hover {
  color: var(--am-text);
}

.am-shell__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.am-shell__view {
  flex: 1;
  padding: 24px;
}
</style>
