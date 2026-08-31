// Куда ведут ссылки из описаний. Ссылка на аниме у Шикимори — это номер
// MyAnimeList, и такой переход обязан остаться внутри приложения: уводить
// наружу за тайтлом, чья карточка у нас есть, обиднее всего.
//
// Живёт в слое надстройки, а не в ядре: разбор описания о переходах не знает,
// и знать не должен — у ядра нет ни адресов экранов, ни оболочки.

import { fetchBriefsByMal } from '@/api/anilist-lookup'
import { Bridge } from '@/bridge'
import type { RichAim } from '@/core/rich-text'
import { Logger } from '@/utils/logger'

import { navigate } from './router'

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
 * Идёт по ссылке из описания. Возвращает `true`, если переход внутренний:
 * окошко человека по такому переходу закрывается само, иначе карточка
 * откроется за ним и останется незамеченной.
 */
export async function followRichAim(aim: RichAim): Promise<boolean> {
  if (aim.kind === 'web') {
    openOutside(aim.url)
    return false
  }

  const seen = known.get(aim.malId)
  const mediaId = seen === undefined ? await lookup(aim.malId) : seen

  if (mediaId === null) {
    // Пары у AniList нет: пусть откроется у источника, чем никак.
    openOutside(aim.url)
    return false
  }

  navigate('media', { id: String(mediaId) })
  return true
}
