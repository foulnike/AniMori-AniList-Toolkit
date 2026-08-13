// Виджет музыкальных тем OP/ED с поиском трека в выбранном музыкальном сервисе.
// Пустой список и отказ источника — разные исходы: первый молчит, второй пишет причину.
// Клиент AnimeThemes никогда не отклоняется, поэтому причину даёт только core/net-health.ts.

import { Bridge } from '@/bridge'
import {
  NET_SOURCE_ANIMETHEMES,
  fetchMalThemes,
  type MalThemes,
  type ThemeItem,
} from '../../api/animethemes'
import { amApplyAccentToDom } from '../../core/accent'
import { describeState, getHealth, isTroubled } from '../../core/net-health'
import { settings } from '../../core/settings'
import { amCopy, applyMarquee } from '../../utils/dom'
import { Logger } from '../../utils/logger'
import type { MediaContext, MediaWidget } from './types'

const BOX_SELECTOR = '.animori-themes'
const SERVICE_KEY = 'am_music_service'

type MusicService = 'vk' | 'yt' | 'spotify' | 'sc'

const SERVICES: readonly MusicService[] = ['vk', 'yt', 'spotify', 'sc']

const SERVICE_TITLES: Record<MusicService, string> = {
  vk: 'VK Музыка',
  yt: 'YouTube Music',
  spotify: 'Spotify',
  sc: 'SoundCloud',
}

// Брендовые иконки монохромные: fill наследуется от кнопки, поэтому акцент их перекрашивает.
const SERVICE_ICONS: Record<MusicService, string> = {
  vk: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M13.16 18.06c-6.27 0-9.85-4.3-10-11.45h3.14c.1 5.25 2.42 7.47 4.25 7.93V6.61h2.96v4.53c1.81-.19 3.71-2.26 4.35-4.53h2.96c-.49 2.8-2.56 4.87-4.03 5.72 1.47.69 3.83 2.49 4.73 5.73h-3.26c-.7-2.18-2.44-3.87-4.75-4.09v4.09h-.36z"/></svg>',
  yt: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm-1.75 14.5v-9l6 4.5-6 4.5z"/></svg>',
  spotify:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.59 14.42a.62.62 0 0 1-.86.21c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.22c3.81-.87 7.08-.5 9.72 1.11.29.18.39.57.21.86zm1.23-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.98-1.17a.78.78 0 1 1-.45-1.49c3.64-1.1 8.16-.57 11.24 1.33.37.22.49.71.26 1.07zm.11-2.85C14.72 8.95 9.5 8.76 6.53 9.66a.94.94 0 1 1-.54-1.8c3.41-1.03 9.17-.83 12.79 1.31a.94.94 0 0 1-.96 1.62z"/></svg>',
  sc: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M1.4 13.2c-.08 0-.14.06-.15.15l-.18 1.85.18 1.82c.01.08.07.14.15.14.08 0 .14-.06.15-.15l.21-1.81-.21-1.85c-.01-.08-.07-.15-.15-.15zm1.02-.95c-.09 0-.16.07-.17.16l-.24 2.79.24 2.7c.01.09.08.16.17.16.09 0 .16-.07.17-.16l.27-2.7-.27-2.79c-.01-.09-.08-.16-.17-.16zm7.72-3.13c-.14 0-.25.11-.26.25l-.3 6.63.3 3.6c.01.14.12.25.26.25.14 0 .25-.11.26-.25l.34-3.6-.34-6.63c-.01-.14-.12-.25-.26-.25zm-2.5.9c-.13 0-.23.1-.24.23l-.27 5.98.27 3.63c.01.13.11.23.24.23s.23-.1.24-.24l.31-3.62-.31-5.98c-.01-.13-.11-.23-.24-.23zm-2.48.62c-.11 0-.2.09-.21.21l-.28 5.38.28 3.65c.01.12.1.21.21.21.11 0 .2-.09.21-.21l.31-3.65-.31-5.38c-.01-.12-.1-.21-.21-.21zm-1.24-.12c-.11 0-.19.08-.2.2l-.26 5.31.26 3.64c.01.11.09.2.2.2.1 0 .19-.09.2-.2l.29-3.64-.29-5.31c-.01-.12-.1-.2-.2-.2zm8.75-1.03c-.15 0-.27.12-.28.28l-.27 6.28.27 3.58c.01.16.13.28.28.28.15 0 .27-.12.28-.28l.3-3.58-.3-6.28c-.01-.16-.13-.28-.28-.28zm2.71 10.7c1.86 0 3.37-1.5 3.37-3.35 0-1.86-1.51-3.36-3.37-3.36-.46 0-.9.09-1.3.26-.27-3.04-2.83-5.43-5.95-5.43-.76 0-1.5.15-2.16.4-.26.1-.33.2-.33.4v11.09c0 .21.16.38.36.4h9.38z"/></svg>',
}

const COPY_ICON =
  '<svg class="am-copy-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg class="am-check-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

