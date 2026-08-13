<script setup lang="ts">
// Пункт 1.5: первый экран своего клиента, пока только для проверки сборки.
// Настоящие экраны придут в разделе 3, вход и данные — в разделе 2.
const version = __ANIMORI_VERSION__
const platform = __ANIMORI_PLATFORM__
</script>

<template>
  <main class="am-app">
    <h1>AniMori</h1>
    <p>Каркас своего клиента собран. Экраны ещё не написаны.</p>
    <p class="am-app__meta">Версия {{ version }} · площадка {{ platform }}</p>
  </main>
</template>

<style scoped>
.am-app {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  font-family: system-ui, sans-serif;
  color: #e7edf7;
  background: #0b1622;
}

.am-app__meta {
  font-size: 13px;
  color: #8ba1bd;
}
</style>
