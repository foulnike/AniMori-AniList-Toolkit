<!--
  Панель «Поддержать»: звезда на GitHub, обратная связь и ссылка на установку.
  Вторая кнопка и ссылка разные у скрипта и приложения; идентификаторы am-sup-* сохранены.
  Ссылки идут через window.open: в десктопе их перехватывает оболочка и отдаёт браузеру.
-->
<template>
  <div class="amk-card">
    <div class="amk-card-title">Поддержать проект</div>
    <div class="amk-row-hint" style="padding: 2px 2px 10px; line-height: 1.55">
      AniMori — бесплатный проект, я делаю его из любви к японским мультикам. Денег не нужно. Если
      тулкит вам пригодился, лучшая благодарность — пара действий ниже. Это правда помогает.
    </div>
    <button
      class="amk-btn amk-btn-primary amk-btn-block"
      id="am-sup-star"
      style="margin-bottom: 8px; gap: 8px"
      @click="openExternal(SUP_GITHUB)"
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
        />
      </svg>
      Star на GitHub
    </button>
    <button
      class="amk-btn amk-btn-ghost amk-btn-block"
      id="am-sup-review"
      style="margin-bottom: 8px; gap: 8px"
      @click="openExternal(feedbackUrl)"
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {{ feedbackLabel }}
    </button>
    <div class="amk-row-hint" style="padding: 2px 2px 6px; line-height: 1.5">
      {{ feedbackHint }}
    </div>
  </div>
  <div class="amk-card">
    <div class="amk-card-title">Поделиться</div>
    <div class="amk-row-hint" style="padding: 2px 2px 8px; line-height: 1.5">
      {{ shareHint }}
    </div>
    <div style="display: flex; gap: 8px">
      <input
        class="amk-input amk-mono"
        id="am-sup-link"
        readonly
        :value="shareUrl"
        style="flex: 1"
      />
      <button
        class="amk-btn amk-btn-primary"
        id="am-sup-copy"
        style="gap: 7px"
        @click="onSupportCopy($event)"
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>{{ supportCopyLabel }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import { Bridge } from '@/bridge'
import { amCopy } from '../../utils/dom'
import { ISSUES_CHOOSE, SUP_GITHUB, SUP_GREASY, SUP_GREASY_FEEDBACK } from './settings-state'

/** Платформа константна на всю сессию, поэтому не ref и не computed. */
const isDesktop = Bridge.platform === 'tauri'

// Отзыв на Greasy Fork имеет смысл только тому, кто ставил оттуда скрипт.
const feedbackUrl = isDesktop ? ISSUES_CHOOSE : SUP_GREASY_FEEDBACK
const feedbackLabel = isDesktop ? 'Отзыв или идея на GitHub' : 'Оценить на Greasy Fork'
const feedbackHint = isDesktop
  ? 'Отчёт об ошибке или идея — самая полезная помощь приложению.'
  : 'Отзыв двигает скрипт в выдаче — так его находят новые пользователи.'

// Другу даём ту точку установки, которой пользуется сам отправитель.
const shareUrl = isDesktop ? SUP_GITHUB : SUP_GREASY
const shareHint = isDesktop
  ? 'Рассказать друзьям — тоже поддержка. Страница проекта с установщиком:'
  : 'Рассказать друзьям — тоже поддержка. Ссылка на установку:'

const supportCopyLabel = ref('Копировать')

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener')
}

function onSupportCopy(e: Event): void {
  const target = e.currentTarget
  amCopy(shareUrl, target instanceof HTMLElement ? target : undefined)
  supportCopyLabel.value = 'Скопировано ✓'
  setTimeout(() => {
    supportCopyLabel.value = 'Копировать'
  }, 1200)
}
</script>
