<script setup lang="ts">
// Пункт 3.5: поиск по чужому каталогу. Поиск по своему списку живёт
// во вкладке списков: там он идёт по памяти и сети не требует вовсе.
// Куда идти за русским словом, решает core/media-search: экран только показывает.
import { computed, ref } from 'vue'

import type { MediaBrief } from '@/api/anilist-media'
import { isRussianWord, searchCatalog } from '@/core/media-search'
import { peekRussianTitle, prefetchRussianTitles } from '@/core/media-title'
import type { MediaType } from '@/core/types'
import { Logger } from '@/utils/logger'

import { navigate } from '../router'

/** Пауза после последнего нажатия: каждая буква в сеть — сожжённый темп. */
const TYPING_PAUSE_MS = 450

/** По скольку тайтлов просить русские названия за заход. */
const TITLE_CHUNK = 10

/** Подвкладки вида: тип решает и запрос, и раздел русского источника. */
const KIND_TABS: ReadonlyArray<{ key: MediaType; title: string }> = [
  { key: 'ANIME', title: 'Аниме' },
  { key: 'MANGA', title: 'Манга' },
]

/** Подписи закладок аниме для столбца «у меня». */
const ANIME_STATUS: Readonly<Record<string, string>> = {
  CURRENT: 'Смотрю',
  REPEATING: 'Пересматриваю',
  PLANNING: 'В планах',
  COMPLETED: 'Просмотрено',
  PAUSED: 'Отложено',
  DROPPED: 'Брошено',
}

/** Подписи закладок манги: ключи те же, слова про чтение. */
const MANGA_STATUS: Readonly<Record<string, string>> = {
  CURRENT: 'Читаю',
  REPEATING: 'Перечитываю',
  PLANNING: 'В планах',
  COMPLETED: 'Прочитано',
  PAUSED: 'Отложено',
  DROPPED: 'Брошено',
}

/** Строка выдачи. Название и подпись готовятся заранее: разметка не считает. */
interface Row {
  mediaId: number
  title: string
  facts: string
  ownStatus: string
  score10: string
}

const word = ref('')
const kind = ref<MediaType>('ANIME')
const rows = ref<Row[]>([])
const busy = ref(false)
const trouble = ref('')
const total = ref<number | null>(null)
const hasNext = ref(false)
const page = ref(1)

/** Путь поиска виден человеку: чей ответ он читает — вопрос не праздный. */
const viaShikimori = computed(() => isRussianWord(word.value))
const asked = computed(() => word.value.trim())

/** Номера идущих работ: ответ на устаревший вопрос в выдачу не попадает. */
let run = 0
let titleRun = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** Найденные выписки этого показа: по ним строки перерисовываются с названиями. */
let briefs: MediaBrief[] = []

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Оценка сервера для глаз: у AniList она в сотнях, показываем как есть. */
function scoreText(brief: MediaBrief): string {
  return brief.averageScore === null ? '—' : String(brief.averageScore)
}

/** Короткая подпись под названием: вид, год и части. */
function briefFacts(brief: MediaBrief): string {
  const parts: string[] = []

  if (brief.format !== null) parts.push(brief.format)
  if (brief.seasonYear !== null) parts.push(String(brief.seasonYear))

  const count = brief.type === 'MANGA' ? brief.chapters : brief.episodes
  if (count !== null) parts.push(brief.type === 'MANGA' ? `Глав ${count}` : `Серий ${count}`)

  if (brief.isAdult) parts.push('18+')

  return parts.join(' · ')
}

/** Что у меня с этим тайтлом по ответу сервера. */
function ownText(brief: MediaBrief): string {
  const own = brief.ownEntry
  if (!own || own.status === null) return 'не в списке'

  const table = brief.type === 'MANGA' ? MANGA_STATUS : ANIME_STATUS
  return table[own.status] ?? own.status
}

/** Название для строки: русское, латиница, английское, номер. */
function pickTitle(brief: MediaBrief): string {
  const russian = peekRussianTitle(brief.mediaId)?.russian ?? null
  return russian ?? brief.romaji ?? brief.english ?? `Тайтл #${brief.mediaId}`
}

/** Выписка сервера в строку показа. */
function toRow(brief: MediaBrief): Row {
  return {
    mediaId: brief.mediaId,
    title: pickTitle(brief),
    facts: briefFacts(brief),
    ownStatus: ownText(brief),
    score10: scoreText(brief),
  }
}

function redraw(): void {
  rows.value = briefs.map(toRow)
}

/**
 * Добирает русские названия для найденного. На выдаче это важнее,
 * чем в списке: человек искал русское слово и ждёт русский ответ.
 */
async function fillTitles(): Promise<void> {
  const mine = ++titleRun
  const type = kind.value
  const wanted = briefs
    .filter((brief) => peekRussianTitle(brief.mediaId) === null)
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
        placeholder="Поиск по каталогу"
        @input="onType"
      />
    </div>

    <p class="am-screen__meta">
      <template v-if="asked === ''">
        Ищет по чужому каталогу. Свой список ищите во вкладке «Списки».
      </template>
      <template v-else-if="viaShikimori"> Русское слово ищется через Шикимори. </template>
      <template v-else> Поиск по каталогу AniList. </template>
      <template v-if="total !== null"> Найдено {{ total }}. </template>
    </p>

    <p v-if="trouble" class="am-screen__error">{{ trouble }}</p>

    <p v-if="busy && rows.length === 0" class="am-screen__hint">Ищем…</p>
    <p v-else-if="asked !== '' && !busy && rows.length === 0" class="am-screen__hint">
      Ничего не нашлось. Попробуйте другое слово или другой вид.
    </p>

    <ul v-if="rows.length > 0" class="am-rows">
      <li v-for="row in rows" :key="row.mediaId" class="am-row">
        <button class="am-row__main" type="button" @click="open(row.mediaId)">
          <span class="am-row__title">{{ row.title }}</span>
          <span class="am-row__sub">{{ row.facts }}</span>
        </button>
        <span class="am-row__own">{{ row.ownStatus }}</span>
        <span class="am-row__num" title="Средняя оценка">{{ row.score10 }}</span>
      </li>
    </ul>

    <div v-if="hasNext" class="am-foot">
      <button class="am-btn am-btn--ghost" type="button" :disabled="busy" @click="onMore">
        Показать ещё
      </button>
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
  margin: 0;
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
  grid-template-columns: 1fr 140px 52px;
  gap: 8px;
  align-items: center;
  padding: 4px 10px;
  border-bottom: 1px solid var(--am-line);
}

.am-row:last-child {
  border-bottom: none;
}

.am-row__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
  overflow: hidden;
  font: inherit;
  color: var(--am-text);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
}

.am-row__main:hover .am-row__title {
  color: var(--am-accent);
}

.am-row__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-row__sub {
  font-size: 12px;
  color: var(--am-dim);
}

.am-row__own {
  font-size: 12px;
  color: var(--am-dim);
  text-align: right;
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
