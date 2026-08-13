<script setup lang="ts">
// Пункт 3.2: заглушка поиска. Поле пока ничего не ищет и намеренно
// не шлёт запросов: сеть появится в разделе 2, сам поиск — пункт 3.5.
import { ref } from 'vue'

const query = ref('')
</script>

<template>
  <section class="am-screen">
    <input v-model="query" class="am-screen__input" type="search" placeholder="Название тайтла" />
    <p class="am-screen__hint">
      Поиск заработает в пункте 3.5, когда будет клиент GraphQL и ограничитель
      запросов.
    </p>
    <p v-if="query !== ''" class="am-screen__hint">Запрос в памяти: {{ query }}</p>
  </section>
</template>

<style scoped>
.am-screen {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}

.am-screen__input {
  width: 320px;
  padding: 8px 12px;
  font: inherit;
  color: var(--am-text);
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-screen__hint {
  max-width: 640px;
  margin: 0;
  color: var(--am-dim);
}
</style>
