<script setup lang="ts">
// Пункт 3.5: списки одним экраном на оба вида. Данные, обновление и
// снимок у аниме и манги общие, разные только подписи и счёт частей.
// Здесь же поиск по своему списку: искать надо там, где список и лежит.
// Поиск по чужому каталогу живёт на своём экране: там сеть и другие метки.
import { computed, onMounted, ref } from 'vue'

import { initCollection, refreshFromServer } from '@/core/collection'
import { countByStatus, countEntries, selectEntries } from '@/core/collection-view'
import { startEditSender } from '@/core/edit-sender'
import { peekLook, warmLooks, type MediaLook } from '@/core/media-looks'
import { searchOwnList } from '@/core/media-search'
import { peekRussianName, prefetchRussianTitles } from '@/core/media-title'
import type { SnapshotEntry } from '@/core/snapshot'
import type { MediaType } from '@/core/types'
import { Logger } from '@/utils/logger'

import MediaTile from '../components/MediaTile.vue'
import { navigate } from '../router'

/**
 * Сколько записей рисуется за раз. Полный список бывает на тысячи записей,
 * а каждая требует обложки и русского названия.
 */
const PAGE_LIMIT = 100

/** По скольку тайтлов просить названия за заход: источники отвечают по одному. */
const TITLE_CHUNK = 10

/** Сколько найденного показывать. Слово из двух букв иначе вывалит весь список. */
const FOUND_LIMIT = 60

/** Пауза после последнего нажатия. Поиск идёт в памяти, поэтому пауза короткая. */
const TYPING_PAUSE_MS = 250

/** Сколько плиток-заглушек показать на время подъёма списка. */
const HOLD_COUNT = 18

/** Подвкладки вида. Сервер знает только эти два типа записей. */
const KIND_TABS: ReadonlyArray<{ key: MediaType; title: string }> = [
  { key: 'ANIME', title: 'Аниме' },
  { key: 'MANGA', title: 'Манга' },
]

/** Закладки аниме. Порядок как в привычном списке на сайте. */
const ANIME_STATUS: ReadonlyArray<{ key: string; title: string }> = [
  { key: 'CURRENT', title: 'Смотрю' },
  { key: 'REPEATING', title: 'Пересматриваю' },
  { key: 'PLANNING', title: 'В планах' },
  { key: 'COMPLETED', title: 'Просмотрено' },
  { key: 'PAUSED', title: 'Отложено' },
  { key: 'DROPPED', title: 'Брошено' },
]

/** Закладки манги: ключи те же, а подписи обязаны быть про чтение. */
const MANGA_STATUS: ReadonlyArray<{ key: string; title: string }> = [
  { key: 'CURRENT', title: 'Читаю' },
  { key: 'REPEATING', title: 'Перечитываю' },
  { key: 'PLANNING', title: 'В планах' },
  { key: 'COMPLETED', title: 'Прочитано' },
  { key: 'PAUSED', title: 'Отложено' },
  { key: 'DROPPED', title: 'Брошено' },
]

/** Вид тайтла по-русски: сервер зовёт их по-английски и заглавными. */
const FORMAT_WORDS: Readonly<Record<string, string>> = {
  TV: 'ТВ',
  TV_SHORT: 'Короткий ТВ',
  MOVIE: 'Фильм',
  SPECIAL: 'Спешл',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Клип',
  MANGA: 'Манга',
  NOVEL: 'Ранобэ',
  ONE_SHOT: 'Ваншот',
}

/** Строка списка в виде, готовом к отрисовке: разметка ничего не считает. */
interface Row {
  mediaId: number
  title: string
  facts: string
  mark: string | null
  own: string | null
  done: number
  cover: string | null
  color: string | null
  adult: boolean
}

/** Идёт ли работа со списком: подъём снимка или ответ сервера. */
const busy = ref(true)

/** Идёт ли добор названий или обложек. Кнопки списка он держать не должен. */
const titlesBusy = ref(false)
const looksBusy = ref(false)

/** Идёт ли отбор по слову. На кириллице перед отбором поднимается склад. */
const searchBusy = ref(false)

const trouble = ref('')
const kind = ref<MediaType>('ANIME')
const activeStatus = ref<string>('CURRENT')
const word = ref('')
const rows = ref<Row[]>([])
const counts = ref<Map<string, number>>(new Map())
const total = ref(0)

/** Подписи закладок зависят только от вида. */
const statusTabs = computed(() => (kind.value === 'MANGA' ? MANGA_STATUS : ANIME_STATUS))
const searching = computed(() => word.value.trim() !== '')
const shown = computed(() => (searching.value ? total.value : (counts.value.get(activeStatus.value) ?? 0)))

/**
 * Найденные записи последнего поиска. Не реактивные сознательно:
 * по ним перерисовываются плитки, когда добрались обложки и названия.
 */
let foundEntries: SnapshotEntry[] = []

