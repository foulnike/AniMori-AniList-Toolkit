<script setup lang="ts">
// Пункт 3.2: заглушка списков. Набор номеров здесь не данные,
// а проверка перехода с параметром в адресе. Настоящие списки — пункт 3.3.
import { navigate } from '../router'

const SAMPLE_IDS: readonly string[] = ['1', '21', '5114']
</script>

<template>
  <section class="am-screen">
    <p class="am-screen__hint">
      Здесь будут списки с AniList (пункт 3.3). Кнопки ниже проверяют только переход на карточку с
      номером в адресе.
    </p>
    <ul class="am-screen__rows">
      <li v-for="id in SAMPLE_IDS" :key="id">
        <button class="am-screen__row" type="button" @click="navigate('media', { id })">
          Тайтл № {{ id }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.am-screen {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
}

.am-screen__hint {
  max-width: 640px;
  margin: 0;
  color: var(--am-dim);
}

.am-screen__rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.am-screen__row {
  width: 260px;
  padding: 9px 12px;
  font: inherit;
  color: var(--am-text);
  text-align: left;
  cursor: pointer;
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-screen__row:hover {
  background: var(--am-hover);
}
</style>
