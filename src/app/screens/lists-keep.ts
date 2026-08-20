// Отбор списка живёт вне показа экрана: возврат с карточки
// собирает экран заново и сбрасывал закладку, порядок и слово поиска.
import { ref } from 'vue'

/** Порядки показа списка. */
export type SortName = 'updated' | 'score' | 'rating' | 'nameUp' | 'nameDown'

export const keptStatus = ref<string>('CURRENT')

export const keptSort = ref<SortName>('updated')

export const keptWord = ref('')
