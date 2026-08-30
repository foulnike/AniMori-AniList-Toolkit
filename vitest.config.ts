import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@/api': fileURLToPath(new URL('./src/shared/api', import.meta.url)),
      '@/bridge': fileURLToPath(new URL('./src/shared/bridge', import.meta.url)),
      '@/core': fileURLToPath(new URL('./src/shared/core', import.meta.url)),
      '@/utils': fileURLToPath(new URL('./src/shared/utils', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@bridge-impl': fileURLToPath(new URL('./tests/mocks/bridge.ts', import.meta.url)),
      '@/bridge': fileURLToPath(new URL('./tests/mocks/bridge-module.ts', import.meta.url)),
    },
  },
  define: {
    __ANIMORI_PLATFORM__: JSON.stringify('app'),
    __ANIMORI_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
})
