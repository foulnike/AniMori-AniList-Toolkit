// IBridge для десктопной оболочки Tauri.
// В бандл юзерскрипта не попадает: alias '@bridge-impl' в vite.config.ts разводит
// реализации по mode. Ветвлением не обойтись — new LazyStore ниже даёт побочный эффект.

import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { LazyStore } from '@tauri-apps/plugin-store'

import {
  DEFAULT_PROXY,
  PROXY_KEYS,
  normalizeProxyKind,
  proxyBypassList,
  proxyUrl,
  type ProxyConfig,
} from '@/core/proxy'

import {
  BridgeHttpError,
  type HttpRequestOptions,
  type HttpResponse,
  type IBridge,
  type IClipboard,
  type IHttp,
  type IShell,
  type IStorage,
} from './IBridge'
import { tauriProxyDiagnostics } from './TauriProxyDiagnostics'

// ==== storage ====

// LazyStore не требует await при создании. autoSave — только сетка безопасности:
// он пишет файл уже после разрешения set(), это дефект 4.5.
const store = new LazyStore('animori-settings.json', { autoSave: true })

/** Снимок файла настроек в памяти: один entries() вместо трёх десятков get() на старте. */
let snapshot: Map<string, unknown> | null = null

/** Незавершённая загрузка снимка: параллельные чтения не дёргают entries() повторно. */
let snapshotLoading: Promise<Map<string, unknown> | null> | null = null

async function loadSnapshot(): Promise<Map<string, unknown> | null> {
  if (snapshot) return snapshot
  if (snapshotLoading) return snapshotLoading

  snapshotLoading = (async () => {
    try {
      const entries = await store.entries()
      snapshot = new Map(entries)
      return snapshot
    } catch (e) {
      // Падать незачем: ниже есть путь через store.get() по одному ключу.
      console.error('[AniMori] Не удалось прочитать файл настроек целиком', e)
      return null
    } finally {
      snapshotLoading = null
    }
  })()

  return snapshotLoading
}

/** Незавершённые записи: вызывающие set() его не ждут, а flush() обязан их дождаться. */
const pendingWrites = new Set<Promise<void>>()

/** Предел проходов flush(): без него непрерывный поток set() держит ожидание вечно. */
const FLUSH_MAX_ROUNDS = 5

// Перегрузки как в MonkeyBridge: объектный литерал перегруженный метод не реализует.
async function storageGet<T>(key: string, defaultValue: T): Promise<T>
async function storageGet<T = unknown>(key: string): Promise<T | undefined>
async function storageGet<T>(key: string, defaultValue?: T): Promise<T | undefined> {
  const hasDefault = arguments.length >= 2

  const cache = await loadSnapshot()
  const value = cache ? (cache.get(key) as T | undefined) : await store.get<T>(key)

  // store.get дефолт не принимает — подставляем сами.
  if (value === undefined && hasDefault) return defaultValue as T
  return value
}

/** Запись значения и немедленная выгрузка файла на диск. */
async function writeValue(key: string, value: unknown): Promise<void> {
  // Снимок правится сразу: чтение сразу после set() обязано видеть новое значение.
  if (snapshot) snapshot.set(key, value)

  await store.set(key, value)
  // Явный save(): контракт IStorage.set требует долговечности к моменту разрешения.
  await store.save()
}

const tauriStorage: IStorage = {
  get: storageGet,

  set(key: string, value: unknown): Promise<void> {
    const write = writeValue(key, value)

    // В реестр идёт ветвь без отклонения: flush() не должен падать из-за чужой ошибки.
    const tracked = write.catch(() => undefined)
    pendingWrites.add(tracked)
    void tracked.then(() => {
      pendingWrites.delete(tracked)
    })

    return write
  },

  async flush(): Promise<void> {
    // Несколько проходов: пока ждём партию, могли прийти новые записи.
    for (let round = 0; round < FLUSH_MAX_ROUNDS; round++) {
      if (pendingWrites.size === 0) return
      await Promise.all([...pendingWrites])
    }
  },
}

// ==== прокси ====

/**
 * Прокси НАШЕГО канала — запросов из процесса оболочки. Страницу в WebView2
 * настраивает src-tauri/src/proxy.rs. Тип выведен из fetch: имя экспорта менялось.
 */
type TauriFetchOptions = NonNullable<Parameters<typeof tauriFetch>[1]>
type TauriProxyOption = TauriFetchOptions['proxy']

/** Читается один раз за сеанс: смена адреса вступает в силу только с перезапуском. */
let proxyOption: TauriProxyOption
let proxyReady = false

