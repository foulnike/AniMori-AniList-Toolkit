// Единственная точка входа к мосту: код вне src/bridge импортирует только '@/bridge'.
// Напрямую нельзя: в бандл юзерскрипта уехали бы пакеты @tauri-apps/*.
//
// Выбор реализации сделан сборкой, а не в рантайме: ветвление по __ANIMORI_PLATFORM__
// не годится, так как TauriBridge создаёт LazyStore на верхнем уровне модуля, и Rollup
// вправе сохранить этот побочный эффект даже из недостижимой ветки. Вместо этого
// resolve.alias разводит псевдопуть '@bridge-impl' в один файл.
//
// tsconfig.json указывает '@bridge-impl' на MonkeyBridge: тайпчекеру нужна одна цель.
// На проверку это не влияет: обе реализации объявлены как IBridge.

export {
  BridgeHttpError,
  type HttpErrorKind,
  type HttpMethod,
  type HttpRequestOptions,
  type HttpResponse,
  type IAniList,
  type IBridge,
  type IClipboard,
  type IHttp,
  type IProxyDiagnostics,
  type IShell,
  type IStorage,
  type ProxyOutcome,
  type ProxyProbe,
  type ProxyStatus,
} from './IBridge'

/**
 * Мост к платформе: хранилище, сеть, запросы к AniList, буфер обмена, окно
 * и диагностика прокси. Реализацию подставляет сборка; ветвиться по Bridge.platform
 * стоит только там, где поведение действительно расходится.
 */
export { platformBridge as Bridge } from '@bridge-impl'
