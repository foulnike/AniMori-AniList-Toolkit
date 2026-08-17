// Отбор списков живёт вне показа экрана: возврат с карточки
// собирает экран заново и сбрасывал вид обратно на аниме.
import { ref } from 'vue'

import type { MediaType } from '@/core/types'

/** Порядки показа списка. */
export type SortName = 'updated' | 'score' | 'rating' | 'nameUp' | 'nameDown'

export const keptKind = ref<MediaType>('ANIME')

export const keptStatus = ref<string>('CURRENT')

export const keptSort = ref<SortName>('updated')

export const keptWord = ref('')
