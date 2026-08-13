// Подключает UI логгера: сток записей, LoggerModal.vue и кнопка в панели.
// Записи держит кольцевой буфер в logger-state.ts: в DOM их накапливалось до шести тысяч.

import { settings } from '../../core/settings'
import { registerLogSink } from '../../utils/logger'
import { mountApp } from '../../utils/vue-mounter'
import { ACTION_ORDER, registerActionButton } from './actions'
import LoggerModal from './LoggerModal.vue'
import { isLoggerOpen, pushLogEntry } from './logger-state'

export const LOGGER_APP_KEY = 'logger-modal'

/** Открывает модалку логгера. Используется как onClick в registerActionButton. */
export function openLoggerModal(): void {
  isLoggerOpen.value = true
}

/**
 * Подключает UI логгера: подписка на записи, монтирование модалки, кнопка в панели.
 * Видимость модалки управляется через isLoggerOpen из logger-state.ts.
 */
export function initLoggerUI(): void {
  if (!settings.enableLogger) return

  // Записи копятся в буфер и при закрытой модалке: при открытии она синхронизируется сама.
  registerLogSink((entry) => {
    pushLogEntry(entry)
  })

  mountApp(LOGGER_APP_KEY, LoggerModal, { container: document.body, watchContainer: false })

  registerActionButton({
    id: 'am-log-btn',
    label: '</>',
    title: 'Открыть логгер (AniMori)',
    order: ACTION_ORDER.logger,
    onClick: openLoggerModal,
  })
}
