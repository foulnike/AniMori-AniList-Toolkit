// Разбор описаний в разметку показа. Источников два, и оба «почти текст»:
// Шикимори отдаёт BBcode, AniList — полумаркдаун с редкими тегами HTML.
// Прежде теги просто вырезались, а вместе с ними пропадали перекрёстные
// ссылки, спойлеры и начертания — то есть половина смысла описания.
//
// Разбор живёт в ядре, рисование — в надстройке. На склад описание ложится
// как приехало: разбор дешёвый, а сохранённая разметка через год окажется
// от другого разбора.

import { SHIKI_DOMAINS } from './constants'

/** Начертания куска текста. Пустой набор — обычный текст. */
export interface RichFace {
  bold?: true
  italic?: true
  strike?: true
  under?: true
}

/**
 * Куда ведёт ссылка из описания.
 *
 * Тайтл отделён от прочего нарочно: у Шикимори номер аниме — это номер
 * MyAnimeList, и карточка находится внутри приложения. Персонажи и люди
 * так не находятся: у них номера свои, и ссылка ведёт наружу.
 */
export type RichAim =
  | { kind: 'web'; url: string }
  | { kind: 'media'; malId: number; url: string }

/** Кусок строки: текст или ссылка. */
export type RichPart =
  | { kind: 'text'; text: string; face: RichFace }
  | { kind: 'link'; text: string; face: RichFace; aim: RichAim }

/**
 * Блок описания. Переносы внутри абзаца сохраняются как есть: их рисует
 * стиль, а не разбор — иначе описание, набранное строками, склеилось бы
 * в одну простыню.
 */
export type RichBlock =
  | { kind: 'para'; parts: RichPart[] }
  | { kind: 'spoiler'; label: string; blocks: RichBlock[] }
  | { kind: 'quote'; who: string | null; blocks: RichBlock[] }
  | { kind: 'list'; items: RichPart[][] }
  | { kind: 'image'; url: string }
  | { kind: 'rule' }

/** Теги начертаний: имя тега — поле набора. */
const FACE_TAGS: Record<string, keyof RichFace | undefined> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'under',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
}

/** Разделы Шикимори по имени тега: из них собирается адрес ссылки. */
const SHIKI_PATHS: Record<string, string | undefined> = {
  anime: 'animes',
  animes: 'animes',
  manga: 'mangas',
  mangas: 'mangas',
  ranobe: 'ranobe',
  character: 'characters',
  characters: 'characters',
  person: 'people',
  people: 'people',
  user: 'users',
  club: 'clubs',
  topic: 'topics',
}

/** Тег BBcode в разобранном виде. */
interface Tag {
  name: string
  arg: string | null
  close: boolean
}

/** Рамка вложенности: спойлер, цитата и список собирают блоки в себя. */
interface Frame {
  kind: 'root' | 'spoiler' | 'quote' | 'list'
  label: string
  who: string | null
  blocks: RichBlock[]
  items: RichPart[][]
}

const TAG_RE = /\[(\/)?([a-z*][a-z0-9_-]*)(?:=([^\]\n]*))?\]/gi

/** Зеркало для относительных адресов: домена в BBcode Шикимори нет. */
function shikiHost(): string {
  return SHIKI_DOMAINS[0] ?? 'shikimori.one'
}

/** Строка или `null`: пустое значение тега равносильно отсутствию. */
function textOrNull(value: string | null): string | null {
  if (value === null) return null

  const clean = value.trim()
  return clean === '' ? null : clean
}

