<script setup lang="ts">
// Пункт 3.2: заглушка карточки тайтла. Номер берётся из адреса,
// чтобы ссылка на тайтл переживала перезагрузку окна. Содержимое — пункт 3.4.
import { computed } from 'vue'

import { currentRoute } from '../router'

const mediaId = computed(() => currentRoute.value.params.id ?? '')
</script>

<template>
  <section class="am-screen">
    <p v-if="mediaId === ''" class="am-screen__hint">
      Тайтл не выбран: в адресе нет номера. Откройте карточку из списков.
    </p>
    <template v-else>
      <p>Номер тайтла из адреса: {{ mediaId }}</p>
      <p class="am-screen__hint">
        Описание, оценка и список эпизодов появятся в пункте 3.4 поверх данных из раздела 2.
      </p>
    </template>
  </section>
</template>

<style scoped>
.am-screen {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}

.am-screen__hint {
  max-width: 640px;
  margin: 0;
  color: var(--am-dim);
}
</style>
