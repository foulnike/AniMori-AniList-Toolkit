<script setup lang="ts">
// Пункт 3.2: заглушка настроек. Настоящие настройки, словарь и свои ссылки —
// пункт 3.6, кнопка запасного вида с настоящим сайтом — пункт 3.7.
const version = __ANIMORI_VERSION__
const platform = __ANIMORI_PLATFORM__
</script>

<template>
  <section class="am-screen">
    <p class="am-screen__hint">
      Настройки переедут сюда в пункте 3.6. Кнопка «Открыть настоящий сайт»
      появится в пункте 3.7: само окно и команда для него уже готовы.
    </p>
    <p class="am-screen__meta">Версия {{ version }} · площадка {{ platform }}</p>
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

.am-screen__meta {
  margin: 0;
  font-size: 13px;
  color: var(--am-dim);
}
</style>
