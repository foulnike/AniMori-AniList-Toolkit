// Подписи видов и закладок по-русски: один источник для всех экранов.
// Сервер зовёт виды и закладки заглавной латиницей — человеку это ни о чём.
// Незнакомый ключ показывается как есть: молчаливая пустота хуже латиницы.

import type { MediaType } from '@/core/types'

const FORMAT_WORDS: Readonly<Record<string, string>> = {
  TV: 'ТВ',
  TV_SHORT: 'Короткий ТВ',
  MOVIE: 'Фильм',
  SPECIAL: 'Спешл',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Клип',
  MANGA: 'Манга',
  NOVEL: 'Ранобэ',
  ONE_SHOT: 'Ваншот',
}

export interface StatusItem {
  key: string
  title: string
}

/** Закладки аниме. Порядок как в привычном списке на сайте. */
const ANIME_STATUS: ReadonlyArray<StatusItem> = [
  { key: 'CURRENT', title: 'Смотрю' },
  { key: 'REPEATING', title: 'Пересматриваю' },
  { key: 'PLANNING', title: 'В планах' },
  { key: 'COMPLETED', title: 'Просмотрено' },
  { key: 'PAUSED', title: 'Отложено' },
  { key: 'DROPPED', title: 'Брошено' },
]

/** Закладки манги: ключи те же, а подписи обязаны быть про чтение. */
const MANGA_STATUS: ReadonlyArray<StatusItem> = [
  { key: 'CURRENT', title: 'Читаю' },
  { key: 'REPEATING', title: 'Перечитываю' },
  { key: 'PLANNING', title: 'В планах' },
  { key: 'COMPLETED', title: 'Прочитано' },
  { key: 'PAUSED', title: 'Отложено' },
  { key: 'DROPPED', title: 'Брошено' },
]

/** Вид тайтла по-русски. Нет вида — нет и подписи. */
export function formatWord(format: string | null): string | null {
  if (format === null || format === '') return null
  return FORMAT_WORDS[format] ?? format
}

/** Закладки под вид тайтла: порядок важен, поэтому массив, а не словарь. */
export function statusList(type: MediaType): ReadonlyArray<StatusItem> {
  return type === 'MANGA' ? MANGA_STATUS : ANIME_STATUS
}

/** Подпись одной закладки. Пустой ключ значит «тайтла нет в списке». */
export function statusWord(type: MediaType, key: string | null): string | null {
  if (key === null || key === '') return null

  const found = statusList(type).find((item) => item.key === key)
  return found?.title ?? key
}

/** Подпись строки счёта частей для карточки. */
export function partsWord(type: MediaType): string {
  return type === 'MANGA' ? 'Главы' : 'Эпизоды'
}

/** Короткое слово для плитки: на постере места мало. */
export function partsShort(type: MediaType): string {
  return type === 'MANGA' ? 'гл.' : 'эп.'
}
