<script setup lang="ts">
// Пункт 3.5: поиск по чужому каталогу. Поиск по своему списку живёт
// во вкладке списков: там он идёт по памяти и сети не требует вовсе.
// Куда идти за русским словом, решает core/media-search: экран только показывает.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type { MediaBrief } from '@/api/anilist-media'
import { setupVideoSources } from '@/api/video-sources'
import { initCollection } from '@/core/collection'
import { rememberBrief } from '@/core/media-looks'
import { searchCatalog } from '@/core/media-search'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import { peekPlayable, primePlayable, warmPlayable } from '@/core/playable'
import { Logger } from '@/utils/logger'

import MediaTile from '../components/MediaTile.vue'
import { navigate } from '../router'
import { toPlayAsk, toTileRow, type TileRow } from '../tile-row'

/** Пауза после последнего нажатия: каждая буква в сеть — сожжённый темп. */
const TYPING_PAUSE_MS = 300

/** По скольку тайтлов просить русские названия за заход. */
const TITLE_CHUNK = 10

/**
 * Скольким верхним строкам добирать названия сетью. Ниже человек почти не смотрит,
 * а каждая строка стоит отдельного похода к источнику через очередь темпа.
 */
const TITLE_DEPTH = 20

/**
 * Скольким верхним строкам добирать метку доступности сетью. Склад поднимается
 * для всей выдачи даром, а в сеть идёт только верх: строка стоит вопроса
 * к каждому источнику, и полная страница выдачи съела бы очередь темпа.
 */
const PLAY_DEPTH = 10

/** Сколько плиток-заглушек показать, пока идёт первый ответ. */
const HOLD_COUNT = 12

const word = ref('')
const rows = ref<TileRow[]>([])
const busy = ref(false)
const trouble = ref('')
const total = ref<number | null>(null)
const hasNext = ref(false)
const page = ref(1)

const asked = computed(() => word.value.trim())

/** Номера идущих работ: ответ на устаревший вопрос в выдачу не попадает. */
let run = 0
let titleRun = 0
let playRun = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** Найденные выписки этого показа: по ним плитки перерисовываются с названиями. */
let briefs: MediaBrief[] = []

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function redraw(): void {
  rows.value = briefs.map(toTileRow)
}

/**
 * Добирает русские названия тем строкам, где их ещё нет. Русский путь сюда
 * почти не заходит: имена пришли вместе с находками.
 */
async function fillTitles(): Promise<void> {
  const mine = ++titleRun
  const wanted = briefs
    .slice(0, TITLE_DEPTH)
    .filter((brief) => peekRussianName(brief.mediaId) === null)
    .map((brief) => brief.mediaId)

  if (wanted.length === 0) return

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      if (mine !== titleRun) return

      // Выдаче нужно только имя: описание и оценки спросит открытая карточка.
      await prefetchRussianNames(wanted.slice(from, from + TITLE_CHUNK))
      if (mine !== titleRun) return

      redraw()
    }
  } catch (e) {
    // Без перевода выдача останется на латинице — это не повод ругаться на экране.
    Logger('WARN', 'Поиск: названия добрать не вышло', e)
  }
}

/**
 * Добирает метки доступности. Сначала склад — он отвечает даром и разом по всей
 * выдаче, — и только потом сеть, и то верхним строкам. Метка нужна здесь больше
 * всего: половину каталога наши источники не показывают, и без неё человек
 * узнаёт об этом только внутри плеера.
 */
async function fillPlay(): Promise<void> {
  const mine = ++playRun
  if (briefs.length === 0) return

  try {
    const primed = await primePlayable(briefs.map((brief) => brief.mediaId))
    if (mine !== playRun) return
    if (primed > 0) redraw()

    const wanted = briefs
      .filter((brief) => peekPlayable(brief.mediaId) === null)
      .slice(0, PLAY_DEPTH)
      .map((brief) => toPlayAsk(brief))

    if (wanted.length === 0) return

    // Реестр источников собирает экран: ядро своих поставщиков не зовёт.
    setupVideoSources()

    await warmPlayable(wanted)
    if (mine !== playRun) return

    redraw()
  } catch (e) {
    // Без метки выдача живая: плитка про доступность просто молчит.
    Logger('WARN', 'Поиск: метки доступности не доехали', e)
  }
}

/**
 * Спрашивает каталог. С `add` добирает следующую страницу к уже показанному,
 * без него начинает с первой. Устаревшие ответы отбрасываются по номеру работы.
 */
async function search(add = false): Promise<void> {
  const mine = ++run
  const wordNow = asked.value

  if (wordNow === '') {
    briefs = []
    rows.value = []
    total.value = null
    hasNext.value = false
    trouble.value = ''
    return
  }

  busy.value = true
  trouble.value = ''

  if (!add) {
    briefs = []
    rows.value = []
    page.value = 1
    hasNext.value = false
    total.value = null
  }

  const wanted = add ? page.value + 1 : 1

  try {
    const found = await searchCatalog(wordNow, wanted)
    if (mine !== run) return

    if (found === null) {
      trouble.value = 'Каталог не ответил. Попробуйте ещё раз через минуту.'
      return
    }

    // Обложки уже в ответе: кладём их в общую память даром для списков и главной.
    for (const brief of found.items) rememberBrief(brief)

    briefs = add ? [...briefs, ...found.items] : found.items
    page.value = wanted
    hasNext.value = found.hasNext
    total.value = found.total
    redraw()
  } catch (e) {
    if (mine !== run) return
    trouble.value = describe(e)
  } finally {
    if (mine === run) busy.value = false
  }

  void fillTitles()
  void fillPlay()
}

