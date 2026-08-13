// Блокировка рекламных блоков самого AniList.
//
// Почему это модуль юзерскрипта, а не часть Tauri-оболочки: баннеры живут
// в главном фрейме, на том же домене, где работаем мы, и решение одинаково
// работает в браузере и в десктопной сборке.
//
// Сетевая блокировка (src-tauri/src/adblock.rs) управляется тем же тумблером
// «Блокировщик рекламы»: для человека это одна функция, а не две настройки
// с похожими названиями. Разделение труда: здесь прячется разметка баннеров
// самого сайта, там отбиваются сетевые запросы, в том числе реклама внутри
// плеера, куда этот модуль не дотянется в принципе (чужой домен).
//
// Слои разметки баннера, снятые с живого сайта:
//   .sense-wrap                       — обёртка самого AniList (её рисует Vue сайта);
//   .vm-placement                     — посадочное место Venatus, тоже рисуется Vue сайта;
//   [data-gamera-placement-container] — метка движка доставки Gamera;
//   вложенные <span> и <iframe>   — чужак, его вставляет рекламный скрипт.
//
// Атрибуты data-v-* СОЗНАТЕЛЬНО не используются: это хеши scoped-стилей Vue,
// они меняются при каждой пересборке сайта.
//
// Главная осторожность — зеркальный риск №3 из docs/DECISIONS.md. Там мы боимся, что сайт
// убьёт наши Vue-узлы; здесь риск обратный — мы можем убить узлы сайта. Если вырвать
// из DOM .sense-wrap или .vm-placement, Vue AniList при следующем патче полезет к узлу
// с parentNode === null и сломает рендер страницы. Поэтому стратегия двухслойная:
//
//   1. Узлы сайта НЕ удаляем — только прячем через CSS. Vue сайта продолжает
//      видеть свою разметку целой.
//   2. Удаляем только СОДЕРЖИМОЕ посадочного места — те самые <span>/<iframe>,
//      которые вставил рекламный скрипт. Их Vue не отслеживает, удалять безопасно.
//      Это важно не только косметически: убитый iframe перестаёт грузиться, крутить
//      таймеры и есть память — одного display:none для этого мало.
//
// Защита от риска №4 (рекурсия мутаций): контейнеры помечаются am-notr, чтобы
// в них не лез переводчик, а чистка одного места ограничена счётчиком: если реклама
// упорно пересоздаёт себя, мы отступаем на чистый CSS и не вступаем в гонку
// на всю оставшуюся жизнь вкладки.

import { settings } from '@/core/settings'
import { Logger } from '@/utils/logger'
import { initNetBlockReporter, setShellAdBlock } from './net-block'

/** id тега со стилями — нужен, чтобы снять его при выключении без перезагрузки. */
export const ADBLOCK_STYLE_ID = 'am-adblock-style'

/** Класс-маркер «переводчик, сюда не ходи» (тот же, что у Vue-корней). */
const NO_TRANSLATE_CLASS = 'am-notr'

/**
 * Подтверждённые селекторы рекламных контейнеров.
 * Добавлять сюда только то, что реально видели в DOM, а не предполагаемые имена.
 */
const AD_SELECTORS = ['.sense-wrap', '.vm-placement', '[data-gamera-placement-container]']

const AD_SELECTOR = AD_SELECTORS.join(', ')

/**
 * Диагностика: широкий шаблон под разметку Venatus/Gamera. Совпадения НЕ
 * блокируются, а только пишутся в лог — чтобы собрать селекторы оставшихся
 * форматов (липучка снизу, скины по бокам, видео-уголок) по факту, а не по догадке.
 * Слепо резать всё с префиксом vm- опасно: под него может попасть разметка сайта.
 */
const DIAG_SELECTOR = '[id^="vm-"], [class*="gamera"], [data-gamera]'

/** Сколько раз подряд чистим одно и то же место, прежде чем сдаться и оставить CSS. */
const MAX_CLEANUPS = 8

/**
 * Прячем с !important и схлопываем геометрию: у .sense-wrap есть собственные
 * отступы, и без обнуления на месте баннера осталась бы дыра в вёрстке.
 */
const ADBLOCK_CSS =
  AD_SELECTOR +
  ' {' +
  'display: none !important;' +
  'height: 0 !important;' +
  'min-height: 0 !important;' +
  'max-height: 0 !important;' +
  'margin: 0 !important;' +
  'padding: 0 !important;' +
  '}'

let observer: MutationObserver | null = null
let blockedCount = 0
let diagReported = 0

