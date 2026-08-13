// Точка монтирования сканера и регистрация его кнопки: логика сверки в compare.ts,
// состояние в scanner-state.ts, разметка в ScannerModal.vue.

import { mountApp, unmountApp } from '@/utils/vue-mounter'
import { ACTION_ORDER, registerActionButton } from '../ui/actions'
import { showCompareButton } from '../ui/settings-state'
import ScannerModal from './ScannerModal.vue'
import { closeScanner, isScannerOpen, openScanner } from './scanner-state'

export const SCANNER_APP_KEY = 'scanner-modal'

let mounted = false

/**
 * Монтирует модалку лениво, при первом открытии: сканер открывают редко.
 *
 * watchContainer: false — корнем служит document.body, React его не пересобирает (риск №3).
 */
function ensureMounted(): void {
  if (mounted) return
  mountApp(SCANNER_APP_KEY, ScannerModal, { container: document.body, watchContainer: false })
  mounted = true
}

/** Обработчик кнопки ⇄ на панели действий. */
export async function openCompareModal(): Promise<void> {
  ensureMounted()
  await openScanner()
}

export function closeCompareModal(): void {
  closeScanner()
}

export function toggleCompareModal(): void {
  if (isScannerOpen.value) closeScanner()
  else void openCompareModal()
}

/**
 * Регистрирует кнопку ⇄ в панели действий.
 *
 * Вызывать до initActionBar(), как и остальные init*UI(): порядок пилюль задаёт
 * ACTION_ORDER, а не очередь вызовов. Модалка здесь намеренно не монтируется.
 *
 * Регистрация безусловная, даже если тумблер выключен: панель сама отсеивает
 * скрытые кнопки. Передаём ссылку на модель, а не её значение, иначе панель
 * запомнила бы состояние на момент старта и тумблер требовал бы перезагрузки.
 */
export function initScannerUI(): void {
  registerActionButton({
    id: 'am-cmp-btn',
    label: '⇄',
    title: 'Сравнить списки Shikimori и AniList (AniMori)',
    order: ACTION_ORDER.compare,
    visible: showCompareButton,
    onClick: () => void openCompareModal(),
  })
}

export function destroyScannerUI(): void {
  if (!mounted) return
  closeScanner()
  unmountApp(SCANNER_APP_KEY)
  mounted = false
}

// Совместимость: до разделения логика сверки жила здесь, поэтому её публичный
// API пробрасывается дальше — сторонние импорты из 'features/scanner' не ломаются.
export * from './compare'
