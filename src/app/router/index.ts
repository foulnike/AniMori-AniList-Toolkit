// Пункт 3.2: свой маршрутизатор на хэше адреса.
//
// Почему хэш, а не обычные пути: страница живёт файлом внутри
// приложения, и перезагрузка по адресу вида /lists искала бы такой файл.
// Почему свой, а не vue-router: экранов мало, а на телевизоре нужен
// полный контроль над историей и кнопкой «Назад» на пульте.
//
// Переход бывает двух видов. Обычный кладёт в историю новую запись: так
// человек уходит вглубь и возвращается шаг за шагом. Замена переписывает
// текущую запись: ею уходят с экрана, возвращаться на который незачем.
// Без замены плеер и карточка образовывали кольцо: «назад» с карточки
// вело в плеер, из которого на неё только что и вышли.
import { computed, ref, type ComputedRef } from 'vue'

import { DEFAULT_ROUTE, SCREEN_NAMES, type Route, type ScreenName } from './routes'

const state = ref<Route>(DEFAULT_ROUTE)

/** Адрес, с которого пришли на нынешний: по нему видно, куда ведёт «назад». */
let before: Route | null = null

/** Экраны, у которых второй кусок адреса — номер сущности. */
const SCREENS_WITH_ID: ReadonlyArray<ScreenName> = ['media', 'studio', 'player']

/** Как переходить: обычно или заменой текущей записи истории. */
export interface NavigateOptions {
  replace?: boolean
}

// Снаружи адрес только читают; менять его можно только через navigate.
export const currentRoute: ComputedRef<Route> = computed(() => state.value)

function isScreenName(value: string): value is ScreenName {
  return (SCREEN_NAMES as readonly string[]).includes(value)
}

// Неизвестный или битый адрес ведёт на главную: пустого экрана
// пользователь видеть не должен ни при каком содержимом строки.
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const parts = raw.split('/').filter((part) => part !== '')
  const head = parts[0] ?? ''
  if (!isScreenName(head)) return DEFAULT_ROUTE

  const params: Record<string, string> = {}
  const tail = parts[1]
  if (SCREENS_WITH_ID.includes(head) && tail !== undefined) {
    try {
      params.id = decodeURIComponent(tail)
    } catch {
      return DEFAULT_ROUTE
    }
  }
  return { name: head, params }
}

export function buildHash(name: ScreenName, params: Record<string, string> = {}): string {
  const id = params.id
  return id === undefined ? `#/${name}` : `#/${name}/${encodeURIComponent(id)}`
}

/**
 * Адрес, с которого пришли на нынешний экран. Нужен тем экранам, которые сами
 * выбирают между шагом назад и переходом вперёд: возврат на уже пройденное
 * историю не растит, а переход вперёд на него же — растит и заводит кольцо.
 */
export function peekPrevious(): Route | null {
  return before
}

/** Ставит адрес и запоминает прежний. Повтор того же адреса за переход не в счёт. */
function land(next: Route): void {
  const now = state.value
  if (next.name === now.name && next.params.id === now.params.id) return

  before = now
  state.value = next
}

export function navigate(
  name: ScreenName,
  params: Record<string, string> = {},
  options: NavigateOptions = {},
): void {
  const next = buildHash(name, params)
  if (window.location.hash === next) return

  if (options.replace !== true) {
    window.location.hash = next
    return
  }

  // replaceState меняет строку адреса молча: hashchange он не поднимает,
  // и без своего вызова экран остался бы прежним при новом адресе.
  window.history.replaceState(null, '', next)
  land(parseHash(next))
}

// На телевизоре «Назад» будет жать сюда же, поэтому шаг назад один.
export function goBack(): void {
  window.history.back()
}

// Возвращает отключатель: без него горячая замена в разработке
// накопила бы по подписчику на каждую пересборку.
export function startRouter(): () => void {
  const apply = (): void => {
    land(parseHash(window.location.hash))
  }

  apply()
  window.addEventListener('hashchange', apply)
  return () => window.removeEventListener('hashchange', apply)
}
