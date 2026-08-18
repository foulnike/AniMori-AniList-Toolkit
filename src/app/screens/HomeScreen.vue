<script setup lang="ts">
// Пункт 3.9: главная как лицо программы. Своих данных не добывает:
// берёт то, что уже лежит в памяти коллекции, и добирает только вид.
// Обновление списка с сервера живёт на экране списков: там ему и место.
import { computed, onMounted, ref } from 'vue'

import { entryCount, initCollection } from '@/core/collection'
import {
  averageScore,
  countByStatus,
  countEntries,
  selectEntries,
  totalProgress,
} from '@/core/collection-view'
import { partsOut, peekLook, warmLooks, type MediaLook } from '@/core/media-looks'
import { peekRussianName, prefetchRussianTitles } from '@/core/media-title'
import type { SnapshotEntry } from '@/core/snapshot'
import type { MediaType } from '@/core/types'
import { Logger } from '@/utils/logger'

import MediaTile from '../components/MediaTile.vue'
import { formatWord, partsShort } from '../labels'
import { navigate } from '../router'

/** Сколько постеров класть на полку аниме и полку манги. */
const ANIME_SHELF = 14
const MANGA_SHELF = 8

/** Скольким плиткам добирать русские названия и по скольку за заход. */
const TITLE_DEPTH = 12
const TITLE_CHUNK = 6

/** Сколько заглушек держать на время подъёма снимка. */
const HOLD_COUNT = 7

/** Плитка полки. Тот же вид, что в списках: вид тайтла везде один. */
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

/** Сводка цифрами: одна карточка — одно число с подписью. */
interface Sum {
  key: string
  name: string
  value: string
}

const busy = ref(true)
const trouble = ref('')
const animeRows = ref<Row[]>([])
const mangaRows = ref<Row[]>([])
const sums = ref<Sum[]>([])
const total = ref(0)

const empty = computed(() => total.value === 0)

/** Записи полок вне реактивности: по ним плитки пересбираются после добора. */
let animeEntries: SnapshotEntry[] = []
let mangaEntries: SnapshotEntry[] = []

/** Номера идущих доборов: быстрый уход с главной гасит старую работу. */
let lookRun = 0
let titleRun = 0

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Короткая подпись под названием: вид и год. */
function factsText(look: MediaLook | null): string {
  if (look === null) return ''

  const parts: string[] = []
  const kindWord = formatWord(look.format)
  if (kindWord !== null) parts.push(kindWord)
  if (look.seasonYear !== null) parts.push(String(look.seasonYear))
  return parts.join(' · ')
}

/** Свой счёт частей на постере. */
function ownText(entry: SnapshotEntry, parts: number | null): string | null {
  const short = partsShort(entry.type)
  if (parts === null) return entry.progress > 0 ? `${entry.progress} ${short}` : null
  return `${entry.progress} / ${parts} ${short}`
}

/** Запись памяти в плитку полки. */
function toRow(entry: SnapshotEntry): Row {
  const look = peekLook(entry.mediaId)

  // У идущего сезона счёт идёт от вышедшего: объявленного итога ещё нет.
  const parts = partsOut(look, entry.type)
  const done =
    parts !== null && parts > 0 && entry.progress > 0 ? Math.min(1, entry.progress / parts) : 0

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
    done,
    cover: look?.cover ?? null,
    color: look?.color ?? null,
    adult: entry.isAdult,
  }
}

/** Что человек смотрит или читает сейчас, свежее — впереди. */
function pickShelf(type: MediaType, limit: number): SnapshotEntry[] {
  return selectEntries({ type, status: ['CURRENT', 'REPEATING'] }, { key: 'updated' }, { limit })
}

/** Сводка по памяти. Средняя с одним знаком: два здесь ничего не добавляют. */
function countSums(): Sum[] {
  const animeByStatus = countByStatus({ type: 'ANIME' })
  const mangaByStatus = countByStatus({ type: 'MANGA' })
  const mark = averageScore()

  return [
    { key: 'watch', name: 'Смотрю', value: String(animeByStatus.get('CURRENT') ?? 0) },
    { key: 'read', name: 'Читаю', value: String(mangaByStatus.get('CURRENT') ?? 0) },
    { key: 'done', name: 'Просмотрено', value: String(animeByStatus.get('COMPLETED') ?? 0) },
    { key: 'plan', name: 'В планах', value: String(animeByStatus.get('PLANNING') ?? 0) },
    { key: 'eps', name: 'Серий просмотрено', value: String(totalProgress({ type: 'ANIME' })) },
    { key: 'chs', name: 'Глав прочитано', value: String(totalProgress({ type: 'MANGA' })) },
    { key: 'mark', name: 'Средняя оценка', value: mark > 0 ? mark.toFixed(1) : '—' },
    { key: 'all', name: 'Записей всего', value: String(countEntries()) },
  ]
}

function redraw(): void {
  total.value = entryCount()
  sums.value = countSums()
  animeRows.value = animeEntries.map(toRow)
  mangaRows.value = mangaEntries.map(toRow)
}

/** Добирает обложки показанных полок: два вида — два запроса. */
async function fillLooks(): Promise<void> {
  const mine = ++lookRun

  const pairs: ReadonlyArray<{ type: MediaType; entries: SnapshotEntry[] }> = [
    { type: 'ANIME', entries: animeEntries },
    { type: 'MANGA', entries: mangaEntries },
  ]

  for (const pair of pairs) {
    const wanted = pair.entries
      .filter((entry) => peekLook(entry.mediaId) === null)
      .map((entry) => entry.mediaId)

    if (wanted.length === 0) continue

    try {
      await warmLooks(wanted, pair.type)
      if (mine !== lookRun) return

      redraw()
    } catch (e) {
      // Без обложки плитка останется с буквой названия — это не повод ругаться.
      Logger('WARN', 'Главная: обложки добрать не вышло', e)
    }
  }
}

