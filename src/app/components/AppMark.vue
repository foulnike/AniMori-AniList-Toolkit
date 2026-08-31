<script setup lang="ts">
// Знак приложения: сакура с вырезом воспроизведения в скруглённом
// квадрате — та же фигура, что в иконке окна из src-tauri/icons.
//
// Вектором, а не картинкой из иконок: PNG там один на все темы, на
// тридцати четырёх пикселях рельса он мылится, а на AMOLED его тёмно-синяя
// подложка светит заплаткой на чистом чёрном.
//
// Цвета знака объявлены здесь, а не в theme.css, и это единственное такое
// место в приложении. Причина: акцент всех трёх тем синий, а сакура
// акцентного цвета — уже не сакура. Знак — не часть палитры окна,
// и правило «цвета только токенами» выполнено по сути: три темы правятся
// в одном месте, а не размазаны по экранам.
//
// По темам меняется плита, а не цветок: на тёмной и светлой она
// остаётся тёмно-синей, как в самой иконке — розовые лепестки на
// светлой подложке теряют и контур, и узнаваемость. На AMOLED плита
// гаснет до чёрного и остаётся только кромка: квадрат темнее фона
// там невозможен, а светлее — грязное пятно.
</script>

<template>
  <svg class="am-mark" viewBox="0 0 32 32" role="img" aria-label="AniMori">
    <defs>
      <!-- Плита светлее сверху: ровная заливка выглядит наклейкой,
           и в иконке окна тот же косой переход. -->
      <linearGradient id="am-mark-plate" x1="0.1" y1="0" x2="0.55" y2="1">
        <stop class="am-mark__plate-a" offset="0" />
        <stop class="am-mark__plate-b" offset="1" />
      </linearGradient>

      <!-- Цветок залит одним градиентом на всю фигуру: заливка по
           лепестку дала бы пять разных розовых. -->
      <linearGradient id="am-mark-bloom" x1="0.15" y1="0" x2="0.85" y2="1">
        <stop class="am-mark__bloom-a" offset="0" />
        <stop class="am-mark__bloom-b" offset="1" />
      </linearGradient>

      <!-- Лепесток описан один раз и стоит остриём в центр квадрата:
           оттуда его разворачивает пять раз. Выемка на конце — тот самый
           надрез сакуры, без него цветок читается ромашкой. -->
      <path
        id="am-mark-petal"
        d="M16 17.1 C12.1 16.6 9.3 13.2 9.6 9.8 C9.8 6.5 12.9 4.5 16 7 C19.1 4.5 22.2 6.5 22.4 9.8 C22.7 13.2 19.9 16.6 16 17.1 Z"
      />

      <!-- Треугольник именно вырезан, а не нарисован цветом подложки:
           подложка градиентная, и заливка поверх выдала бы себя
           ступенькой на скате. -->
      <mask id="am-mark-cut">
        <rect width="32" height="32" fill="#000" />

        <!-- Цветок растёт вокруг (16, 16), а не вокруг левого верхнего
             угла: scale без возврата увез бы всю фигуру вправо-вниз
             на 0.96 пикселя. Диаметр цветка: 0.69 стороны как в PNG. -->
        <g fill="#fff" transform="translate(-0.96 -0.96) scale(1.06)">
          <use href="#am-mark-petal" />
          <use href="#am-mark-petal" transform="rotate(72 16 16)" />
          <use href="#am-mark-petal" transform="rotate(144 16 16)" />
          <use href="#am-mark-petal" transform="rotate(216 16 16)" />
          <use href="#am-mark-petal" transform="rotate(288 16 16)" />
        </g>

        <!-- Углы скруглены самим путём: прежняя обводка тонкого
             треугольника растила его по нормали к каждому ребру, а у
             прямого и двух косых рёбер прирост разный: нос тупился,
             а фигура уезжала с центра. Габарит выреза теперь ровно
             11.65..20.35 на 10.95..21.05 — центр в (16, 16), стороны 8.7 и 10.1
             (0.27 и 0.32 стороны плиты, как в PNG). -->
        <path
          d="M 12.95 11.7 L 18.97 15.2 Q 20.35 16 18.97 16.8 L 12.95 20.3 Q 11.65 21.05 11.65 19.55 L 11.65 12.45 Q 11.65 10.95 12.95 11.7 Z"
          fill="#000"
        />
      </mask>
    </defs>

    <rect class="am-mark__plate" width="32" height="32" rx="11" />
    <rect class="am-mark__bloom" width="32" height="32" mask="url(#am-mark-cut)" />
    <rect class="am-mark__edge" x="0.5" y="0.5" width="31" height="31" rx="10.5" />
  </svg>
</template>

<style scoped>
/* Тёмная — основная: значения взяты с самой иконки окна. */
.am-mark {
  --am-mark-plate-1: #1b2534;
  --am-mark-plate-2: #0a0e16;
  --am-mark-bloom-1: #f5b3c8;
  --am-mark-bloom-2: #e88ba9;
  --am-mark-edge: transparent;

  display: block;
  flex: none;
}

.am-mark__plate {
  fill: url('#am-mark-plate');
}

.am-mark__bloom {
  fill: url('#am-mark-bloom');
}

.am-mark__edge {
  fill: none;
  stroke: var(--am-mark-edge);
  stroke-width: 1;
}

.am-mark__plate-a {
  stop-color: var(--am-mark-plate-1);
}

.am-mark__plate-b {
  stop-color: var(--am-mark-plate-2);
}

.am-mark__bloom-a {
  stop-color: var(--am-mark-bloom-1);
}

.am-mark__bloom-b {
  stop-color: var(--am-mark-bloom-2);
}

/* Светлая: плита чуть светлее и с тёплой кромкой, лепестки на тон глубже:
   светлый розовый рядом со светлым окном читался выцветшим.
   Селектор глобальный: метка темы стоит на <html>, а не на знаке. */
:global([data-am-skin='light']) .am-mark {
  --am-mark-plate-1: #223047;
  --am-mark-plate-2: #101a28;
  --am-mark-bloom-1: #f2a6bf;
  --am-mark-bloom-2: #e07d9f;
  --am-mark-edge: rgb(255 255 255 / 0.16);
}

/* AMOLED: плита гаснет до чёрного, форму держит кромка и сам цветок. */
:global([data-am-skin='amoled']) .am-mark {
  --am-mark-plate-1: #05070a;
  --am-mark-plate-2: #000000;
  --am-mark-bloom-1: #f0a6bf;
  --am-mark-bloom-2: #de85a4;
  --am-mark-edge: rgb(240 166 191 / 0.24);
}
</style>
