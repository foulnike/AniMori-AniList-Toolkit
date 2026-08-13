<!--
  Итерация 5.2: предупреждение о недоступности источников.

  Задача по требованию владельца (сообщения 66 и 72): общее предупреждение должно быть
  явным, а не спрятанным в логгере, и выглядеть как тост сверху поверх всего
  интерфейса. Тумблера отключения нет намеренно.

  Главное решение — когда МОЛЧАТЬ. Условие показа одно: `looksLikeOutage()`, то есть
  два и больше РАЗНЫХ источников не ответили по два раза подряд в одном окне. Отказ
  одного сервиса — дело его собственного виджета, и тащить из-за него плашку на всю
  ширину экрана — верный способ сделать так, чтобы её перестали читать.
  Отказы вида `forbidden` в это условие не входят вовсе: там связь есть и совет про
  VPN был бы ложью.

  Показывается однократно за сеанс. Причина такая же: пока источник лежит, отказы идут
  пачками на каждую карточку, и тост на каждый из них превратился бы в ту самую
  бомбардировку, которую уже лечили в журнале на этапе 2.

  z-index выше модалок AniMori (у них 999999): плашка обязана быть видна и при открытой
  панели настроек: именно туда ведёт её кнопка.

  Подписка снимается дважды: при размонтировании и сразу после показа — второго раза
  всё равно не будет, а висеть на каждом отчёте всех клиентов задаром незачем.
-->
<template>
  <div
    v-if="visible"
    id="am-net-toast"
    style="
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000000;
      max-width: min(680px, calc(100vw - 32px));
      box-sizing: border-box;
      display: flex;
      gap: 12px;
      align-items: flex-start;
      padding: 12px 14px;
      border-radius: 10px;
      background: #1f2430;
      color: #e6e9ef;
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
      font-size: 13px;
      line-height: 1.5;
    "
  >
    <span style="flex: 0 0 auto; font-size: 16px; line-height: 1.3">⚠</span>
    <div style="flex: 1 1 auto; min-width: 0">
      <div style="font-weight: 700; margin-bottom: 2px">Часть источников не отвечает</div>
      <div style="overflow-wrap: anywhere; opacity: 0.85">{{ text }}</div>
      <button
        id="am-net-toast-check"
        style="
          margin-top: 8px;
          background: none;
          border: none;
          padding: 0;
          color: inherit;
          font: inherit;
          text-decoration: underline;
          cursor: pointer;
        "
        @click="openCheck()"
      >
        Проверить источники
      </button>
    </div>
    <button
      id="am-net-toast-close"
      title="Скрыть"
      style="
        flex: 0 0 auto;
        background: none;
        border: none;
        padding: 0 2px;
        color: inherit;
        opacity: 0.6;
        font-size: 16px;
        line-height: 1.3;
        cursor: pointer;
      "
      @click="visible = false"
    >
      ✕
    </button>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { looksLikeOutage, subscribeNetHealth, troubledLabels } from '@/core/net-health'
import { activeTab, openSettings } from './settings-state'

const visible = ref(false)
const text = ref('')

/** Показали ли уже в этом сеансе. Повторно не показываем даже после закрытия. */
let shown = false
let unsubscribe: (() => void) | null = null

function stop(): void {
  if (!unsubscribe) return
  unsubscribe()
  unsubscribe = null
}

function evaluate(): void {
  if (shown) return
  if (!looksLikeOutage()) return

  const labels = troubledLabels()
  text.value =
    labels.length > 0
      ? 'Не ответили: ' +
        labels.join(', ') +
        '. Если часть данных не грузится — обычно помогает VPN.'
      : 'Если часть данных не грузится — обычно помогает VPN.'

  shown = true
  visible.value = true
  stop()
}

function openCheck(): void {
  visible.value = false
  activeTab.value = 'dev'
  openSettings()
}

onMounted(() => {
  // Первая сверка сразу: к моменту монтирования часть клиентов уже могла отчитаться,
  // а подписка о прошлых событиях ничего не знает.
  evaluate()
  if (shown) return
  unsubscribe = subscribeNetHealth(() => {
    evaluate()
  })
})

onBeforeUnmount(stop)
</script>
