<!--
  Панель настроек #am-panel: каркас модалки, навигация и простые вкладки.
  Сложные вкладки вынесены в свои компоненты, состояние — в settings-state.ts.
-->
<template>
  <div
    v-if="isSettingsOpen"
    id="am-panel"
    class="am-accent-scope"
    style="display: flex"
    @click.self="closeSettings()"
  >
    <div class="amk-modal">
      <div class="amk-head">
        <h2 class="amk-title">
          <span class="amk-dot"></span>AniMori <span class="amk-sub">настройки</span>
        </h2>
        <button class="amk-close" id="am-set-close" title="Закрыть" @click="closeSettings()">
          ✕
        </button>
      </div>

      <div class="amk-body amk-tabbed">
        <nav class="amk-tabnav">
          <button
            v-for="tab in TABS"
            :key="tab.key"
            type="button"
            class="amk-tab"
            :class="{ active: activeTab === tab.key }"
            :data-tab="tab.key"
            @click="activeTab = tab.key"
          >
            <span class="amk-tab-ic">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                v-html="TAB_ICONS[tab.key]"
              ></svg>
            </span>
            {{ tab.label }}
            <span
              v-if="tab.key === 'dict'"
              class="amk-tab-count"
              id="am-dict-count"
              :hidden="dictTotal === 0"
              >{{ dictTotal }}</span
            >
          </button>
        </nav>

        <div class="amk-tabpanes">
          <!-- ==== Перевод ==== -->
          <div
            class="amk-pane"
            :class="{ active: activeTab === 'translate' }"
            data-pane="translate"
          >
            <div class="amk-card">
              <div class="amk-card-title">Перевод</div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Интерфейс</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_interface" v-model="translateInterface" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Тайтлы и описания</b
                  ><span class="amk-row-hint">основной источник · фоллбэк</span></span
                >
              </div>
              <div class="amk-row" style="gap: 8px; border-top: none; padding-top: 0">
                <select
                  class="amk-select"
                  id="set_title_primary"
                  style="flex: 1"
                  :value="titlePrimary"
                  @change="onPrimaryChange($event)"
                >
                  <option value="shikimori">Shikimori</option>
                  <option value="anime365">anime365</option>
                  <option value="off">Выключено (оригинал)</option>
                </select>
                <select
                  class="amk-select"
                  id="set_title_fallback"
                  style="flex: 1"
                  :value="titleFallback"
                  :disabled="fallbackDisabled"
                  @change="onFallbackChange($event)"
                >
                  <option value="none">Без фоллбэка</option>
                  <option value="shikimori" :disabled="isFallbackOptionDisabled('shikimori')">
                    Shikimori
                  </option>
                  <option value="anime365" :disabled="isFallbackOptionDisabled('anime365')">
                    anime365
                  </option>
                </select>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Персонажи</b><span class="amk-row-hint">с Shikimori</span></span
                >
                <label class="amk-switch">
                  <input type="checkbox" id="set_chars" v-model="translateCharacters" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Персонал</b><span class="amk-row-hint">с Shikimori</span></span
                >
                <label class="amk-switch">
                  <input type="checkbox" id="set_staff" v-model="translateStaff" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
            </div>
          </div>

          <!-- ==== Словарь ==== -->
          <div class="amk-pane am-notr" :class="{ active: activeTab === 'dict' }" data-pane="dict">
            <SettingsDictTab />
          </div>

          <!-- ==== Модули ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'modules' }" data-pane="modules">
            <div class="amk-card">
              <div class="amk-card-title">Модули</div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Аниме-плеер</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_player" v-model="enablePlayer" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Рейтинги MAL и Shiki</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_ratings" v-model="enableRatings" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Дерево франшизы</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_franchise" v-model="enableFranchise" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Музыкальные темы</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_themes" v-model="enableThemes" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
            </div>
          </div>

          <!-- ==== Оформление ==== -->
          <div
            class="amk-pane"
            :class="{ active: activeTab === 'appearance' }"
            data-pane="appearance"
          >
            <div class="amk-card">
              <div class="amk-card-title">Оформление</div>
              <div class="amk-row-hint" style="padding: 2px 2px 8px">
                Акцентный цвет тулкита — тему AniList не меняет
              </div>
              <div class="am-accents" id="am-accent-chips">
                <button
                  v-for="key in ACCENT_KEYS"
                  :key="key"
                  type="button"
                  class="am-accent-chip"
                  :class="{ active: accentPreset === key }"
                  :data-key="key"
                  @click="selectAccent(key)"
                >
                  <span class="am-accent-dot" :style="{ background: accentDot(key) }"></span
                  >{{ AM_ACCENTS[key].name }}
                </button>
              </div>
              <!-- Пипетка и поле hex дублируют друг друга: нативный выбор может не открыться. -->
              <div class="amk-row" v-if="accentPreset === 'custom'" style="margin-top: 10px">
                <span class="amk-row-label"
                  ><b>Свой цвет</b
                  ><span class="amk-row-hint">пипетка или hex вида #7aa2f7</span></span
                >
                <span style="display: flex; gap: 8px; align-items: center; flex-shrink: 0">
                  <input
                    type="color"
                    id="am_accent_pick"
                    :value="accentCustomColor"
                    style="
                      width: 40px;
                      height: 32px;
                      padding: 2px;
                      background: transparent;
                      border: 1px solid rgba(var(--color-text-light), 0.25);
                      border-radius: 8px;
                      cursor: pointer;
                    "
                    @input="onAccentColor($event)"
                  />
                  <input
                    class="amk-input amk-mono"
                    id="am_accent_hex"
                    placeholder="#7aa2f7"
                    style="width: 104px"
                    :value="accentCustomColor"
                    @change="onAccentColor($event)"
                  />
                </span>
              </div>
              <div v-if="accentTooLight" class="amk-row-hint" style="padding: 8px 2px 2px">
                Цвет светлый: белый текст кнопок и активных серий на нём читается плохо.
              </div>
            </div>
          </div>

          <!-- ==== Ссылки ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'links' }" data-pane="links">
            <SettingsLinksTab />
          </div>

          <!-- ==== Аккаунт ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'account' }" data-pane="account">
            <div class="amk-card">
              <div class="amk-card-title">Авторизация AniList</div>
              <div class="amk-row-hint" style="padding: 8px 2px 6px">
                Токен нужен для экспорта и сравнения списков. Создайте Client
                <a
                  :href="AL_DEV_SETTINGS"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="color: rgb(var(--color-blue)); text-decoration: none"
                  >здесь</a
                >, redirect URL:
                <code
                  style="
                    background: rgba(var(--color-text-light), 0.12);
                    padding: 1px 5px;
                    border-radius: 4px;
                  "
                  >{{ AL_PIN_REDIRECT }}</code
                >
              </div>
              <input
                class="amk-input amk-mono"
                type="password"
                id="set_al_token"
                placeholder="Токен AniList"
                style="margin-bottom: 8px"
                :value="alToken"
                @change="onTokenChange($event)"
              />
              <div style="display: flex; gap: 8px; margin-bottom: 6px">
                <input
                  class="amk-input amk-mono"
                  id="set_al_client"
                  placeholder="Client ID"
                  style="flex: 1"
                  v-model="alClientId"
                />
                <button
                  class="amk-btn amk-btn-ghost"
                  id="set_al_gen"
                  title="Создать ссылку авторизации"
                  @click="onGenerateAuthLink()"
                >
                  Ссылка
                </button>
              </div>
              <div id="set_al_link_wrap" style="text-align: center; font-size: 12px">
                <a
                  v-if="alAuthLink"
                  :href="alAuthLink"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="
                    color: rgb(var(--color-blue));
                    text-decoration: none;
                    font-weight: bold;
                    display: block;
                    padding: 6px;
                    border: 1px dashed rgb(var(--color-blue));
                    border-radius: 6px;
                    margin-top: 5px;
                    transition: 0.2s;
                  "
                  >👉 Клик: Перейти к авторизации</a
                >
              </div>
            </div>
          </div>

          <!-- ==== Прочее ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'misc' }" data-pane="misc">
            <div class="amk-card">
              <div class="amk-card-title">Панель действий</div>
              <div class="amk-row-hint" style="padding: 2px 2px 8px; line-height: 1.5">
                Какие кнопки показывать в плавающей панели AniMori. Сами функции остаются рабочими.
              </div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Кнопка переноса</b
                  ><span class="amk-row-hint">перенос списков Shikimori → AniList</span></span
                >
                <label class="amk-switch">
                  <input type="checkbox" id="set_btn_sync" v-model="showSyncButton" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Кнопка сравнения</b
                  ><span class="amk-row-hint">сверка списков двух сайтов</span></span
                >
                <label class="amk-switch">
                  <input type="checkbox" id="set_btn_compare" v-model="showCompareButton" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
            </div>
          </div>

          <!-- ==== Разработчик ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'dev' }" data-pane="dev">
            <SettingsDevTab />
          </div>

          <!-- ==== Поддержать ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'support' }" data-pane="support">
            <SettingsSupportTab />
          </div>
        </div>
      </div>

      <div class="amk-foot">
        <button class="amk-btn amk-btn-primary amk-btn-block" id="am-apply" @click="onApply()">
          Применить и перезагрузить
        </button>
        <button
          class="amk-btn amk-btn-danger"
          id="am-clear"
          :title="clearTitle"
          :disabled="clearBusy"
          @click="onClearCache()"
        >
          {{ clearLabel }}
        </button>
      </div>
      <div
        v-if="clearArmed"
        class="amk-row-hint"
        id="am-clear-note"
        style="padding: 0 14px 10px; line-height: 1.5; text-align: right"
      >
        Будут удалены все сохранённые названия, персонажи, франшизы и темы. Настройки, токен и свой
        словарь останутся. После очистки страница перезагрузится, а данные поедут с серверов заново.
        Нажмите ещё раз для подтверждения.
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { AM_ACCENTS } from '../../core/accent'
import { clearCache } from '../../core/db'
import type { AccentPreset, TitleSource } from '../../core/settings'
import { Logger } from '../../utils/logger'
import SettingsDevTab from './SettingsDevTab.vue'
import SettingsDictTab from './SettingsDictTab.vue'
import SettingsLinksTab from './SettingsLinksTab.vue'
import SettingsSupportTab from './SettingsSupportTab.vue'
import { reloadPage } from './reload'
import {
  ACCENT_KEYS,
  AL_DEV_SETTINGS,
  AL_PIN_REDIRECT,
  accentCustomColor,
  accentCustomDot,
  accentPreset,
  accentTooLight,
  activeTab,
  alAuthLink,
  alClientId,
  alToken,
  closeSettings,
  dictTotal,
  enableFranchise,
  enablePlayer,
  enableRatings,
  enableThemes,
  fallbackDisabled,
  generateAuthLink,
  isFallbackOptionDisabled,
  isSettingsOpen,
  loadAuthState,
  refreshDict,
  reloadCustomLinks,
  saveAlToken,
  selectAccent,
  setAccentCustom,
  showCompareButton,
  showSyncButton,
  syncTitleSources,
  titleFallback,
  titlePrimary,
  translateCharacters,
  translateInterface,
  translateStaff,
} from './settings-state'
import type { TabKey } from './settings-state'

