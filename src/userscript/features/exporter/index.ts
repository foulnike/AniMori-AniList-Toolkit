// Точка монтирования модуля переноса списков: сеть в sync-api.ts, состояние
// в sync-state.ts, разметка в SyncModal.vue.
//
// Вход один для обеих сборок — пилюля в панели действий AniList. Точки на
// Shikimori больше нет: десктопная оболочка показывает только anilist.co,
// и вход на чужом домене там недостижим, а два сценария пришлось бы
// тестировать отдельно.

import { Logger } from '../../utils/logger'
import { mountApp, unmountApp } from '../../utils/vue-mounter'
import { ACTION_ORDER, registerActionButton } from '../ui/action-panel-state'
import { showSyncButton } from '../ui/settings-state'
import SyncModal from './SyncModal.vue'
import { closeSyncModal, isSyncOpen, openSyncModal, pillProgress } from './sync-state'

export const SYNC_MODAL_APP_KEY = 'sync-modal'

/**
 * Иконка переноса: стрелка в приёмный лоток, а не круговые стрелки: рядом
 * стоит кнопка сравнения со знаком ⇄, и два стрелочных значка читались бы
 * как одно действие. Формат — внутренности SVG 24×24 без оболочки.
 */
const SYNC_ICON =
  '<path d="M12 3v11"/><path d="M7.5 9.5 12 14l4.5-4.5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'

let mounted = false

/**
 * Монтирует окно переноса и регистрирует кнопку в панели действий.
 *
 * Ленивого монтирования нет намеренно: внутри окна стоит v-if, до первого
 * открытия в DOM попадает только пустой корень.
 *
 * watchContainer: false — корнем служит document.body, пересобирать его некому (риск №3).
 *
 * Прогресс и видимость отдаются панели ссылками, а не значениями: кнопка
 * регистрируется один раз при старте, а текст меняется десятки раз за перенос.
 *
 * Тумблер во вкладке «Прочее» прячет только кнопку: окно остаётся смонтированным
 * и toggleSyncModal() работает. Гасить сам модуль по этой настройке нельзя: она
 * про внешний вид панели, а не про отключение переноса.
 */
export function initExporter(): void {
  if (mounted) return
  Logger('INFO', 'Инициализация модуля синхронизации')
  mountApp(SYNC_MODAL_APP_KEY, SyncModal, { container: document.body, watchContainer: false })
  registerActionButton({
    id: 'am-sync-btn',
    label: 'Перенос',
    title: 'Перенос списков Shikimori → AniList (AniMori)',
    order: ACTION_ORDER.sync,
    icon: SYNC_ICON,
    progress: pillProgress,
    visible: showSyncButton,
    onClick: () => toggleSyncModal(),
  })
  mounted = true
}

export function destroyExporter(): void {
  if (!mounted) return
  closeSyncModal()
  unmountApp(SYNC_MODAL_APP_KEY)
  mounted = false
}

/**
 * Переключает окно переноса.
 *
 * Открытие асинхронное (читает запомненный логин из хранилища моста), но обработчик
 * кнопки синхронный: панель ловит только синхронные исключения, поэтому промис
 * гасится явно через void, а ошибки чтения хранилища обработаны внутри моста.
 */
export function toggleSyncModal(): void {
  if (isSyncOpen.value) closeSyncModal()
  else void openSyncModal()
}

// Совместимость: до разделения весь перенос жил в этом модуле, поэтому его публичный
// API пробрасывается дальше — сторонние импорты из 'features/exporter' не ломаются.
export * from './sync-api'
export * from './sync-state'
