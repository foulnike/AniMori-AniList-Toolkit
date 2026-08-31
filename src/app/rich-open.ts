// Куда ведут ссылки из описаний. Ссылка на аниме у Шикимори — это номер
// MyAnimeList, и такой переход обязан остаться внутри приложения: уводить
// наружу за тайтлом, чья карточка у нас есть, обиднее всего.
//
// Со ссылками на людей так просто не выходит: номера у них свои, и разрешать
// их умеет ядро (core/person-link.ts). Здесь только решение, куда вести.
//
// Живёт в слое надстройки, а не в ядре: разбор описания о переходах не знает,
// и знать не должен — у ядра нет ни адресов экранов, ни оболочки.

import { fetchBriefsByMal } from '@/api/anilist-lookup'
import { Bridge } from '@/bridge'
import { resolveShikiPerson } from '@/core/person-link'
import type { RichAim } from '@/core/rich-text'
import { Logger } from '@/utils/logger'

import { openPerson } from './person-layer'
import { navigate } from './router'

/**
 * Чем кончился переход. Окошко человека закрывается только на `media`:
 * иначе карточка тайтла откроется за окошком и останется незамеченной.
 * На `person` закрывать нельзя: окошко только что показало нового человека.
 */
export type RichAimResult = 'media' | 'person' | 'outside'

/** Соответствия MAL и AniList этого запуска: описание часто зовёт одно и то же. */
const known = new Map<number, number | null>()

/** Уводит наружу через оболочку: в WebView2 переход в новом окне молча теряется. */
function openOutside(url: string): void {
  void Bridge.shell.openExternal(url).catch((e) => {
    Logger('WARN', `Описание: внешняя ссылка не открылась (${url})`, e)
  })
}

/** Номер AniList по номеру MAL. Отказ не запоминается: сеть вернётся. */
async function lookup(malId: number): Promise<number | null> {
  try {
    const briefs = await fetchBriefsByMal([malId])
    const found = briefs[0]?.mediaId ?? null

    // Запоминается и отсутствие: тайтла без пары у AniList нет и через минуту.
    known.set(malId, found)
    return found
  } catch (e) {
    Logger('WARN', `Описание: тайтл MAL ${malId} не нашёлся`, e)
    return null
  }
}

/**
 * Идёт по ссылке из описания и говорит, чем всё кончилось.
 *
 * Любой промах ведёт к источнику: пусть откроется в браузере, чем никак.
 */
export async function followRichAim(aim: RichAim): Promise<RichAimResult> {
  if (aim.kind === 'web') {
    openOutside(aim.url)
    return 'outside'
  }

  if (aim.kind === 'person') {
    const target = await resolveShikiPerson(aim.who, aim.shikiId)
    if (target === null) {
      openOutside(aim.url)
      return 'outside'
    }

    openPerson(target)
    return 'person'
  }

  const seen = known.get(aim.malId)
  const mediaId = seen === undefined ? await lookup(aim.malId) : seen

  if (mediaId === null) {
    // Пары у AniList нет: пусть откроется у источника, чем никак.
    openOutside(aim.url)
    return 'outside'
  }

  navigate('media', { id: String(mediaId) })
  return 'media'
}
