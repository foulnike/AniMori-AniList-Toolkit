// Состояние панели действий: реестр кнопок и кнопка плеера, без разметки.
// Отдельный файл, чтобы не было цикла actions.ts — ActionPanel.vue — actions.ts.
// Почему shallowRef и почему кнопка плеера здесь — docs/DECISIONS.md.

import { computed, ref, shallowRef } from 'vue'
import type { Ref } from 'vue'

/** Порядок кнопок слева направо: ⚙, </>, ⇄. Перенос — правее всех. */
export const ACTION_ORDER = {
  settings: 10,
  logger: 20,
  compare: 30,
  sync: 40,
} as const

export interface ActionButton {
  /** id узла: am-set-btn, am-log-btn, am-cmp-btn. Менять нельзя, на них завязаны стили. */
  id: string
  /** Подпись кнопки. Вставляется как текст, не как HTML. Используется, когда нет icon. */
  label: string
  title: string
  /** Меньше — левее. Значения из ACTION_ORDER. */
  order: number
  /**
   * Внутренности SVG 24×24 без самого тега svg, как у TAB_ICONS в SettingsModal.vue.
   * Значение — только собственная константа, пользовательский ввод сюда не попадает.
   */
  icon?: string
  /**
   * Ход длительной операции. Непустая строка вытесняет иконку и подпись.
   * Перенос идёт минутами и без строки состояния выглядит зависшим.
   */
  progress?: Ref<string>
  /** Видимость кнопки. Отсутствует — кнопка видна всегда. */
  visible?: Ref<boolean>
  onClick: () => void
}

/**
 * Реестр зарегистрированных кнопок. shallowRef сохраняет связь с чужими ref в progress и visible.
 * Цена решения: push не замечается, массив надо заменять целиком.
 */
const registry = shallowRef<ActionButton[]>([])

/**
 * Кнопки в порядке отрисовки: по полю order, а не по порядку регистрации.
 * Скрытые отсеиваются здесь, а не через v-if: иначе рвётся соседство кнопок в панели.
 */
export const actionButtons = computed<ActionButton[]>(() =>
  registry.value
    .filter((b) => (b.visible ? b.visible.value : true))
    .sort((a, b) => a.order - b.order),
)

/**
 * Добавляет кнопку в панель. Повторная регистрация того же id игнорируется.
 * Можно вызывать и до, и после initActionBar(): панель реактивна.
 */
export function registerActionButton(button: ActionButton): void {
  if (registry.value.some((b) => b.id === button.id)) return
  registry.value = [...registry.value, button]
}

export const PLAYER_BUTTON_ID = 'ru-player-btn'
export const PLAYER_BUTTON_LABEL = '▶ Плеер'
export const PLAYER_BUTTON_TITLE = 'Смотреть онлайн'

/** Подпись на месте в шапке тайтла: там кнопка широкая и короткое слово смотрится сиротливо. */
export const PLAYER_BUTTON_HERO_LABEL = '▶ Смотреть'

/** Колонка под обложкой в шапке тайтла: кнопка встаёт следом за «Добавить в список». */
const PLAYER_ANCHOR_SELECTOR = '.header .cover-wrap-inner'

/** Куда переносится кнопка плеера. null — кнопка остаётся в плавающей панели. */
export const playerAnchor = shallowRef<HTMLElement | null>(null)

/**
 * Ищет посадочное место заново: AniList пересобирает шапку и выкидывает узлы (РИСК №3).
 * Присваивание только при настоящей смене, иначе кнопка перевешивалась бы на каждый вызов.
 */
export function refreshPlayerAnchor(): void {
  const found = document.querySelector<HTMLElement>(PLAYER_ANCHOR_SELECTOR)
  const next = found && found.isConnected ? found : null
  const current = playerAnchor.value
  if (current === next && (!current || current.isConnected)) return
  playerAnchor.value = next
}

/** Видна ли кнопка плеера. Управляется медиа-виджетом плеера. */
export const isPlayerVisible = ref(false)

/**
 * Обработчик кнопки плеера. shallowRef: значение — функция.
 * В шаблоне не используется, поэтому смена обработчика не перерисовывает панель.
 */
export const playerHandler = shallowRef<(() => void) | null>(null)

/** Показывает кнопку плеера и привязывает запуск для текущего тайтла. */
export function showPlayerButton(onClick: () => void): void {
  playerHandler.value = onClick
  isPlayerVisible.value = true
  // Зовётся на каждую перерисовку страницы, поэтому здесь же обновляется и место кнопки.
  refreshPlayerAnchor()
}

/**
 * Гасит кнопку плеера.
 * Зовётся и виджетом плеера, и медиа-модулем: cleanupSelectors кнопку не снимает.
 */
export function hidePlayerButton(): void {
  isPlayerVisible.value = false
  playerHandler.value = null
  playerAnchor.value = null
}
