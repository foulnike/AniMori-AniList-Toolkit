// Отбор списка живёт вне показа экрана: возврат с карточки
// собирает экран заново и сбрасывал закладку, порядок и слово поиска.
import { ref } from 'vue'

/** Порядки показа списка. */
export type SortName = 'updated' | 'score' | 'rating' | 'nameUp' | 'nameDown'

/**
 * Вид показа: большие постеры, компактные строки, строки с миниатюрой.
 * Лежит рядом с закладкой и порядком, а не в настройках: это выбор
 * на сейчас, который меняют по ходу чтения списка.
 */
export type ViewName = 'tiles' | 'slim' | 'wide'

export const keptStatus = ref<string>('CURRENT')

export const keptSort = ref<SortName>('updated')

export const keptView = ref<ViewName>('tiles')

export const keptWord = ref('')