/** Счётчик чисток по конкретному узлу. WeakMap — чтобы не держать удалённые узлы в памяти. */
const cleanupCounts = new WeakMap<Element, number>()

/** Лимит записей диагностики за сессию — иначе заспамим логгер. */
const DIAG_LIMIT = 10

function ensureStyle(): void {
  if (document.getElementById(ADBLOCK_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = ADBLOCK_STYLE_ID
  style.textContent = ADBLOCK_CSS
  // documentElement, а не head: на document-start head может ещё не существовать.
  ;(document.head ?? document.documentElement).appendChild(style)
}

function removeStyle(): void {
  document.getElementById(ADBLOCK_STYLE_ID)?.remove()
}

/**
 * Выпотрошить одно посадочное место: сам узел остаётся на месте (он принадлежит
 * Vue сайта), выбрасывается только чужое содержимое вместе с iframe.
 */
function stripPlacement(el: Element): void {
  el.classList.add(NO_TRANSLATE_CLASS)

  const seen = cleanupCounts.get(el) ?? 0
  if (seen >= MAX_CLEANUPS) return

  if (!el.firstChild) return

  cleanupCounts.set(el, seen + 1)
  while (el.firstChild) el.removeChild(el.firstChild)
  blockedCount++

  if (seen + 1 === MAX_CLEANUPS) {
    Logger('INFO', 'Адблок: место пересоздаётся слишком часто, дальше только скрытие через CSS', {
      selector: el.className || el.tagName,
    })
  }
}

/** Пройтись по поддереву и выпотрошить всё, что подходит под селекторы. */
function sweep(root: ParentNode): void {
  if (root instanceof Element && root.matches(AD_SELECTOR)) stripPlacement(root)
  root.querySelectorAll(AD_SELECTOR).forEach(stripPlacement)
}

/**
 * Диагностика неопознанных блоков Venatus. Только запись в лог, никаких действий.
 * По этим записям добиваем AD_SELECTORS по факту увиденного.
 */
function diagnose(root: ParentNode): void {
  if (diagReported >= DIAG_LIMIT) return

  root.querySelectorAll(DIAG_SELECTOR).forEach((el) => {
    if (diagReported >= DIAG_LIMIT) return
    if (el.closest(AD_SELECTOR)) return

    diagReported++
    Logger('INFO', 'Адблок: неопознанный рекламный узел (не заблокирован)', {
      tag: el.tagName,
      id: el.id,
      class: el.className,
      html: el.outerHTML.slice(0, 300),
    })
  })
}

/**
 * Запуск модуля. Вызывать как можно раньше в bootstrap(), до остального UI:
 * стиль должен оказаться в документе раньше первой отрисовки баннера, иначе он мигнёт.
 *
 * Сетевой блокировщик оболочки настраивается ДО раннего выхода по выключенной
 * настройке: если тумблер выключен, оболочке надо об этом СООБЩИТЬ, а не промолчать —
 * по умолчанию она режет рекламу с первой миллисекунды запуска, ещё до того, как
 * страница вообще успеет загрузить настройки.
 */
export function initAdblock(): void {
  initNetBlockReporter()
  setShellAdBlock(settings.hideAds)

  if (!settings.hideAds) return

  ensureStyle()
  sweep(document)
  diagnose(document)

  if (observer) return

  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        sweep(node)
        diagnose(node)
      }
    }
  })

  observer.observe(document.documentElement, { childList: true, subtree: true })
  Logger('INFO', 'Адблок запущен', { selectors: AD_SELECTORS })
}

/**
 * Остановка модуля. Нужна для тумблера в настройках и для LifecycleManager.
 * Уже выпотрошенные блоки не восстанавливаются — рекламный скрипт нальёт их сам
 * при следующей смене страницы или после перезагрузки.
 *
 * Сетевой блокировщик гасится вместе с модулем: человек, выключивший тумблер, ожидает
 * увидеть сайт ровно таким, каким его видят все остальные, вместе с рекламой.
 */
export function destroyAdblock(): void {
  observer?.disconnect()
  observer = null
  removeStyle()
  setShellAdBlock(false)
}

/** Привести состояние модуля в соответствие с текущей настройкой (вызывает тумблер). */
export function syncAdblock(): void {
  if (settings.hideAds) initAdblock()
  else destroyAdblock()
}

/** Сколько блоков выпотрошено за сессию — для отладки. */
export function getBlockedCount(): number {
  return blockedCount
}
