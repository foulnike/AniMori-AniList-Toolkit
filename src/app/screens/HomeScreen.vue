<script setup lang="ts">
// Пункт 3.2: заглушка главного экрана. Содержимое придёт с разделом 2:
// без входа и клиента GraphQL показывать здесь нечего.
import { navigate } from '../router'
</script>

<template>
  <section class="am-screen">
    <p>Оболочка готова: меню работает, адрес в окне меняется, «Назад» живое.</p>
    <p class="am-screen__hint">
      Следующие пункты наполняют экраны: 3.3 списки, 3.4 карточка, 3.5 поиск, 3.6 настройки.
    </p>
    <button class="am-screen__link" type="button" @click="navigate('lists')">К спискам</button>
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
  color: var(--am-dim);
}

.am-screen__link {
  padding: 7px 12px;
  font: inherit;
  color: var(--am-text);
  cursor: pointer;
  background: var(--am-hover);
  border: 1px solid var(--am-line);
  border-radius: 8px;
}
</style>
