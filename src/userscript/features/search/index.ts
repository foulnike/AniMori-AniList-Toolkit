// Русский поиск в шапке AniList.
//
// AniList не ищет по русским названиям. Схема обхода:
//   1) пользователь вводит кириллицу → ищем на Shikimori (он умеет русские названия);
//   2) полученные MAL id одним GraphQL-запросом маппим в тайтлы AniList;
//   3) рисуем результаты в родной выпадашке сайта, подстраиваясь под его разметку.
//
// Два тонких места:
//   - корневые поля Character/Staff в AniList отдают 404 на пустой результат, поэтому
//     каждый персонаж запрашивается через алиас Page(perPage:1) — пустой список вместо ошибки;
//   - эндпоинты /search у Shikimori игнорируют &limit, поэтому списки режутся на клиенте.

import { anilistQuery } from '../../api/anilist'
import { fetchShiki } from '../../api/shikimori'
import { SHIKI_DOMAINS } from '../../core/constants'
import { html, rawHTML } from '../../utils/dom'
import { Logger } from '../../utils/logger'
import { initDictCapture } from './dict-capture'

/**
 * Признак поля поиска в шапке сайта.
 *
 * Сравнивать placeholder со строкой 'Поиск в AniList' нельзя: это результат работы
 * нашего же переводчика, и при translateInterface: false или правке формулировки
 * в dictionary.json русский поиск молча переставал работать: две независимые
 * функции оказывались связаны через текст интерфейса.
 *
 * Поэтому поле опознаётся по смыслу placeholder'а: упоминание AniList плюс глагол поиска
 * на любом из двух языков. Подходит и 'Поиск в AniList', и исходное 'Search AniList'.
 */
const SEARCH_SITE_RE = /anilist/i
const SEARCH_VERB_RE = /search|поиск|искать/i

const DEBOUNCE_MS = 600
const PER_CATEGORY = 4

/** Абсолютный адрес на зеркале Shikimori (для фоллбэков без пары на AniList). */
function shikiUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

/**
 * Это поле поиска сайта?
 *
 * Проверка сознательно узкая: ложное срабатывание показало бы выпадашку поиска
 * поверх чужого поля — например, поверх заметки к тайтлу или поля фильтров списка.
 */
function isSiteSearchInput(el: HTMLInputElement): boolean {
  const placeholder = el.getAttribute('placeholder') ?? ''
  if (placeholder === '') return false
  return SEARCH_SITE_RE.test(placeholder) && SEARCH_VERB_RE.test(placeholder)
}

interface ShikiSearchMedia {
  /** Равен MyAnimeList ID. */
  id: number
  name?: string | null
  russian?: string | null
  aired_on?: string | null
}

interface ShikiSearchPersonRaw {
  id: number
  name?: string | null
  russian?: string | null
  url?: string | null
  image?: { preview?: string | null } | null
}

/** То же, но с пометкой зеркала: фоллбэк-ссылки должны быть абсолютными. */
interface ShikiSearchPerson extends ShikiSearchPersonRaw {
  __domain: string
}

interface AlMediaHit {
  id: number
  idMal: number | null
  type: string
  format?: string | null
  seasonYear?: number | null
  coverImage?: { medium?: string | null } | null
}

interface AlPersonNode {
  id: number
  image?: { large?: string | null } | null
}

type AlSearchData = {
  pm?: { media?: AlMediaHit[] | null } | null
} & Record<string, unknown>

let isStarted = false
let searchTimeout: number | null = null
let activeQuery = ''
let cachedHtml = ''

