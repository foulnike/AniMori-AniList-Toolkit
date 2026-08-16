<script setup lang="ts">
// Пункт 3.5: поиск и отборы. Своё ищется по памяти мгновенно,
// каталог — запросом с задержкой. Правки здесь не делаются:
// строка ведёт в карточку, где есть всё для правки записи.
import { onMounted, ref } from 'vue'
import { SEARCH_PAGE_SIZE, searchMedia, type MediaBrief } from '@/api/anilist-media'
import { initCollection } from '@/core/collection'
import { selectEntries } from '@/core/collection-view'
import { getRussianTitle, peekRussianTitle } from '@/core/media-title'
import type { MediaType } from '@/core/types'
import { Logger } from '@/utils/logger'
import { navigate } from '../router'

/** Сколько ждём после последней клавиши перед запросом к каталогу. */
const TYPING_PAUSE_MS = 450

/** Сколько своих записей показывать. Дальше список читать невозможно. */
const OWN_LIMIT = 30

/** Для скольких найденных сразу добираем русские названия. */
const TITLE_CHUNK = 10

/** Подписи закладок. Два набора: у манги читают, а не смотрят. */
const ANIME_STATUS: Record<string, string> = {
  CURRENT: 'Смотрю',
  REPEATING: 'Пересматриваю',
  PLANNING: 'В планах',
  COMPLETED: 'Просмотрено',
  PAUSED: 'Отложено',
  DROPPED: 'Брошено',
}

const MANGA_STATUS: Record<string, string> = {
  CURRENT: 'Читаю',
  REPEATING: 'Перечитываю',
  PLANNING: 'В планах',
  COMPLETED: 'Прочитано',
  PAUSED: 'Отложено',
  DROPPED: 'Брошено',
}

/** Строка выдачи. Один вид на два источника: разметка тоже одна. */
interface Row {
  mediaId: number
  title: string
  romaji: string
  facts: string
  ownStatus: string | null
  score10: number
}

const word = ref('')
const kind = ref<MediaType>('ANIME')
const source = ref<'own' | 'catalog'>('own')
const rows = ref<Row[]>([])
const busy = ref(false)
const trouble = ref('')
const total = ref<number | null>(null)
const hasNext = ref(false)
const page = ref(1)

// Номер последнего набора и свертка отложенного запроса: ответы
// приходят в любом порядке, и чужой ответ не должен замещать свежий.
let run = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** Факты одной строкой: год, вид и сколько частей всего. */
function briefFacts(item: MediaBrief): string {
  const parts: string[] = []
  if (item.format !== null) parts.push(item.format)
  if (item.seasonYear !== null) parts.push(String(item.seasonYear))

  const count = item.type === 'MANGA' ? item.chapters : item.episodes
  if (count !== null) parts.push(item.type === 'MANGA' ? `Глав: ${count}` : `Эпизодов: ${count}`)
  if (item.averageScore !== null) parts.push(`Средняя ${item.averageScore}`)
  if (item.isAdult) parts.push('18+')

  return parts.join(' · ')
}

/** Название для строки: русское, если уже знаем, иначе ромадзи. */
function pickTitle(mediaId: number, romaji: string | null, english: string | null): string {
  const known = peekRussianTitle(mediaId)
  if (known !== null && known.russian !== null) return known.russian
  return romaji ?? english ?? `Тайтл ${mediaId}`
}

/** Подпись закладки или `null`, если тайтла в своём списке нет. */
function describe(status: string | null, type: MediaType): string | null {
  if (status === null) return null
  const table = type === 'MANGA' ? MANGA_STATUS : ANIME_STATUS
  return table[status] ?? status
}

/** Оценка для глаза: ноль значит «оценки нет», а не плохую оценку. */
function scoreText(score10: number): string {
  return score10 > 0 ? score10.toFixed(1) : '—'
}

/**
 * Русские названия для первых строк. Спрашиваем последовательно
 * и только для видимого: веер запросов убьёт темп чужого источника.
 */
