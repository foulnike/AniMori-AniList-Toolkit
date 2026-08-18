// Пункт 3.2: свой маршрутизатор на хэше адреса.
//
// Почему хэш, а не обычные пути: страница живёт файлом внутри
// приложения, и перезагрузка по адресу вида /lists искала бы такой файл.
// Почему свой, а не vue-router: экранов мало, а на телевизоре нужен
// полный контроль над историей и кнопкой «Назад» на пульте.
import { computed, ref, type ComputedRef } from 'vue'

import { DEFAULT_ROUTE, SCREEN_NAMES, type Route, type ScreenName } from './routes'

const state = ref<Route>(DEFAULT_ROUTE)

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
  if ((head === 'media' || head === 'studio') && tail !== undefined)
    params.id = decodeURIComponent(tail)
  return { name: head, params }
}

export function buildHash(name: ScreenName, params: Record<string, string> = {}): string {
  const id = params.id
  return id === undefined ? `#/${name}` : `#/${name}/${encodeURIComponent(id)}`
}

export function navigate(name: ScreenName, params: Record<string, string> = {}): void {
  const next = buildHash(name, params)
  if (window.location.hash === next) return
  window.location.hash = next
}

// На телевизоре «Назад» будет жать сюда же, поэтому шаг назад один.
export function goBack(): void {
  window.history.back()
}

// Возвращает отключатель: без него горячая замена в разработке
// накопила бы по подписчику на каждую пересборку.
export function startRouter(): () => void {
  const apply = (): void => {
    state.value = parseHash(window.location.hash)
  }

  apply()
  window.addEventListener('hashchange', apply)
  return () => window.removeEventListener('hashchange', apply)
}
