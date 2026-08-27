// Единая точка перезагрузки страницы: сначала дожидаемся записи настроек,
// потом уходим: иначе правка настройки теряется вместе со старой страницей.

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
