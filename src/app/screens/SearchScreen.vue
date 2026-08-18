<script setup lang="ts">
// Пункт 3.5: поиск по чужому каталогу. Поиск по своему списку живёт
// во вкладке списков: там он идёт по памяти и сети не требует вовсе.
// Куда идти за русским словом, решает core/media-search: экран только показывает.
import { computed, onMounted, ref } from 'vue'

import type { MediaBrief } from '@/api/anilist-media'
import { getEntry, initCollection } from '@/core/collection'
import { rememberBrief } from '@/core/media-looks'
import { searchCatalog } from '@/core/media-search'
import { peekRussianName, prefetchRussianTitles } from '@/core/media-title'
import type { MediaType } from '@/core/types'
import { Logger } from '@/utils/logger'

import MediaTile from '../components/MediaTile.vue'
import { formatWord, partsShort, statusWord } from '../labels'
import { navigate } from '../router'

/** Пауза после последнего нажатия: каждая буква в сеть — сожжённый темп. */
const TYPING_PAUSE_MS = 300

/** По скольку тайтлов просить русские названия за заход. */
const TITLE_CHUNK = 10

/**
 * Скольким верхним строкам добирать названия сетью. Ниже человек почти не смотрит,
 * а каждая строка стоит отдельного похода к источнику через очередь темпа.
 */
const TITLE_DEPTH = 20

/** Сколько плиток-заглушек показать, пока идёт первый ответ. */
const HOLD_COUNT = 12

/** Подвкладки вида: тип решает и запрос, и раздел русского источника. */
const KIND_TABS: ReadonlyArray<{ key: MediaType; title: string }> = [
  { key: 'ANIME', title: 'Аниме' },
  { key: 'MANGA', title: 'Манга' },
]

/** Плитка выдачи. Всё готовится заранее: разметка ничего не считает. */
interface Row {
  mediaId: number
  title: string
  facts: string
  cover: string | null
  color: string | null
  score: string | null
  mark: string | null
  own: string | null
  repeat: number
  note: string | null
  done: number
  adult: boolean
}

const word = ref('')
const kind = ref<MediaType>('ANIME')
const rows = ref<Row[]>([])
const busy = ref(false)
const trouble = ref('')
const total = ref<number | null>(null)
const hasNext = ref(false)
const page = ref(1)

const asked = computed(() => word.value.trim())

/** Номера идущих работ: ответ на устаревший вопрос в выдачу не попадает. */
let run = 0
let titleRun = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** Найденные выписки этого показа: по ним плитки перерисовываются с названиями. */
let briefs: MediaBrief[] = []

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Оценка сервера для угла постера: у AniList она в сотнях. */
function scoreText(brief: MediaBrief): string | null {
  return brief.averageScore === null ? null : `${brief.averageScore}%`
}

/** Сколько всего частей у тайтла: у аниме серии, у манги главы. */
function partsCount(brief: MediaBrief): number | null {
  return brief.type === 'MANGA' ? brief.chapters : brief.episodes
}

/** Короткая подпись под названием: вид и год. Счёт частей ушёл на постер. */
function briefFacts(brief: MediaBrief): string {
  const parts: string[] = []

  const kindWord = formatWord(brief.format)
  if (kindWord !== null) parts.push(kindWord)
  if (brief.seasonYear !== null) parts.push(String(brief.seasonYear))

  return parts.join(' · ')
}

/**
 * Своя закладка: сначала местный список, и только потом ответ сервера.
 * Без входа ownEntry пуст всегда, а свой список у нас есть и так (пункт 3.14).
 */
function markText(brief: MediaBrief): string | null {
  const mine = getEntry(brief.mediaId)
  if (mine) return statusWord(brief.type, mine.status)

  return statusWord(brief.type, brief.ownEntry?.status ?? null)
}

/** Свой счёт частей по той же лестнице: память, ответ сервера, ноль. */
function ownSeen(brief: MediaBrief): number {
  const mine = getEntry(brief.mediaId)
  if (mine) return mine.progress

  return brief.ownEntry?.progress ?? 0
}

