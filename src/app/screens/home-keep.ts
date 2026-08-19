// Отбор главной живёт вне показа экрана: возврат с карточки
// собирает экран заново и сбрасывал вкладку обратно на аниме.
import { ref } from 'vue'

import type { MediaType } from '@/core/types'

export const homeKind = ref<MediaType>('ANIME')

/** Выбранный жанр витрины. Пустая строка — весь каталог. */
export const homeGenre = ref('')
