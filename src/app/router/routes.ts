// Пункт 3.2: список экранов и их подписи — один источник правды.
// Новый экран = три места: имя здесь, подпись в SCREEN_TITLES
// и сам компонент в App.vue. Меню — четвёртое и необязательное место.

export const SCREEN_NAMES = ['home', 'lists', 'search', 'media', 'settings'] as const

export type ScreenName = (typeof SCREEN_NAMES)[number]

export type Route = {
  name: ScreenName
  params: Record<string, string>
}

export const DEFAULT_ROUTE: Route = { name: 'home', params: {} }

export type MenuItem = {
  name: ScreenName
  title: string
  icon: string
}

// Карточки тайтла в меню нет: на неё попадают из списков и поиска.
export const MENU: ReadonlyArray<MenuItem> = [
  { name: 'home', title: 'Главная', icon: '⌂' },
  { name: 'lists', title: 'Списки', icon: '≡' },
  { name: 'search', title: 'Поиск', icon: '⌕' },
  { name: 'settings', title: 'Настройки', icon: '⚙' },
]

export const SCREEN_TITLES: Record<ScreenName, string> = {
  home: 'Главная',
  lists: 'Списки',
  search: 'Поиск',
  media: 'Тайтл',
  settings: 'Настройки',
}
