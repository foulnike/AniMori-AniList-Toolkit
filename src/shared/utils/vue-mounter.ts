// Единая точка монтирования Vue-приложений в чужую страницу.
//
// Никто кроме этого модуля не должен звать createApp().mount() напрямую.
// Причины из docs/DECISIONS.md:
//
// Риск №4 (рекурсия мутаций). Vue на каждом реактивном обновлении выдаёт сотни
// микро-мутаций. Если корень не помечен am-notr до первого mount(), наблюдатель
// переводчика успевает зайти в свежую разметку, переводит текст, Vue возвращает
// свой — и цикл не заканчивается. Порядок важен буквально: класс → вставка в DOM → mount().
//
// Риск №3 (React против Vue). AniList — React-SPA и без предупреждений сносит чужие
// узлы при перерисовке. Если контейнер вырезали, экземпляр приложения остаётся жив
// и держит подписки — это zombie-компонент и утечка. Поэтому всё смонтированное
// регистрируется здесь.
//
// Обращений к GM_*, хранилищу и сети здесь нет сознательно: модуль переезжает
// в Tauri без правок.

import { createApp } from 'vue'
import type { App, Component } from 'vue'
import { NO_TRANSLATE_CLASS } from '@/features/translator/dom'
import { Logger } from './logger'

/** Префикс id у всех созданных нами корней. Удобно искать в инспекторе. */
const ROOT_ID_PREFIX = 'am-vue-'

/** Класс на каждом корне: единый селектор для массовых операций и стилей. */
export const VUE_ROOT_CLASS = 'am-vue-root'

export interface MountOptions {
  /**
   * Где создать корень. По умолчанию document.body — самое безопасное место:
   * React туда не залезает. Всё, что встраивается внутрь разметки сайта, обязано
   * передавать container и быть готовым к пересозданию.
   */
  container?: HTMLElement
  /** props корневого компонента. */
  props?: Record<string, unknown>
  /** Дополнительные классы на корневом узле. */
  rootClasses?: readonly string[]
  /**
   * Следить за тем, что корень остался в документе. При пропаже — пересоздать.
   * Для модалок в body не нужно, для инъекций в React-дерево — обязательно.
   */
  watchContainer?: boolean
  /**
   * Приложение привязано к конкретной странице и должно сниматься при смене
   * роута (unmountPageScoped).
   *
   * По умолчанию false — приложение считается постоянным и живёт всю сессию.
   * Так работают панель действий и все модалки: их видимостью управляет v-if внутри
   * компонента, а не монтирование.
   */
  pageScoped?: boolean
}

interface MountedEntry {
  key: string
  app: App<Element>
  root: HTMLElement
  component: Component
  options: MountOptions
  observer?: MutationObserver
}

/** Реестр живых приложений. Ключ — логическое имя («settings», «logger»). */
const registry = new Map<string, MountedEntry>()

function createRoot(key: string, options: MountOptions): HTMLElement {
  const root = document.createElement('div')
  root.id = ROOT_ID_PREFIX + key
  // Класс-иммунитет выставляется ДО вставки в документ и ДО mount().
  root.classList.add(NO_TRANSLATE_CLASS, VUE_ROOT_CLASS)
  for (const cls of options.rootClasses ?? []) root.classList.add(cls)
  return root
}

/**
 * Убирает брошенный корень с таким же id, если он висит в документе.
 *
 * Такое бывает после аварийного снятия: экземпляр уже не в реестре, а узел в DOM
 * остался. Без этой проверки на странице копились бы два одинаковых id — именно так
 * появляются двойные кнопки после серии быстрых переходов.
 */
function removeOrphanRoot(key: string): void {
  const orphan = document.getElementById(ROOT_ID_PREFIX + key)
  if (!orphan) return
  if (registry.has(key)) return
  Logger('WARN', `vue-mounter: убираю брошенный корень «${key}»`)
  orphan.remove()
}

/**
 * Монтирует компонент и регистрирует его под ключом key.
 * Повторный вызов с тем же ключом возвращает уже созданный экземпляр,
 * а не плодит второе приложение: модалки открываются из разных мест.
 *
 * @returns экземпляр приложения или null, если смонтировать не удалось.
 */
