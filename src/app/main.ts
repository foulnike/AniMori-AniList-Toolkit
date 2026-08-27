// Точка входа своего клиента (режим сборки app).
// Отличие от скрипта: разметка своя и готова сразу, ждать нечего.

import { createApp } from 'vue'
import App from './App.vue'
import { initCollection } from '@/core/collection'
import { initDatasetNames, updateDatasetNamesInBackground } from '@/core/dataset-names'
import { startEditSender } from '@/core/edit-sender'
import { loadSettings } from '@/core/settings'
import { installGlobalErrorHandlers } from '@/utils/logger'

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
 * и окно всё равно открывается.
 *
 * Отправщик очереди правок запускается после монтирования, а не до него:
 * чтение снимка задержало бы первую отрисовку, а очередь минуту-другую
 * подождёт. Раньше его не звали вовсе, и фоновый разбор с повтором при
 * возврате сети просто не жил: уходила только правка, сделанная руками
 * при живом сервере.
 *
 * Датасет названий стартует фоном и не блокирует окно: чтение слепка
 * с диска подождёт первый запрос имён (обещание одно на всех), а сверка
 * с последним выпуском живёт своей задачей и пишет только на диск.
 */
async function start(): Promise<void> {
  await loadSettings()

  // Перехватчики ставятся до первой отрисовки: сбой монтирования — тоже
  // событие для журнала. Раньше настроек нельзя: тумблер журнала не прочтён.
  installGlobalErrorHandlers()

  createApp(App).mount(root as HTMLElement)

  // Отправщику нужна поднятая коллекция: до неё в памяти править нечего.
  // Ошибка подъёма окно не роняет — список просто останется пустым до
  // первого действия, а причина уйдёт в журнал.
  try {
    await initCollection()
    startEditSender()
  } catch (e: unknown) {
    console.error('AniMori: отправщик правок не запущен', e)
  }

  void initDatasetNames()
  updateDatasetNamesInBackground()
}

void start()
