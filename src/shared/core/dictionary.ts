// Словарь переводов: удалённая база с GitHub плюс правки пользователя поверх неё.
// Правки держим в памяти: переводчик читает словарь синхронно на каждом проходе по DOM.
// Любое изменение словаря дёргает amRetranslate — коллбэк из initTranslator.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'

/** Удалённая база с GitHub, ставится единожды через setRemoteDict(). */
let remoteDict: Record<string, string> = Object.create(null)

/** Коллбэк повторного перевода DOM, ставится через registerRetranslateCallback(). */
let amRetranslate: (() => void) | null = null

const STORAGE_KEY = 'am_user_dict'

/** Кэш правок в памяти: getUserDict() обязан оставаться синхронным. */
let userDictCache: Record<string, string> = {}

/** Итоговый словарь: база плюс правки юзера. */
export let dictionary: Record<string, string> = Object.create(null)

/**
 * Нормализует ключ: схлопывает пробелы и триммит.
 * Экспортируется ради захвата выделения: иначе ключи разойдутся и перевод не сработает.
 */
export function normDictKey(v: string | null | undefined): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Разбирает значение из хранилища: там может лежать и строка, и готовый объект. */
function parseDict(raw: unknown): Record<string, string> {
  const obj = raw && typeof raw === 'object' ? raw : JSON.parse((raw as string) || '{}')
  return obj && typeof obj === 'object' && !Array.isArray(obj)
    ? (obj as Record<string, string>)
    : {}
}

/**
 * Наполняет кэш правок из хранилища.
 * Вызывается из bootstrap() до rebuildDictionary(), иначе первый проход пойдёт без правок.
 */
export async function loadUserDict(): Promise<void> {
  try {
    const raw = await Bridge.storage.get<unknown>(STORAGE_KEY, '{}')
    userDictCache = parseDict(raw)
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения am_user_dict', e)
    userDictCache = {}
  }
}

/**
 * Отдаёт копию правок, а не сам объект.
 * Иначе правки в редакторе меняли бы сохранённые данные до setUserDict().
 */
export function getUserDict(): Record<string, string> {
  return { ...userDictCache }
}

/**
 * Сохраняет правки: сначала память, затем хранилище.
 * Никогда не бросает: иначе добавление слова из выделения падало бы на ошибке записи.
 */
export function setUserDict(obj: Record<string, string>): void {
  userDictCache = obj && typeof obj === 'object' ? { ...obj } : {}
  void Bridge.storage.set(STORAGE_KEY, JSON.stringify(userDictCache)).catch((e) => {
    Logger('ERROR', 'Ошибка записи am_user_dict', e)
  })
}

/** Пересобирает итоговый словарь: база + правки юзера. */
export function rebuildDictionary(): void {
  dictionary = Object.assign(Object.create(null), remoteDict, getUserDict())
}

/**
 * Добавляет/обновляет запись в пользовательском словаре и применяет вживую.
 * @returns false, если ключ или значение пустые.
 */
export function upsertUserDictEntry(source: string, translation: string): boolean {
  const k = normDictKey(source)
  const v = normDictKey(translation)
  if (!k || !v) return false

  const ud = getUserDict()
  ud[k] = v
  setUserDict(ud)
  rebuildDictionary()

  if (typeof amRetranslate === 'function') amRetranslate()
  return true
}

/** Удаляет запись из пользовательского словаря. */
export function removeUserDictEntry(source: string): void {
  const k = normDictKey(source)
  const ud = getUserDict()
  if (Object.prototype.hasOwnProperty.call(ud, k)) {
    delete ud[k]
    setUserDict(ud)
    rebuildDictionary()
  }
}

/**
 * Устанавливает удалённую базу словаря (вызывается из bootstrap() при старте).
 * @param dict Объект { "Original": "Translation" } с GitHub.
 */
export function setRemoteDict(dict: Record<string, string>): void {
  remoteDict = dict
  rebuildDictionary()
}

/**
 * Регистрирует коллбэк для ре-скана DOM (вызывается из initTranslator).
 * @param callback Функция, которая перезапускает перевод страницы.
 */
export function registerRetranslateCallback(callback: () => void): void {
  amRetranslate = callback
}