/** Колонка с тайтлами. Без пары на AniList элемент пропускается: ссылаться некуда. */
function generateCol(
  title: string,
  items: ShikiSearchMedia[],
  typeStr: string,
  alMap: Record<string, AlMediaHit>,
): string {
  if (items.length === 0) return ''

  let colHtml = html`<div class="result-col animori-custom-result-col">
    <h3 class="title">${title}</h3>
  </div>`

  for (const item of items) {
    const alItem = alMap[`${typeStr.toUpperCase()}_${item.id}`]
    if (!alItem) continue

    const year =
      alItem.seasonYear ?? (item.aired_on ? new Date(item.aired_on).getFullYear() : '???')
    const format = (alItem.format ?? typeStr).replace(/_/g, ' ')
    const cover = rawHTML(encodeURI(alItem.coverImage?.medium ?? '').replace(/'/g, '%27'))
    const href = `/${String(alItem.type).toLowerCase()}/${alItem.id}`

    colHtml += html`<div class="result">
      <div>
        <a href="${href}" class="">
          <div class="image" style="background-image: url('${cover}');"></div>
          <div class="name">
            ${item.russian || item.name}
            <div class="info"><span>${year}</span> <span>${format}</span></div>
          </div>
        </a>
      </div>
    </div>`
  }

  return colHtml + '</div>'
}

/** Колонка с персонами: ссылка и аватар AniList при совпадении, иначе фоллбэк на Shikimori. */
function generatePersonCol(
  title: string,
  items: ShikiSearchPerson[],
  aliasPrefix: string,
  listKey: 'characters' | 'staff',
  alPath: string,
  alData: AlSearchData,
): string {
  if (items.length === 0) return ''

  let colHtml = html`<div class="result-col animori-custom-result-col">
    <h3 class="title">${title}</h3>
  </div>`

  items.forEach((item, i) => {
    const page = alData[`${aliasPrefix}${i}`] as Record<string, AlPersonNode[] | null> | undefined
    const node = page?.[listKey]?.[0]
    const alId = node?.id

    // Нет пары на AniList — ведём на зеркало Shikimori, которое ответило на поиск.
    const href = alId ? `/${alPath}/${alId}` : shikiUrl(item.__domain, item.url ?? '')
    const imgUrl =
      alId && node?.image?.large
        ? node.image.large
        : shikiUrl(item.__domain, item.image?.preview ?? '')
    const cover = rawHTML(encodeURI(imgUrl).replace(/'/g, '%27'))

    colHtml += html`<div class="result">
      <div>
        <a href="${href}" class="">
          <div class="image" style="background-image: url('${cover}');"></div>
          <div class="name">
            ${item.russian || item.name}
            <div class="info"><span>${item.name}</span></div>
          </div>
        </a>
      </div>
    </div>`
  })

  return colHtml + '</div>'
}

/**
 * Вставляет готовый HTML в выпадашку поиска.
 *
 * Если родного контейнера .results ещё нет (AniList ничего не нашёл по кириллице и
 * не создал выпадашку), рисуем свой .am-fake-results, копируя data-v-* атрибут
 * scoped-стилей Vue — иначе блок остался бы без оформления сайта.
 */
function renderCustomResults(htmlContent: string): void {
  let resultsContainer = document.querySelector<HTMLElement>('.results:not(.am-fake-results)')

  if (!resultsContainer) {
    resultsContainer = document.querySelector<HTMLElement>('.am-fake-results')
    if (!resultsContainer) {
      const inputWrap = document.querySelector<HTMLElement>('.input')
      if (!inputWrap?.parentNode) return

      resultsContainer = document.createElement('div')
      resultsContainer.className = 'results am-fake-results'
      const dataAttr = Array.from(inputWrap.attributes).find((a) => a.name.startsWith('data-v-'))
      if (dataAttr) resultsContainer.setAttribute(dataAttr.name, '')
      inputWrap.parentNode.appendChild(resultsContainer)
    }
  }

  document.querySelectorAll('.am-ru-injected-container').forEach((el) => el.remove())

  const wrapper = document.createElement('div')
  wrapper.className = 'am-ru-injected-container'
  // htmlContent собран через html`` выше, то есть уже доверенный.
  wrapper.innerHTML = htmlContent
  resultsContainer.appendChild(wrapper)
}

function removeCustomResults(): void {
  document.querySelectorAll('.am-ru-injected-container').forEach((el) => el.remove())
  document.querySelectorAll('.am-fake-results').forEach((el) => el.remove())
}

async function performRussianSearch(query: string): Promise<void> {
  Logger('INFO', `Русский поиск: ${query}`)
  const q = encodeURIComponent(query)

  try {
    const [animeRes, mangaRes, charRes, staffRes] = await Promise.all([
      fetchShiki<ShikiSearchMedia[]>(`/api/animes?search=${q}&limit=${PER_CATEGORY}`),
      fetchShiki<ShikiSearchMedia[]>(`/api/mangas?search=${q}&limit=${PER_CATEGORY}`),
      fetchShiki<ShikiSearchPersonRaw[]>(`/api/characters/search?search=${q}`),
      fetchShiki<ShikiSearchPersonRaw[]>(`/api/people/search?search=${q}`),
    ])

    // Пользователь успел допечатать — результат устарел.
    if (activeQuery !== query) return

    const shikiAnime = animeRes.data ?? []
    const shikiManga = mangaRes.data ?? []

    const tagDomain = (res: {
      data: ShikiSearchPersonRaw[] | null
      domain: string | null
    }): ShikiSearchPerson[] =>
      (res.data ?? []).map((item) => ({
        ...item,
        __domain: res.domain ?? SHIKI_DOMAINS[0] ?? 'shikimori.io',
      }))

    const shikiChars = tagDomain(charRes).slice(0, PER_CATEGORY)
    const shikiStaff = tagDomain(staffRes).slice(0, PER_CATEGORY)

    if (
      shikiAnime.length === 0 &&
      shikiManga.length === 0 &&
      shikiChars.length === 0 &&
      shikiStaff.length === 0
    ) {
      cachedHtml = html`<div class="am-ru-empty">Ничего не найдено ¯_(ツ)_/¯</div>`
      renderCustomResults(cachedHtml)
      return
    }

    // Один запрос на всё: медиа по MAL id + персонажи/стафф через алиасы.
    const malIds = [...shikiAnime.map((i) => i.id), ...shikiManga.map((i) => i.id)]
    const varDefs = ['$m:[Int]']
    const rootFields = [
      'pm: Page{ media(idMal_in:$m){ id idMal type format seasonYear coverImage{medium} } }',
    ]
    const vars: Record<string, unknown> = { m: malIds }

    shikiChars.forEach((c, i) => {
      varDefs.push(`$c${i}:String`)
      rootFields.push(`pc${i}: Page(perPage:1){ characters(search:$c${i}){ id image{ large } } }`)
      vars[`c${i}`] = c.name
    })
    shikiStaff.forEach((c, i) => {
      varDefs.push(`$s${i}:String`)
      rootFields.push(`ps${i}: Page(perPage:1){ staff(search:$s${i}){ id image{ large } } }`)
      vars[`s${i}`] = c.name
    })

    const alRes = await anilistQuery<AlSearchData>(
      `query(${varDefs.join(',')}){ ${rootFields.join(' ')} }`,
      vars,
    )
    if (activeQuery !== query) return

    const alData = (alRes.data ?? {}) as AlSearchData
    const alMap: Record<string, AlMediaHit> = {}
    for (const item of alData.pm?.media ?? []) {
      alMap[`${item.type}_${item.idMal}`] = item
    }

    let resultHtml = ''
    resultHtml += generateCol('Аниме (RU)', shikiAnime, 'Anime', alMap)
    resultHtml += generateCol('Манга (RU)', shikiManga, 'Manga', alMap)
    resultHtml += generatePersonCol(
      'Персонажи (RU)',
      shikiChars,
      'pc',
      'characters',
      'character',
      alData,
    )
    resultHtml += generatePersonCol('Стафф (RU)', shikiStaff, 'ps', 'staff', 'staff', alData)

    if (resultHtml === '') {
      resultHtml = html`<div class="am-ru-empty">Совпадений на AniList не найдено</div>`
    }

    cachedHtml = resultHtml
    renderCustomResults(resultHtml)
  } catch (e) {
    if (activeQuery !== query) return
    cachedHtml = html`<div class="am-ru-empty">Ошибка соединения с базой</div>`
    renderCustomResults(cachedHtml)
    Logger('ERROR', 'Ошибка русского поиска', e)
  }
}

/** Русский поиск в шапке AniList. Идемпотентна. */
export function initRussianSearch(): void {
  if (isStarted) return
  isStarted = true

  // Слушатель на body, а не на инпуте: React пересоздаёт поле поиска при навигации.
  document.body.addEventListener('input', (e) => {
    const target = e.target
    if (!(target instanceof HTMLInputElement)) return
    if (!isSiteSearchInput(target)) return

    const query = target.value.trim()
    const hasCyrillic = /[а-яА-ЯёЁ]/.test(query)

    if (!hasCyrillic || query.length < 2) {
      document.body.classList.remove('am-ru-search-active')
      activeQuery = ''
      cachedHtml = ''
      removeCustomResults()
      return
    }
    if (query === activeQuery) return

    activeQuery = query
    document.body.classList.add('am-ru-search-active')
    if (searchTimeout !== null) clearTimeout(searchTimeout)

    cachedHtml = html`<div class="am-ru-loading">Ищем на Shikimori... 🔍</div>`
    renderCustomResults(cachedHtml)
    searchTimeout = window.setTimeout(() => void performRussianSearch(query), DEBOUNCE_MS)
  })

  // Риск №3 из docs/DECISIONS.md: React выкидывает наш блок при перерисовке выпадашки,
  // поэтому результат держится в cachedHtml и восстанавливается наблюдателем.
  const observer = new MutationObserver(() => {
    if (!document.body.classList.contains('am-ru-search-active')) return
    if (activeQuery.length < 2) return

    // Как только сайт создал свою выпадашку — свою подделку убираем.
    const realResults = document.querySelector('.results:not(.am-fake-results)')
    const fakeResults = document.querySelector('.am-fake-results')
    if (realResults && fakeResults) fakeResults.remove()

    const resultsContainer = document.querySelector('.results')
    const hasOurContainer = document.querySelector('.am-ru-injected-container')
    if (resultsContainer && !hasOurContainer && cachedHtml) renderCustomResults(cachedHtml)
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

/** Единая точка входа модуля поиска. */
export function initSearch(): void {
  initRussianSearch()
  initDictCapture()
}

export { initDictCapture }
