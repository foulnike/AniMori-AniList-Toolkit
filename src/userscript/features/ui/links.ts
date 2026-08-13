// Ссылки в десктопной сборке: внешние адреса — в браузер, anilist.co — в окне.
// Страховка без клика — on_navigation в src-tauri/src/lib.rs.
// Почему перехват и почему патч window.open — docs/DECISIONS.md.

import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

/**
 * Пометка «клик по этому элементу — не переход по ссылке».
 * Ставится на свои кнопки-действия внутри ссылки: AniList вкладывает их в карточки.
 */
const NO_NAV_ATTR = 'data-am-no-nav'

/** Хосты, которые живут внутри окна. Совпадает с is_internal_host в lib.rs и remote.urls. */
function isInternalHost(host: string): boolean {
  return host === 'anilist.co' || host.endsWith('.anilist.co')
}

/** Адреса, которые имеет смысл отдавать браузеру. Схема также проверяется в Rust. */
function isWebUrl(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:'
}

/**
 * Разбирает адрес относительно текущей страницы.
 * Возвращает null вместо исключения: «href="#"» и пустые значения — не наш случай.
 */
function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw, location.href)
  } catch {
    return null
  }
}

/** Уводит адрес в системный браузер. Ошибка — в журнал: молчаливый отказ и был багом. */
function openExternal(url: string): void {
  void Bridge.shell.openExternal(url).catch((e) => {
    Logger('ERROR', `Не удалось открыть ссылку в браузере: ${url}`, e)
  })
}

/**
 * Обработчик кликов по ссылкам: фаза перехвата, чтобы опередить роутер AniList.
 * stopPropagation не вызывается: если мы не вмешались, событие должно дойти до сайта.
 */
function onClick(e: MouseEvent): void {
  if (e.defaultPrevented) return

  // Только обычный левый клик: тихо менять смысл жеста мы не вправе.
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

  const target = e.target
  if (!(target instanceof Element)) return

  if (target.closest(`[${NO_NAV_ATTR}]`)) return

  const anchor = target.closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement)) return

  // getAttribute, а не anchor.href: сырое значение отличает якорь и javascript:-заглушку.
  const raw = anchor.getAttribute('href')
  if (!raw || raw.startsWith('#')) return

  const url = parseUrl(raw)
  if (!url || !isWebUrl(url)) return

  if (isInternalHost(url.host)) {
    // Внутренний адрес без target — работа роутера AniList, не мешаем.
    if (!anchor.target || anchor.target === '_self') return

    // В окне без вкладок target="_blank" читается как обычный переход.
    e.preventDefault()
    location.assign(url.href)
    return
  }

  e.preventDefault()
  openExternal(url.href)
}

/** Оригинальный window.open — на случай адресов, которые мы не берём на себя. */
let nativeOpen: typeof window.open | null = null

/**
 * Подменяет window.open на версию, уводящую веб-адреса в браузер.
 * Без патча окно без вкладок открывало бы внешний адрес поверх самого себя.
 */
function patchWindowOpen(): void {
  if (nativeOpen) return
  nativeOpen = window.open.bind(window)

  window.open = ((url?: string | URL, windowTarget?: string, features?: string): Window | null => {
    if (url !== undefined && url !== '') {
      const parsed = parseUrl(String(url))

      if (parsed && isWebUrl(parsed)) {
        if (isInternalHost(parsed.host)) {
          location.assign(parsed.href)
        } else {
          openExternal(parsed.href)
        }

        // null — штатное значение для заблокированного попапа, к нему код готов.
        return null
      }
    }

    // about:blank и прочие служебные вызовы отдаём как было.
    return nativeOpen ? nativeOpen(url, windowTarget, features) : null
  }) as typeof window.open
}

let installed = false

/**
 * Включает обработку ссылок. В браузере ничего не делает.
 * Там ссылки работают и без нас, а подмена window.open ломала бы вкладки.
 */
export function initLinks(): void {
  if (Bridge.platform !== 'tauri') return
  if (installed) return
  installed = true

  document.addEventListener('click', onClick, { capture: true })
  patchWindowOpen()
}
