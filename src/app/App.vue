<script setup lang="ts">
// Пункт 3.2: корень приложения. Здесь только выбор экрана по адресу
// и подписка на его смену; вся разметка рамки — в AppShell.
import { computed, onBeforeUnmount, onMounted, type Component } from 'vue'

import AppShell from './components/AppShell.vue'
import { currentRoute, startRouter } from './router'
import type { ScreenName } from './router/routes'
import HomeScreen from './screens/HomeScreen.vue'
import ListsScreen from './screens/ListsScreen.vue'
import MediaScreen from './screens/MediaScreen.vue'
import SearchScreen from './screens/SearchScreen.vue'
import SettingsScreen from './screens/SettingsScreen.vue'

// Полный набор имён обязателен: забытый экран уронит проверку типов,
// а не вскроется пустым окном у пользователя.
const SCREENS: Record<ScreenName, Component> = {
  home: HomeScreen,
  lists: ListsScreen,
  search: SearchScreen,
  media: MediaScreen,
  settings: SettingsScreen,
}

const screen = computed<Component>(() => SCREENS[currentRoute.value.name])

let stopRouter: (() => void) | null = null

onMounted(() => {
  stopRouter = startRouter()
})

onBeforeUnmount(() => {
  if (stopRouter === null) return
  stopRouter()
  stopRouter = null
})
</script>

<template>
  <AppShell>
    <component :is="screen" />
  </AppShell>
</template>

<style>
:root {
  --am-bg: #0b1622;
  --am-panel: #101f2f;
  --am-hover: #17293c;
  --am-line: #1e3346;
  --am-text: #e7edf7;
  --am-dim: #8ba1bd;
  --am-accent: #4c9ffe;
}

html,
body {
  margin: 0;
  padding: 0;
}

body {
  font-family: system-ui, sans-serif;
  color: var(--am-text);
  background: var(--am-bg);
}

#app {
  min-height: 100vh;
}
</style>
