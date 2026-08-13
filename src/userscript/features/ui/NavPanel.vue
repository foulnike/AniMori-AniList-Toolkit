<!--
  Пункт 4.5: браузерная навигация в окне, у которого нет тулбара.

  Кнопка обновления появилась на пункте 4.3 в панели действий — там, где живут кнопки
  самого AniMori (настройки, журнал, сверка, перенос). Это было неправильное место:
  перезагрузка — не функция расширения, а функция оболочки, и искать её пользователь
  будет там, где она стоит в браузере: рядом со стрелками назад и вперёд, в шапке.

  Почему плавающий блок, а не встраивание в шапку AniList: шапка — чужое React-дерево
  (РИСК №3 из docs/DECISIONS.md). Встроенный туда узел живёт до первой перерисовки, а самой
  шапки на части страниц просто нет (она прячется на страницах тайтлов при скролле).
  Поэтому блок монтируется в body и висит поверх — так же, как панель действий.

  Свёрнутое состояние — одна узкая плашка: три кнопки постоянно перекрывали бы угол
  интерфейса сайта. Раскрывается по наведению — это выбор пользователя. Клик по язычку
  закрепляет блок раскрытым: без этого при быстром движении мыши к стрелке блок
  успевал бы свернуться, и по стрелке пришлось бы охотиться.

  Строка адреса только читается. Ввод чужого адреса окно всё равно не примет:
  on_navigation в lib.rs пускает внутрь лишь anilist.co, а остальное уводит в браузер,
  так что поле ввода обещало бы возможность, которой нет.

  Кнопка полного экрана стоит последней и отделена от стрелок: она управляет окном,
  а не перемещением по сайту. Вид кнопки зависит от состояния окна: в полном экране
  больше нет ни рамки, ни крестика, и подсказка о выходе остаётся единственной.

  Стили лежат в самом компоненте, а не в style.scss, осознанно: это единственный элемент
  интерфейса, которого в браузерной сборке нет совсем, и его оформление не должно
  гулять по общему файлу стилей. Селекторы префиксованы am-nav-, так что с разметкой
  сайта они не пересекаются.
-->

<script setup lang="ts">
import { ref } from 'vue'
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'
import { copyCurrentUrl, currentUrl, isFullscreen, toggleFullscreen, urlCopied } from './nav-state'
import { reloadPage } from './reload'

/** Блок раскрыт: либо мышь над ним, либо его закрепили кликом. */
const hovered = ref(false)
const pinned = ref(false)

function onEnter(): void {
  hovered.value = true
}

function onLeave(): void {
  hovered.value = false
}

function togglePinned(): void {
  pinned.value = !pinned.value
}

/**
 * Шаг по истории. Историю нельзя спросить — браузер не говорит, есть ли куда идти,
 * поэтому кнопки никогда не блокируются. В крайней точке нажатие просто ничего
 * не даёт — ровно как погасшая стрелка в тулбаре.
 */
function goBack(): void {
  void Bridge.shell.back().catch((e) => {
    Logger('ERROR', 'Не удалось вернуться назад', e)
  })
}

function goForward(): void {
  void Bridge.shell.forward().catch((e) => {
    Logger('ERROR', 'Не удалось перейти вперёд', e)
  })
}

/** Перезагрузка живёт в reload.ts с пункта 4.3 и уже пишет ошибки в журнал сама. */
function onReload(): void {
  void reloadPage()
}

/** Клик по строке выделяет адрес целиком — как в адресной строке браузера. */
function onUrlFocus(e: FocusEvent): void {
  const el = e.target
  if (el instanceof HTMLInputElement) el.select()
}

/** Обёртка ради void: обработчику клика промис не нужен, ошибку пишет nav-state.ts. */
function onCopy(): void {
  void copyCurrentUrl()
}

/** То же для полного экрана: состояние и журнал — забота nav-state.ts. */
function onFullscreen(): void {
  void toggleFullscreen()
}
</script>

