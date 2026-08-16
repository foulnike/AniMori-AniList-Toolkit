<script setup lang="ts">
// Пункт 3.5: списки одним экраном на оба вида. Данные, обновление и
// снимок у аниме и манги общие, разные только подписи и столбец томов.
// Здесь же поиск по своему списку: искать надо там, где список и лежит.
// Поиск по чужому каталогу живёт на своём экране: там сеть и другие столбцы.
import { computed, onMounted, ref } from 'vue'

import { initCollection, refreshFromServer } from '@/core/collection'
import { countByStatus, countEntries, selectEntries } from '@/core/collection-view'
import { startEditSender } from '@/core/edit-sender'
import { searchOwnList } from '@/core/media-search'
import { peekRussianTitle, prefetchRussianTitles } from '@/core/media-title'
import type { SnapshotEntry } from '@/core/snapshot'
import type { MediaType } from '@/core/types'
import { Logger } from '@/utils/logger'

import { navigate } from '../router'

/**
 * Сколько записей рисуется за раз. Полный список бывает на тысячи записей,
 * а каждая требует русского названия — то есть обращения к чужому сервису.
 */
const PAGE_LIMIT = 100

/** По скольку тайтлов просить названия за заход: источники отвечают по одному. */
const TITLE_CHUNK = 10

/** Сколько найденного показывать. Слово из двух букв иначе вывалит весь список. */
const FOUND_LIMIT = 60

/** Пауза после последнего нажатия. Поиск идёт в памяти, поэтому пауза короткая. */
const TYPING_PAUSE_MS = 250

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

/**
 * Строка списка в виде, готовом к отрисовке. Три названия вместо одного:
 * русское может быть ещё не добыто, а строку надо показать сразу.
 */
interface Row {
  mediaId: number
  score10: number
  progress: number
  volumes: number
  title: string | null
  romaji: string | null
  english: string | null
}

/** Идёт ли работа со списком: подъём снимка или ответ сервера. */
const busy = ref(true)

/** Идёт ли добор названий. Кнопки списка он держать не должен. */
const titlesBusy = ref(false)

/** Идёт ли отбор по слову. На кириллице перед отбором поднимается склад. */
const searchBusy = ref(false)

const trouble = ref('')
const kind = ref<MediaType>('ANIME')
const activeStatus = ref<string>('CURRENT')
const word = ref('')
const rows = ref<Row[]>([])
const counts = ref<Map<string, number>>(new Map())
const total = ref(0)

/** Подписи закладок и столбцов зависят только от вида. */
const statusTabs = computed(() => (kind.value === 'MANGA' ? MANGA_STATUS : ANIME_STATUS))
const isManga = computed(() => kind.value === 'MANGA')
const searching = computed(() => word.value.trim() !== '')

/**
 * Найденные записи последнего поиска. Не реактивные сознательно:
 * по ним перерисовываются строки, когда добрались названия.
 */
let foundEntries: SnapshotEntry[] = []

/** Номера идущих работ: старый цикл видит, что его ответ больше не нужен. */
let titleRun = 0
let searchRun = 0

/** Таймер паузы набора. */
let timer: ReturnType<typeof setTimeout> | null = null

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Запись памяти в строку показа. Ссылки на записи в разметку не передаются. */
function toRow(entry: SnapshotEntry): Row {
  return {
    mediaId: entry.mediaId,
    score10: entry.score10,
    progress: entry.progress,
    volumes: entry.volumes,
    title: peekRussianTitle(entry.mediaId)?.russian ?? null,
    romaji: entry.romaji,
    english: entry.english,
  }
}

/**
 * Снимает кусок коллекции в свои строки. При идущем поиске строки
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
 * Что показать в строке. Порядок: русское, латиница, английское, номер.
 * Номер остаётся только у записи, созданной правкой до ответа сервера.
 */
function titleText(row: Row): string {
  return row.title ?? row.romaji ?? row.english ?? `Тайтл #${row.mediaId}`
}

