/** AniMori userscript entry point. */

import './style.scss'
// Через псевдопуть, а не из features/adblock: прямой импорт оставил бы оба модуля
// в графе юзерскрипта вопреки алиасу.
import { destroyAdblock, destroyNetProbe, initAdblock, initNetProbe } from '@adblock-impl'
import { loadInterfaceDictionary } from './api/dictionary'
import { loadAlToken } from './api/anilist'
import { amSetAccent } from './core/accent'
import { IS_ANILIST, IS_SHIKI } from './core/constants'
import { loadCustomLinks } from './core/custom-links'
import { openDB, runGarbageCollector } from './core/db'
import { loadUserDict, rebuildDictionary, setRemoteDict } from './core/dictionary'
import { initLifecycle, registerRouteTask, registerShutdownTask } from './core/lifecycle'
import { loadSettings, settings } from './core/settings'
import { initExporter } from './features/exporter'
import { initMedia, refreshMediaPage, registerMediaWidget } from './features/media'
import { extLinksWidget } from './features/media/extlinks'
import { franchiseWidget } from './features/media/franchise'
import { playerWidget } from './features/media/player'
import { ratingsWidget } from './features/media/ratings'
import { themesWidget } from './features/media/themes'
import { initScannerUI } from './features/scanner'
import { initSearch } from './features/search'
import { initTranslator, resetTranslatorRetries } from './features/translator'
import { initActionBar } from './features/ui/actions'
import { initLoggerUI } from './features/ui/logger-ui'
import { initNetToast } from './features/ui/net-toast'
import { initSettingsUI } from './features/ui/settings'
import { installGlobalErrorHandlers, Logger } from './utils/logger'
import { sweepPhantomRoots, unmountAll, unmountPageScoped } from './utils/vue-mounter'

/** Задержка сборщика мусора: не конкурировать с отрисовкой первой страницы. */
const GC_DELAY_MS = 15000

/** Шаг опроса в гейте готовности DOM: один кадр при 60 гц. */
const DOM_POLL_MS = 16

/**
 * Ждёт появления `document.body` (дефект A2): менеджер вставляет скрипт раньше,
 * чем браузер собрал дерево. Опрос рядом с событием — на случай, если
 * DOMContentLoaded пройдёт до подписки.
 */
function whenDomReady(): Promise<void> {
  if (document.body) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let poll: number | undefined

    const finish = (): void => {
      if (poll !== undefined) {
        window.clearInterval(poll)
        poll = undefined
      }
      document.removeEventListener('DOMContentLoaded', finish)
      resolve()
    }

    document.addEventListener('DOMContentLoaded', finish)
    poll = window.setInterval(() => {
      if (document.body) finish()
    }, DOM_POLL_MS)
  })
}

/**
 * Выполняет один шаг старта, не давая его падению унести остаток (дефект A1).
 * Не замена проверкам внутри подсистем: упавший шаг свою работу не сделал.
 */
// unknown принимает и синхронную функцию, и любой промис; возврат отбрасывается.
async function step(name: string, run: () => unknown): Promise<void> {
  try {
    await run()
  } catch (e) {
    Logger('ERROR', `Старт: шаг «${name}» не выполнен`, e)
  }
}

/**
 * Привязка подсистем к SPA-навигации. Здесь, а не в core/lifecycle.ts: ядро не знает
 * о features, иначе граф зависимостей стал бы круговым.
 * Порядок важен: снять старое → убрать фантомы → собрать новое.
 */
function wireLifecycle(): void {
  // Постраничные Vue-приложения. Панель и модалки сюда не попадают: живут всю сессию.
  registerRouteTask('vue:page-scoped', () => {
    const count = unmountPageScoped()
    if (count > 0) Logger('INFO', `[Router] Снято постраничных приложений: ${count}`)
  })

  // Фантомы: am-vue-root без живого приложения — React перенёс разметку с нашим корнем.
  registerRouteTask('vue:phantoms', () => {
    sweepPhantomRoots()
  })

  // Медиа-страница: загрузка данных при смене тайтла и восстановление виджетов.
  registerRouteTask('media', refreshMediaPage)
  registerRouteTask('translator:retries', resetTranslatorRetries)

  // Разбор идёт в обратном порядке, по выгрузке страницы.
  registerShutdownTask('vue:all', unmountAll)
  // Обе задачи уходят в заглушки из '@adblock-impl': резать рекламу нам нечем.
  registerShutdownTask('adblock', destroyAdblock)
  registerShutdownTask('net-probe', destroyNetProbe)

  initLifecycle()
}

/**
 * Порядок взят из init() монолита: DOM и настройки → перехватчики → акцент → панели →
 * БД → словарь → переводчик → поиск → виджеты → SPA-обвязка → сборщик мусора.
 * Всё, что читает settings, идёт строго после loadSettings(); каждый шаг в step().
 */
