// Реализация IProxyDiagnostics для десктопа. Вынесена из TauriBridge.ts ради размера.
// Инвариант 1 цел: файл внутри src/bridge, его импортирует только TauriBridge,
// а тот отсекается псевдопутём '@bridge-impl'.

import { invoke } from '@tauri-apps/api/core'

import type { IProxyDiagnostics, ProxyOutcome, ProxyProbe, ProxyStatus } from './IBridge'

/**
 * Что отдаёт Rust; сериализатор там настроен на camelCase. Поля reachable в ответе
 * нет: в Rust это то же самое, что outcome === 'applied', а два источника одной правды
 * разошлись бы. В контракте поле есть: карточке удобнее читать его, а не строки.
 */
type RawProxyProbe = {
  outcome: ProxyOutcome
  server: string
  hasCredentials: boolean
  latencyMs: number
}

export const tauriProxyDiagnostics: IProxyDiagnostics = {
  /**
   * Исход применения прокси при запуске и состояние авторизации на сейчас.
   * Сетевой работы нет, вызов дешёвый.
   */
  async status(): Promise<ProxyStatus> {
    return await invoke<ProxyStatus>('animori_proxy_status')
  },

  /**
   * Живая проверка сохранённого адреса: до двух секунд, поэтому только по кнопке.
   */
  async probe(): Promise<ProxyProbe> {
    const raw = await invoke<RawProxyProbe>('animori_proxy_probe')

    return {
      outcome: raw.outcome,
      server: raw.server,
      reachable: raw.outcome === 'applied',
      latencyMs: raw.latencyMs,
    }
  },

  /**
   * Сообщает оболочке, что страница ожила (5.3.7): на той стороне поднимается флаг,
   * по которому сторож решает, вмешиваться ли.
   */
  async markPageReady(): Promise<void> {
    try {
      await invoke('animori_page_ready')
    } catch (e) {
      // Отклонение запрещено контрактом: отметка — страховка от редкого отказа,
      // ронять из-за неё старт нельзя. Логгер недоступен: он сам читает мост.
      console.warn('[AniMori] Не удалось отметить готовность страницы', e)
    }
  },
}
