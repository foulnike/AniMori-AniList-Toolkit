// AniList — SPA: адрес меняется через History API, документ при этом не перезагружается.
// Наблюдателя мутаций мало: между однотипными страницами React переиспользует узлы.
// Модуль не знает ни о виджетах, ни о селекторах: вся привязка живёт в main.ts.

import { Logger } from '../utils/logger'

/**
 * Задержка перед реакцией на смену адреса.
 * К моменту вызова pushState новой разметки ещё нет.
 */
const ROUTE_DELAY_MS = 50

/** Период страховочного пулинга адреса. */
const POLL_INTERVAL_MS = 800

/** Одна зарегистрированная задача. */
interface LifecycleTask {
  name: string
  run: () => void
}

/** Задачи на смену роута, в порядке регистрации. */
const routeTasks: LifecycleTask[] = []

/** Задачи на полный разбор скрипта. */
const shutdownTasks: LifecycleTask[] = []

let isStarted = false

/**
 * Адрес, для которого задачи уже отработали. Читает его ТОЛЬКО пулинг.
 * Сверять по нему сам прогон нельзя: это закрывает повтор по тому же адресу.
 */
let lastHandledUrl = ''

let routeTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * Регистрирует задачу на каждую смену адреса. Задача обязана быть идемпотентной
 * и дешёвой: повторный вызов по тому же адресу — штатный способ дожать промах.
 *
 * @param name Имя для журнала: по нему видно, какая задача упала.
 */
export function registerRouteTask(name: string, run: () => void): void {
  routeTasks.push({ name, run })
}

/**
 * Регистрирует задачу разбора: снятие наблюдателей, размонтирование Vue, стили.
 * Вызывается только из shutdownLifecycle().
 */
export function registerShutdownTask(name: string, run: () => void): void {
  shutdownTasks.push({ name, run })
}

/** Имена зарегистрированных задач — для дампа состояния в логгере. */
export function listLifecycleTasks(): { route: string[]; shutdown: string[] } {
  return {
    route: routeTasks.map((task) => task.name),
    shutdown: shutdownTasks.map((task) => task.name),
  }
}

/**
 * Прогоняет все задачи роута.
 * Каждая в своём try/catch: упавшая уборка фантомов не должна сносить виджеты.
 */
function runRouteTasks(): void {
  for (const task of routeTasks) {
    try {
      task.run()
    } catch (e) {
      Logger('WARN', `[Router] Задача «${task.name}» завершилась ошибкой`, e)
    }
  }
}

/**
 * Планирует прогон и гасит дубли: таймер один на всех и сдвигается при каждом
 * вызове, так что три события на один переход дают один прогон.
 */
function scheduleRouteTasks(): void {
  if (routeTimer) clearTimeout(routeTimer)
  routeTimer = setTimeout(() => {
    routeTimer = null
    lastHandledUrl = location.href
    runRouteTasks()
  }, ROUTE_DELAY_MS)
}

/**
 * Запускает отслеживание SPA-навигации по трём источникам: обёртки pushState
 * и replaceState, событие popstate и пулинг на случай переприсвоения History API.
 *
 * @param onRouteChange Необязательный коллбэк ради старого вызова
 *   initLifecycle(refreshMediaPage); внутри — обычная задача с именем 'legacy'.
 */
export function initLifecycle(onRouteChange?: () => void): void {
  if (isStarted) return
  isStarted = true

  if (onRouteChange) registerRouteTask('legacy', onRouteChange)

  // Стартовый адрес сюда писать нельзя: первый проход подсистем одноразовый
  // и может не застать разметку готовой. С пустой строкой пулинг делает один
  // дожимающий прогон, и это дешевле пустой страницы до ручной перезагрузки.
  lastHandledUrl = ''

  const notifyDeferred = (reason: string): void => {
    Logger('INFO', `[Router] ${reason}`)
    scheduleRouteTasks()
  }

  // Обёртки держим тонкими: это чужой History API, и исключение вышло бы наружу.
  const originalPushState = history.pushState.bind(history)
  history.pushState = (...args: Parameters<History['pushState']>): void => {
    originalPushState(...args)
    notifyDeferred(`Переход по ссылке на ${location.pathname}`)
  }

  const originalReplaceState = history.replaceState.bind(history)
  history.replaceState = (...args: Parameters<History['replaceState']>): void => {
    originalReplaceState(...args)
    notifyDeferred(`Обновление роута ${location.pathname}`)
  }

  window.addEventListener('popstate', () => {
    notifyDeferred(`Кнопка Назад/Вперед ➜ ${location.pathname}`)
  })

  // Пулинг не логируется: обёртки выше уже сообщили о переходе.
  // Сверка с lastHandledUrl только здесь: иначе он гонял бы задачи бесконечно.
  pollTimer = setInterval(() => {
    if (location.href === lastHandledUrl) return
    scheduleRouteTasks()
  }, POLL_INTERVAL_MS)

  Logger('INFO', `[Router] Отслеживание SPA-навигации запущено, задач: ${routeTasks.length}`)
}

/**
 * Полный разбор: гасит пулинг и прогоняет задачи в обратном порядке, как стек.
 * Обёртки над History API не снимаются: гарантии, что после нас их никто не менял, нет.
 */
export function shutdownLifecycle(): void {
  if (!isStarted) return

  if (routeTimer) {
    clearTimeout(routeTimer)
    routeTimer = null
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }

  for (const task of [...shutdownTasks].reverse()) {
    try {
      task.run()
    } catch (e) {
      Logger('WARN', `[Router] Разбор «${task.name}» завершился ошибкой`, e)
    }
  }

  isStarted = false
  Logger('INFO', '[Router] Отслеживание SPA-навигации остановлено')
}