async function bootstrap(): Promise<void> {
  // Гейт DOM и чтение настроек независимы: ждать их по очереди незачем.
  await Promise.all([whenDomReady(), step('настройки', loadSettings)])

  // Читает settings.enableLogger, поэтому только после loadSettings().
  await step('перехватчики ошибок', installGlobalErrorHandlers)

  // Токен лежит в асинхронном хранилище, а берётся синхронно при сборке заголовков.
  await step('токен AniList', loadAlToken)

  // На Shikimori AniMori не рисует ничего. Проверка не лишняя: у старых установок
  // шапка с @match на shikimori.io обновится только после переустановки скрипта.
  if (IS_SHIKI) return
  if (!IS_ANILIST) return

  // Кэши наполняются до первой отрисовки и rebuildDictionary(): читаются они синхронно.
  await step('свои ссылки и словарь пользователя', () =>
    Promise.all([loadCustomLinks(), loadUserDict()]),
  )

  // Заглушка: рекламу в браузере режет расширение пользователя. Шаг оставлен
  // потому, что точка входа не знает, что стоит за '@adblock-impl'.
  await step('адблок', initAdblock)

  // Вторая заглушка оттуда же: разведка вложенных фреймов собирала адреса
  // для блокировщика, которого здесь нет.
  await step('сетевая разведка', initNetProbe)

  // Без этого вызова сохранённый пресет игнорируется.
  await step('акцентный цвет', () => amSetAccent(settings.accentPreset, settings.accentCustom))

  // Каждая фича регистрирует свою кнопку внутри init*(), порядок пилюль задаёт
  // ACTION_ORDER. Отдельные шаги: сломавшаяся модалка не лишает панели действий.
  await step('панель настроек', initSettingsUI)
  await step('журнал', initLoggerUI)
  await step('сканер', initScannerUI)
  await step('перенос списка', initExporter)
  await step('панель действий', initActionBar)

  // До всего, что ходит в сеть: подписка не знает о прошлых отказах.
  await step('предупреждение о сети', initNetToast)

  // Отказ БД не фатален (дефект A3): потребители кэша работают без него.
  await step('IndexedDB', openDB)

  const needTranslator =
    settings.translateInterface ||
    settings.translateTitles ||
    settings.translateCharacters ||
    settings.translateStaff

  await step('словарь интерфейса', async () => {
    if (!needTranslator) {
      rebuildDictionary()
      return
    }

    // Словарь берётся из IndexedDB и применяется сразу, сеть обновляет его в фоне:
    // прямой запрос здесь задерживал весь старт. Колбэк может сработать дважды.
    Logger('API', 'Загрузка словаря интерфейса...')
    const applied = await loadInterfaceDictionary((dict) => setRemoteDict(dict))
    // Ни в кэше, ни в сети: пересобираем вручную ради правок пользователя.
    if (!applied) rebuildDictionary()
  })

  await step('переводчик', initTranslator)

  // Поиск вешает слушатели на body и готовой разметки сайта не требует.
  await step('поиск', initSearch)

  // Виджеты живут на наблюдателе переводчика; порядок регистрации задаёт порядок блоков.
  await step('медиа-виджеты', () => {
    registerMediaWidget(playerWidget)
    registerMediaWidget(ratingsWidget)
    registerMediaWidget(franchiseWidget)
    registerMediaWidget(themesWidget)
    registerMediaWidget(extLinksWidget)
    initMedia()
  })

  // После initMedia(): первый проход делает сам медиа-модуль, здесь — смены адреса.
  // Потеря этого шага давала симптом «перешёл на страницу, она пустая».
  await step('SPA-обвязка', wireLifecycle)

  // Фоновая чистка устаревшего кэша: без вызова IndexedDB росла бесконечно.
  window.setTimeout(() => void runGarbageCollector(), GC_DELAY_MS)
}

// Сторож страницы. Проверка идёт ВНЕ bootstrap(): упавший старт не должен
// выглядеть как незагрузившийся сайт. Молчание — норма; в журнал уходит только
// случай, когда разметки AniList так и не появилось.
const ANILIST_ROOT_SELECTOR = '#app'
const ALIVE_POLL_MS = 250
const ALIVE_ATTEMPTS = 32 // около 8 секунд

function reportPageAlive(): void {
  let left = ALIVE_ATTEMPTS
  const tick = (): void => {
    if (document.querySelector(ANILIST_ROOT_SELECTOR)) return
    if (--left <= 0) {
      Logger('WARN', 'Разметка AniList не появилась за 8 с: страница не загрузилась')
      return
    }
    window.setTimeout(tick, ALIVE_POLL_MS)
  }
  tick()
}

// На чужом домене корня #app нет и быть не должно — сторожить там нечего.
if (IS_ANILIST) reportPageAlive()

// Последняя сетка (дефект A1): сбой самого каркаса старта обязан попасть в журнал.
void bootstrap().catch((e) => {
  Logger('ERROR', 'Старт AniMori оборвался', e)
})
