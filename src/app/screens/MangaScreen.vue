<script setup lang="ts">
// Список манги. Отдельный экран, а не закладка в списках: подписи здесь
// про чтение, в строке кроме глав есть тома, и смешивать это с аниме незачем.
// Данные общие: одна коллекция в памяти, разделяет их отбор по типу.
// Читать мангу мы пока не даём — это учёт списка, а не читалка.
import { onMounted, ref } from 'vue'

import { initCollection, refreshFromServer } from '@/core/collection'
import { countByStatus, countEntries, selectEntries } from '@/core/collection-view'
import { peekRussianTitle, prefetchRussianTitles } from '@/core/media-title'
import { Logger } from '@/utils/logger'

import { navigate } from '../router'

/** Сколько записей рисуется за раз. Добор остатка по прокрутке — пункт 3.5. */
const PAGE_LIMIT = 100

/** По скольку тайтлов просить названия за заход: источники отвечают по одному. */
const TITLE_CHUNK = 10

/**
 * Закладки по статусам AniList. Ключи те же, что у аниме — сервер других не знает,
 * а вот подписи обязаны быть про чтение: «Смотрю» у манги выглядит ошибкой.
 */
const STATUS_TABS: ReadonlyArray<{ key: string; title: string }> = [
  { key: 'CURRENT', title: 'Читаю' },
  { key: 'REPEATING', title: 'Перечитываю' },
  { key: 'PLANNING', title: 'В планах' },
  { key: 'COMPLETED', title: 'Прочитано' },
  { key: 'PAUSED', title: 'Отложено' },
  { key: 'DROPPED', title: 'Брошено' },
]

/** Строка списка. Тома рядом с главами: у манги счёт часто ведётся томами. */
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

const trouble = ref('')
const activeStatus = ref<string>('CURRENT')
const rows = ref<Row[]>([])
const counts = ref<Map<string, number>>(new Map())
const total = ref(0)

/** Номер идущего добора названий: смена закладки отменяет старый цикл. */
let titleRun = 0

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Снимает кусок коллекции в свои строки. Отбор по типу везде один и тот же. */
function redraw(): void {
  counts.value = countByStatus({ type: 'MANGA' })
  total.value = countEntries({ type: 'MANGA' })

  const picked = selectEntries(
    { type: 'MANGA', status: [activeStatus.value] },
    { key: 'updated' },
    {
      limit: PAGE_LIMIT,
    },
  )

  rows.value = picked.map((entry) => ({
    mediaId: entry.mediaId,
    score10: entry.score10,
    progress: entry.progress,
    volumes: entry.volumes,
    title: peekRussianTitle(entry.mediaId)?.russian ?? null,
    romaji: entry.romaji,
    english: entry.english,
  }))
}

/** Что показать в строке: русское, латиница, английское, номер. */
function titleText(row: Row): string {
  return row.title ?? row.romaji ?? row.english ?? `Тайтл #${row.mediaId}`
}

/**
 * Добирает русские названия пачками. Тип передаётся явно:
 * у Шикимори аниме и манга — разные разделы, и номер без типа ведёт не туда.
 */
async function fillTitles(): Promise<void> {
  const run = ++titleRun
  const wanted = rows.value.filter((row) => row.title === null).map((row) => row.mediaId)
  if (wanted.length === 0) return

  titlesBusy.value = true

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      // Закладку успели сменить: остаток пачек этому показу уже не нужен.
      if (run !== titleRun) return

      await prefetchRussianTitles(wanted.slice(from, from + TITLE_CHUNK), 'MANGA')
      if (run !== titleRun) return

      redraw()
    }
  } catch (e) {
    Logger('WARN', 'Манга: названия добрать не вышло', e)
  } finally {
    if (run === titleRun) titlesBusy.value = false
  }
}

/** Переключение закладки. Сети не требует: вся коллекция уже в памяти. */
function pick(status: string): void {
  if (activeStatus.value === status) return

  activeStatus.value = status
  redraw()
  void fillTitles()
}

/** Переход на карточку. Карточка манги — пункт 3.4, там же что и аниме. */
function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

/** Оценка для глаз: ноль у AniList значит «оценки нет». */
function scoreText(score10: number): string {
  return score10 > 0 ? score10.toFixed(1) : '—'
}

/**
 * Забирает список с сервера. Обновление общее на оба типа: два разных
 * порядка обновления расходились бы между собой и путали бы снимок.
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
      // Снимок уже мог быть поднят экраном списков: повторный вызов безвреден.
      // Отправщик правок запускает экран списков, второй запуск ему не нужен.
      await initCollection()
      redraw()
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
        v-for="tab in STATUS_TABS"
        :key="tab.key"
        class="am-tab"
        :class="{ 'am-tab--on': tab.key === activeStatus }"
        type="button"
        @click="pick(tab.key)"
      >
        {{ tab.title }}
        <span class="am-tab__num">{{ counts.get(tab.key) ?? 0 }}</span>
      </button>
    </div>

    <p v-if="trouble" class="am-screen__error">{{ trouble }}</p>

    <p v-if="busy && total === 0" class="am-screen__hint">Список загружается…</p>
    <p v-else-if="total === 0" class="am-screen__hint">
      Манги в списке пока нет. Записи появятся после обновления с сервера.
    </p>
    <p v-else-if="rows.length === 0" class="am-screen__hint">В этой закладке записей нет.</p>

    <ul v-else class="am-rows">
      <li v-for="row in rows" :key="row.mediaId" class="am-row">
        <button class="am-row__open" type="button" @click="open(row.mediaId)">
          {{ titleText(row) }}
        </button>
        <span class="am-row__num" title="Оценка">{{ scoreText(row.score10) }}</span>
        <span class="am-row__num" title="Прочитано глав">{{ row.progress }}</span>
        <span class="am-row__num" title="Прочитано томов">{{ row.volumes }}</span>
      </li>
    </ul>

    <div class="am-foot">
      <button class="am-btn am-btn--ghost" type="button" :disabled="busy" @click="onRefresh">
        Обновить с сервера
      </button>
      <span class="am-screen__meta">
        Всего манги {{ total }} · показано {{ rows.length }} из
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

.am-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
  grid-template-columns: 1fr 52px 52px 52px;
  gap: 8px;
  align-items: center;
  padding: 4px 10px;
  border-bottom: 1px solid var(--am-line);
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
