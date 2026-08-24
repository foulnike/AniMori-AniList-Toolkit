// Единственная точка входа к мосту: код вне src/bridge импортирует только '@/bridge'.
//
// Реализация теперь одна — мост для браузера. Прежде их было две, и выбор делала
// сборка, а не рантайм: ветвление по __ANIMORI_PLATFORM__ не годилось, так как
// TauriBridge создавал LazyStore на верхнем уровне модуля, а Rollup вправе сохранить
// такой побочный эффект даже из недостижимой ветки. Десктопная реализация уехала
// вместе с приложением — см. ветку app-3.0-dev.
//
// Псевдопуть '@bridge-impl' оставлен при единственной цели сознательно: он ничего
// не стоит и остаётся тем самым швом, куда подставляется платформа. Цель одна
// и та же в двух местах: resolve.alias в vite.config.ts и paths в tsconfig.json.

export {
  BridgeHttpError,
  type HttpErrorKind,
  type HttpMethod,
  type HttpRequestOptions,
  type HttpResponse,
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
 * Мост к платформе: хранилище, сеть, буфер обмена, окно и диагностика прокси.
 * Реализацию подставляет сборка; ветвиться по Bridge.platform больше негде —
 * платформа в этой ветке одна.
 */
export { platformBridge as Bridge } from '@bridge-impl'
