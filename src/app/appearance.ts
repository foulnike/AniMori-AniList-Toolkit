// Оформление окна: тёмное, светлое, AMOLED. Значение хранит ядро
// (ключ am_appearance), здесь только применение к <html> и смена по клику.
//
// Подписи тем лежат рядом с выбором, как SCREEN_TITLES в router/routes.ts:
// в labels.ts живут слова предметной области — виды, статусы, жанры.

import { ref } from 'vue'

import { saveSetting, settings, type AppearanceName } from '@/core/settings'

export interface AppearanceOption {
  name: AppearanceName
  title: string
  /** Знак для кнопки переключателя: лишнего текста в шапке быть не должно. */
  mark: string
}

/** Порядок такой же, как в переключателе: светлее → темнее. */
export const APPEARANCES: ReadonlyArray<AppearanceOption> = [
  { name: 'light', title: 'Светлая тема', mark: '☀' },
  { name: 'dark', title: 'Тёмная тема', mark: '◐' },
  { name: 'amoled', title: 'Тема AMOLED', mark: '●' },
]

/**
 * Выбранная тема для разметки: настройки ядра — обычный объект,
 * и подсветка активной кнопки без ссылки на реактивное значение не перерисовалась бы.
 */
export const appearance = ref<AppearanceName>(settings.appearance)

function applyAppearance(name: AppearanceName): void {
  document.documentElement.dataset.amSkin = name
}

/** Поднять тему из настроек. Зовётся из start() до монтирования окна. */
export function startAppearance(): void {
  appearance.value = settings.appearance
  applyAppearance(settings.appearance)
}

/**
 * Сменить тему. Атрибут меняется сразу, а запись идёт своим ходом:
 * ожидание хранилища перед перекраской читалось бы как подвисание кнопки.
 */
export function setAppearance(name: AppearanceName): void {
  if (appearance.value === name) return

  appearance.value = name
  applyAppearance(name)
  void saveSetting('appearance', 'am_appearance', name)
}
