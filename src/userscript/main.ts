/** AniMori userscript entry point. */

import './style.scss'
// Через псевдопуть, а не из shared/adblock: прямой импорт оставил бы оба модуля
// в графе юзерскрипта вопреки алиасу.
import { destroyAdblock, destroyNetProbe, initAdblock, initNetProbe } from '@adblock-impl'
import { loadInterfaceDictionary } from '@/api/dictionary'
import { loadAlToken } from '@/api/anilist'
import { amSetAccent } from '@/core/accent'
import { IS_ANILIST, IS_SHIKI } from '@/core/constants'
import { openDB, runGarbageCollector } from '@/core/db'
import { loadUserDict, rebuildDictionary, setRemoteDict } from '@/core/dictionary'
import { loadSettings, settings } from '@/core/settings'
import { initExporter } from '@/features/exporter'
import { initMedia, refreshMediaPage, registerMediaWidget } from '@/features/media'
import { extLinksWidget } from '@/features/media/extlinks'
import { franchiseWidget } from '@/features/media/franchise'
import { playerWidget } from '@/features/media/player'
import { ratingsWidget } from '@/features/media/ratings'
import { themesWidget } from '@/features/media/themes'
import { initScannerUI } from '@/features/scanner'
import { initSearch } from '@/features/search'
import { initTranslator, resetTranslatorRetries } from '@/features/translator'
import { initActionBar } from '@/features/ui/actions'
import { initLinks } from '@/features/ui/links'
import { initLoggerUI } from '@/features/ui/logger-ui'
import { initNavPanel } from '@/features/ui/nav'
import { initNetToast } from '@/features/ui/net-toast'
import { initSettingsUI } from '@/features/ui/settings'
import { installGlobalErrorHandlers, Logger } from '@/utils/logger'
import { sweepPhantomRoots, unmountAll, unmountPageScoped } from '@/utils/vue-mounter'
import { Bridge } from '@/bridge'

// Сосед по слою, а не ядро: реестр задач знает про роуты и корни чужого SPA,
// поэтому при разделении дерева он остался рядом с точкой входа.
import { initLifecycle, registerRouteTask, registerShutdownTask } from './lifecycle'

/** Задержка сборщика мусора: не конкурировать с отрисовкой первой страницы. */
const GC_DELAY_MS = 15000

/** Шаг опроса в гейте готовности DOM: один кадр при 60 гц. */
const DOM_POLL_MS = 16

/**
 * Ждёт появления `document.body` (дефект A2): в десктопе бандл идёт
 * initialization_script'ом и выполняется ДО создания DOM. Опрос рядом с событием —
 * на случай, если DOMContentLoaded пройдёт до подписки.
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
 * Привязка подсистем к SPA-навигации. Здесь, а не в lifecycle.ts: реестр задач
 * не знает о features, иначе граф зависимостей стал бы круговым.
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

  // Разбор идёт в обратном порядке. В браузере не вызывается никогда.
  registerShutdownTask('vue:all', unmountAll)
  // В юзерскрипте обе задачи попадают на заглушки: точка входа не знает о платформе.
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
  // Гейт DOM и чтение настроек независимы: в десктопе хранилище — это IPC и файл.
  await Promise.all([whenDomReady(), step('настройки', loadSettings)])

  // Читает settings.enableLogger, поэтому только после loadSettings().
  await step('перехватчики ошибок', installGlobalErrorHandlers)

  // Перехват ссылок ставится до проверок домена: ссылки есть на любой странице.
  await step('перехват ссылок', initLinks)

  // Токен лежит в асинхронном хранилище, а берётся синхронно при сборке заголовков.
  await step('токен AniList', loadAlToken)

  // На Shikimori AniMori не рисует ничего. Проверка не лишняя: у старых установок
  // шапка с @match на shikimori.io обновится только после переустановки скрипта.
  if (IS_SHIKI) return
  if (!IS_ANILIST) return

  // Кэш наполняется до первой отрисовки и rebuildDictionary(): читается он синхронно.
  await step('словарь пользователя', loadUserDict)

  // Адблок — первым среди всего, что касается страницы: иначе баннер мигнёт.
  // В задачи смены роута НЕ входит: его наблюдатель обязан переживать переходы.
  // В браузере заглушка: рекламу режет расширение пользователя.
  await step('адблок', initAdblock)

  // Сводка о том, куда ходят вложенные фреймы: из неё пересобирается список
  // адресов для adblock.rs. Ставится до любого UI: повторять сообщение некому.
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

  // Замена тулбара в десктопе: назад, вперёд, обновить, F5 и Alt+стрелки.
  await step('блок навигации', initNavPanel)

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

// Сторож страницы (5.3.7). Отметка ставится ВНЕ bootstrap(): упавший старт и ранний
// выход на чужом домене не должны выглядеть как отказ прокси. Опрос корня, а не голая
// отметка: бандл выполняется и на странице ошибки WebView2.
const ANILIST_ROOT_SELECTOR = '#app'
const ALIVE_POLL_MS = 250
const ALIVE_ATTEMPTS = 32 // ~8 секунд, заведомо меньше 12 секунд сторожа

function reportPageAlive(): void {
  let left = ALIVE_ATTEMPTS
  const tick = (): void => {
    if (document.querySelector(ANILIST_ROOT_SELECTOR)) {
      void Bridge.proxyDiagnostics.markPageReady()
      return
    }
    if (--left <= 0) return
    window.setTimeout(tick, ALIVE_POLL_MS)
  }
  tick()
}

reportPageAlive()

// Последняя сетка (дефект A1): сбой самого каркаса старта обязан попасть в журнал.
void bootstrap().catch((e) => {
  Logger('ERROR', 'Старт AniMori оборвался', e)
})
