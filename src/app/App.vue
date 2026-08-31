<script setup lang="ts">
// Пункт 3.2: корень приложения. Здесь только выбор экрана по адресу
// и подписка на его смену; вся разметка рамки — в AppShell.
//
// Здесь же живёт окошко человека: его открывают и состав тайтла, и ссылка
// из любого описания, так что привязывать его к одному экрану нельзя.
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, type Component } from 'vue'

import { refreshAuth, watchAuth } from './auth/session'
import AppShell from './components/AppShell.vue'
import { closePerson, shownPerson } from './person-layer'
import { currentRoute, startRouter } from './router'
import type { ScreenName } from './router/routes'
import './styles/theme.css'

// Полный набор имён обязателен: забытый экран уронит проверку типов,
// а не вскроется пустым окном у пользователя.
const SCREENS: Record<ScreenName, Component> = {
  home: defineAsyncComponent(() => import('./screens/HomeScreen.vue')),
  lists: defineAsyncComponent(() => import('./screens/ListsScreen.vue')),
  search: defineAsyncComponent(() => import('./screens/SearchScreen.vue')),
  media: defineAsyncComponent(() => import('./screens/MediaScreen.vue')),
  studio: defineAsyncComponent(() => import('./screens/StudioScreen.vue')),
  settings: defineAsyncComponent(() => import('./screens/SettingsScreen.vue')),
  log: defineAsyncComponent(() => import('./screens/LogScreen.vue')),
}

// Окошко грузится по надобности: большая часть запусков обходится без него.
const PersonSheet = defineAsyncComponent(() => import('./components/PersonSheet.vue'))

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

  <!-- Рядом с рамкой, а не внутри неё: блюр рельса создаёт свой контекст
       наложения, и окошко внутри него прижалось бы к содержимому. -->
  <PersonSheet v-if="shownPerson" :start="shownPerson" @close="closePerson" />
</template>
