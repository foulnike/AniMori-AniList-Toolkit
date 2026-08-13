// Точка входа тоста о недоступности источников; логика показа в NetToast.vue.
// Приложение не постраничное: снятие на смене роута сбросило бы «уже показано».

import { mountApp } from '@/utils/vue-mounter'
import NetToast from './NetToast.vue'

export const NET_TOAST_APP_KEY = 'net-toast'

/**
 * Монтирует тост. Вызывать после loadSettings() и до первых сетевых запросов:
 * компонент сверяется с накопленным учётом один раз при монтировании.
 */
export function initNetToast(): void {
  mountApp(NET_TOAST_APP_KEY, NetToast, {
    container: document.body,
    watchContainer: false,
  })
}
