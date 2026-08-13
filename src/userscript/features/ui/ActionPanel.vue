<!--
  Плавающая панель кнопок: компонент рисует сам контейнер #animori-actions в body.
  Узел-обёртка внутри контейнера разорвал бы flex и убрал разделители кнопок.
  Кнопка плеера идёт первой и при наличии посадочного места уезжает под обложку.
-->

<script setup lang="ts">
import { Logger } from '@/utils/logger'
import {
  actionButtons,
  isPlayerVisible,
  PLAYER_BUTTON_HERO_LABEL,
  PLAYER_BUTTON_ID,
  PLAYER_BUTTON_LABEL,
  PLAYER_BUTTON_TITLE,
  playerAnchor,
  playerHandler,
  type ActionButton,
} from './action-panel-state'
import './player-hero.scss'

/** Без обёртки ошибка обработчика всплывёт в планировщик Vue и погасит панель. */
function runAction(button: ActionButton): void {
  try {
    button.onClick()
  } catch (e) {
    Logger('ERROR', `[UI] Ошибка обработчика кнопки ${button.id}`, e)
  }
}

/** Текущая строка прогресса кнопки либо пусто, если операция не идёт. */
function progressOf(button: ActionButton): string {
  return button.progress ? button.progress.value : ''
}

function runPlayer(): void {
  const handler = playerHandler.value
  if (!handler) return
  try {
    handler()
  } catch (e) {
    Logger('ERROR', '[UI] Ошибка обработчика кнопки плеера', e)
  }
}
</script>

<template>
  <div id="animori-actions" class="am-accent-scope">
    <!-- При выключенном телепорте адрес не нужен, но Vue требует годного значения. -->
    <Teleport :to="playerAnchor ?? 'body'" :disabled="!playerAnchor">
      <button
        v-if="isPlayerVisible"
        :id="PLAYER_BUTTON_ID"
        type="button"
        class="am-premium-btn"
        :class="{ 'am-player-hero': !!playerAnchor }"
        :title="PLAYER_BUTTON_TITLE"
        @click="runPlayer"
      >
        {{ playerAnchor ? PLAYER_BUTTON_HERO_LABEL : PLAYER_BUTTON_LABEL }}
      </button>
    </Teleport>

    <!-- Интерполяция, а не v-html: подпись вида '</>' должна остаться текстом. -->
    <button
      v-for="button in actionButtons"
      :key="button.id"
      :id="button.id"
      type="button"
      class="am-premium-btn"
      :title="button.title"
      @click="runAction(button)"
    >
      <template v-if="progressOf(button)">{{ progressOf(button) }}</template>
      <svg
        v-else-if="button.icon"
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="vertical-align: -2px"
        v-html="button.icon"
      ></svg>
      <template v-else>{{ button.label }}</template>
    </button>
  </div>
</template>