/** Набор слова: запрос уходит после паузы, а не на каждую букву. */
function onType(): void {
  if (timer !== null) clearTimeout(timer)

  timer = setTimeout(() => {
    timer = null
    void search()
  }, TYPING_PAUSE_MS)
}

/** Добор следующей страницы. */
function onMore(): void {
  void search(true)
}

/** Переход на карточку найденного тайтла. */
function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

onMounted(() => {
  void (async () => {
    // Поиск бывает первым экраном запуска: без подъёма снимка память пуста,
    // и своих меток на постерах не будет даже при полном списке на диске.
    try {
      await initCollection()
      redraw()
    } catch (e) {
      Logger('WARN', 'Поиск: свой список поднять не вышло', e)
    }
  })()
})

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
  timer = null
  run++
  titleRun++
  playRun++
})
</script>

<template>
  <section class="am-page">
    <label class="am-hunt">
      <span class="am-hunt__mark" aria-hidden="true">⌕</span>
      <input
        v-model="word"
        class="am-hunt__field"
        type="search"
        placeholder="Название на любом языке"
        @input="onType"
      />
      <span v-if="total !== null" v-tip="'Найдено в каталоге'" class="am-hunt__num">
        {{ total }}
      </span>
    </label>

    <p v-if="trouble" class="am-error">{{ trouble }}</p>

    <ul v-if="busy && rows.length === 0" class="am-grid">
      <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
        <span class="am-skeleton am-hold__art" />
        <span class="am-skeleton am-hold__line" />
      </li>
    </ul>

    <div v-else-if="asked === ''" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⌕</span>
      <span>Начните вводить название.</span>
      <span>Можно по-русски, по-английски или на латинице.</span>
    </div>

    <div v-else-if="rows.length === 0 && !busy" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⊘</span>
      <span>Ничего не нашлось.</span>
      <span>Попробуйте другое слово.</span>
    </div>

    <ul v-else class="am-grid">
      <MediaTile
        v-for="row in rows"
        :key="row.mediaId"
        :title="row.title"
        :facts="row.facts"
        :cover="row.cover"
        :color="row.color"
        :score="row.score"
        :mark="row.mark"
        :own="row.own"
        :repeat="row.repeat"
        :note="row.note"
        :done="row.done"
        :soon="row.soon"
        :play="row.play"
        :adult="row.adult"
        @open="open(row.mediaId)"
      />
    </ul>

    <div v-if="hasNext" class="am-more">
      <button class="am-btn am-btn--soft" type="button" :disabled="busy" @click="onMore">
        {{ busy ? 'Грузим…' : 'Показать ещё' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
/* Поле поиска — главный предмет экрана, а не одна из контролок в ряду.
   Обёртка — label: клик по капсуле целиком ставит курсор в поле. */
.am-hunt {
  display: flex;
  gap: 12px;
  align-items: center;
  min-height: clamp(48px, 5vw, 60px);
  padding: 0 clamp(16px, 1.6vw, 24px);
  cursor: text;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  box-shadow: inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur)) saturate(1.4);
  transition:
    border-color var(--am-mid) var(--am-ease),
    box-shadow var(--am-mid) var(--am-ease);
}

/* Свечение вместо обводки поверх капсулы: два кольца одно в другом
   выглядели браком рисования. */
.am-hunt:focus-within {
  border-color: rgb(var(--am-accent-rgb) / 0.6);
  box-shadow:
    inset 0 1px 0 var(--am-edge),
    var(--am-sh-glow);
}

.am-hunt__mark {
  font-size: 18px;
  color: var(--am-faint);
  transition: color var(--am-mid) var(--am-ease);
}

.am-hunt:focus-within .am-hunt__mark {
  color: var(--am-accent);
}

/* Своё поле без рамки и фона: рамка живёт на капсуле выше. */
.am-hunt__field {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  font-size: clamp(14px, 1.1vw, 16px);
  color: var(--am-text);
  background: none;
  border: 0;
}

.am-hunt__field::placeholder {
  color: var(--am-faint);
}

.am-hunt__field:focus {
  outline: none;
}

/* Крестик очистки у type=search рисуется темным квадратом на светлой теме:
   приводим его к цвету текста. */
.am-hunt__field::-webkit-search-cancel-button {
  cursor: pointer;
  filter: grayscale(1) opacity(0.6);
}

/* Счётчик внутри поля: отдельная строка ради одного числа сдвигала
   всю выдачу вниз. */
.am-hunt__num {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--am-dim);
  background: var(--am-fill-2);
  border-radius: var(--am-r-cap);
  font-variant-numeric: tabular-nums;
}

/* Заглушка — элемент сетки, а общий .am-hold в слое тем сам сетка:
   внутри .am-grid его надо вернуть в колонку. */
.am-hold {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.am-hold__art {
  display: block;
  aspect-ratio: 2 / 3;
}

.am-hold__line {
  display: block;
  width: 72%;
  height: 12px;
  border-radius: var(--am-r-s);
}

.am-more {
  display: flex;
  justify-content: center;
  padding: 6px 0 10px;
}
</style>