async function fillTitles(mine: number, type: MediaType): Promise<void> {
  const chunk = rows.value.slice(0, TITLE_CHUNK)

  for (const row of chunk) {
    if (run !== mine) return

    const found = await getRussianTitle(row.mediaId, type)
    if (run !== mine) return
    if (found === null || found.russian === null) continue

    // Строка могла смениться местом, поэтому ищем её по номеру.
    const live = rows.value.find((item) => item.mediaId === row.mediaId)
    if (live) live.title = found.russian
  }
}

/** Поиск по своему списку: память, никакой сети и никакого ожидания. */
function searchOwn(): void {
  const asked = word.value.trim().toLowerCase()
  const type = kind.value

  total.value = null
  hasNext.value = false
  trouble.value = ''

  if (asked === '') {
    rows.value = []
    return
  }

  // Слово в отбор не кладём: русское название знает только экран.
  const picked: Row[] = []
  for (const entry of selectEntries({ type }, { key: 'updated' })) {
    const russian = peekRussianTitle(entry.mediaId)?.russian ?? null
    const fits =
      (entry.romaji !== null && entry.romaji.toLowerCase().includes(asked)) ||
      (entry.english !== null && entry.english.toLowerCase().includes(asked)) ||
      (russian !== null && russian.toLowerCase().includes(asked))

    if (!fits) continue

    picked.push({
      mediaId: entry.mediaId,
      title: russian ?? entry.romaji ?? entry.english ?? `Тайтл ${entry.mediaId}`,
      romaji: entry.romaji ?? '',
      facts: entry.isAdult ? '18+' : '',
      ownStatus: describe(entry.status, type),
      score10: entry.score10,
    })

    if (picked.length >= OWN_LIMIT) break
  }

  rows.value = picked
  total.value = picked.length
}

/** Страница из каталога. При `add` найденное кладётся в конец выдачи. */
async function searchCatalog(add = false): Promise<void> {
  const asked = word.value.trim()
  const type = kind.value

  if (asked === '') {
    rows.value = []
    total.value = null
    hasNext.value = false
    return
  }

  run += 1
  const mine = run
  busy.value = true
  trouble.value = ''

  try {
    const found = await searchMedia(asked, type, add ? page.value + 1 : 1)
    if (run !== mine) return

    if (found === null) {
      trouble.value = 'Сервер не ответил на поиск. Попробуй ещё раз через минуту.'
      return
    }

    const fresh: Row[] = found.items.map((item) => ({
      mediaId: item.mediaId,
      title: pickTitle(item.mediaId, item.romaji, item.english),
      romaji: item.romaji ?? '',
      facts: briefFacts(item),
      ownStatus: describe(item.ownEntry?.status ?? null, item.type),
      score10: item.ownEntry?.score10 ?? 0,
    }))

    rows.value = add ? rows.value.concat(fresh) : fresh
    page.value = add ? page.value + 1 : 1
    hasNext.value = found.hasNext
    total.value = found.total

    await fillTitles(mine, type)
  } catch (error) {
    if (run === mine) trouble.value = 'Поиск не удался. Подробности в журнале.'
    Logger('ERROR', `Поиск «${asked}» сорвался`, error)
  } finally {
    if (run === mine) busy.value = false
  }
}

/** Набор в поле. Своё ищется сразу, каталог — после паузы в наборе. */
function onType(): void {
  if (timer !== null) clearTimeout(timer)

  if (source.value === 'own') {
    searchOwn()
    return
  }

  timer = setTimeout(() => {
    timer = null
    void searchCatalog()
  }, TYPING_PAUSE_MS)
}

/** Смена типа или источника: выдача старого набора больше не годится. */
function onSwitch(): void {
  rows.value = []
  page.value = 1
  hasNext.value = false
  total.value = null
  onType()
}

function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

onMounted(() => {
  // Своё ищется по памяти, а память может быть пуста: список из снимка.
  void initCollection()
})
</script>

