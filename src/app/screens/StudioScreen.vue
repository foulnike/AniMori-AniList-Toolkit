<script setup lang="ts">
// Пункт 3.10: экран студии — её работы сеткой постеров внутри приложения.
// Плитка и её сборка общие с поиском (tile-row.ts): вид тайтла везде один.
import { computed, onMounted, ref, watch } from 'vue'

import { fetchStudioWorks, STUDIO_PAGE_SIZE, type MediaBrief } from '@/api/anilist-media'
import { hiddenCount, keepAllowed } from '@/core/adult'
import { initCollection } from '@/core/collection'
import { rememberBrief } from '@/core/media-looks'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import { studioLogos } from '@/core/studio-logos'
import { Logger } from '@/utils/logger'

import MediaTile from '../components/MediaTile.vue'
import { currentRoute, navigate } from '../router'
import { toTileRow, type TileRow } from '../tile-row'

/** Сколько плиток-заглушек показать, пока идёт первый ответ: два ряда
    широкого окна, чтобы ожидание не выглядело короче выдачи. */
const HOLD_COUNT = 18

/** По скольку тайтлов просить русские названия за заход. */
const TITLE_CHUNK = 20

/** Сколько видимых постеров обязан дать один заход: три полных ряда. */
const WANT = STUDIO_PAGE_SIZE

/**
 * Сколько страниц позволено спросить за один заход. Обычно хватает одной,
 * но у студии с полусотней взрослых работ норма иначе не собирается вовсе,
 * а бесконечный цикл на медленном источнике хуже неполного ряда.
 */
const PAGE_TRIES = 4

const name = ref('')
const rows = ref<TileRow[]>([])
const busy = ref(false)
const trouble = ref('')
const hasNext = ref(false)

/** Скрытое отбором 18+ число говорится вслух, а не тихо теряется. */
const hidden = ref(0)

/** Литография студии или `null`. Промах штатен: шапка останется текстом. */
const logo = ref<string | null>(null)

/**
 * Всё добытое и принятое в показ, до отбора 18+. По нему считается скрытое
 * и дедупликация: показать отобранное мало, иначе взрослая работа приедет
 * второй раз следующей страницей.
 */
let raw: MediaBrief[] = []

/** Выписки, которые видно: по ним и рисуются плитки. */
let briefs: readonly MediaBrief[] = []

/**
 * Добытое сверх нормы. Страница источника даёт двадцать семь работ целиком,
 * и когда норма собралась раньше её конца, хвост ждёт следующего нажатия
 * здесь, а не выбрасывается: заплаченный запрос обиднее лишней памяти.
 */
let spare: MediaBrief[] = []

/** Последняя спрошенная страница источника. */
let lastPage = 0

/** Есть ли у источника страницы дальше. Остаток спрашивать не надо. */
let sourceMore = true

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

/** Сколько работ из набора видно после отбора 18+. */
function shownCount(pool: readonly MediaBrief[]): number {
  return keepAllowed(pool, (brief) => brief.isAdult).length
}

/**
 * Делит добытое на порцию показа и остаток. Считаются только видимые работы:
 * норма захода — про постеры в сетке, а не про строки ответа сервера.
 * Взрослые работы едут вместе со своим куском страницы, чтобы счёт скрытого
 * совпадал с тем, что показано.
 */
function splitBatch(pool: readonly MediaBrief[]): { take: MediaBrief[]; rest: MediaBrief[] } {
  const take: MediaBrief[] = []
  const rest: MediaBrief[] = []
  let shown = 0

  for (const brief of pool) {
    const visible = keepAllowed([brief], (item) => item.isAdult).length === 1

    if (rest.length > 0 || (visible && shown >= WANT)) {
      rest.push(brief)
      continue
    }

    take.push(brief)
    if (visible) shown++
  }

  return { take, rest }
}

/**
 * Ищет литографию студии по имени. Список берётся у Шикимори раз за сеанс
 * и ложится на склад, так что второй визит сети не тревожит. Промах по имени —
 * штатный исход: у многих студий картинки нет вовсе.
 */
async function fillLogo(mine: number, studioName: string): Promise<void> {
  const map = await studioLogos()
  if (mine !== run || map === null) return

  logo.value = map.get(studioName.trim().toLowerCase()) ?? null
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
 * Спрашивает работы студии. С `add` добирает норму к уже показанному, без него
 * начинает с первой страницы. Устаревшие ответы отброшены.
 *
 * Заход не равен странице источника: он равен норме показа. Пока видимых
 * работ меньше нормы и у источника есть чем ответить, страницы добираются
 * подряд, а лишнее из последней остаётся в остатке.
 */
async function load(add = false): Promise<void> {
  const mine = ++run
  const id = studioId.value

  if (!add) {
    raw = []
    briefs = []
    spare = []
    lastPage = 0
    sourceMore = true
    rows.value = []
    name.value = ''
    logo.value = null
    hidden.value = 0
    hasNext.value = false
  }

  if (id === 0) {
    busy.value = false
    return
  }

  busy.value = true
  trouble.value = ''

  // Заход начинается с прошлого остатка: он уже добыт и оплачен.
  const pool: MediaBrief[] = [...spare]
  spare = []

  let tries = 0
  let failed = false

  try {
    while (shownCount(pool) < WANT && sourceMore && tries < PAGE_TRIES) {
      // Известным считается и показанное, и добранное в этом заходе: иначе
      // дедупликация источника пропустит повтор внутри одного нажатия.
      const found = await fetchStudioWorks(id, lastPage + 1, [...raw, ...pool])
      if (mine !== run) return

      tries++

      if (found === null) {
        failed = true
        break
      }

      lastPage++
      name.value = found.name
      sourceMore = found.hasNext
      pool.push(...found.items)

      if (!add && tries === 1) void fillLogo(mine, found.name)
    }

    if (failed && pool.length === 0) {
      trouble.value = 'Каталог не ответил. Попробуйте ещё раз через минуту.'
      return
    }

    // Обложки уже в ответе: кладём их в общую память даром для списков и главной.
    for (const brief of pool) rememberBrief(brief)

    const { take, rest } = splitBatch(pool)
    spare = rest
    raw = [...raw, ...take]

    hidden.value = hiddenCount(raw, (brief) => brief.isAdult)
    briefs = keepAllowed(raw, (brief) => brief.isAdult)
    hasNext.value = sourceMore || spare.length > 0
    redraw()
    await fillTitles([...new Set(take.map((item) => item.mediaId))])
  } catch (e) {
    if (mine !== run) return
    trouble.value = describe(e)
  } finally {
    if (mine === run) busy.value = false
  }
}

/** Добор следующей порции. */
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
        <!-- Литография только когда она есть: буква в квадрате на её месте
             ничего не сообщала и только шумела рядом с названием. -->
        <img
          v-if="logo"
          class="am-studio__logo"
          :src="logo"
          :alt="name"
          loading="lazy"
          decoding="async"
          @error="logo = null"
        />

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
/* Шапка студии: имя и литография, если она есть у источника. */
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

/* Литография вписывается целиком: знаки студий бывают и квадратными,
   и вытянутыми в строку, а обрезка съедала бы слово. Подложка светлая
   во всех трёх темах: у источника знаки лежат на прозрачном фоне тёмной
   заливкой, и на тёмной теме они исчезали бы целиком. */
.am-studio__logo {
  flex: 0 0 auto;
  box-sizing: border-box;
  width: 84px;
  height: 54px;
  padding: 6px 8px;
  object-fit: contain;
  background: color-mix(in srgb, #fff 90%, transparent);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
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
