<script setup lang="ts">
// Пункт 3.10: экран студии — её работы сеткой постеров внутри приложения.
// Плитка и её сборка общие с поиском (tile-row.ts): вид тайтла везде один.
import { computed, onMounted, ref, watch } from 'vue'

import { fetchStudioWorks, type MediaBrief } from '@/api/anilist-media'
import { hiddenCount, keepAllowed } from '@/core/adult'
import { initCollection } from '@/core/collection'
import { rememberBrief } from '@/core/media-looks'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import { Logger } from '@/utils/logger'

import MediaTile from '../components/MediaTile.vue'
import { currentRoute, navigate } from '../router'
import { toTileRow, type TileRow } from '../tile-row'

/** Сколько плиток-заглушек показать, пока идёт первый ответ. */
const HOLD_COUNT = 12

/** По скольку тайтлов просить русские названия за заход. */
const TITLE_CHUNK = 20

const name = ref('')
const rows = ref<TileRow[]>([])
const busy = ref(false)
const trouble = ref('')
const hasNext = ref(false)
const page = ref(1)

/** Скрытое отбором 18+ число говорится вслух, а не тихо теряется. */
const hidden = ref(0)

/** Первая буква имени для монограммы: логотипов у большинства студий нет. */
const mono = computed<string>(() => name.value.trim().slice(0, 1).toUpperCase())

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
async function fillTitles(targetIds: readonly number[]): Promise<void> {
  const mine = ++titleRun
  const ids = targetIds.filter((id) => peekRussianName(id) === null)
  if (ids.length === 0) return

  try {
    for (let from = 0; from < ids.length; from += TITLE_CHUNK) {
      if (mine !== titleRun) return

      // Сетке нужно только имя: описание и оценки спросит открытая карточка.
      await prefetchRussianNames(ids.slice(from, from + TITLE_CHUNK))
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
    hidden.value = 0
  }

  if (id === 0) {
    busy.value = false
    return
  }

  busy.value = true
  trouble.value = ''

  const wanted = add ? page.value + 1 : 1
  const known = add ? briefs : []

  try {
    const found = await fetchStudioWorks(id, wanted, known)
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
    hasNext.value = found.hasNext && found.known > 0
    name.value = found.name
    redraw()
    await fillTitles([...new Set(found.items.map((item) => item.mediaId))])
  } catch (e) {
    if (mine !== run) return
    trouble.value = describe(e)
  } finally {
    if (mine === run) busy.value = false
  }
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
      <header v-if="name" class="am-studio">
        <span class="am-studio__mono" aria-hidden="true">{{ mono }}</span>

        <div class="am-studio__text">
          <h2 class="am-studio__name">{{ name }}</h2>
          <p v-if="hidden > 0" class="am-meta">Скрыто с меткой 18+: {{ hidden }}</p>
        </div>
      </header>

      <p v-else-if="hidden > 0" class="am-meta">Скрыто с меткой 18+: {{ hidden }}</p>

      <p v-if="trouble" class="am-error">{{ trouble }}</p>

      <ul v-if="busy && rows.length === 0" class="am-grid am-studio-grid">
        <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
          <span class="am-skeleton am-hold__art" />
          <span class="am-skeleton am-hold__line" />
        </li>
      </ul>

      <div v-else-if="rows.length === 0 && !busy && trouble === ''" class="am-empty">
        <span class="am-empty__mark" aria-hidden="true">⊘</span>
        <span>У студии пока ничего не числится.</span>
      </div>

      <ul v-else class="am-grid am-studio-grid">
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
/* Шапка студии: имя с монограммой вместо голого заголовка в ряду. */
.am-studio {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 14px 18px;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-leaf);
  box-shadow: inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur)) saturate(1.4);
}

/* Монограмма формы капли: окружность рядом с круглыми аватарами
   людей читалась бы как ещё один человек. */
.am-studio__mono {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 52px;
  height: 52px;
  font-size: 22px;
  font-weight: 700;
  color: var(--am-text);
  background: linear-gradient(
    140deg,
    rgb(var(--am-accent-rgb) / 0.34),
    rgb(var(--am-accent-2-rgb) / 0.22)
  );
  border: 1px solid rgb(var(--am-accent-rgb) / 0.28);
  border-radius: var(--am-r-drop);
}

.am-studio__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.am-studio__name {
  margin: 0;
  font-size: clamp(18px, 1.9vw, 25px);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.am-studio-grid {
  grid-template-columns: repeat(auto-fit, minmax(var(--am-tile), 1fr));
}

/* Заглушка — элемент сетки, а общий .am-hold в слое тем сам сетка. */
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
