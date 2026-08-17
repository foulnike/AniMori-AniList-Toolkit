// Виджет внешних ссылок: поиск тайтла по встроенным сервисам.
// Домены сервисов берутся из настроек, а не из кода: зеркала регулярно переезжают.

import { amApplyAccentToDom } from '@/core/accent'
import { settings } from '@/core/settings'
import { applyMarquee } from '@/utils/dom'
import { Logger } from '@/utils/logger'
import type { MediaContext, MediaWidget } from './types'

const BOX_SELECTOR = '.animori-extlinks'

type ThemeToken = 'blue' | 'red' | 'green' | 'orange' | 'pink' | 'purple'

// Фолбэк-триплы на случай, если тема AniList не задаёт часть --color-*.
const TOKEN_FALLBACK: Record<ThemeToken, string> = {
  blue: '61, 187, 238',
  red: '252, 129, 129',
  green: '166, 227, 161',
  orange: '246, 193, 119',
  pink: '243, 139, 168',
  purple: '183, 148, 244',
}

function colorValue(token: ThemeToken): string {
  return `var(--color-${token}, ${TOKEN_FALLBACK[token]})`
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function createExtLink(
  name: string,
  token: ThemeToken,
  href: string,
  opts: { domain?: string } = {},
): HTMLAnchorElement {
  const link = document.createElement('a')
  link.href = href
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.className = 'am-extlink'
  link.style.setProperty('--c', colorValue(token))

  const avatar = document.createElement('span')
  avatar.className = 'am-extlink-av'
  avatar.textContent = (name.trim()[0] ?? '?').toUpperCase()

  const info = document.createElement('span')
  info.className = 'am-extlink-info'

  const nameSpan = document.createElement('span')
  nameSpan.className = 'am-extlink-name'
  nameSpan.appendChild(document.createTextNode(name))

  const domainSpan = document.createElement('span')
  domainSpan.className = 'am-extlink-domain'
  domainSpan.textContent = opts.domain || hostOf(href)

  info.append(nameSpan, domainSpan)

  const arrow = document.createElement('span')
  arrow.className = 'am-extlink-arrow'
  arrow.textContent = '↗'

  link.append(avatar, info, arrow)
  applyMarquee(nameSpan)
  applyMarquee(domainSpan)
  return link
}

// Домен из настроек может прийти с протоколом, слешем или пробелами — чистим.
function cleanDomain(raw: string | null | undefined, fallback: string): string {
  const value = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
  return value || fallback
}

function searchUrl(domain: string, path: string, query: string): string {
  return 'https://' + domain + path + encodeURIComponent(query)
}

function placeBox(sidebar: HTMLElement, box: HTMLElement): void {
  if (sidebar.contains(box)) return
  const themes = sidebar.querySelector('.animori-themes')
  const ratings = sidebar.querySelector('.animori-ratings')
  if (themes) themes.after(box)
  else if (ratings) ratings.after(box)
  else sidebar.prepend(box)
}

function buildLinks(ctx: MediaContext): HTMLElement | null {
  const romaji = (ctx.malData.title.romaji ?? '').trim()
  const russian = (ctx.shikiData?.russian ?? '').trim()
  const ruTitle = russian || romaji
  // Без названия поисковые ссылки бессмысленны: вели бы на пустой поиск.
  if (!ruTitle && !romaji) return null

  const list = document.createElement('div')
  list.style.cssText = 'display: flex; flex-direction: column; gap: 8px;'
  let added = 0

  if (settings.enableLinkRutracker && romaji) {
    list.appendChild(
      createExtLink(
        'RuTracker',
        'orange',
        searchUrl('rutracker.org', '/forum/tracker.php?nm=', romaji),
      ),
    )
    added++
  }

  if (ctx.malData.type === 'ANIME') {
    if (settings.enableLinkYummy) {
      const domain = cleanDomain(settings.yummyDomain, 'yummyanime.tv')
      list.appendChild(
        createExtLink(
          'YummyAnime',
          'pink',
          searchUrl(domain, '/index.php?do=search&subaction=search&story=', ruTitle),
          { domain },
        ),
      )
      added++
    }
    if (settings.enableLinkAnimego) {
      const domain = cleanDomain(settings.animegoDomain, 'animego.org')
      list.appendChild(
        createExtLink('AnimeGO', 'purple', searchUrl(domain, '/search/anime?q=', ruTitle), {
          domain,
        }),
      )
      added++
    }
  } else if (settings.enableLinkMangalib) {
    const domain = cleanDomain(settings.mangalibDomain, 'mangalib.me')
    list.appendChild(
      createExtLink('MangaLib', 'blue', searchUrl(domain, '/ru/catalog?q=', ruTitle), {
        domain,
      }),
    )
    added++
  }

  return added > 0 ? list : null
}

function mount(ctx: MediaContext): void {
  if (!settings.enableExtLinks) return
  if (ctx.malData.type !== 'ANIME' && ctx.malData.type !== 'MANGA') return

  const sidebar = ctx.sidebar
  if (!sidebar) return
  if (document.querySelector(BOX_SELECTOR)) return

  try {
    const list = buildLinks(ctx)
    // Ни одного включённого сервиса — блок не создаём, пустая рамка не нужна.
    if (!list) return

    const box = document.createElement('div')
    box.className = 'animori-extlinks animori-franchise am-accent-scope'

    const heading = document.createElement('h2')
    heading.textContent = ctx.malData.type === 'ANIME' ? 'Где посмотреть' : 'Где почитать'
    heading.style.cssText = 'text-align: center; margin-bottom: 15px;'

    box.append(heading, list)
    placeBox(sidebar, box)
    amApplyAccentToDom()
  } catch (e) {
    Logger('ERROR', '[ExtLinks] Не удалось построить блок внешних ссылок', e)
  }
}

export const extLinksWidget: MediaWidget = {
  name: 'extlinks',
  cleanupSelectors: [BOX_SELECTOR],
  mount,
}