/** Похоже ли на адрес наружу. */
function isWeb(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Номер MAL из адреса тайтла: /animes/5114-… и /animes/z5114-…. */
function malFromUrl(url: string): number | null {
  const found = /\/animes\/[a-z]?(\d+)/i.exec(url)
  if (found === null) return null

  const malId = Number(found[1])
  return Number.isFinite(malId) && malId > 0 ? malId : null
}

/** Ссылка из адреса: тайтл Шикимори ведёт внутрь, прочее — наружу. */
function webAim(raw: string | null): RichAim | null {
  const asked = (raw ?? '').trim()
  if (asked === '') return null

  // Относительный адрес: в BBcode Шикимори домена в ссылках нет.
  const url = asked.startsWith('/') ? `https://${shikiHost()}${asked}` : asked
  if (!isWeb(url)) return null

  const malId = malFromUrl(url)
  return malId === null ? { kind: 'web', url } : { kind: 'media', malId, url }
}

/** Ссылка из тега раздела: [anime=5114]…[/anime] и его родня. */
function entityAim(path: string, arg: string | null): RichAim | null {
  // Значение бывает с хвостом-слагом: [anime=5114-fullmetal-alchemist].
  const digits = /^\d+/.exec((arg ?? '').trim())
  const id = digits === null ? 0 : Number(digits[0])
  if (!Number.isFinite(id) || id <= 0) return null

  const url = `https://${shikiHost()}/${path}/${id}`
  // Номер аниме у Шикимори — номер MyAnimeList: карточка найдётся внутри.
  return path === 'animes' ? { kind: 'media', malId: id, url } : { kind: 'web', url }
}

function newFrame(kind: Frame['kind'], label = '', who: string | null = null): Frame {
  return { kind, label, who, blocks: [], items: [] }
}

/**
 * Приводит разметку AniList и остатки HTML к тому же BBcode: дальше работает
 * один разбор. Своего разбора для маркдауна нет нарочно — два разбора
 * расходятся на первой же правке.
 */
function toBbcode(text: string): string {
  return (
    text
      // Переносы AniList приезжают тегом даже при asHtml: false.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(?:i|em)>/gi, '[i]')
      .replace(/<\/(?:i|em)>/gi, '[/i]')
      .replace(/<(?:b|strong)>/gi, '[b]')
      .replace(/<\/(?:b|strong)>/gi, '[/b]')
      .replace(/<u>/gi, '[u]')
      .replace(/<\/u>/gi, '[/u]')
      .replace(/<(?:s|strike|del)>/gi, '[s]')
      .replace(/<\/(?:s|strike|del)>/gi, '[/s]')
      // Прочая разметка HTML описанию не нужна: абзацы и списки у нас свои.
      .replace(/<[^>]+>/g, '')
      // Спойлер AniList: ~!скрытое!~
      .replace(/~!([\s\S]*?)!~/g, '[spoiler]$1[/spoiler]')
      // Ссылка маркдауном: [подпись](адрес)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '[url=$2]$1[/url]')
      // Картинка AniList: img(адрес) и img250(адрес)
      .replace(/\bimg\d*\((https?:\/\/[^)\s]+)\)/gi, '[img]$1[/img]')
      .replace(/~~([^\n~]+)~~/g, '[s]$1[/s]')
      .replace(/__([^\n_]+)__/g, '[b]$1[/b]')
      // Курсив подчёркиванием только по краям слова: иначе рвутся имена_файлов.
      .replace(/(^|[\s(«"])_([^\n_]+)_(?=$|[\s).,!?:;»"])/gm, '$1[i]$2[/i]')
      .replace(/^[ \t]*(?:\*\*\*|---)[ \t]*$/gm, '[hr]')
  )
}

/**
 * Разбирает описание в блоки показа. Незакрытые теги не беда: чужой текст
 * рвёт разметку постоянно, и рамки закрываются сами в конце.
 */
export function parseRich(raw: string | null | undefined): RichBlock[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []

  const text = toBbcode(raw)
  const stack: Frame[] = [newFrame('root')]
  const faces: Array<keyof RichFace> = []

  let parts: RichPart[] = []

  /** Открытая ссылка: её подпись собирается отдельно от строки. */
  let aim: RichAim | null = null
  let aimText = ''

  /** Открытая картинка: адрес лежит между её тегами. */
  let imageOn = false
  let imageText = ''

  function top(): Frame {
    return stack[stack.length - 1]!
  }

  function face(): RichFace {
    const found: RichFace = {}
    for (const name of faces) found[name] = true
    return found
  }

  function addText(chunk: string): void {
    if (chunk === '') return

    if (imageOn) {
      imageText += chunk
      return
    }

    if (aim !== null) {
      aimText += chunk
      return
    }

    parts.push({ kind: 'text', text: chunk, face: face() })
  }

  function closeLink(): void {
    const open = aim
    if (open === null) return

    aim = null
    const shown = aimText.trim()
    aimText = ''

    // [url]адрес[/url] без значения: адресом служит сама подпись.
    const ready = open.kind === 'web' && open.url === '' ? webAim(shown) : open
    if (ready === null) {
      addText(shown)
      return
    }

    parts.push({ kind: 'link', text: shown === '' ? ready.url : shown, face: face(), aim: ready })
  }

  function openLink(next: RichAim | null): void {
    closeLink()
    if (next === null) return

    aim = next
    aimText = ''
  }

  /** Закрывает набранную строку: в списке она становится пунктом. */
  function flushLine(): void {
    closeLink()

    const line = parts
    parts = []

    // Края строки без пробелов: отступы вокруг блоков рисует стиль.
    const first = line[0]
    if (first?.kind === 'text') first.text = first.text.replace(/^[ \t\n]+/, '')

    const last = line[line.length - 1]
    if (last?.kind === 'text') last.text = last.text.replace(/[ \t\n]+$/, '')

    const kept = line.filter((part) => part.kind === 'link' || part.text !== '')
    if (!kept.some((part) => part.kind === 'link' || part.text.trim() !== '')) return

    const frame = top()
    if (frame.kind === 'list') frame.items.push(kept)
    else frame.blocks.push({ kind: 'para', parts: kept })
  }

  function openFrame(kind: Frame['kind'], label: string, who: string | null): void {
    flushLine()
    stack.push(newFrame(kind, label, who))
  }

  /** Закрывает рамку, только если она и есть верхняя: чужой тег чужую не уносит. */
  function closeFrame(kind: Frame['kind']): void {
    if (stack.length < 2 || top().kind !== kind) return

    flushLine()
    const done = stack.pop()!
    const parent = top()

    if (done.kind === 'list') parent.blocks.push({ kind: 'list', items: done.items })
    else if (done.kind === 'spoiler') {
      parent.blocks.push({ kind: 'spoiler', label: done.label, blocks: done.blocks })
    } else if (done.kind === 'quote') {
      parent.blocks.push({ kind: 'quote', who: done.who, blocks: done.blocks })
    }
  }

  function openImage(arg: string | null): void {
    closeLink()

    const direct = (arg ?? '').trim()
    imageOn = true
    imageText = isWeb(direct) ? direct : ''
  }

  function closeImage(): void {
    if (!imageOn) return

    imageOn = false
    const url = imageText.trim()
    imageText = ''
    if (!isWeb(url)) return

    flushLine()
    top().blocks.push({ kind: 'image', url })
  }

  function apply(tag: Tag): void {
    const faceName = FACE_TAGS[tag.name]
    if (faceName !== undefined) {
      if (!tag.close) faces.push(faceName)
      else {
        const at = faces.lastIndexOf(faceName)
        if (at >= 0) faces.splice(at, 1)
      }
      return
    }

    if (tag.name === 'br') {
      addText('\n')
      return
    }

    if (tag.name === 'hr') {
      flushLine()
      top().blocks.push({ kind: 'rule' })
      return
    }

    // spoiler_block у Шикимори — тот же спойлер, только с заголовком.
    if (tag.name.startsWith('spoiler')) {
      if (tag.close) closeFrame('spoiler')
      else openFrame('spoiler', textOrNull(tag.arg) ?? '', null)
      return
    }

    if (tag.name === 'quote') {
      if (tag.close) closeFrame('quote')
      else openFrame('quote', '', textOrNull(tag.arg))
      return
    }

    if (tag.name === 'list' || tag.name === 'ul' || tag.name === 'ol') {
      if (tag.close) closeFrame('list')
      else openFrame('list', '', null)
      return
    }

    // Пункт списка. Вне списка звёздочка — просто перенос строки.
    if (tag.name === '*') {
      if (top().kind === 'list') flushLine()
      else addText('\n')
      return
    }

    if (tag.name === 'img' || tag.name === 'poster') {
      if (tag.close) closeImage()
      else openImage(tag.arg)
      return
    }

    if (tag.name === 'url') {
      if (tag.close) closeLink()
      else openLink(tag.arg === null ? { kind: 'web', url: '' } : webAim(tag.arg))
      return
    }

    const path = SHIKI_PATHS[tag.name]
    if (path !== undefined) {
      if (tag.close) closeLink()
      else openLink(entityAim(path, tag.arg))
      return
    }

    // Косметика и незнакомое — цвет, размер, выравнивание: содержимое
    // остаётся, тег уходит молча.
  }

  let at = 0
  TAG_RE.lastIndex = 0

  let found: RegExpExecArray | null
  while ((found = TAG_RE.exec(text)) !== null) {
    if (found.index > at) addText(text.slice(at, found.index))
    at = found.index + found[0].length

    apply({
      name: (found[2] ?? '').toLowerCase(),
      arg: found[3] ?? null,
      close: found[1] === '/',
    })
  }

  if (at < text.length) addText(text.slice(at))

  closeImage()
  flushLine()
  while (stack.length > 1) closeFrame(top().kind)

  return stack[0]!.blocks
}
