// Точка входа панели настроек: монтирует SettingsModal.vue и кнопку ⚙.
// Разметка живёт в SettingsModal.vue, состояние — в settings-state.ts.

import { mountApp } from '@/utils/vue-mounter'
import SettingsModal from './SettingsModal.vue'
import { ACTION_ORDER, registerActionButton } from './actions'
import { openSettings, toggleSettings } from './settings-state'

export const SETTINGS_APP_KEY = 'settings-modal'

/** Открыть панель настроек извне. */
export function openSettingsModal(): void {
  openSettings()
}

/**
 * Монтирует панель настроек и регистрирует кнопку ⚙.
 * Вызывать только после loadSettings(): компонент читает settings при первом рендере.
 */
export function initSettingsUI(): void {
  // Корень в body вне разметки AniList, поэтому наблюдение за контейнером не нужно.
  mountApp(SETTINGS_APP_KEY, SettingsModal, {
    container: document.body,
    watchContainer: false,
  })

  registerActionButton({
    id: 'am-set-btn',
    label: '⚙',
    title: 'Настройки AniMori',
    order: ACTION_ORDER.settings,
    onClick: toggleSettings,
  })
}
