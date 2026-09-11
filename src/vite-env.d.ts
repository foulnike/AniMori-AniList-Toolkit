/// <reference types="vite/client" />

// Номер версии из package.json (см. define в vite.config.ts).
// Подставляет сборка: число версии руками в коде не пишем (инвариант 11).
declare const __ANIMORI_VERSION__: string

// ==== GM_* API ====
// @types/greasemonkey описывает только GM.* (GM4), а мы зовём GM_*.
// Зовёт их один мост, src/bridge/index.ts (инвариант 9); описано ровно то, что есть в @grant.
declare function GM_getValue<T>(key: string, defaultValue: T): T
declare function GM_getValue(key: string): unknown
declare function GM_setValue(key: string, value: unknown): void
declare function GM_addStyle(css: string): HTMLStyleElement
declare function GM_setClipboard(text: string, type?: string): void

declare interface GMXhrResponse {
  readonly status: number
  readonly statusText: string
  readonly responseText: string
  readonly responseHeaders: string
  readonly finalUrl: string
  readonly response: unknown
}

declare interface GMXhrDetails {
  method?: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE' | 'PATCH'
  url: string
  headers?: Record<string, string>
  data?: string
  responseType?: 'text' | 'json' | 'blob' | 'arraybuffer'
  timeout?: number
  /**
   * Не отправлять куки текущей сессии. Реализует режим credentials: 'omit' из моста.
   *
   * Поддерживается Tampermonkey и Violentmonkey, но не Greasemonkey 4. Менеджеры без
   * поддержки просто игнорируют поле и отправляют куки — см. предупреждение в src/bridge/index.ts.
   */
  anonymous?: boolean
  onload?: (response: GMXhrResponse) => void
  onerror?: (response: GMXhrResponse) => void
  ontimeout?: (response: GMXhrResponse) => void
  onabort?: (response: GMXhrResponse) => void
}

declare function GM_xmlhttpRequest(details: GMXhrDetails): { abort: () => void }

// Информация о менеджере юзерскриптов. Доступна без отдельного @grant.
// Нужна мосту, чтобы понять, поддерживается ли анонимный запрос.
declare const GM_info:
  | {
      scriptHandler?: string
      version?: string
    }
  | undefined
