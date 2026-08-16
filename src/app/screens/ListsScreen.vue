<script setup lang="ts">
// Пункт 3.3: списки на живой коллекции. Первый экран, который зовёт слой данных
// раздела 2: подъём снимка, обновление с сервера, запуск отправщика правок.
// Правка оценок и статусов — на карточке (3.4), отборы и сортировки — 3.5.
// Манга живёт на своём экране: статусы те же, но подписи и столбцы другие.
import { onMounted, ref } from 'vue'

import { initCollection, refreshFromServer } from '@/core/collection'
import { countByStatus, countEntries, selectEntries } from '@/core/collection-view'
import { startEditSender } from '@/core/edit-sender'
import { peekRussianTitle, prefetchRussianTitles } from '@/core/media-title'
import { Logger } from '@/utils/logger'

import { navigate } from '../router'

/**
 * Сколько записей рисуется за раз. Полный список бывает на тысячи записей,
 * а каждая требует русского названия — то есть обращения к чужому сервису.
 * Добор остатка по прокрутке — пункт 3.5, вместе с отборами.
 */
const PAGE_LIMIT = 100

/**
 * По скольку тайтлов просить названия за один заход. Источники отвечают
 * по одному тайтлу и с выдержкой темпа, поэтому пачка — единица показа:
 * после каждой список перерисовывается, и ждать всё целиком не приходится.
 */
const TITLE_CHUNK = 10

/**
 * Закладки по статусам AniList. Порядок как в привычном списке на сайте:
 * человек ищет глазами туда, где привык.
 */
const STATUS_TABS: ReadonlyArray<{ key: string; title: string }> = [
  { key: 'CURRENT', title: 'Смотрю' },
  { key: 'REPEATING', title: 'Пересматриваю' },
  { key: 'PLANNING', title: 'В планах' },
  { key: 'COMPLETED', title: 'Просмотрено' },
  { key: 'PAUSED', title: 'Отложено' },
  { key: 'DROPPED', title: 'Брошено' },
]

/**
 * Строка списка в виде, готовом к отрисовке. Три названия вместо одного:
 * русское может быть ещё не добыто или отсутствовать вовсе, а показать
 * строку надо сразу.
 */
interface Row {
  mediaId: number
  score10: number
  progress: number
  title: string | null
  romaji: string | null
  english: string | null
}

/** Идёт ли работа со списком: подъём снимка или ответ сервера. */
const busy = ref(true)

/**
 * Идёт ли добор названий. Флаг отдельный сознательно: названия берутся
 * из чужих сервисов минутами и не должны держать кнопки самого списка.
 */
const titlesBusy = ref(false)

const trouble = ref('')
const activeStatus = ref<string>('CURRENT')
const rows = ref<Row[]>([])
const counts = ref<Map<string, number>>(new Map())
const total = ref(0)

/**
 * Номер идущего добора названий. Смена закладки увеличивает его,
 * и старый цикл видит, что его работа больше не нужна.
 */
let titleRun = 0

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Снимает кусок коллекции в свои строки. Память коллекции не реактивна
 * сознательно, и ссылки на её записи в разметку не передаются: отрисовка
 * должна меняться по событиям экрана, а не незаметно из-под рук.
 *
 * Везде один и тот же отбор по типу: в памяти лежат оба типа, а числа
 * у закладок и внизу должны совпадать со списком на глазах.
 */
function redraw(): void {
  counts.value = countByStatus({ type: 'ANIME' })
  total.value = countEntries({ type: 'ANIME' })

  const picked = selectEntries(
    { type: 'ANIME', status: [activeStatus.value] },
    { key: 'updated' },
    { limit: PAGE_LIMIT },
  )

  rows.value = picked.map((entry) => ({
    mediaId: entry.mediaId,
    score10: entry.score10,
    progress: entry.progress,
    title: peekRussianTitle(entry.mediaId)?.russian ?? null,
    romaji: entry.romaji,
    english: entry.english,
  }))
}

/**
 * Что показать в строке. Порядок: русское, латиница, английское, номер.
 * Номер остаётся только у записи, созданной правкой до ответа сервера:
 * такая запись действительно известна нам одним номером.
 */
function titleText(row: Row): string {
  return row.title ?? row.romaji ?? row.english ?? `Тайтл #${row.mediaId}`
}

/**
 * Добирает русские названия для показанных строк пачками.
 * Ошибка здесь не стопорит экран: без перевода строка останется
 * на латинице, а список — пригодным.
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

      // Тип обязателен: у Шикимори аниме и манга лежат в разных разделах.
      await prefetchRussianTitles(wanted.slice(from, from + TITLE_CHUNK), 'ANIME')
      if (run !== titleRun) return

      redraw()
    }
  } catch (e) {
    Logger('WARN', 'Списки: названия добрать не вышло', e)
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

/** Переход на карточку. Номер идёт строкой: в адресе окна чисел нет. */
function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

/** Оценка для глаз: ноль у AniList значит «оценки нет», а не «ноль баллов». */
function scoreText(score10: number): string {
  return score10 > 0 ? score10.toFixed(1) : '—'
}

/**
 * Забирает список с сервера. Отказ сети показанные данные не стирает.
 * Названия запускаются вдогонку и не держат состояние занятости.
 *
 * Обновление тянет оба типа сразу: списки разделены только на экранах,
 * а хранилище и порядок обновления у них общие.
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
      Списка пока нет. Войдите в AniList на экране настроек и обновите список.
    </p>
    <p v-else-if="rows.length === 0" class="am-screen__hint">В этой закладке записей нет.</p>

    <ul v-else class="am-rows">
      <li v-for="row in rows" :key="row.mediaId" class="am-row">
        <button class="am-row__open" type="button" @click="open(row.mediaId)">
          {{ titleText(row) }}
        </button>
        <span class="am-row__num" title="Оценка">{{ scoreText(row.score10) }}</span>
        <span class="am-row__num" title="Просмотрено частей">{{ row.progress }}</span>
      </li>
    </ul>

    <div class="am-foot">
      <button class="am-btn am-btn--ghost" type="button" :disabled="busy" @click="onRefresh">
        Обновить с сервера
      </button>
      <span class="am-screen__meta">
        Всего аниме {{ total }} · показано {{ rows.length }} из
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
  grid-template-columns: 1fr 52px 52px;
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