/** Сколько кнопка сброса держится «на взводе»: хватает прочитать предупреждение. */
const CLEAR_ARM_MS = 8000

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'translate', label: 'Перевод' },
  { key: 'dict', label: 'Словарь' },
  { key: 'modules', label: 'Модули' },
  { key: 'appearance', label: 'Оформление' },
  { key: 'links', label: 'Ссылки' },
  { key: 'account', label: 'Аккаунт' },
  { key: 'misc', label: 'Прочее' },
  { key: 'dev', label: 'Разработчик' },
  { key: 'support', label: 'Поддержать' },
]

/** Иконки вкладок — те же SVG, что в 1.9.1; у dev — терминал. */
const TAB_ICONS: Record<TabKey, string> = {
  translate:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>',
  dict: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  modules:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  appearance: '<path d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/>',
  links:
    '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-2 2"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l2-2"/>',
  account: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="M16 7l3 3"/>',
  misc: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
  dev: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
  support:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
}

function inputValue(e: Event): string {
  const el = e.target
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : ''
}

// ==== Источники названий ====

function onPrimaryChange(e: Event): void {
  titlePrimary.value = inputValue(e) as TitleSource
  syncTitleSources()
}

function onFallbackChange(e: Event): void {
  titleFallback.value = inputValue(e) as TitleSource
}

