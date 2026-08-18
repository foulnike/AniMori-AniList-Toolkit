<script setup lang="ts">
// Пункт 3.2: корень приложения. Здесь только выбор экрана по адресу
// и подписка на его смену; вся разметка рамки — в AppShell.
import { computed, onBeforeUnmount, onMounted, type Component } from 'vue'

import { refreshAuth, watchAuth } from './auth/session'
import AppShell from './components/AppShell.vue'
import { currentRoute, startRouter } from './router'
import type { ScreenName } from './router/routes'
import HomeScreen from './screens/HomeScreen.vue'
import ListsScreen from './screens/ListsScreen.vue'
import MediaScreen from './screens/MediaScreen.vue'
import SearchScreen from './screens/SearchScreen.vue'
import SettingsScreen from './screens/SettingsScreen.vue'
import StudioScreen from './screens/StudioScreen.vue'
import './styles/theme.css'

// Полный набор имён обязателен: забытый экран уронит проверку типов,
// а не вскроется пустым окном у пользователя.
const SCREENS: Record<ScreenName, Component> = {
  home: HomeScreen,
  lists: ListsScreen,
  search: SearchScreen,
  media: MediaScreen,
  studio: StudioScreen,
  settings: SettingsScreen,
}

const screen = computed<Component>(() => SCREENS[currentRoute.value.name])

let stopRouter: (() => void) | null = null
let stopAuth: (() => void) | null = null

onMounted(() => {
  stopRouter = startRouter()

  // Состояние входа нужно всем экранам, а не только настройкам: без него
  // запросы после запуска идут без подписи и свой список выглядит пустым.
  // Ошибка не роняет запуск: без входа приложение работает.
  void refreshAuth().catch((e: unknown) => {
    console.error('AniMori: состояние входа не прочитано', e)
  })

  // Вход случается в стороннем окне, и ждать его надо всю жизнь окна,
  // а не пока открыт экран настроек.
  void watchAuth()
    .then((stop) => {
      stopAuth = stop
    })
    .catch((e: unknown) => {
      console.error('AniMori: подписка на вход не удалась', e)
    })
})

onBeforeUnmount(() => {
  stopAuth?.()
  stopAuth = null

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