export function mountApp(
  key: string,
  component: Component,
  options: MountOptions = {},
): App<Element> | null {
  const existing = registry.get(key)
  if (existing) {
    if (existing.root.isConnected) return existing.app
    // Корень вырезали из-под нас — чистим и монтируем заново.
    Logger('WARN', `mountApp: корень «${key}» исчез из DOM, пересоздаю`)
    unmountApp(key)
  }

  const parent = options.container ?? document.body
  if (!parent) {
    Logger('ERROR', `mountApp: нет контейнера для «${key}»`)
    return null
  }

  // Сначала убираем возможный фантом с тем же id, потом вставляем свежий.
  removeOrphanRoot(key)

  const root = createRoot(key, options)

  try {
    parent.appendChild(root)
    const app = createApp(component, options.props ?? {})

    // Ошибка в любом компоненте не должна ронять остальной скрипт.
    app.config.errorHandler = (err, _instance, info) => {
      Logger('ERROR', `Vue «${key}»: сбой в ${info}`, err)
    }

    app.mount(root)

    const entry: MountedEntry = { key, app, root, component, options }
    if (options.watchContainer) entry.observer = watchRoot(entry, parent)
    registry.set(key, entry)

    return app
  } catch (e) {
    Logger('ERROR', `mountApp: не удалось смонтировать «${key}»`, e)
    root.remove()
    return null
  }
}

/**
 * Наблюдатель за исчезновением корня (риск №3).
 * Следим только за детьми родителя и без subtree: внутренние мутации — это
 * работа самого Vue, и подписка на них вернёт ту же рекурсию, от которой ушли.
 */
function watchRoot(entry: MountedEntry, parent: HTMLElement): MutationObserver | undefined {
  if (!window.MutationObserver) return undefined
  try {
    const observer = new MutationObserver(() => {
      if (entry.root.isConnected) return
      observer.disconnect()
      const { key, component, options } = entry
      registry.delete(key)
      try {
        entry.app.unmount()
      } catch {
        /* узлов уже нет — нормально */
      }
      Logger('INFO', `vue-mounter: корень «${key}» удалён страницей, монтирую заново`)
      mountApp(key, component, options)
    })
    observer.observe(parent, { childList: true })
    return observer
  } catch (e) {
    Logger('WARN', `vue-mounter: не удалось включить наблюдение за «${entry.key}»`, e)
    return undefined
  }
}

/** Смонтированное приложение по ключу, если оно есть. */
export function getApp(key: string): App<Element> | undefined {
  return registry.get(key)?.app
}

/** Корневой узел приложения по ключу. */
export function getRoot(key: string): HTMLElement | undefined {
  return registry.get(key)?.root
}

/**
 * Корневой компонент приложения через defineExpose.
 * Так панель действий открывает модалки, не зная о их внутренностях.
 */
export function getExposed<T = Record<string, unknown>>(key: string): T | null {
  const app = registry.get(key)?.app
  if (!app) return null
  return (app._instance?.exposed as T | undefined) ?? null
}

/** Снимает одно приложение и убирает его корень из DOM. */
export function unmountApp(key: string): void {
  const entry = registry.get(key)
  if (!entry) return
  registry.delete(key)
  entry.observer?.disconnect()
  try {
    entry.app.unmount()
  } catch (e) {
    Logger('WARN', `unmountApp: сбой при снятии «${key}»`, e)
  }
  entry.root.remove()
}

/**
 * Снимает только постраничные приложения (pageScoped: true).
 *
 * Именно это вызывается при смене роута, а не unmountAll(): панель действий и модалки
 * монтируются один раз в body при старте и обязаны пережить переход, иначе кнопки
 * исчезнут и больше не вернутся.
 *
 * @returns сколько приложений снято.
 */
export function unmountPageScoped(): number {
  let count = 0
  for (const [key, entry] of Array.from(registry.entries())) {
    if (!entry.options.pageScoped) continue
    unmountApp(key)
    count++
  }
  return count
}

/**
 * Убирает корни с классом am-vue-root, которых нет в реестре.
 *
 * Это и есть те самые фантомные виджеты: узел в DOM есть, живого приложения за ним нет,
 * события не работают. Появляются, когда React переносит кусок разметки вместе с нашим
 * корнем вместо того, чтобы его удалить: наблюдатель watchRoot такой случай не ловит,
 * потому что узел формально остался в документе.
 *
 * @returns сколько узлов убрано.
 */
export function sweepPhantomRoots(): number {
  const live = new Set<HTMLElement>()
  for (const entry of registry.values()) live.add(entry.root)

  let removed = 0
  document.querySelectorAll<HTMLElement>(`.${VUE_ROOT_CLASS}`).forEach((node) => {
    if (live.has(node)) return
    node.remove()
    removed++
  })

  if (removed > 0) Logger('INFO', `vue-mounter: убрано фантомных корней: ${removed}`)
  return removed
}

/**
 * Снимает всё. Вызывается только при полном разборе скрипта (shutdownLifecycle),
 * а не при смене роута — для роута есть unmountPageScoped().
 * Порядок не важен: приложения между собой не связаны.
 */
export function unmountAll(): void {
  for (const key of Array.from(registry.keys())) unmountApp(key)
}

/** Список ключей живых приложений — для дампа состояния в логгере. */
export function listMountedApps(): string[] {
  return Array.from(registry.keys())
}
