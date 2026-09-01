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
  /**
   * Подсказка под наведением: одним словом названия не объяснить, чем темы
   * отличаются. Поле обязательное: у необязательного разметка получала бы
   * `string | undefined`, и у новой темы подсказка молча пропадала бы.
   */
  hint: string
}

export const APPEARANCES: ReadonlyArray<AppearanceOption> = [
  { name: 'dark', title: 'Тёмная', mark: '◐', hint: 'Тёмная: обычный вид приложения' },
  { name: 'light', title: 'Светлая', mark: '☀', hint: 'Светлая: для дневного света' },
  { name: 'amoled', title: 'AMOLED', mark: '⬤', hint: 'AMOLED: чёрный фон, экономит заряд' },
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