/** Номера идущих работ: старый цикл видит, что его ответ больше не нужен. */
let titleRun = 0
let lookRun = 0
let searchRun = 0

/** Таймер паузы набора. */
let timer: ReturnType<typeof setTimeout> | null = null

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Короткая подпись под названием: вид и год. Больше в две строки не влезает. */
function factsText(look: MediaLook | null): string {
  if (look === null) return ''

  const parts: string[] = []
  if (look.format !== null) parts.push(FORMAT_WORDS[look.format] ?? look.format)
  if (look.seasonYear !== null) parts.push(String(look.seasonYear))
  return parts.join(' · ')
}

/** Свой счёт частей на постере. Неизвестный итог не выдумывается. */
function ownText(entry: SnapshotEntry, parts: number | null): string | null {
  const word = entry.type === 'MANGA' ? 'гл.' : 'эп.'
  if (parts === null) return entry.progress > 0 ? `${entry.progress} ${word}` : null
  return `${entry.progress} / ${parts} ${word}`
}

/** Доля пройденного для полосы. Завершённое залито целиком даже без итога. */
function donePart(entry: SnapshotEntry, parts: number | null): number {
  if (entry.status === 'COMPLETED') return 1
  if (parts === null || parts <= 0 || entry.progress <= 0) return 0
  return Math.min(1, entry.progress / parts)
}

/**
 * Запись памяти в плитку. Название: русское, латиница, английское, номер.
 * Номер остаётся только у записи, созданной правкой до ответа сервера.
 */
function toRow(entry: SnapshotEntry): Row {
  const look = peekLook(entry.mediaId)
  const parts = entry.type === 'MANGA' ? (look?.chapters ?? null) : (look?.episodes ?? null)

  return {
    mediaId: entry.mediaId,
    title:
      peekRussianName(entry.mediaId) ??
      entry.romaji ??
      entry.english ??
      look?.romaji ??
      `Тайтл #${entry.mediaId}`,
    facts: factsText(look),
    mark: entry.score10 > 0 ? `★ ${entry.score10.toFixed(1)}` : null,
    own: ownText(entry, parts),
    done: donePart(entry, parts),
    cover: look?.cover ?? null,
    color: look?.color ?? null,
    adult: entry.isAdult,
  }
}

/**
 * Снимает кусок коллекции в свои плитки. При идущем поиске плитки
 * берутся из находок: закладка тогда не главная, а слово главное.
 */
function redraw(): void {
  counts.value = countByStatus({ type: kind.value })
  total.value = countEntries({ type: kind.value })

  if (searching.value) {
    rows.value = foundEntries.map(toRow)
    return
  }

  const picked = selectEntries(
    { type: kind.value, status: [activeStatus.value] },
    { key: 'updated' },
    { limit: PAGE_LIMIT },
  )

  rows.value = picked.map(toRow)
}

/**
 * Добирает обложки для показанных плиток. Сотня строк стоит двух
 * запросов, а возврат в ту же закладку — ни одного.
 */
async function fillLooks(): Promise<void> {
  const mine = ++lookRun
  const asked = kind.value
  const wanted = rows.value
    .filter((row) => peekLook(row.mediaId) === null)
    .map((row) => row.mediaId)

  if (wanted.length === 0) return

  looksBusy.value = true

  try {
    await warmLooks(wanted, asked)
    if (mine !== lookRun) return

    redraw()
  } catch (e) {
    // Без обложек список живой: на плитке останется первая буква названия.
    Logger('WARN', 'Списки: обложки добрать не вышло', e)
  } finally {
    if (mine === lookRun) looksBusy.value = false
  }
}

/**
 * Добирает русские названия для показанных плиток пачками. Ошибка здесь
 * не стопорит экран: без перевода название останется на латинице.
 */
async function fillTitles(): Promise<void> {
  const mine = ++titleRun
  const asked = kind.value
  const wanted = rows.value
    .filter((row) => peekRussianName(row.mediaId) === null)
    .map((row) => row.mediaId)

  if (wanted.length === 0) return

  titlesBusy.value = true

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      // Закладку или вид успели сменить: остаток пачек этому показу не нужен.
      if (mine !== titleRun) return

      // Тип обязателен: у Шикимори аниме и манга лежат в разных разделах.
      await prefetchRussianTitles(wanted.slice(from, from + TITLE_CHUNK), asked)
      if (mine !== titleRun) return

      redraw()
    }
  } catch (e) {
    Logger('WARN', 'Списки: названия добрать не вышло', e)
  } finally {
    if (mine === titleRun) titlesBusy.value = false
  }
}

/** Отрисовка и два добора вслед. Сами доборы зовут только redraw — круга нет. */
function refill(): void {
  redraw()
  void fillLooks()
  void fillTitles()
}

/**
 * Отбор по слову по всем закладкам выбранного вида. Сети не требует,
 * но на кириллице сначала поднимает склад русских названий.
 */
