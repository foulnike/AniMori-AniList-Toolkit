// Применение перевода к живым узлам страницы: без сети и без очереди.
// Всё внутри .am-notr не трогаем: иначе Vue и переводчик зациклятся (РИСК №4).

import { NO_TRANSLATE_CLASS } from '@/core/constants'
import { escapeHTML } from '@/utils/dom'
import { Logger } from '@/utils/logger'
import { translateAdvanced } from './rules'

// Имя класса живёт в ядре, а не здесь: его ставит монтировщик Vue.
// Реэкспорт оставлен для остальных частей переводчика.
export { NO_TRANSLATE_CLASS }

/** В этих тегах текст — код или разметка, перевод только сломает страницу. */
const SKIP_TAGS: readonly string[] = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG']

/** Атрибуты с видимым текстом (подсказки, плейсхолдеры, доступность). */
export const TRANSLATABLE_ATTRS: readonly string[] = [
  'placeholder',
  'title',
  'aria-label',
  'value',
  'label',
]

function isValueElement(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

/**
 * Рекурсивно переводит узел и всё, что внутри него.
 * Замена точечная: на окружающих пробелах держится вёрстка AniList.
 */
export function translateNode(node: Node | null | undefined): void {
  if (!node) return

  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element
    if (el.closest(`.${NO_TRANSLATE_CLASS}`)) return
    if (SKIP_TAGS.includes(el.tagName)) return

    for (const attr of TRANSLATABLE_ATTRS) {
      const val = el.getAttribute(attr)
      if (!val) continue
      const translated = translateAdvanced(val)
      if (translated && translated !== val) el.setAttribute(attr, translated)
    }

    // У полей ввода видимое значение живёт в свойстве, а не в атрибуте.
    if (isValueElement(el) && el.value) {
      const translated = translateAdvanced(el.value)
      if (translated && translated !== el.value) el.value = translated
    }

    el.childNodes.forEach((child) => translateNode(child))
    return
  }

  if (node.nodeType === Node.TEXT_NODE) {
    const raw = node.nodeValue ?? ''
    const clean = raw.trim()
    if (!clean) return
    const translated = translateAdvanced(clean)
    if (translated && translated !== clean) node.nodeValue = raw.replace(clean, translated)
  }
}

/**
 * Пишет текст в первый непустой текстовый узел, сохраняя внутреннюю разметку.
 * @returns false, если подходящего узла не нашлось.
 */
export function safelySetText(el: Element, text: string): boolean {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? '').trim().length > 0) {
      child.nodeValue = text
      return true
    }
  }
  return false
}

/**
 * Перевод значений инпутов Element UI: Vue пишет текст фильтров прямо в .value.
 * MutationObserver этого не видит, поэтому оборачиваем сеттер.
 */
export function setupVueInputInterceptor(): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  if (!descriptor || typeof descriptor.set !== 'function') return
  const originalSet = descriptor.set

  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    configurable: true,
    enumerable: true,
    get: descriptor.get,
    set(this: HTMLInputElement, val: unknown) {
      let finalVal = val
      try {
        if (
          typeof val === 'string' &&
          val.trim() !== '' &&
          this.classList &&
          this.classList.contains('el-input__inner')
        ) {
          const translated = translateAdvanced(val)
          if (translated && translated !== val) finalVal = translated
        }
      } catch (e) {
        Logger('WARN', 'setupVueInputInterceptor: сбой перевода значения инпута', e)
      }
      originalSet.call(this, finalVal)
    },
  })
}

/**
 * BB-разметка описаний Shikimori/anime365 в HTML: сначала экранируем всё.
 * Возвращаются только разрешённые теги: текст приходит с чужого сайта.
 */
export function cleanShikiBB(text: string, url: string, sourceName = 'Shikimori'): string {
  let out = escapeHTML(text)

  out = out
    .replace(/\[i\]([\s\S]*?)\[\/i\]/g, '<i>$1</i>')
    .replace(/\[b\]([\s\S]*?)\[\/b\]/g, '<b>$1</b>')
    .replace(/\[u\]([\s\S]*?)\[\/u\]/g, '<u>$1</u>')
    // [character=123]Имя[/character] -> просто Имя
    .replace(/\[(\w+)=\d+\]([\s\S]*?)\[\/\1\]/g, '$2')
    .replace(/\[\/?[^\]]+\]/g, '')
    .replace(/\n/g, '<br>')

  const footer = `<small>Описание предоставлено <a href="${escapeHTML(
    url,
  )}" target="_blank" rel="noopener noreferrer" style="color:#3dbbee; font-weight:bold;">${escapeHTML(
    sourceName,
  )}</a></small>`

  return `${out}<br><br>${footer}`
}