/** Оценка для глаз: ноль у AniList значит «оценки нет», а не «ноль баллов». */
function scoreText(score10: number): string {
  return score10 > 0 ? score10.toFixed(1) : '—'
}

/**
 * Добирает русские названия для показанных строк пачками. Ошибка здесь
 * не стопорит экран: без перевода строка останется на латинице.
 */
async function fillTitles(): Promise<void> {
  const run = ++titleRun
  const asked = kind.value
  const wanted = rows.value.filter((row) => row.title === null).map((row) => row.mediaId)
  if (wanted.length === 0) return

  titlesBusy.value = true

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      // Закладку или вид успели сменить: остаток пачек этому показу не нужен.
      if (run !== titleRun) return

      // Тип обязателен: у Шикимори аниме и манга лежат в разных разделах.
      await prefetchRussianTitles(wanted.slice(from, from + TITLE_CHUNK), asked)
      if (run !== titleRun) return

      redraw()
    }
  } catch (e) {
    Logger('WARN', 'Списки: названия добрать не вышло', e)
  } finally {
    if (run === titleRun) titlesBusy.value = false
  }
}

/**
 * Отбор по слову по всем закладкам выбранного вида. Сети не требует,
 * но на кириллице сначала поднимает склад русских названий.
 */
async function runSearch(): Promise<void> {
  const run = ++searchRun
  const asked = word.value.trim()

  if (asked === '') {
    foundEntries = []
    redraw()
    return
  }

  searchBusy.value = true

  try {
    const found = await searchOwnList(asked, kind.value, FOUND_LIMIT)
    if (run !== searchRun) return

    foundEntries = found
    redraw()
  } catch (e) {
    Logger('WARN', 'Списки: поиск по своему списку не удался', e)
  } finally {
    if (run === searchRun) searchBusy.value = false
  }

  void fillTitles()
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
  redraw()
  void fillTitles()
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

  redraw()
  void fillTitles()
}

/** Переключение закладки статуса. */
function pickStatus(status: string): void {
  if (activeStatus.value === status) return

  activeStatus.value = status
  redraw()
  void fillTitles()
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
    redraw()
  } catch (e) {
    trouble.value = describe(e)
  } finally {
    busy.value = false
  }

  void fillTitles()
}

function onRefresh(): void {
  void pull()
}

