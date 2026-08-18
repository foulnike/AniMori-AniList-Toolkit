// Точка входа своего клиента (режим сборки app).
// Отличие от скрипта: разметка своя и готова сразу, ждать нечего.

import { createApp } from 'vue'
import App from './App.vue'
import { loadSettings } from '@/core/settings'

// Корень обязан существовать: он лежит в нашем же index.html.
// Если его нет, разметка разошлась с кодом — молчать об этом вредно.
const root = document.getElementById('app')
if (!root) throw new Error('AniMori: корень #app не найден в index.html')

/**
 * Настройки поднимаются до первой отрисовки: от них зависит отбор 18+
 * и выбор источника названий, а полки главной спрашивают их сразу
 * в onMounted. Показать выдачу по дефолту и тут же перерисовать по
 * настоящему было бы хуже короткой паузы на чтение десятка ключей.
 *
 * Своих ошибок loadSettings не бросает: без хранилища он оставляет дефолты,
 * и окно вся равно открывается.
 */
async function start(): Promise<void> {
  await loadSettings()
  createApp(App).mount(root as HTMLElement)
}

void start()
