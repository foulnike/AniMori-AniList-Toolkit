<script setup lang="ts">
// Знак приложения: та же ель в скруглённом квадрате, что в иконке окна
// (mori — лес). Рисуется вектором, а не картинкой из src-tauri/icons: иконка
// окна одна на все темы и на чёрном фоне светит заплаткой, а здесь знак
// живёт токенами темы.
//
// Три темы обслуживаются здесь же: на тёмной и светлой квадрат залит
// акцентным градиентом, а ель — вырез цвета завесы. На AMOLED наоборот:
// подложка глухая, светится сама ель — яркий квадрат на чистом чёрном
// бил по глазам сильнее заголовка рядом.
</script>

<template>
  <svg class="am-mark" viewBox="0 0 32 32" role="img" aria-label="AniMori">
    <defs>
      <linearGradient id="am-logo-grad" x1="0" y1="0" x2="1" y2="1">
        <stop class="am-mark__stop-a" offset="0" />
        <stop class="am-mark__stop-b" offset="1" />
      </linearGradient>
    </defs>

    <rect class="am-mark__plate" width="32" height="32" rx="11" />

    <!-- Ель тремя фигурами: два яруса кроны и ствол. Одним путём было бы
         короче, но тогда ярусы не разнести по темам порознь. -->
    <path class="am-mark__cut" d="M16 5.5 22 15.5 10 15.5Z" />
    <path class="am-mark__cut" d="M16 11.5 25.5 25 6.5 25Z" />
    <rect class="am-mark__cut" x="14.6" y="24" width="2.8" height="3.4" rx="1" />
  </svg>
</template>

<style scoped>
.am-mark {
  display: block;
  flex: none;
}

.am-mark__plate {
  fill: url('#am-logo-grad');
}

.am-mark__stop-a {
  stop-color: var(--am-accent);
}

.am-mark__stop-b {
  stop-color: var(--am-accent-2);
}

/* Вырез красится завесой, а не фоном окна: на светлой теме фон совпал бы
   с градиентом и ель исчезла. */
.am-mark__cut {
  fill: var(--am-veil);
}

/* AMOLED: инверсия — глухая плита с акцентной кромкой и светящаяся ель.
   Селектор глобальный: метка темы стоит на <html>, а не на знаке. */
:global([data-am-skin='amoled']) .am-mark__plate {
  fill: var(--am-panel-2);
  stroke: rgb(var(--am-accent-rgb) / 0.45);
  stroke-width: 1;
}

:global([data-am-skin='amoled']) .am-mark__cut {
  fill: url('#am-logo-grad');
}
</style>