// mount() синхронный, а темы приезжают по сети: держим готовый блок и замок в модуле.
let builtAniId: number | null = null
let builtBox: HTMLElement | null = null
let loadingAniId: number | null = null

// Выбранный сервис лежит в асинхронном хранилище, а нужен там, где ждать нельзя.
// Читается один раз в buildThemes(); если чтение не удалось, остаётся VK Музыка.
let serviceCache: MusicService = 'vk'
let serviceLoaded = false

function isStillOnPage(aniId: number): boolean {
  const match = /\/(?:anime|manga)\/(\d+)/.exec(window.location.pathname)
  return match ? Number(match[1]) === aniId : false
}

async function loadService(): Promise<void> {
  if (serviceLoaded) return
  serviceLoaded = true
  try {
    const raw = await Bridge.storage.get<unknown>(SERVICE_KEY, 'vk')
    const value = String(raw)
    if (SERVICES.includes(value as MusicService)) serviceCache = value as MusicService
  } catch (e) {
    Logger('WARN', '[Themes] Не удалось прочитать выбранный музыкальный сервис', e)
  }
}

function readService(): MusicService {
  return serviceCache
}

/** Запись «сначала в память»: ссылки перестраиваются сразу, диск догоняет фоном. */
function saveService(service: MusicService): void {
  serviceCache = service
  serviceLoaded = true
  void Bridge.storage.set(SERVICE_KEY, service).catch((e: unknown) => {
    Logger('ERROR', '[Themes] Не удалось сохранить выбранный музыкальный сервис', e)
  })
}

function musicUrl(service: MusicService, query: string): string {
  const encoded = encodeURIComponent(query)
  if (service === 'vk') return 'https://vk.com/audio?q=' + encoded
  if (service === 'spotify') return 'https://open.spotify.com/search/' + encoded
  if (service === 'sc') return 'https://soundcloud.com/search?q=' + encoded
  return 'https://music.youtube.com/search?q=' + encoded
}

function placeBox(sidebar: HTMLElement, box: HTMLElement): void {
  if (sidebar.contains(box)) return
  const ratings = sidebar.querySelector('.animori-ratings')
  if (ratings) ratings.after(box)
  else sidebar.prepend(box)
}

function createServiceToggle(
  active: MusicService,
  onPick: (service: MusicService) => void,
): HTMLElement {
  const toggle = document.createElement('div')
  toggle.className = 'am-service-toggle'

  SERVICES.forEach((service) => {
    const btn = document.createElement('div')
    btn.className = 'am-service-btn' + (service === active ? ' active' : '')
    btn.dataset.val = service
    btn.title = SERVICE_TITLES[service]
    btn.setAttribute('aria-label', SERVICE_TITLES[service])
    // Константа модуля, не пользовательские данные.
    btn.innerHTML = SERVICE_ICONS[service]
    btn.addEventListener('click', () => {
      toggle
        .querySelectorAll('.am-service-btn')
        .forEach((other) => other.classList.remove('active'))
      btn.classList.add('active')
      onPick(service)
    })
    toggle.appendChild(btn)
  })

  return toggle
}

function createTrack(
  track: ThemeItem,
  kind: 'OP' | 'ED',
  service: MusicService,
): HTMLAnchorElement {
  const title = (track.title || '')
    .replace(/^\d+:\s*/, '')
    .replace(/"/g, '')
    .trim()
  const artist = (track.artist || '').trim()
  // Исполнитель в запросе — поиск точнее находит нужный трек.
  const query = [title.replace(/\s*\(eps.*?\)/i, ''), artist].filter(Boolean).join(' ').trim()

  const wrap = document.createElement('a')
  wrap.className = 'am-theme-track ' + (kind === 'OP' ? 'is-op' : 'is-ed')
  wrap.dataset.query = query
  wrap.href = musicUrl(service, query)
  wrap.target = '_blank'
  wrap.rel = 'noopener noreferrer'

  const badge = document.createElement('span')
  badge.className = 'am-theme-label'
  badge.textContent = kind + (track.seq || '')

  const info = document.createElement('span')
  info.className = 'am-theme-info'

  const titleSpan = document.createElement('span')
  titleSpan.className = 'am-theme-title'
  titleSpan.textContent = title
  info.appendChild(titleSpan)

  let artistSpan: HTMLElement | null = null
  if (artist) {
    artistSpan = document.createElement('span')
    artistSpan.className = 'am-theme-artist'
    artistSpan.textContent = artist
    info.appendChild(artistSpan)
  }

  // data-am-no-nav обязателен: в десктопе links.ts перехватывает клик раньше и откроет стриминг.
  const copyBtn = document.createElement('span')
  copyBtn.className = 'am-theme-copy'
  copyBtn.title = 'Скопировать трек'
  copyBtn.setAttribute('aria-label', 'Скопировать трек')
  copyBtn.setAttribute('data-am-no-nav', '')
  copyBtn.innerHTML = COPY_ICON
  copyBtn.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    amCopy([title, artist].filter(Boolean).join(' — '), copyBtn)
  })

  // Лейбл OP/ED и кнопка копирования делят одну позицию: при hover лейбл прячется.
  const lead = document.createElement('span')
  lead.className = 'am-theme-lead'
  lead.append(badge, copyBtn)

  wrap.append(lead, info)
  applyMarquee(titleSpan)
  if (artistSpan) applyMarquee(artistSpan)
  return wrap
}

