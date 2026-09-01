// Пункт 3.2: список экранов и их подписи — один источник правды.
// Новый экран = три места: имя здесь, подпись в SCREEN_TITLES
// и сам компонент в App.vue. Меню — четвёртое и необязательное место.

export const SCREEN_NAMES = [
  'home',
  'lists',
  'search',
  'media',
  'studio',
  'player',
  'settings',
  'log',
] as const

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
// Студии в меню нет: на неё ведут чипы карточки.
// Плеера в меню нет: без тайтла смотреть нечего, вход только из карточки.
// Журнала в меню нет: он нужен при разборе поломки, а не каждый день,
// и ведёт на него кнопка из настроек.
//
// Подписи и имена экранов живут раздельно: имя 'lists' стоит в адресе
// окна и в памяти отбора, поэтому подпись меняется, а имя остаётся.
export const MENU: ReadonlyArray<MenuItem> = [
  { name: 'home', title: 'Главная', icon: '⌂' },
  { name: 'lists', title: 'Моё', icon: '≡' },
  { name: 'search', title: 'Поиск', icon: '⌕' },
  { name: 'settings', title: 'Настройки', icon: '⚙' },
]

export const SCREEN_TITLES: Record<ScreenName, string> = {
  home: 'Главная',
  lists: 'Моё',
  search: 'Поиск',
  media: 'Тайтл',
  studio: 'Студия',
  player: 'Просмотр',
  settings: 'Настройки',
  log: 'Журнал',
}