onMounted(() => {
  void (async () => {
    try {
      // Сначала снимок и отрисовка, потом сеть: список виден даже при лежащем API.
      await initCollection()
      redraw()

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
  <section class="am-screen">
    <div class="am-tabs">
      <button
        v-for="tab in KIND_TABS"
        :key="tab.key"
        class="am-tab am-tab--kind"
        :class="{ 'am-tab--on': tab.key === kind }"
        type="button"
        @click="pickKind(tab.key)"
      >
        {{ tab.title }}
      </button>

      <span class="am-tabs__gap" />

      <input
        v-model="word"
        class="am-screen__input"
        type="search"
        placeholder="Поиск по своему списку"
        @input="onType"
      />

      <button v-if="searching" class="am-tab" type="button" @click="onClear">Сбросить</button>
    </div>

    <div v-if="!searching" class="am-tabs">
      <button
        v-for="tab in statusTabs"
        :key="tab.key"
        class="am-tab"
        :class="{ 'am-tab--on': tab.key === activeStatus }"
        type="button"
        @click="pickStatus(tab.key)"
      >
        {{ tab.title }}
        <span class="am-tab__num">{{ counts.get(tab.key) ?? 0 }}</span>
      </button>
    </div>

    <p v-if="trouble" class="am-screen__error">{{ trouble }}</p>

    <p v-if="busy && total === 0" class="am-screen__hint">Список загружается…</p>
    <p v-else-if="total === 0" class="am-screen__hint">
      Записей пока нет. Войдите в AniList на экране настроек и обновите список.
    </p>
    <p v-else-if="searchBusy && rows.length === 0" class="am-screen__hint">Ищем…</p>
    <p v-else-if="searching && rows.length === 0" class="am-screen__hint">
      В своём списке ничего не нашлось. Поищите в каталоге на экране поиска.
    </p>
    <p v-else-if="rows.length === 0" class="am-screen__hint">В этой закладке записей нет.</p>

    <ul v-else class="am-rows">
      <li
        v-for="row in rows"
        :key="row.mediaId"
        class="am-row"
        :class="{ 'am-row--manga': isManga }"
      >
        <button class="am-row__open" type="button" @click="open(row.mediaId)">
          {{ titleText(row) }}
        </button>
        <span class="am-row__num" title="Оценка">{{ scoreText(row.score10) }}</span>
        <span class="am-row__num" :title="isManga ? 'Прочитано глав' : 'Просмотрено частей'">
          {{ row.progress }}
        </span>
        <span v-if="isManga" class="am-row__num" title="Прочитано томов">{{ row.volumes }}</span>
      </li>
    </ul>

    <div class="am-foot">
      <button class="am-btn am-btn--ghost" type="button" :disabled="busy" @click="onRefresh">
        Обновить с сервера
      </button>
      <span v-if="searching" class="am-screen__meta">
        Нашлось {{ rows.length }} из {{ total }}
        <template v-if="searchBusy"> · ищем…</template>
        <template v-if="titlesBusy"> · названия догружаются…</template>
      </span>
      <span v-else class="am-screen__meta">
        Всего {{ total }} · показано {{ rows.length }} из
        {{ counts.get(activeStatus) ?? 0 }}
        <template v-if="titlesBusy"> · названия догружаются…</template>
      </span>
    </div>
  </section>
</template>

<style scoped>
.am-screen {
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: flex-start;
  width: 100%;
}

.am-screen__hint {
  max-width: 640px;
  margin: 0;
  color: var(--am-dim);
}

.am-screen__meta {
  font-size: 13px;
  color: var(--am-dim);
}

.am-screen__error {
  margin: 0;
  font-size: 13px;
  color: #ff8a8a;
}

.am-screen__input {
  width: 260px;
  padding: 7px 10px;
  font: inherit;
  color: var(--am-text);
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-screen__input:focus {
  border-color: var(--am-accent);
  outline: none;
}

.am-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  width: 100%;
  max-width: 720px;
}

.am-tabs__gap {
  flex: 1 1 auto;
}

.am-tab {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 7px 12px;
  font: inherit;
  color: var(--am-text);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-tab:hover {
  background: var(--am-hover);
}

.am-tab--on {
  background: var(--am-panel);
  border-color: var(--am-accent);
}

.am-tab--kind {
  font-weight: 600;
}

.am-tab__num {
  font-size: 12px;
  color: var(--am-dim);
}

.am-rows {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 720px;
  margin: 0;
  padding: 0;
  list-style: none;
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: 12px;
}

.am-row {
  display: grid;
  grid-template-columns: 1fr 52px 52px;
  gap: 8px;
  align-items: center;
  padding: 4px 10px;
  border-bottom: 1px solid var(--am-line);
}

.am-row--manga {
  grid-template-columns: 1fr 52px 52px 52px;
}

.am-row:last-child {
  border-bottom: none;
}

.am-row__open {
  padding: 6px 0;
  overflow: hidden;
  font: inherit;
  color: var(--am-text);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  background: transparent;
  border: none;
}

.am-row__open:hover {
  color: var(--am-accent);
}

.am-row__num {
  font-size: 13px;
  color: var(--am-dim);
  text-align: right;
}

.am-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.am-btn {
  padding: 8px 14px;
  font: inherit;
  color: #06121f;
  cursor: pointer;
  background: var(--am-accent);
  border: 1px solid var(--am-accent);
  border-radius: 8px;
}

.am-btn:disabled {
  cursor: default;
  opacity: 0.55;
}

.am-btn--ghost {
  color: var(--am-text);
  background: transparent;
  border-color: var(--am-line);
}

.am-btn--ghost:hover:not(:disabled) {
  background: var(--am-hover);
}
</style>