// ==== Оформление ====

/** У чипа «Свой цвет» кружок показывает выбранный оттенок, а не радугу. */
function accentDot(key: AccentPreset): string {
  return key === 'custom' ? accentCustomDot.value : AM_ACCENTS[key].dot
}

function onAccentColor(e: Event): void {
  setAccentCustom(inputValue(e))
}

// ==== Аккаунт ====

function onTokenChange(e: Event): void {
  alToken.value = inputValue(e).trim()
  saveAlToken()
}

function onGenerateAuthLink(): void {
  if (!generateAuthLink()) {
    alert('Введите Client ID (его можно создать в настройках AniList -> Developer)')
  }
}

// ==== Подвал ====

// Обёртка нужна ради void: reloadPage() асинхронен, а обработчику клика промис не нужен.
function onApply(): void {
  void reloadPage()
}

// ==== Очистка кэша ====

/** Первый клик взвёл кнопку и показал предупреждение. */
const clearArmed = ref(false)
/** Очистка идёт или уже завершилась и ждёт перезагрузки: повторный клик бессмыслен. */
const clearBusy = ref(false)
const clearLabel = ref('Очистить кэш')
const clearTitle = ref('Удалить сохранённые данные и перезагрузить страницу')

let clearTimer: number | undefined

/** Снять взвод и вернуть кнопке исходный вид. */
function disarmClear(): void {
  if (clearTimer !== undefined) {
    window.clearTimeout(clearTimer)
    clearTimer = undefined
  }
  if (clearBusy.value) return
  clearArmed.value = false
  clearLabel.value = 'Очистить кэш'
  clearTitle.value = 'Удалить сохранённые данные и перезагрузить страницу'
}

