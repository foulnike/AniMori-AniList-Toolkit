// Точка входа своего клиента (режим сборки app).
// Отличие от скрипта: разметка своя и готова сразу, ждать нечего.

import { createApp } from 'vue'
import App from './App.vue'

// Корень обязан существовать: он лежит в нашем же index.html.
// Если его нет, разметка разошлась с кодом — молчать об этом вредно.
const root = document.getElementById('app')
if (!root) throw new Error('AniMori: корень #app не найден в index.html')

createApp(App).mount(root)
