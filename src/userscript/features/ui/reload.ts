// Единая точка перезагрузки страницы и клавиатурные сочетания для неё.
// Почему не location.reload() и зачем ожидание записи — docs/DECISIONS.md.

import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

/**
 * Предел ожидания записи настроек перед перезагрузкой.
 * Полторы секунды: с запасом на запись файла и ниже порога «интерфейс завис».
 */
const FLUSH_TIMEOUT_MS = 1500

/**
 * Перезагружает страницу через мост; прикладной код обязан звать её, а не location.reload().
 * Ждёт незавершённых записей в хранилище, но не дольше FLUSH_TIMEOUT_MS.
 */
export async function reloadPage(): Promise<void> {
  try {
    // Таймер снимается в finally: иначе он держал бы страницу от выгрузки.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), FLUSH_TIMEOUT_MS)
    })

    try {
      const outcome = await Promise.race([Bridge.storage.flush(), timeout])
      if (outcome === 'timeout') {
        Logger(
          'WARN',
          `Запись настроек не завершилась за ${FLUSH_TIMEOUT_MS} мс, перезагружаемся без ожидания`,
        )
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  } catch (e) {
    Logger('ERROR', 'Не удалось дождаться записи настроек перед перезагрузкой', e)
  }

  try {
    await Bridge.shell.reload()
  } catch (e) {
    Logger('ERROR', 'Не удалось перезагрузить страницу', e)
  }
}

/** Повторный вызов initReloadControls() не должен вешать второй обработчик клавиатуры. */
let controlsInstalled = false

/**
 * Вешает F5 и Ctrl+R в десктопной сборке.
 * Только Tauri: в браузере эти сочетания обрабатывает он сам, и перебивать его нельзя.
 */
export function initReloadControls(): void {
  if (Bridge.platform !== 'tauri') return
  if (controlsInstalled) return
  controlsInstalled = true

  window.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      // Ctrl+Shift+R не трогаем: жёсткую перезагрузку без кэша мы обещать не можем.
      if (e.altKey || e.shiftKey || e.metaKey) return

      const isF5 = e.key === 'F5' && !e.ctrlKey
      const isCtrlR = e.ctrlKey && (e.key === 'r' || e.key === 'R')
      if (!isF5 && !isCtrlR) return

      // В поле ввода Ctrl+R не перехватываем: промах по клавише стоил бы набранного текста.
      if (isCtrlR) {
        const el = document.activeElement as HTMLElement | null
        const tag = el?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) {
          return
        }
      }

      e.preventDefault()
      void reloadPage()
    },
    // capture: сайт может гасить клавиатуру на своих узлах, а перезагрузка обязана работать.
    { capture: true },
  )
}