async function runSearch(): Promise<void> {
  const mine = ++searchRun
  const asked = word.value.trim()

  if (asked === '') {
    foundEntries = []
    refill()
    return
  }

  searchBusy.value = true

  try {
    const found = await searchOwnList(asked, kind.value, FOUND_LIMIT)
    if (mine !== searchRun) return

    foundEntries = found
    refill()
  } catch (e) {
    Logger('WARN', 'Списки: поиск по своему списку не удался', e)
  } finally {
    if (mine === searchRun) searchBusy.value = false
  }
}

/** Набор слова: поиск ждёт короткую паузу, чтобы не бегать на каждую букву. */
function onType(): void {
  if (timer !== null) clearTimeout(timer)

  timer = setTimeout(() => {
    timer = null
    void runSearch()
  }, TYPING_PAUSE_MS)
}

/** Очистка слова: возврат к закладкам без ожидания. */
function onClear(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }

  word.value = ''
  foundEntries = []
  searchRun++
  refill()
}

/** Переключение вида. Сети не требует: в памяти лежат оба вида сразу. */
function pickKind(next: MediaType): void {
  if (kind.value === next) return

  kind.value = next
  activeStatus.value = 'CURRENT'

  if (searching.value) {
    void runSearch()
    return
  }

  refill()
}

/** Переключение закладки статуса. */
function pickStatus(status: string): void {
  if (activeStatus.value === status) return

  activeStatus.value = status
  refill()
}

/** Переход на карточку. Номер идёт строкой: в адресе окна чисел нет. */
function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

/**
 * Забирает список с сервера. Отказ сети показанные данные не стирает.
 * Обновление тянет оба вида сразу: два порядка обновления путали бы снимок.
 */
async function pull(): Promise<void> {
  busy.value = true
  trouble.value = ''

  try {
    await refreshFromServer()
    refill()
  } catch (e) {
    trouble.value = describe(e)
  } finally {
    busy.value = false
  }
}

function onRefresh(): void {
  void pull()
}

onMounted(() => {
  void (async () => {
    try {
      // Сначала снимок и отрисовка, потом сеть: список виден даже при лежащем API.
      await initCollection()
      refill()

      // Отправщик запускается только после подъёма: до него в памяти править нечего.
      startEditSender()
    } catch (e) {
      trouble.value = describe(e)
      busy.value = false
      return
    }

    await pull()
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

      <label class="am-search">
        <span class="am-search__mark" aria-hidden="true">⌕</span>
        <input
          v-model="word"
          class="am-input"
          type="search"
          placeholder="Поиск по своему списку"
          @input="onType"
        />
      </label>

      <button v-if="searching" class="am-btn am-btn--ghost" type="button" @click="onClear">
        Сбросить
      </button>

      <button class="am-btn am-btn--ghost" type="button" :disabled="busy" @click="onRefresh">
        {{ busy ? 'Обновляем…' : 'Обновить' }}
      </button>
    </div>

    <div v-if="!searching" class="am-bar">
      <button
        v-for="tab in statusTabs"
        :key="tab.key"
        class="am-chip"
        :class="{ 'am-chip--on': tab.key === activeStatus }"
        type="button"
        @click="pickStatus(tab.key)"
      >
        {{ tab.title }}
        <span class="am-chip__num">{{ counts.get(tab.key) ?? 0 }}</span>
      </button>
    </div>

    <p v-if="trouble" class="am-error">{{ trouble }}</p>

    <ul v-if="busy && rows.length === 0" class="am-grid">
      <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
        <span class="am-skeleton am-hold__art" />
        <span class="am-skeleton am-hold__line" />
      </li>
    </ul>

    <div v-else-if="total === 0" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⊘</span>
      <span>Записей пока нет.</span>
      <span>Войдите в AniList на экране настроек и обновите список.</span>
    </div>

    <div v-else-if="searchBusy && rows.length === 0" class="am-empty">
      <span>Ищем…</span>
    </div>

    <div v-else-if="searching && rows.length === 0" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⌕</span>
      <span>В своём списке ничего не нашлось.</span>
      <span>Поищите в каталоге на экране поиска.</span>
    </div>

    <div v-else-if="rows.length === 0" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⊘</span>
      <span>В этой закладке записей нет.</span>
    </div>

    <ul v-else class="am-grid">
      <MediaTile
        v-for="row in rows"
        :key="row.mediaId"
        :title="row.title"
        :facts="row.facts"
        :cover="row.cover"
        :color="row.color"
        :mark="row.mark"
        :own="row.own"
        :done="row.done"
        :adult="row.adult"
        @open="open(row.mediaId)"
      />
    </ul>

    <p class="am-meta">
      Всего {{ total }} · показано {{ rows.length }} из {{ shown }}
      <template v-if="looksBusy"> · обложки грузятся…</template>
      <template v-if="titlesBusy"> · названия грузятся…</template>
    </p>
  </section>
</template>

<style scoped>
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
</style>
