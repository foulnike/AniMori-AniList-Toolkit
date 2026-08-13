<!--
  Вкладка «Разработчик»: тумблер логгера и ручная проверка сети.
  Строки отчёта копятся по ходу прогона: молчащая полминуты кнопка читалась бы как зависание.
  У левой колонки обязателен min-width: 0 — иначе она не сжимается и наезжает на код с временем.
-->
<template>
  <div class="amk-card">
    <div class="amk-card-title">Отладка</div>
    <div class="amk-row">
      <span class="amk-row-label"
        ><b>Логгер</b
        ><span class="amk-row-hint">отслеживание действий скрипта (для отладки)</span></span
      >
      <label class="amk-switch">
        <input type="checkbox" id="set_logger" v-model="enableLogger" />
        <span class="amk-track"></span><span class="amk-thumb"></span>
      </label>
    </div>
  </div>

  <div class="amk-card">
    <div class="amk-card-title">Проверка сети</div>
    <div class="amk-row-hint" style="padding: 2px 2px 8px; line-height: 1.5">
      По очереди стучится во все источники, которыми пользуется AniMori, и покажет код ответа с
      временем. Полный прогон занимает до полуминуты, если часть адресов не отвечает.
    </div>
    <button
      class="amk-btn amk-btn-primary amk-btn-block"
      id="am-net-run"
      :disabled="busy"
      @click="onRun()"
    >
      {{ busy ? 'Проверяем…' : 'Проверить источники' }}
    </button>
    <div v-if="hint" class="amk-row-hint" style="padding: 8px 2px 0; line-height: 1.5">
      {{ hint }}
    </div>
    <div
      v-if="rows.length > 0"
      id="am-net-rows"
      style="display: flex; flex-direction: column; gap: 6px; margin-top: 10px"
    >
      <div
        v-for="row in rows"
        :key="row.id"
        class="amk-row"
        style="gap: 10px; align-items: flex-start"
      >
        <span class="amk-row-label" style="min-width: 0; flex: 1 1 auto"
          ><b style="overflow-wrap: anywhere">{{ row.label }}</b
          ><span class="amk-row-hint" style="overflow-wrap: anywhere">{{ row.detail }}</span></span
        >
        <span
          class="amk-row-hint amk-mono"
          style="flex: 0 0 auto; white-space: nowrap; text-align: right; padding-top: 1px"
          :style="{
            color: row.ok
              ? 'rgb(var(--color-green, 166,227,161))'
              : 'rgb(var(--color-red, 243,139,168))',
          }"
          >{{ row.status > 0 ? row.status : '—' }} · {{ row.latencyMs }} мс</span
        >
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import { canRunNetCheck, netCheckCooldownRemaining, runNetCheck } from './net-check'
import type { NetCheckRow } from './net-check'
import { enableLogger } from './settings-state'

const rows = ref<NetCheckRow[]>([])
const busy = ref(false)
const hint = ref('')

async function onRun(): Promise<void> {
  if (busy.value) return
  if (!canRunNetCheck()) {
    const left = Math.ceil(netCheckCooldownRemaining() / 1000)
    hint.value = 'Повторная проверка будет доступна через ' + String(left) + ' с'
    return
  }

  busy.value = true
  hint.value = ''
  rows.value = []

  try {
    await runNetCheck((row) => {
      rows.value = [...rows.value, row]
    })
    const bad = rows.value.filter((r) => !r.ok)
    hint.value =
      bad.length === 0
        ? 'Все источники ответили.'
        : 'Не ответили: ' +
          String(bad.length) +
          ' из ' +
          String(rows.value.length) +
          '. Если среди них есть нужные вам сервисы — поможет VPN.'
  } finally {
    busy.value = false
  }
}
</script>
