// Виджет рейтингов Shikimori, MyAnimeList и AniList с гистограммой голосов.
// При устойчивом молчании Shikimori блок всё равно строится: оценка AniList есть всегда.
// Совета про VPN здесь нет: отказ одного источника — не суждение о сети, это дело тоста.

import { shikimoriTrouble } from '../../api/shikimori'
import { amApplyAccentToDom } from '../../core/accent'
import { settings } from '../../core/settings'
import { getPlural } from '../../utils/dom'
import { Logger } from '../../utils/logger'
import type { MediaContext, MediaWidget } from './types'

const SHIKI_FALLBACK_DOMAIN = 'shikimori.io'
const NO_VALUE = 'N/A'

type ScoreMap = Map<number, number>

interface RatingItemOptions {
  className: string
  label: string
  value: string
  href?: string
  title?: string
}

/**
 * Один бейдж рейтинга. Собирается узлами, а не innerHTML: названия и домены
 * приходят из внешних API, и вставлять их в разметку строкой небезопасно.
 */
function createRatingItem(options: RatingItemOptions): HTMLElement {
  const isLink = typeof options.href === 'string' && options.href.length > 0
  const item = document.createElement(isLink ? 'a' : 'div')
  item.className = 'rating-item ' + options.className
  if (options.title) item.title = options.title

  if (item instanceof HTMLAnchorElement && options.href) {
    item.href = options.href
    item.target = '_blank'
    item.rel = 'noopener noreferrer'
  } else {
    item.style.cursor = 'default'
  }

  const star = document.createElement('span')
  star.className = 'rating-star'
  star.textContent = '★'

  const label = document.createElement('span')
  label.className = 'rating-label'
  label.textContent = options.label

  const value = document.createElement('span')
  value.className = 'rating-value'
  value.textContent = options.value

  item.append(star, label, value)
  return item
}

/** Строка отказа под бейджами. Один стиль для всех виджетов сайдбара. */
function createTroubleNote(text: string): HTMLElement {
  const note = document.createElement('div')
  note.className = 'am-net-note'
  note.textContent = text
  note.style.cssText =
    'margin-top: 8px; padding: 8px 10px; border-radius: 6px; font-size: 0.85em; line-height: 1.35;' +
    ' color: rgb(var(--color-text-light)); background: rgba(var(--color-red, 252,129,129), 0.10);'
  return note
}

/** Средняя оценка Shikimori, посчитанная из распределения голосов. */
function averageFromStats(map: ScoreMap): { score: string; votes: number } {
  let sum = 0
  let votes = 0
  map.forEach((count, mark) => {
    sum += mark * count
    votes += count
  })
  return { score: votes > 0 ? (sum / votes).toFixed(2) : NO_VALUE, votes }
}

/** Распределение оценок 1..10 из ответа Shikimori. Мусорные ключи отбрасываются. */
function buildScoreMap(ctx: MediaContext): ScoreMap {
  const map: ScoreMap = new Map()
  const stats = ctx.shikiData?.rates_scores_stats ?? []
  for (const stat of stats) {
    const mark = Number.parseInt(String(stat.name), 10)
    const count = Number(stat.value)
    if (!Number.isFinite(mark) || mark < 1 || mark > 10) continue
    if (!Number.isFinite(count) || count <= 0) continue
    map.set(mark, (map.get(mark) ?? 0) + count)
  }
  return map
}

/** Гистограмма оценок. Возвращает null, если голосов нет вообще. */
function buildHistogram(label: string, map: ScoreMap): HTMLElement | null {
  let max = 0
  let total = 0
  for (let mark = 1; mark <= 10; mark++) {
    const value = map.get(mark) ?? 0
    if (value > max) max = value
    total += value
  }
  if (max <= 0) return null

  const histo = document.createElement('div')
  histo.className = 'am-histo'

  const head = document.createElement('div')
  head.className = 'am-histo-head'
  const headLabel = document.createElement('span')
  headLabel.textContent = label
  const headTotal = document.createElement('span')
  headTotal.textContent =
    total.toLocaleString('ru-RU') + ' ' + getPlural(total, ['голос', 'голоса', 'голосов'])
  head.append(headLabel, headTotal)

  const bars = document.createElement('div')
  bars.className = 'am-histo-bars'
  for (let mark = 1; mark <= 10; mark++) {
    const value = map.get(mark) ?? 0
    const height = Math.round((value / max) * 100)
    const bar = document.createElement('div')
    bar.className = 'am-histo-bar'
    bar.title = mark + ': ' + value.toLocaleString('ru-RU')
    const fill = document.createElement('div')
    fill.className = 'am-histo-fill'
    fill.style.height = Math.max(height, 2) + '%'
    bar.appendChild(fill)
    bars.appendChild(bar)
  }

  const axis = document.createElement('div')
  axis.className = 'am-histo-axis'
  const axisMin = document.createElement('span')
  axisMin.textContent = '1'
  const axisMax = document.createElement('span')
  axisMax.textContent = '10'
  axis.append(axisMin, axisMax)

  histo.append(head, bars, axis)
  return histo
}