function fillBox(box: HTMLElement, themes: MalThemes): void {
  let service = readService()

  const header = document.createElement('div')
  header.style.cssText =
    'display: flex; flex-direction: column; align-items: center; margin-bottom: 12px; gap: 10px;'

  const heading = document.createElement('h2')
  heading.textContent = 'Музыкальные темы'
  heading.style.cssText = 'margin: 0; width: 100%; text-align: center;'

  const list = document.createElement('div')
  list.className = 'themes-list'
  list.style.cssText =
    'display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; padding: 4px 0;'

  const toggle = createServiceToggle(service, (picked) => {
    service = picked
    saveService(picked)
    list.querySelectorAll('.am-theme-track').forEach((node) => {
      const link = node as HTMLAnchorElement
      link.href = musicUrl(picked, link.dataset.query ?? '')
    })
  })

  header.append(heading, toggle)

  themes.openings.forEach((item) => list.appendChild(createTrack(item, 'OP', service)))
  themes.endings.forEach((item) => list.appendChild(createTrack(item, 'ED', service)))

  box.append(header, list)
  box.style.display = 'block'
}

/**
 * Причина отказа AnimeThemes или null, если учёт считает источник живым.
 * Текст берётся из состояния: 403 без туннеля и молчание сети лечатся по-разному.
 */
function themesTrouble(): string | null {
  if (!isTroubled(NET_SOURCE_ANIMETHEMES)) return null
  const state = getHealth(NET_SOURCE_ANIMETHEMES)?.state
  return state ? describeState(state) : null
}

/** Строка отказа вместо списка треков. Стиль тот же, что у виджета рейтингов. */
function fillTrouble(box: HTMLElement, reason: string): void {
  const heading = document.createElement('h2')
  heading.textContent = 'Музыкальные темы'
  heading.style.cssText = 'margin: 0 0 8px; width: 100%; text-align: center;'

  const note = document.createElement('div')
  note.className = 'am-net-note'
  note.textContent =
    `AnimeThemes ${reason}: список опенингов и эндингов сейчас недоступен. ` +
    `Подробности — в настройках, вкладка «Разработчик».`
  note.style.cssText =
    'padding: 8px 10px; border-radius: 6px; font-size: 0.85em; line-height: 1.35;' +
    ' color: rgb(var(--color-text-light)); background: rgba(var(--color-red, 252,129,129), 0.10);'

  box.append(heading, note)
  box.style.display = 'block'
}

async function buildThemes(ctx: MediaContext, sidebar: HTMLElement): Promise<void> {
  // Блок создаём сразу скрытым: он занимает место в DOM и не даёт повторно дёргать API.
  const box = document.createElement('div')
  box.className = 'animori-themes animori-franchise am-accent-scope'
  box.style.display = 'none'
  placeBox(sidebar, box)
  builtAniId = ctx.aniId
  builtBox = box

  // Чтение сервиса идёт параллельно запросу тем: оно короче и ничего не задерживает.
  const [themes] = await Promise.all([fetchMalThemes(ctx.malData.idMal), loadService()])
  if (!isStillOnPage(ctx.aniId)) return

  // Причину пишем, только если учёт её знает: лучше ничего, чем ложное объяснение.
  if (!themes) {
    const reason = themesTrouble()
    if (reason) fillTrouble(box, reason)
    return
  }

  // Тем нет в базе — блок остаётся скрытым, а не удаляется: иначе виджет запросит их снова.
  if (themes.openings.length === 0 && themes.endings.length === 0) return

  fillBox(box, themes)
  amApplyAccentToDom()
}

function mount(ctx: MediaContext): void {
  if (!settings.enableThemes) return
  if (ctx.malData.type !== 'ANIME') return

  const sidebar = ctx.sidebar
  if (!sidebar) return

  if (builtAniId === ctx.aniId && builtBox) {
    placeBox(sidebar, builtBox)
    return
  }

  if (document.querySelector(BOX_SELECTOR)) return
  if (loadingAniId === ctx.aniId) return

  loadingAniId = ctx.aniId
  void buildThemes(ctx, sidebar)
    .catch((e: unknown) =>
      Logger('ERROR', '[Themes] Не удалось построить список музыкальных тем', e),
    )
    .finally(() => {
      if (loadingAniId === ctx.aniId) loadingAniId = null
    })
}

export const themesWidget: MediaWidget = {
  name: 'themes',
  cleanupSelectors: [BOX_SELECTOR],
  mount,
}
