// DOM- и HTML-утилиты.
//
// Аккуратно с html``: все интерполяции экранируются. Доверенный HTML надо явно
// оборачивать в rawHTML(); шаблонная строка без тега html не экранирует ничего.

import { Bridge } from '@/bridge'
import { Logger } from './logger'

export function escapeHTML(str: unknown): string {
  if (!str) return ''
  return String(str).replace(
    /[&<>'"]/g,
    (tag) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[tag] || tag,
  )
}

export interface RawHTML {
  __isRawHTML: true
  value: string
}

function isRawHTML(value: unknown): value is RawHTML {
  return typeof value === 'object' && value !== null && '__isRawHTML' in value
}

/** Сборка HTML: интерполяции экранируются. Доверенный HTML — rawHTML(value). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, str, i) => {
    const val = values[i - 1]
    const safe = isRawHTML(val) ? val.value : escapeHTML(val)
    return out + (i > 0 ? safe : '') + str
  }, '')
}

export function rawHTML(value: unknown): RawHTML {
  return { __isRawHTML: true, value: String(value == null ? '' : value) }
}

/**
 * Бегущая строка для текста, не влезающего в контейнер: спан и CSS-анимация
 * туда-сюда при overflow, скорость пропорциональна длине.
 *
 * Риски №3 и №4 из docs/DECISIONS.md: функция сама меняет DOM — оборачивает детей
 * в span. В Vue-компонентах вызывать только через директиву или onMounted по ref,
 * иначе ререндер потеряет вставленный span и флаг dataset.amMarqInit.
 */
export function applyMarquee(el: HTMLElement | null): void {
  if (!el || el.dataset.amMarqInit) return
  el.dataset.amMarqInit = '1'
  const inner = document.createElement('span')
  inner.className = 'am-marq-inner'
  while (el.firstChild) inner.appendChild(el.firstChild)
  el.appendChild(inner)
  el.classList.add('am-marq')

  const measure = (): void => {
    const overflow = inner.scrollWidth - el.clientWidth
    if (overflow > 4) {
      el.style.setProperty('--am-marq-shift', `-${overflow}px`)
      el.style.setProperty('--am-marq-dur', `${Math.max(3, overflow / 40 + 1).toFixed(1)}s`)
      el.classList.add('am-marq-on')
    } else {
      el.classList.remove('am-marq-on')
      el.style.removeProperty('--am-marq-shift')
    }
  }

  requestAnimationFrame(measure)
  if (window.ResizeObserver) {
    try {
      new ResizeObserver(measure).observe(el)
    } catch {
      /* игнор */
    }
  }
}

/**
 * Копирование в буфер с фидбэком на кнопке.
 *
 * Запись в буфер асинхронна, но сигнатура оставлена синхронной: все вызовы
 * идут из обработчиков клика, им нечего делать с обещанием. Галочка «скопировано»
 * зажигается по факту успеха, а не сразу после вызова: при отказе буфера
 * пользователь не увидит ложное подтверждение.
 *
 * Запасной путь через navigator.clipboard оставлен: если мост отказал, остаётся
 * шанс скопировать штатным браузерным API.
 */
export function amCopy(text: string, btn?: HTMLElement | null): void {
  const done = (): void => {
    if (!btn) return
    btn.classList.add('am-copied')
    setTimeout(() => btn.classList.remove('am-copied'), 1200)
  }

  const fallback = (e: unknown): void => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(done)
        .catch((err: unknown) => Logger('WARN', 'Не удалось скопировать в буфер', err))
      return
    }
    Logger('WARN', 'Буфер обмена недоступен', e)
  }

  void Bridge.clipboard.writeText(text).then(done).catch(fallback)
}

/** Русские плюральные формы: forms = ['эпизод', 'эпизода', 'эпизодов']. */
export function getPlural(n: number, forms: readonly string[]): string {
  return (
    n % 10 === 1 && n % 100 !== 11
      ? forms[0]
      : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
        ? forms[1]
        : forms[2]
  ) as string
}