function shikimoriUrl(ctx: MediaContext): string | undefined {
  const path = ctx.shikiData?.url
  if (!path) return undefined
  const domain = ctx.shikiData?.domain || ctx.shikiDomain || SHIKI_FALLBACK_DOMAIN
  return 'https://' + domain + path
}

function myAnimeListUrl(ctx: MediaContext): string | undefined {
  const malId = ctx.malData?.idMal
  if (!malId) return undefined
  const section = ctx.malData?.type === 'MANGA' ? 'manga' : 'anime'
  return 'https://myanimelist.net/' + section + '/' + String(malId)
}

/** Оценка AniList в виде текста. Есть всегда, когда открыта сама страница. */
function anilistScoreText(ctx: MediaContext): string {
  const averageScore = ctx.malData?.averageScore
  return typeof averageScore === 'number' && averageScore > 0
    ? (averageScore / 10).toFixed(2)
    : NO_VALUE
}

/**
 * Урезанный блок на случай молчания Shikimori: только оценка AniList и причина.
 * Бейджи Shikimori и MAL не рисуются вовсе: без адресов они выглядят поломкой.
 */
function mountTrouble(ctx: MediaContext, sidebar: HTMLElement, reason: string): void {
  const box = document.createElement('div')
  box.className = 'animori-ratings am-accent-scope'

  box.appendChild(
    createRatingItem({
      className: 'al-badge',
      label: 'ANILIST',
      value: anilistScoreText(ctx),
      title: 'Официальная средняя оценка AniList',
    }),
  )
  box.appendChild(
    createTroubleNote(
      `Shikimori ${reason}: оценки и распределение голосов сейчас недоступны. ` +
        `Подробности — в настройках, вкладка «Разработчик».`,
    ),
  )

  sidebar.prepend(box)
  amApplyAccentToDom()
}

function mount(ctx: MediaContext): void {
  if (!settings.enableRatings) return

  const sidebar = ctx.sidebar
  if (!sidebar) return
  if (document.querySelector('.animori-ratings')) return

  // Молчим без известной причины: у тайтла может не быть карточки на Shikimori.
  if (!ctx.shikiData) {
    const reason = shikimoriTrouble()
    if (reason) mountTrouble(ctx, sidebar, reason)
    return
  }

  const box = document.createElement('div')
  box.className = 'animori-ratings am-accent-scope'

  const scoreMap = buildScoreMap(ctx)
  const { score: pureScore } = averageFromStats(scoreMap)

  const malScore = ctx.shikiData.score
  const malScoreText = malScore ? String(malScore) : NO_VALUE

  const alScoreText = anilistScoreText(ctx)

  const shikiBadge = createRatingItem({
    className: 'shiki-badge',
    label: 'SHIKIMORI',
    value: pureScore,
    href: shikimoriUrl(ctx),
    title: 'Средняя оценка по распределению голосов Shikimori',
  })
  const malBadge = createRatingItem({
    className: 'mal-badge',
    label: 'MYANIMELIST',
    value: malScoreText,
    href: myAnimeListUrl(ctx),
  })
  const alBadge = createRatingItem({
    className: 'al-badge',
    label: 'ANILIST',
    value: alScoreText,
    title: 'Официальная средняя оценка AniList',
  })
  const alValue = alBadge.querySelector('.rating-value')
  if (alValue) alValue.classList.add('al-score-val')

  box.append(shikiBadge, malBadge, alBadge)
  sidebar.prepend(box)

  try {
    const histo = buildHistogram('SHIKIMORI', scoreMap)
    // Гистограмма висит на бейдже MAL: у Shikimori-бейджа её срезала бы шапка страницы.
    if (histo) {
      histo.classList.add('am-histo-shiki')
      malBadge.appendChild(histo)
    }
  } catch (e) {
    Logger('WARN', '[Ratings] Гистограмма Shikimori не построена', e)
  }

  amApplyAccentToDom()
}

export const ratingsWidget: MediaWidget = {
  name: 'ratings',
  cleanupSelectors: ['.animori-ratings'],
  mount,
}
