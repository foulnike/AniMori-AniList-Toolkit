// Состояние блока навигации: адрес текущей страницы, его копирование и полный экран.
// Отдельно от nav.ts по образцу action-panel-state.ts: импорт из компонента
// в модуль, который сам его монтирует, дал бы круг в графе модулей.

import { ref } from 'vue'

import { Bridge } from '@/bridge'

import { Logger } from '@/utils/logger'

/** Сколько кнопка держит отметку об успешном копировании. */
const COPIED_MS = 1500

/** Адрес текущей страницы. Обновляется задачей роута из nav.ts. */
export const currentUrl = ref(location.href)

/** Копирование удалось: кнопка ненадолго меняет вид. */
export const urlCopied = ref(false)

/**
 * Окно в полном экране. Значение приходит только ответом оболочки:
 * собственная копия разошлась бы с правдой при системном развороте окна.
 */
export const isFullscreen = ref(false)

let copiedTimer: number | undefined

/** Перечитывает адрес. Задача роута идемпотентна и вызывается на каждый переход. */
export function syncCurrentUrl(): void {
  currentUrl.value = location.href
}

/**
 * Кладёт адрес в буфер обмена. Отказ идёт в журнал, а не в тишину:
 * единственная реальная причина — невыданное разрешение в capabilities.
 */
export async function copyCurrentUrl(): Promise<void> {
  try {
    await Bridge.clipboard.writeText(currentUrl.value)
  } catch (e) {
    Logger('ERROR', 'Не удалось скопировать адрес страницы', e)
    return
  }

  urlCopied.value = true

  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    urlCopied.value = false
    copiedTimer = undefined
  }, COPIED_MS)
}

/**
 * Переключает полный экран. Флаг берётся из ответа команды, а не переворотом
 * своего значения: иначе после отказа кнопка показывала бы небывшее состояние.
 */
export async function toggleFullscreen(): Promise<void> {
  try {
    isFullscreen.value = await Bridge.shell.toggleFullscreen()
  } catch (e) {
    Logger('ERROR', 'Не удалось переключить полноэкранный режим', e)
  }
}
