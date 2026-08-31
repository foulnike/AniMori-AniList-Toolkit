// Выбор темы оформления: тёмная, светлая, AMOLED.
//
// Тема живёт атрибутом data-am-skin на корне документа, а не классом
// на компоненте: фон окна, скроллбары и выделение текста задаются
// выше любого экрана, и при классе на корне приложения они остались бы
// тёмными на светлой теме.
//
// Подписи тем лежат здесь, а не в labels.ts: там слова предметной области
// — виды, статусы, жанры. Прецедент соседства подписей с выбором уже есть:
// SCREEN_TITLES живёт в router/routes.ts.
import { ref } from 'vue'

import { type AppearanceName, saveSetting, settings } from '@/core/settings'

interface AppearanceOption {
  name: AppearanceName
  title: string
  /** Знак для переключателя в шапке: три слова там шумели бы громче заголовка. */
  mark: string
}

export const APPEARANCES: ReadonlyArray<AppearanceOption> = [
  { name: 'dark', title: 'Тёмная', mark: '◐' },
  { name: 'light', title: 'Светлая', mark: '☀' },
  { name: 'amoled', title: 'AMOLED', mark: '⬤' },
]

/** Тема для разметки: читается переключателем и экраном настроек. */
export const appearance = ref<AppearanceName>(settings.appearance)

function applyAppearance(name: AppearanceName): void {
  document.documentElement.dataset.amSkin = name
}

/**
 * Ставит сохранённую тему на документ. Зовётся из main.ts сразу после
 * чтения настроек и до первой отрисовки: смена фона на глазах
 * читается поломкой.
 */
export function startAppearance(): void {
  appearance.value = settings.appearance
  applyAppearance(settings.appearance)
}

/**
 * Меняет тему и запоминает выбор. Разметка перекрашивается сразу,
 * запись в хранилище её не ждёт: тема меняется по свету в комнате,
 * и ждать диск ради этого нечего.
 */
export function setAppearance(name: AppearanceName): void {
  appearance.value = name
  applyAppearance(name)
  void saveSetting('appearance', 'am_appearance', name)
}