/**
 * Сброс кэша в два шага: первый клик взводит кнопку, второй запускает очистку.
 * Перезагрузка безусловна: половина виджетов уже держит в памяти то,
 * что только что стёрто.
 */
function onClearCache(): void {
  if (clearBusy.value) return

  if (!clearArmed.value) {
    clearArmed.value = true
    clearLabel.value = 'Точно очистить?'
    clearTitle.value = 'Нажмите ещё раз, чтобы подтвердить очистку'
    clearTimer = window.setTimeout(disarmClear, CLEAR_ARM_MS)
    return
  }

  if (clearTimer !== undefined) {
    window.clearTimeout(clearTimer)
    clearTimer = undefined
  }

  clearBusy.value = true
  clearArmed.value = false
  clearLabel.value = 'Очистка...'
  clearTitle.value = 'Идёт очистка кэша'

  void clearCache()
    .catch((e: unknown) => {
      Logger('ERROR', 'Сброс кэша: неожиданный сбой', e)
    })
    .then(() => {
      clearLabel.value = 'Кэш сброшен'
      clearTitle.value = 'Перезагрузка...'
      void reloadPage()
    })
}

// ==== Жизненный цикл ====

onMounted(() => {
  reloadCustomLinks()
  loadAuthState()
  syncTitleSources()
})

onBeforeUnmount(() => {
  if (clearTimer !== undefined) window.clearTimeout(clearTimer)
})

// Словарь и свои ссылки меняются извне, поэтому перечитываем их при каждом открытии.
watch(isSettingsOpen, (open) => {
  // Панель не должна открываться с кнопкой, готовой стереть кэш по одному клику.
  disarmClear()
  if (!open) return
  refreshDict()
  reloadCustomLinks()
})
</script>