<template>
  <section class="am-screen">
    <div class="am-tabs">
      <button
        class="am-tab"
        :class="{ 'am-tab--on': source === 'own' }"
        type="button"
        @click="
          source = 'own'
          onSwitch()
        "
      >
        Свой список
      </button>
      <button
        class="am-tab"
        :class="{ 'am-tab--on': source === 'catalog' }"
        type="button"
        @click="
          source = 'catalog'
          onSwitch()
        "
      >
        Каталог AniList
      </button>
      <span class="am-tabs__gap"></span>
      <button
        class="am-tab"
        :class="{ 'am-tab--on': kind === 'ANIME' }"
        type="button"
        @click="
          kind = 'ANIME'
          onSwitch()
        "
      >
        Аниме
      </button>
      <button
        class="am-tab"
        :class="{ 'am-tab--on': kind === 'MANGA' }"
        type="button"
        @click="
          kind = 'MANGA'
          onSwitch()
        "
      >
        Манга
      </button>
    </div>

    <input
      v-model="word"
      class="am-screen__input"
      type="search"
      placeholder="Название тайтла"
      @input="onType"
      @keyup.enter="onType"
    />

    <p v-if="trouble !== ''" class="am-screen__error">{{ trouble }}</p>

    <p class="am-screen__meta">
      <span v-if="busy">Ищу…</span>
      <span v-else-if="word.trim() === ''">
        {{
          source === 'own'
            ? 'Набери часть названия — искать буду по своему списку, без сети.'
            : 'Набери название — спрошу каталог AniList после паузы в наборе.'
        }}
      </span>
      <span v-else-if="rows.length === 0">Ничего не нашлось.</span>
      <span v-else>
        Показано {{ rows.length }}<span v-if="total !== null"> из {{ total }}</span>
      </span>
    </p>

    <div v-if="rows.length > 0" class="am-rows">
      <button
        v-for="row in rows"
        :key="row.mediaId"
        class="am-row"
        type="button"
        @click="open(row.mediaId)"
      >
        <span class="am-row__main">
          <span class="am-row__title">{{ row.title }}</span>
          <span v-if="row.romaji !== '' && row.romaji !== row.title" class="am-row__sub">
            {{ row.romaji }}
          </span>
          <span v-if="row.facts !== ''" class="am-row__sub">{{ row.facts }}</span>
        </span>
        <span class="am-row__own">
          <span v-if="row.ownStatus !== null" class="am-row__mark">{{ row.ownStatus }}</span>
          <span v-else class="am-row__sub">не в списке</span>
        </span>
        <span class="am-row__num">{{ scoreText(row.score10) }}</span>
      </button>
    </div>

    <div v-if="source === 'catalog' && hasNext" class="am-foot">
      <button class="am-btn am-btn--ghost" type="button" :disabled="busy" @click="searchCatalog(true)">
        Ещё {{ SEARCH_PAGE_SIZE }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.am-screen {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}

.am-screen__input {
  width: 320px;
  padding: 8px 12px;
  font: inherit;
  color: var(--am-text);
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-screen__meta {
  margin: 0;
  color: var(--am-dim);
}

.am-screen__error {
  margin: 0;
  color: #ff8a8a;
}

.am-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  width: 100%;
}

.am-tabs__gap {
  flex: 1;
}

.am-tab {
  padding: 6px 12px;
  font: inherit;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-tab:hover {
  background: var(--am-hover);
}

.am-tab--on {
  color: var(--am-text);
  border-color: var(--am-accent);
}

.am-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.am-row {
  display: grid;
  grid-template-columns: 1fr 140px 52px;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  font: inherit;
  color: var(--am-text);
  text-align: left;
  cursor: pointer;
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-row:hover {
  background: var(--am-hover);
}

.am-row__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
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
  display: flex;
  justify-content: flex-start;
}

.am-row__mark {
  padding: 2px 8px;
  font-size: 12px;
  color: var(--am-text);
  background: var(--am-hover);
  border: 1px solid var(--am-line);
  border-radius: 12px;
}

.am-row__num {
  color: var(--am-dim);
  text-align: right;
}

.am-foot {
  display: flex;
  gap: 8px;
  padding-top: 4px;
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

.am-btn--ghost {
  color: var(--am-text);
  background: var(--am-panel);
  border-color: var(--am-line);
}

.am-btn:disabled {
  cursor: default;
  opacity: 0.6;
}
</style>
