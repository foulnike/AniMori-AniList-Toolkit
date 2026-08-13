// Пользовательские внешние ссылки: JSON-массив { name, url, color } в 'am_custom_links'.
// В url шаблоны {ru}, {romaji} и {query}; color — триплет "r,g,b" для --c в CSS.
// Список держим в памяти: хранилище моста асинхронное, а виджет строится синхронно.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'

export interface CustomLink {
  name: string
  url: string
  /** Триплет "r,g,b" для --c в CSS. */
  color: string
}

/** Палитра по умолчанию: 6 триплетов для новых ссылок. */
export const CL_COLORS = [
  '61,180,242',
  '243,139,168',
  '183,148,244',
  '166,227,161',
  '246,193,119',
  '224,82,100',
]

const STORAGE_KEY = 'am_custom_links'

/** Кэш в памяти: getCustomLinks() обязан оставаться синхронным. */
let cache: CustomLink[] = []

/** Разбирает значение из хранилища: там может лежать и строка, и готовый массив. */
function parseLinks(raw: unknown): CustomLink[] {
  const arr = Array.isArray(raw) ? raw : JSON.parse((raw as string) || '[]')
  return Array.isArray(arr) ? (arr as CustomLink[]) : []
}

/**
 * Наполняет кэш из хранилища, вызывается один раз из bootstrap() до отрисовки.
 * При сбое список остаётся пустым: встроенные сервисы при этом работают.
 */
export async function loadCustomLinks(): Promise<void> {
  try {
    const raw = await Bridge.storage.get<unknown>(STORAGE_KEY, '[]')
    cache = parseLinks(raw)
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения am_custom_links', e)
    cache = []
  }
}

/**
 * Отдаёт копию списка, а не сам массив.
 * Иначе правки в редакторе меняли бы сохранённые данные до setCustomLinks().
 */
export function getCustomLinks(): CustomLink[] {
  return cache.map((link) => ({ ...link }))
}

/**
 * Сохраняет список: сначала память, затем хранилище.
 * Никогда не бросает: иначе редактор ссылок падал бы на ошибке записи.
 */
export function setCustomLinks(arr: CustomLink[]): void {
  cache = Array.isArray(arr) ? arr.map((link) => ({ ...link })) : []
  void Bridge.storage.set(STORAGE_KEY, JSON.stringify(cache)).catch((e) => {
    Logger('ERROR', 'Ошибка записи am_custom_links', e)
  })
}
