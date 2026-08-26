/// <reference types="vite/client" />

// Платформа сборки (см. define в vite.config.ts).
// Цель одна: своё приложение. Значение оставлено под Android из планов —
// там появится второе.
declare const __ANIMORI_PLATFORM__: 'userscript' | 'tauri' | 'app'

// Номер версии из package.json (см. define в vite.config.ts).
// Пункт 5.3.5: нужен рантайму для заголовка User-Agent нашего канала.
declare const __ANIMORI_VERSION__: string
