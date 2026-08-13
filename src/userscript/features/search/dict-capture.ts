// Контекстный захват выделенного текста.
//
// Сценарий: пользователь выделяет латиницу на странице → всплывает кнопка
// «Перевести» → мини-форма → запись уходит в локальный словарь и применяется вживую.
//
// Сама логика словаря живёт в core/dictionary.ts (upsertUserDictEntry сам пересобирает
// словарь и дёргает ре-скан DOM), здесь только императивный UI.
//
// Класс am-notr на форме обязателен: иначе переводчик начнёт переводить собственную
// форму и породит рекурсию мутаций (риск №4 из docs/DECISIONS.md).

import { getUserDict, normDictKey, upsertUserDictEntry } from '@/core/dictionary'
import { html } from '@/utils/dom'

/** Короче — шум вроде случайного клика, длиннее — абзац, а не термин. */
const MIN_LEN = 2
const MAX_LEN = 120

let isStarted = false
let pop: HTMLElement | null = null
let form: HTMLElement | null = null
let currentSel = ''

function removePop(): void {
  if (pop) {
    pop.remove()
    pop = null
  }
}

function removeForm(): void {
  if (form) {
    form.remove()
    form = null
  }
}

/** Выделение внутри поля ввода — пользователь правит текст, а не ищет перевод. */
function inField(target: EventTarget | null): boolean {
  let el = target instanceof HTMLElement ? target : null
  while (el && el !== document.body) {
    const tag = (el.tagName || '').toUpperCase()
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true
    el = el.parentElement
  }
  return false
}

/** Мини-форма рядом с выделением. Если сверху не влезает — уезжает под текст. */
function openForm(rect: DOMRect): void {
  removePop()
  removeForm()

  const existing = getUserDict()[currentSel] ?? ''

  form = document.createElement('div')
  form.className = 'am-dict-capform am-accent-scope am-notr'
  form.innerHTML = html`
    <div class="am-dict-capform-head">Свой перевод</div>
    <div class="am-dict-capform-src" title="${currentSel}">${currentSel}</div>
    <input class="amk-input am-dict-capform-inp" placeholder="Перевод (рус.)" value="${existing}" />
    <div class="am-dict-capform-btns">
      <button class="amk-btn amk-btn-ghost am-dict-capform-cancel" type="button">Отмена</button>
      <button class="amk-btn amk-btn-primary am-dict-capform-save" type="button">Сохранить</button>
    </div>
  `
  document.body.appendChild(form)

  const px = Math.min(Math.max(8, rect.left), window.innerWidth - form.offsetWidth - 8)
  let py = rect.top + window.scrollY - form.offsetHeight - 8
  if (py < window.scrollY + 8) py = rect.bottom + window.scrollY + 8
  form.style.left = px + 'px'
  form.style.top = py + 'px'

  const input = form.querySelector<HTMLInputElement>('.am-dict-capform-inp')
  if (!input) return
  input.focus()
  input.select()

  const save = (): void => {
    if (!upsertUserDictEntry(currentSel, input.value)) return
    removeForm()
    // Снимаем выделение, иначе следующий mouseup сразу вернёт кнопку на тот же текст.
    window.getSelection()?.removeAllRanges()
  }

  form.querySelector<HTMLElement>('.am-dict-capform-save')?.addEventListener('click', save)
  form
    .querySelector<HTMLElement>('.am-dict-capform-cancel')
    ?.addEventListener('click', () => removeForm())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save()
    if (e.key === 'Escape') removeForm()
  })
}

/**
 * Вешает глобальные слушатели выделения. Идемпотентна.
 */
export function initDictCapture(): void {
  if (isStarted) return
  isStarted = true

  document.addEventListener('mouseup', (e) => {
    const target = e.target
    if (form && target instanceof Node && form.contains(target)) return
    if (pop && target instanceof Node && pop.contains(target)) return

    // Отложенная проверка: на момент mouseup выделение ещё не обновлено.
    window.setTimeout(() => {
      const sel = window.getSelection()
      const text = sel ? normDictKey(sel.toString()) : ''
      removePop()

      if (!text || text.length < MIN_LEN || text.length > MAX_LEN) return
      if (inField(target)) return
      // Только латиница: русский текст переводить некуда.
      if (!/[A-Za-z]/.test(text)) return

      let rect: DOMRect
      try {
        rect = sel!.getRangeAt(0).getBoundingClientRect()
      } catch {
        return
      }
      if (!rect || (!rect.width && !rect.height)) return

      currentSel = text

      pop = document.createElement('div')
      pop.className = 'am-dict-capture am-accent-scope'
      pop.innerHTML =
        '<button class="am-dict-cap-btn" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>Перевести</button>'
      document.body.appendChild(pop)

      const px = Math.min(
        Math.max(8, rect.left + rect.width / 2 - pop.offsetWidth / 2),
        window.innerWidth - pop.offsetWidth - 8,
      )
      pop.style.left = px + 'px'
      pop.style.top = rect.top + window.scrollY - pop.offsetHeight - 8 + 'px'
      pop.querySelector<HTMLElement>('.am-dict-cap-btn')?.addEventListener('click', () => {
        openForm(rect)
      })
    }, 10)
  })

  document.addEventListener('mousedown', (e) => {
    const target = e.target
    if (pop && !(target instanceof Node && pop.contains(target))) removePop()
    if (form && !(target instanceof Node && form.contains(target))) removeForm()
  })

  // Кнопка привязана к абсолютным координатам, при скролле проще её убрать, чем пересчитать.
  document.addEventListener('scroll', () => removePop(), true)
}
