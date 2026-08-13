// Связь между страницей и сетевым блокировщиком из src-tauri/src/adblock.rs:
// приём докладов о заблокированных доменах и переключение тумблером из настроек.
//
// Почему не invoke: вызов команды потребовал бы выдачи нового разрешения контексту
// anilist.co, то есть ЛЮБОМУ скрипту чужого сайта. Вместо этого страница дёргает
// адрес на несуществующем домене, а блокировщик видит этот запрос и переключается.
// Зона .invalid зарезервирована стандартом и никогда не разрешается в сети: если
// блокировщика нет (браузер, другая ОС), запрос просто тихо умирает.

import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

const CONTROL_ORIGIN = 'https://adblock.animori.invalid'

declare global {
  interface Window {
    __animoriNetBlocked?: (host: string, total: number) => void
  }
}

/**
 * Принимает доклад оболочки о первой блокировке домена.
 *
 * Запись идёт обычным типом INFO, а не своим новым: типа вне фильтров логгера
 * в окне просто не видно.
 */
export function initNetBlockReporter(): void {
  if (Bridge.platform !== 'tauri') return

  window.__animoriNetBlocked = (host, total) => {
    Logger('INFO', `Адблок: заблокирован источник ${host}`, {
      всего_за_сессию: total,
    })
  }
}

export function destroyNetBlockReporter(): void {
  delete window.__animoriNetBlocked
}

/**
 * Включает или выключает сетевой блокировщик в оболочке.
 *
 * mode: 'no-cors' обязателен: без него браузерный движок сначала спросит разрешение
 * у чужого домена (preflight), а отвечать на него некому.
 *
 * Ошибка глотается молча: если перехвата нет, запрос упадёт — и это нормально,
 * красная запись в журнале только напугала бы без повода.
 */
export function setShellAdBlock(on: boolean): void {
  if (Bridge.platform !== 'tauri') return

  void fetch(`${CONTROL_ORIGIN}/${on ? 'on' : 'off'}`, {
    mode: 'no-cors',
    cache: 'no-store',
  }).catch(() => {})
}