async function loadProxyOption(): Promise<TauriProxyOption> {
  if (proxyReady) return proxyOption

  try {
    const [enabled, kind, host, port, login, password, bypass] = await Promise.all([
      storageGet(PROXY_KEYS.enabled, DEFAULT_PROXY.enabled),
      storageGet(PROXY_KEYS.kind, DEFAULT_PROXY.kind),
      storageGet(PROXY_KEYS.host, DEFAULT_PROXY.host),
      storageGet(PROXY_KEYS.port, DEFAULT_PROXY.port),
      storageGet(PROXY_KEYS.login, DEFAULT_PROXY.login),
      storageGet(PROXY_KEYS.password, DEFAULT_PROXY.password),
      storageGet(PROXY_KEYS.bypass, DEFAULT_PROXY.bypass),
    ])

    const config: ProxyConfig = {
      enabled,
      kind: normalizeProxyKind(kind),
      host: String(host ?? ''),
      port,
      login: String(login ?? ''),
      password: String(password ?? ''),
      bypass: String(bypass ?? ''),
    }

    const url = proxyUrl(config)

    if (config.enabled && !url) {
      // Инвариант 4: иначе включённый тумблер врёт, а трафик идёт напрямую.
      console.warn(
        '[AniMori] Прокси включён, но адрес или порт заданы неверно — запросы идут напрямую',
      )
    }

    if (url) {
      const noProxy = proxyBypassList(config).join(',')
      const trimmedLogin = config.login.trim()

      proxyOption = {
        all: {
          url,
          // Отдельно от адреса: пароль с ':' или '@' сломал бы склейку user:pass@host.
          ...(trimmedLogin
            ? { basicAuth: { username: trimmedLogin, password: config.password } }
            : {}),
          ...(noProxy ? { noProxy } : {}),
        },
      }
    } else {
      proxyOption = undefined
    }
  } catch (e) {
    console.error('[AniMori] Не удалось прочитать настройки прокси, запросы идут напрямую', e)
    proxyOption = undefined
  } finally {
    proxyReady = true
  }

  return proxyOption
}

// ==== http ====

/** Без своего представления reqwest подписывается собой: 403 у AnimeThemes, 5.3.5. */
const DEFAULT_USER_AGENT = `AniMori/${__ANIMORI_VERSION__} (+https://github.com/foulnike/AniMori-AniList-Toolkit)`

const tauriHttp: IHttp = {
  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    const { url, method = 'GET', headers, body, timeoutMs, credentials = 'include' } = options

    // До таймера: первое чтение идёт в оболочку и съело бы таймаут запроса.
    const proxy = await loadProxyOption()

    // connectTimeout покрывает только установку соединения, нужен таймаут на весь запрос.
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    }

    try {
      const res = await tauriFetch(url, {
        method,
        // Свой заголовок под заголовками вызывающего: клиент вправе его перебить.
        headers: { 'User-Agent': DEFAULT_USER_AGENT, ...headers },
        body,
        credentials,
        signal: controller.signal,
        // Ключ только при настроенном прокси: пустой proxy путает разбор сбоев.
        ...(proxy ? { proxy } : {}),
      })

      const text = await res.text()

      // Headers сам приводит имена к нижнему регистру и склеивает повторы.
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value
      })

      return {
        status: res.status,
        statusText: res.statusText,
        ok: res.status >= 200 && res.status < 300,
        headers: responseHeaders,
        text,
        url: res.url || url,
      }
    } catch (e) {
      // Сюда приходят только транспортные сбои; мёртвый прокси от них неотличим.
      if (timedOut) throw new BridgeHttpError('timeout', url)

      const name = e instanceof Error ? e.name : ''
      if (name === 'AbortError') throw new BridgeHttpError('abort', url)

      throw new BridgeHttpError('network', url)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  },
}

// ==== clipboard ====

const tauriClipboard: IClipboard = {
  async writeText(text: string): Promise<void> {
    // Без фоллбэка: отказ означает невыданное разрешение, это надо видеть.
    await writeText(text)
  },
}

// ==== shell ====

/**
 * Оболочка: свои команды из lib.rs плюс история WebView. Перезагрузка, внешние
 * ссылки и полный экран — только командами. Команды требуют разрешений:
 * build.rs и capabilities.
 */
const tauriShell: IShell = {
  async reload(): Promise<void> {
    await invoke('animori_reload')
  },

  async openExternal(url: string): Promise<void> {
    // Проверка схемы на стороне Rust: этот код исполняется в контексте чужого сайта.
    await invoke('animori_open_external', { url })
  },

  back(): Promise<void> {
    // Через историю WebView: маршрутизатор AniList ждёт popstate.
    history.back()
    return Promise.resolve()
  },

  forward(): Promise<void> {
    history.forward()
    return Promise.resolve()
  },

  async toggleFullscreen(): Promise<boolean> {
    // Ответ команды — состояние ПОСЛЕ переключения, его и отдаём как есть.
    return await invoke<boolean>('animori_toggle_fullscreen')
  },
}

// ==== сборка ====

export const tauriBridge: IBridge = {
  platform: 'tauri',
  storage: tauriStorage,
  http: tauriHttp,
  clipboard: tauriClipboard,
  shell: tauriShell,
  // Реализация в TauriProxyDiagnostics.ts.
  proxyDiagnostics: tauriProxyDiagnostics,
}

// Общее для обеих реализаций имя экспорта.
export { tauriBridge as platformBridge }
