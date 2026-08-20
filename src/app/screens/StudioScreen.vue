<script setup lang="ts">
// Пункт 3.10: экран студии — её работы сеткой постеров внутри приложения.
// Плитка и её сборка общие с поиском (tile-row.ts): вид тайтла везде один.
import { computed, onMounted, ref, watch } from 'vue'

import { fetchStudioWorks, type MediaBrief } from '@/api/anilist-media'
import { hiddenCount, keepAllowed } from '@/core/adult'
import { initCollection } from '@/core/collection'
import { rememberBrief } from '@/core/media-looks'
import { peekRussianName, prefetchRussianTitles } from '@/core/media-title'
import { Logger } from '@/utils/logger'

import MediaTile from '../components/MediaTile.vue'
import { currentRoute, navigate } from '../router'
import { toTileRow, type TileRow } from '../tile-row'

/** Сколько плиток-заглушек показать, пока идёт первый ответ. */
const HOLD_COUNT = 12

/** По скольку тайтлов просить русские названия за заход. */
const TITLE_CHUNK = 10

/** Скольким верхним строкам добирать названия сетью. */
const TITLE_DEPTH = 20

const name = ref('')
const rows = ref<TileRow[]>([])
const busy = ref(false)
const trouble = ref('')
const total = ref<number | null>(null)
const hasNext = ref(false)
const page = ref(1)

/** Скрытое отбором 18+ число говорится вслух, а не тихо теряется. */
const hidden = ref(0)

/** Выписки этого показа: по ним плитки перерисовываются с названиями. */
let briefs: readonly MediaBrief[] = []

/** Номера идущих работ: ответ на устаревший вопрос в выдачу не попадает. */
let run = 0
let titleRun = 0

const studioId = computed<number>(() => {
  const raw = Number(currentRoute.value.params.id ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
})

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function redraw(): void {
  rows.value = briefs.map(toTileRow)
}

/**
 * Добирает русские названия верхним строкам. У студии в выдаче только
 * аниме, поэтому проход один: разбивать строки по видам больше незачем.
 */
async function fillTitles(): Promise<void> {
  const mine = ++titleRun
  const ids = briefs
    .slice(0, TITLE_DEPTH)
    .filter((brief) => peekRussianName(brief.mediaId) === null)
    .map((brief) => brief.mediaId)

  try {
    for (let from = 0; from < ids.length; from += TITLE_CHUNK) {
      if (mine !== titleRun) return

      await prefetchRussianTitles(ids.slice(from, from + TITLE_CHUNK))
      if (mine !== titleRun) return

      redraw()
    }
  } catch (e) {
    // Без перевода выдача останется на латинице — не повод ругаться на экране.
    Logger('WARN', 'Студия: названия добрать не вышло', e)
  }
}

/**
 * Спрашивает работы студии. С `add` добирает следующую страницу к уже
 * показанному, без него начинает с первой. Устаревшие ответы отброшены.
 */
async function load(add = false): Promise<void> {
  const mine = ++run
  const id = studioId.value

  if (!add) {
    briefs = []
    rows.value = []
    name.value = ''
    total.value = null
    hidden.value = 0
  }

  if (id === 0) {
    busy.value = false
    return
  }

  busy.value = true
  trouble.value = ''

  const wanted = add ? page.value + 1 : 1

  try {
    const found = await fetchStudioWorks(id, wanted)
    if (mine !== run) return

    if (found === null) {
      trouble.value = 'Каталог не ответил. Попробуйте ещё раз через минуту.'
      return
    }

    // Обложки уже в ответе: кладём их в общую память даром для списков и главной.
    for (const brief of found.items) rememberBrief(brief)

    const fresh = add ? [...briefs, ...found.items] : found.items
    hidden.value = hiddenCount(fresh, (brief) => brief.isAdult)
    briefs = keepAllowed(fresh, (brief) => brief.isAdult)
    page.value = wanted
    hasNext.value = found.hasNext
    name.value = found.name
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

/** Добор следующей страницы. */
function onMore(): void {
  void load(true)
}

/** Переход на карточку тайтла. */
function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

onMounted(() => {
  void (async () => {
    // Свои метки на постерах требуют поднятого снимка: без него память пуста.
    try {
      await initCollection()
      redraw()
    } catch (e) {
      Logger('WARN', 'Студия: свой список поднять не вышло', e)
    }
  })()

  void load()
})

// Переход между двумя студиями не пересобирает экран: грузим сами.
watch(studioId, () => {
  void load()
})
</script>

<template>
  <section class="am-page">
    <div v-if="studioId === 0" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⊘</span>
      <span>Студия не выбрана: в адресе нет номера.</span>
    </div>

    <template v-else>
      <div v-if="name" class="am-bar">
        <h2 class="am-h2">{{ name }}</h2>
        <span class="am-bar__gap" />
        <span v-if="total !== null" class="am-meta">Работ: {{ total }}</span>
      </div>

      <p v-if="hidden > 0" class="am-meta">Скрыто с меткой 18+: {{ hidden }}</p>

      <p v-if="trouble" class="am-error">{{ trouble }}</p>

      <ul v-if="busy && rows.length === 0" class="am-grid">
        <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
          <span class="am-skeleton am-hold__art" />
          <span class="am-skeleton am-hold__line" />
        </li>
      </ul>

      <div v-else-if="rows.length === 0 && !busy && trouble === ''" class="am-empty">
        <span class="am-empty__mark" aria-hidden="true">⊘</span>
        <span>У студии пока ничего не числится.</span>
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
    </template>
  </section>
</template>

<style scoped>
.am-more {
  display: flex;
  justify-content: center;
  padding: 6px 0 10px;
}
</style>