<template>
  <div
    id="animori-nav"
    class="am-accent-scope am-nav"
    :class="{ 'am-nav-open': hovered || pinned, 'am-nav-pinned': pinned }"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @focusin="onEnter"
    @focusout="onLeave"
  >
    <button
      type="button"
      class="am-nav-handle"
      :title="pinned ? 'Открепить панель навигации' : 'Закрепить панель навигации'"
      aria-label="Навигация"
      @click="togglePinned"
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <polyline points="14 8 10 12 14 16" />
      </svg>
    </button>

    <div class="am-nav-items">
      <button type="button" class="am-nav-btn" title="Назад (Alt+←)" @click="goBack">
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
      </button>

      <button type="button" class="am-nav-btn" title="Вперёд (Alt+→)" @click="goForward">
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </button>

      <button type="button" class="am-nav-btn" title="Обновить страницу (F5)" @click="onReload">
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
      </button>

      <input
        class="am-nav-url"
        type="text"
        readonly
        spellcheck="false"
        aria-label="Адрес страницы"
        :value="currentUrl"
        :title="currentUrl"
        @focus="onUrlFocus"
      />

      <button
        type="button"
        class="am-nav-btn"
        :class="{ 'am-nav-done': urlCopied }"
        :title="urlCopied ? 'Адрес скопирован' : 'Скопировать адрес'"
        @click="onCopy"
      >
        <svg
          v-if="urlCopied"
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>

      <button
        type="button"
        class="am-nav-btn"
        :title="isFullscreen ? 'Выйти из полного экрана (F11)' : 'Во весь экран (F11)'"
        @click="onFullscreen"
      >
        <svg
          v-if="isFullscreen"
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="4 14 10 14 10 20" />
          <polyline points="20 10 14 10 14 4" />
          <line x1="14" y1="10" x2="21" y2="3" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
          <line x1="21" y1="3" x2="14" y2="10" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style>
/*
  Позиция: левый верхний угол — там же, где стрелки в любом браузере.
  z-index ниже модалок AniMori, но выше шапки сайта.
*/
.am-nav {
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 9000;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: rgba(18, 20, 26, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(6px);
  color: #e7e9ef;
  opacity: 0.55;
  transition:
    opacity 0.16s ease,
    background 0.16s ease;
}

.am-nav.am-nav-open {
  opacity: 1;
  background: rgba(18, 20, 26, 0.9);
}

.am-nav-handle,
.am-nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background 0.14s ease,
    color 0.14s ease;
}

.am-nav-handle:hover,
.am-nav-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

/* Подтверждение копирования: цвет держится ровно столько же, сколько галочка. */
.am-nav-btn.am-nav-done {
  color: #7ddc9a;
}

.am-nav-handle svg {
  transition: transform 0.18s ease;
}

.am-nav.am-nav-pinned .am-nav-handle svg {
  transform: rotate(180deg);
}

/*
  Адрес: поле только для чтения, а не текст, ради выделения и прокрутки длинных адресов.
  Свойства шрифта и фона заданы явно — поле стоит в чужом документе со своими стилями.
*/
.am-nav-url {
  width: 300px;
  min-width: 0;
  height: 24px;
  margin: 0 2px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font:
    12px/24px ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  text-overflow: ellipsis;
  cursor: text;
}

.am-nav-url:focus {
  outline: none;
  border-color: rgba(255, 255, 255, 0.28);
  background: rgba(255, 255, 255, 0.1);
}

/*
  Свёрнутое состояние сжимается по ширине, а не скрывается через display:none:
  переход должен быть анимированным, а скрытые кнопки всё равно не должны
  ловить клики — за это отвечает pointer-events.
*/
.am-nav-items {
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition:
    max-width 0.2s ease,
    opacity 0.16s ease;
}

.am-nav.am-nav-open .am-nav-items {
  max-width: 470px;
  opacity: 1;
  pointer-events: auto;
}
</style>