/** Строка счёта на постере: свой прогресс, а без него — размер тайтла. */
function ownText(brief: MediaBrief): string | null {
  const parts = partsCount(brief)
  const seen = ownSeen(brief)
  const short = partsShort(brief.type)

  if (seen > 0) return parts === null ? `${seen} ${short}` : `${seen} / ${parts} ${short}`
  return parts === null ? null : `${parts} ${short}`
}

/** Доля пройденного для полосы под постером. */
function donePart(brief: MediaBrief): number {
  const mine = getEntry(brief.mediaId)
  const status = mine ? mine.status : brief.ownEntry?.status ?? null
  if (status === 'COMPLETED') return 1

  const parts = partsCount(brief)
  const seen = ownSeen(brief)
  if (parts === null || parts <= 0 || seen <= 0) return 0

  return Math.min(1, seen / parts)
}

/** Название для плитки: русское, латиница, английское, номер. */
function pickTitle(brief: MediaBrief): string {
  return (
    peekRussianName(brief.mediaId) ?? brief.romaji ?? brief.english ?? `Тайтл #${brief.mediaId}`
  )
}

/** Выписка сервера в плитку показа. */
function toRow(brief: MediaBrief): Row {
  // Повторы и комментарий бывают только своими: у ответа каталога их нет.
  const mine = getEntry(brief.mediaId)

  return {
    mediaId: brief.mediaId,
    title: pickTitle(brief),
    facts: briefFacts(brief),
    cover: brief.cover,
    color: brief.color,
    score: scoreText(brief),
    mark: markText(brief),
    own: ownText(brief),
    repeat: mine?.repeat ?? 0,
    note: mine?.notes ?? null,
    done: donePart(brief),
    adult: brief.isAdult,
  }
}

function redraw(): void {
  rows.value = briefs.map(toRow)
}

/**
 * Добирает русские названия тем строкам, где их ещё нет. Русский путь сюда
 * почти не заходит: имена пришли вместе с находками.
 */
async function fillTitles(): Promise<void> {
  const mine = ++titleRun
  const type = kind.value
  const wanted = briefs
    .slice(0, TITLE_DEPTH)
    .filter((brief) => peekRussianName(brief.mediaId) === null)
    .map((brief) => brief.mediaId)

  if (wanted.length === 0) return

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      if (mine !== titleRun) return

      await prefetchRussianTitles(wanted.slice(from, from + TITLE_CHUNK), type)
      if (mine !== titleRun) return

      redraw()
    }
  } catch (e) {
    // Без перевода выдача останется на латинице — это не повод ругаться на экране.
    Logger('WARN', 'Поиск: названия добрать не вышло', e)
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

  const wanted = add ? page.value + 1 : 1

  try {
    const found = await searchCatalog(wordNow, kind.value, wanted)
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
}

/** Набор слова: запрос уходит после паузы, а не на каждую букву. */
function onType(): void {
  if (timer !== null) clearTimeout(timer)

  timer = setTimeout(() => {
    timer = null
    void search()
  }, TYPING_PAUSE_MS)
}

/** Смена вида: спрашиваем то же слово заново, теперь в другом разделе. */
function pickKind(next: MediaType): void {
  if (kind.value === next) return

  kind.value = next
  void search()
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
</script>

<template>
  <section class="am-page">
    <div class="am-bar">
      <div class="am-seg">
        <button
          v-for="tab in KIND_TABS"
          :key="tab.key"
          class="am-seg__btn"
          :class="{ 'am-seg__btn--on': tab.key === kind }"
          type="button"
          @click="pickKind(tab.key)"
        >
          {{ tab.title }}
        </button>
      </div>

      <span class="am-bar__gap" />

      <label class="am-search am-search--wide">
        <span class="am-search__mark" aria-hidden="true">⌕</span>
        <input
          v-model="word"
          class="am-input"
          type="search"
          placeholder="Название на любом языке"
          @input="onType"
        />
      </label>
    </div>

    <p v-if="total !== null" class="am-meta">Найдено {{ total }}</p>

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
      <span>Попробуйте другое слово или другой вид.</span>
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
.am-search--wide {
  min-width: 320px;
}

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
