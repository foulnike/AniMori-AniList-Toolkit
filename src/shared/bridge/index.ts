// Единственная точка входа к мосту: код вне src/bridge импортирует только '@/bridge'.
// Напрямую нельзя: иначе шов моста расползётся по коду, а он должен быть один.
//
// Выбор реализации сделан сборкой, а не в рантайме: ветвление по __ANIMORI_PLATFORM__
// не годится, так как TauriBridge создаёт LazyStore на верхнем уровне модуля, и Rollup
// вправе сохранить этот побочный эффект даже из недостижимой ветки. Вместо этого
// resolve.alias разводит псевдопуть '@bridge-impl' в один файл.
//
// Цель у псевдопути одна и та же в трёх файлах: vite.config.ts, tsconfig.json
// и tsconfig.shared.json. Расхождение даёт самый неприятный сорт отказа:
// сборка идёт, а проверка типов падает. Шов оставлен под Android из планов,
// реализация сейчас одна — TauriBridge.

export {
  BridgeHttpError,
  type HttpBytesResponse,
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
 * Мост к платформе: хранилище, свои файлы, выгрузка списка в выбранную папку,
 * сеть, запросы к AniList, буфер обмена, окно и диагностика прокси. Реализацию
 * подставляет сборка; Bridge.platform живёт для журнала и текстов, а ветвиться
 * по нему негде: значение одно.
 */
export { platformBridge as Bridge } from '@bridge-impl'