/** Добирает русские названия верхним плиткам полки аниме. */
async function fillTitles(): Promise<void> {
  const mine = ++titleRun
  const wanted = animeEntries
    .slice(0, TITLE_DEPTH)
    .filter((entry) => peekRussianName(entry.mediaId) === null)
    .map((entry) => entry.mediaId)

  if (wanted.length === 0) return

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      if (mine !== titleRun) return

      await prefetchRussianTitles(wanted.slice(from, from + TITLE_CHUNK), 'ANIME')
      if (mine !== titleRun) return

      redraw()
    }
  } catch (e) {
    Logger('WARN', 'Главная: названия добрать не вышло', e)
  }
}

function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

function toLists(): void {
  navigate('lists')
}

function toSearch(): void {
  navigate('search')
}

function toSettings(): void {
  navigate('settings')
}

onMounted(() => {
  void (async () => {
    try {
      // Подъём снимка без сети: главная должна открываться и при лежащем API.
      await initCollection()

      animeEntries = pickShelf('ANIME', ANIME_SHELF)
      mangaEntries = pickShelf('MANGA', MANGA_SHELF)
      redraw()
    } catch (e) {
      trouble.value = describe(e)
      return
    } finally {
      busy.value = false
    }

    await fillLooks()
    await fillTitles()
  })()
})
</script>

<template>
  <section class="am-page">
    <div class="am-hey">
      <div class="am-hey__text">
        <h2 class="am-hey__title">С возвращением</h2>
        <p class="am-hey__sub">Продолжайте с того места, где остановились.</p>

        <div class="am-hey__acts">
          <button class="am-btn" type="button" @click="toLists">Мои списки</button>
          <button class="am-btn am-btn--ghost" type="button" @click="toSearch">Найти тайтл</button>
        </div>
      </div>
    </div>

    <p v-if="trouble" class="am-error">{{ trouble }}</p>

    <ul v-if="!empty" class="am-nums">
      <li v-for="sum in sums" :key="sum.key" class="am-num">
        <span class="am-num__value">{{ sum.value }}</span>
        <span class="am-num__name">{{ sum.name }}</span>
      </li>
    </ul>

    <div v-if="busy" class="am-shelf">
      <ul class="am-rail">
        <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
          <span class="am-skeleton am-hold__art" />
          <span class="am-skeleton am-hold__line" />
        </li>
      </ul>
    </div>

    <div v-else-if="empty" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">✧</span>
      <span>Здесь появятся тайтлы, которые вы смотрите и читаете.</span>
      <span>Найдите тайтл и добавьте к себе: список ведётся здесь, без всяких входов.</span>

      <div class="am-empty__acts">
        <button class="am-btn" type="button" @click="toSearch">Найти тайтл</button>
        <button class="am-btn am-btn--ghost" type="button" @click="toSettings">
          Перенести список с AniList
        </button>
      </div>
    </div>

    <template v-else>
      <section v-if="animeRows.length > 0" class="am-shelf">
        <div class="am-bar">
          <h2 class="am-h2">Продолжаю смотреть</h2>
          <span class="am-bar__gap" />
          <button class="am-btn am-btn--ghost" type="button" @click="toLists">Все списки</button>
        </div>

        <ul class="am-rail">
          <MediaTile
            v-for="row in animeRows"
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
      </section>

      <section v-if="mangaRows.length > 0" class="am-shelf">
        <div class="am-bar">
          <h2 class="am-h2">Читаю сейчас</h2>
          <span class="am-bar__gap" />
          <button class="am-btn am-btn--ghost" type="button" @click="toLists">К манге</button>
        </div>

        <ul class="am-rail">
          <MediaTile
            v-for="row in mangaRows"
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
      </section>

      <div v-if="animeRows.length === 0 && mangaRows.length === 0" class="am-empty">
        <span class="am-empty__mark" aria-hidden="true">▷</span>
        <span>В закладках «Смотрю» и «Читаю» пусто.</span>
        <span>Откройте списки и выберите, что смотреть дальше.</span>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* Приветственная полоса: первое, что видно при запуске. */
.am-hey {
  position: relative;
  overflow: hidden;
  padding: 30px 32px;
  background:
    radial-gradient(700px 320px at 88% -30%, rgba(164, 134, 255, 0.22), transparent 65%),
    linear-gradient(120deg, #16223a, #0d131d 62%);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-xl);
  box-shadow: var(--am-sh-2);
}

.am-hey__text {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 74ch;
}

.am-hey__title {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.am-hey__sub {
  margin: 0;
  color: var(--am-dim);
}

.am-hey__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}

/* Кнопки в пустом состоянии: выход есть сразу, а не в совете текстом. */
.am-empty__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  margin-top: 6px;
}

/* Сводка цифрами: сама раскладывается по ширине окна. */
.am-nums {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.am-num {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 16px;
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-m);
}

.am-num__value {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.am-num__name {
  font-size: 12.5px;
  color: var(--am-dim);
}

.am-shelf {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Постер на полке всегда одного размера: две записи
   не должны раздуваться на всю ширину окна. */
.am-rail {
  grid-auto-columns: 152px;
  justify-content: start;
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
</style>
