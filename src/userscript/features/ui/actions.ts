// Точка запуска панели действий: разметка в ActionPanel.vue, состояние в action-panel-state.ts.
// Реестр кнопок вынесен в отдельный модуль: иначе цикл через ActionPanel.vue.

import { mountApp, unmountApp } from '../../utils/vue-mounter'
import ActionPanel from './ActionPanel.vue'

export {
  ACTION_ORDER,
  hidePlayerButton,
  registerActionButton,
  showPlayerButton,
  type ActionButton,
} from './action-panel-state'

/** Ключ в реестре vue-mounter'а. */
export const ACTION_PANEL_APP_KEY = 'action-panel'

const CONTAINER_ID = 'animori-actions'

let isStarted = false

/**
 * Монтирует панель действий в body: контейнер создаёт сам компонент.
 * Кнопки обязаны оставаться соседями: на этом держится `.am-premium-btn + .am-premium-btn`.
 */
export function initActionBar(): void {
  if (isStarted) return
  isStarted = true

  // Узел мог остаться от прежней версии после горячего обновления — тогда панелей две.
  document.getElementById(CONTAINER_ID)?.remove()

  // Наблюдатель не нужен: панель fixed и лежит вне дерева React, а дети body меняются постоянно.
  mountApp(ACTION_PANEL_APP_KEY, ActionPanel, {
    container: document.body,
    watchContainer: false,
  })
}

/** Снимает панель. Нужно для LifecycleManager. */
export function destroyActionBar(): void {
  unmountApp(ACTION_PANEL_APP_KEY)
  isStarted = false
}
