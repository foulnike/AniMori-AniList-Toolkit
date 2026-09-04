<script setup lang="ts">
// Главная — витрина рекомендаций (пункт 3.11). Своя полка идёт из памяти
// коллекции, витрина каталога — через core/recs: сети экран не знает.
// Статистика с главной убрана: сводке найдầтся своё место отдельно.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { MediaBrief } from '@/api/anilist-media'
import { setupVideoSources } from '@/api/video-sources'
import { initCollection } from '@/core/collection'
import { selectEntries } from '@/core/collection-view'
import {
  notOutYet,
  partsOut,
  peekLook,
  SOON_STATUS,
  warmLooks,
  type MediaLook,
} from '@/core/media-looks'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import {
  onPlayableChange,
  peekPlayable,
  primePlayable,
  warmPlayable,
  type PlayAsk,
  type PlayState,
} from '@/core/playable'
import { hideRec, motifShelf, recShelf, tasteShelf } from '@/core/recs'
import type { SnapshotEntry } from '@/core/snapshot'
import { Logger } from '@/utils/logger'

import MediaTile from '../components/MediaTile.vue'
import { formatWord, GENRE_CHOICES, genreWord, partsShort } from '../labels'
import { navigate } from '../router'
import { toPlayAsk, toTileRow, type TileRow } from '../tile-row'
import { homeGenre } from './home-keep'

/** Сколько постеров класть на свою полку. */
const SHELF_SIZE = 14

/** Скольким плиткам добирать русские названия и по скольку за заход. */
const TITLE_DEPTH = 12
const TITLE_CHUNK = 6

/** Сколько заглушек держать на время подъёма снимка. */
const HOLD_COUNT = 7

/** Ниже этого числа плиток полка не показывается: огрызок из одной-двух
    картинок после чистки повторов выглядит ошибкой загрузки. */
const SHELF_MIN = 3

/** Плитка своей полки. Тот же вид, что в списках: вид тайтла везде один. */
interface Row {
  mediaId: number
  title: string
  facts: string
  mark: string | null
  own: string | null
  done: number
  soon: boolean
  play: PlayState | null
  cover: string | null
  color: string | null
  adult: boolean
}

/** Полка витрины в показе: заголовок и готовые плитки. */
interface Shelf {
  key: string
  title: string
  rows: TileRow[]
}

/** Описание полки витрины: что грузить и как назвать. */
interface ShelfDef {
  key: string
  title: string
  load: () => Promise<MediaBrief[]>
}

const busy = ref(true)
const trouble = ref('')
const ownRows = ref<Row[]>([])
const recs = ref<Shelf[]>([])
const recsPending = ref(false)

/** Записи своей полки вне реактивности: плитки пересобираются после добора. */
let ownEntries: SnapshotEntry[] = []

/** Приехавшие полки витрины и их порядок: плитки собираются на показ. */
const staged = new Map<string, MediaBrief[]>()
let activeDefs: ShelfDef[] = []

/** Номера идущих доборов: смена отбора гасит старую работу. */
let lookRun = 0
let titleRun = 0
let playRun = 0
let recsRun = 0

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
  const short = partsShort()
  if (parts === null) return entry.progress > 0 ? `${entry.progress} ${short}` : null
  return `${entry.progress} / ${parts} ${short}`
}

/**
 * Вопрос об источниках по записи своей полки. Имён берётся столько, сколько
 * есть: снимок хранит латиницу, облик — романдзи, датасет — русское имя,
 * и любое из них может оказаться единственным, по которому источник найдёт
 * тайтл. Номер MAL у записи бывает пустым: снимки до шестой версии его
 * не хранили, и тогда Kodik остаётся ни при чём.
 */
function playAskOf(entry: SnapshotEntry): PlayAsk {
  const look = peekLook(entry.mediaId)
  const names = [
    ...new Set([
      entry.romaji ?? '',
      entry.english ?? '',
      look?.romaji ?? '',
      peekRussianName(entry.mediaId) ?? '',
    ]),
  ]

  return {
    mediaId: entry.mediaId,
    malId: entry.malId ?? null,
    titles: names.filter((name) => name !== ''),
    year: look?.seasonYear ?? undefined,
  }
}

/** Строчка ряда с полки своего списка. */
function toRow(entry: SnapshotEntry): Row {
  const look = peekLook(entry.mediaId)

  // У идущего сезона итога может не быть вовсе: считаем по вышедшему.
  const parts = partsOut(look)
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
    soon: notOutYet(look),
    play: peekPlayable(entry.mediaId),
    cover: look?.cover ?? null,
    color: look?.color ?? null,
    adult: entry.isAdult,
  }
}

/** Пересобирает плитки своей полки из памяти. */
function redrawOwn(): void {
  ownRows.value = ownEntries.map(toRow)
}

/** Добирает обложки своей полки: снимок картинок не хранит. */
async function fillLooks(): Promise<void> {
  const mine = ++lookRun
  const wanted = ownEntries
    .filter((entry) => peekLook(entry.mediaId) === null)
    .map((entry) => entry.mediaId)

  if (wanted.length === 0) return

  try {
    await warmLooks(wanted)
    if (mine !== lookRun) return

    redrawOwn()
  } catch (e) {
    // Без обложки плитка останется с буквой названия — это не повод ругаться.
    Logger('WARN', 'Главная: обложки добрать не вышло', e)
  }
}

/** Добирает русские названия верхним плиткам своей полки. */
async function fillTitles(): Promise<void> {
  const mine = ++titleRun
  const wanted = ownEntries
    .slice(0, TITLE_DEPTH)
    .filter((entry) => peekRussianName(entry.mediaId) === null)
    .map((entry) => entry.mediaId)

  if (wanted.length === 0) return

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      if (mine !== titleRun) return

      // Полке нужно только имя: описание и оценки спросит открытая карточка.
      await prefetchRussianNames(wanted.slice(from, from + TITLE_CHUNK))
      if (mine !== titleRun) return

      redrawOwn()
    }
  } catch (e) {
    Logger('WARN', 'Главная: названия добрать не вышло', e)
  }
}

/**
 * Ставит метку «Есть видео» на свою полку: сначала подъём склада по всей
 * полке даром, потом вопрос источникам про всё остальное.
 *
 * Полка короткая — четырнадцать постеров, — и она про «что смотреть
 * сейчас»: резать её по шести было нечем оправдать даже при старом
 * штучном вопросе, а с очередью и оптом — тем более.
 */
async function fillOwnPlay(): Promise<void> {
  const mine = ++playRun
  if (ownEntries.length === 0) return

  try {
    const primed = await primePlayable(ownEntries.map((entry) => entry.mediaId))
    if (mine !== playRun) return
    if (primed > 0) redrawOwn()

    const asks = ownEntries
      .filter((entry) => peekPlayable(entry.mediaId) === null)
      .map(playAskOf)

    if (asks.length === 0) return

    // Реестр источников собирает не ядро, а слой api, и до плеера человек
    // может и не дойти. Повторный зов ничего не стоит: сборка идёт один раз.
    setupVideoSources()

    await warmPlayable(asks)
    if (mine !== playRun) return

    redrawOwn()
  } catch (e) {
    // Без ответа плитка останется без метки, а не с ложной: так и задумано.
    Logger('WARN', 'Главная: метки своей полки не доехали', e)
  }
}

/** Своя полка: продолжение просмотра и пересмотра. */
function buildOwn(): void {
  ownEntries = selectEntries(
    { status: ['CURRENT', 'REPEATING'] },
    { key: 'updated' },
    { limit: SHELF_SIZE },
  )
  redrawOwn()
  void fillLooks()
  void fillTitles()
  void fillOwnPlay()
}

/** Состав витрины. Порядок важен дважды: по нему полки стоят на экране
    и по нему же решается, кому достанется тайтл при повторе. Нажатый жанр —
    явная просьба хозяина, поэтому он впереди всего и замещает три полки
    каталога. */
function shelfDefs(): ShelfDef[] {
  const genre = homeGenre.value
  if (genre !== '') {
    return [
      {
        key: 'genre',
        title: `Жанр: ${genreWord(genre) ?? genre}`,
        load: () => recShelf('genre', [genre]),
      },
      { key: 'taste', title: 'Под ваш вкус', load: () => tasteShelf() },
      { key: 'motif', title: 'По мотивам вашего списка', load: () => motifShelf() },
    ]
  }

  return [
    { key: 'taste', title: 'Под ваш вкус', load: () => tasteShelf() },
    { key: 'motif', title: 'По мотивам вашего списка', load: () => motifShelf() },
    { key: 'airing', title: 'Сейчас выходит', load: () => recShelf('airing') },
    { key: 'trending', title: 'В тренде', load: () => recShelf('trending') },
    { key: 'top', title: 'Лучшее за всё время', load: () => recShelf('top') },
  ]
}

/** Собирает полки в показ: приехавшее встаёт на своё место в порядке состава.
    Тайтл показывается ровно на одной полке: «тренд», «лучшее» и жанровые
    подборки у каталога пересекаются почти наполовину, и витрина читалась
    одним и тем же рядом под разными заголовками. */
function publish(): void {
  const out: Shelf[] = []
  const seen = new Set<number>()

  for (const def of activeDefs) {
    const items = staged.get(def.key)
    if (items === undefined || items.length === 0) continue

    const fresh = items.filter((brief) => !seen.has(brief.mediaId))
    if (fresh.length < SHELF_MIN) continue

    for (const brief of fresh) seen.add(brief.mediaId)
    out.push({ key: def.key, title: def.title, rows: fresh.map(toTileRow) })
  }

  recs.value = out
}

// Очередь доступности отвечает вразброд и по одному тайтлу, причём один
// и тот же ответ часто касается разу и своей полки, и витрины: рисуем обе.
const stopPlayWatch = onPlayableChange(() => {
  redrawOwn()
  publish()
})

/** Добирает русские названия плиткам полки витрины. */
async function warmRecTitles(mine: number, key: string): Promise<void> {
  const items = staged.get(key)
  if (items === undefined) return

  const wanted = items
    .filter((brief) => peekRussianName(brief.mediaId) === null)
    .map((brief) => brief.mediaId)

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      if (mine !== recsRun) return

      await prefetchRussianNames(wanted.slice(from, from + TITLE_CHUNK))
      if (mine !== recsRun) return

      publish()
    }
  } catch (e) {
    Logger('WARN', 'Главная: названия витрины добрать не вышло', e)
  }
}

/**
 * Ставит метку «Есть видео» на полку витрины.
 *
 * Сначала склад: он отвечает даром и разом по всей полке, потом сеть —
 * всем остальным плиткам без потолка и без общего бюджета захода.
 * Именно эти два потолка давали «десяток меток и тишина»: двадцать
 * вопросов на шесть полок заканчивались на второй же полке. Темп теперь
 * держит очередь ядра: она одна на приложение, спрашивает оптом и сама
 * раскладывает вопросы во времени.
 *
 * Анонсы не спрашиваются вовсе: у них не вышло ни одной части, и ответ
 * известен заранее.
 */
async function warmRecPlay(mine: number, key: string): Promise<void> {
  const items = staged.get(key)
  if (items === undefined) return

  try {
    const primed = await primePlayable(items.map((brief) => brief.mediaId))
    if (mine !== recsRun) return
    if (primed > 0) publish()
  } catch (e) {
    Logger('WARN', 'Главная: склад доступности не поднялся', e)
  }

  const asks: PlayAsk[] = items
    .filter((brief) => brief.status !== SOON_STATUS && peekPlayable(brief.mediaId) === null)
    .map(toPlayAsk)

  if (asks.length === 0) return

  try {
    // Реестр источников собирает не ядро, а слой api, и до плеера человек может
    // и не дойти. Повторный зов ничего не стоит: сборка идёт один раз за запуск.
    setupVideoSources()

    await warmPlayable(asks)
    if (mine !== recsRun) return

    publish()
  } catch (e) {
    // Без ответа плитка останется без метки, а не с ложной: так и задумано.
    Logger('WARN', 'Главная: метки доступности не доехали', e)
  }
}

/** Добор одной полки: сначала имена, потом метки. Имя важнее: без него
    плитку не узнать вовсе, а без метки она просто молчит. */
async function warmRecShelf(mine: number, key: string): Promise<void> {
  await warmRecTitles(mine, key)
  await warmRecPlay(mine, key)
}

/** Полки витрины: каждая встаёт сама по готовности. */
function loadRecs(): void {
  const mine = ++recsRun
  staged.clear()
  recs.value = []
  activeDefs = shelfDefs()
  recsPending.value = true

  const tasks = activeDefs.map((def) =>
    def
      .load()
      .then((items) => {
        if (mine !== recsRun || items.length === 0) return
        staged.set(def.key, items)
        publish()
        void warmRecShelf(mine, def.key)
      })
      .catch((e) => {
        Logger('WARN', `Главная: полка «${def.key}» не доехала`, e)
      }),
  )

  void Promise.allSettled(tasks).then(() => {
    if (mine === recsRun) recsPending.value = false
  })
}

/** Прячет тайтл из витрины: из памяти сразу, в хранилище — вдогонку. */
function hideOne(mediaId: number): void {
  void hideRec(mediaId)
  for (const items of staged.values()) {
    const at = items.findIndex((brief) => brief.mediaId === mediaId)
    if (at >= 0) items.splice(at, 1)
  }
  publish()
}

/** Чип жанра: повторное нажатие снимает отбор. */
function toggleGenre(genre: string): void {
  homeGenre.value = homeGenre.value === genre ? '' : genre
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
    } catch (e) {
      trouble.value = describe(e)
      busy.value = false
      return
    }

    busy.value = false
    buildOwn()
    loadRecs()
  })()
})

onBeforeUnmount(() => {
  lookRun++
  titleRun++
  playRun++
  recsRun++

  // Очередь живёт дольше экрана: неснятая подписка держала бы всю витрину
  // в памяти и пересобирала её на каждый ответ чужого экрана.
  stopPlayWatch()
})

// Страж busy не пускает пересборку до подъёма снимка: иначе витрина встанет на пустом списке.
watch(homeGenre, () => {
  if (busy.value) return
  loadRecs()
})
</script>

<template>
  <section class="am-page">
    <div class="am-hey">
      <span class="am-hey__blob am-hey__blob--a" aria-hidden="true" />
      <span class="am-hey__blob am-hey__blob--b" aria-hidden="true" />

      <div class="am-hey__text">
        <h2 class="am-hey__title">С возвращением</h2>

        <div class="am-hey__acts">
          <button class="am-btn am-btn--soft" type="button" @click="toLists">Мои списки</button>
          <button class="am-btn am-btn--ghost" type="button" @click="toSearch">Найти тайтл</button>
        </div>
      </div>
    </div>

    <p v-if="trouble" class="am-error">{{ trouble }}</p>

    <!-- Внутренний ряд нужен для центровки: сам прокрутчик шириной во всю
         страницу, а ряд — ровно по содержимому. -->
    <div class="am-choose">
      <div class="am-choose__row">
        <button
          v-for="genre in GENRE_CHOICES"
          :key="genre"
          class="am-chip"
          :class="{ 'am-chip--on': homeGenre === genre }"
          type="button"
          @click="toggleGenre(genre)"
        >
          {{ genreWord(genre) }}
        </button>
      </div>
    </div>

    <div v-if="busy" class="am-shelf">
      <ul class="am-rail">
        <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
          <span class="am-skeleton am-hold__art" />
          <span class="am-skeleton am-hold__line" />
        </li>
      </ul>
    </div>

    <template v-else>
      <section v-if="ownRows.length > 0" class="am-shelf am-shelf--mine">
        <div class="am-bar">
          <h2 class="am-h2">Продолжаю смотреть</h2>
          <span class="am-bar__gap" />
          <button class="am-btn am-btn--ghost" type="button" @click="toLists">К спискам</button>
        </div>

        <ul class="am-rail">
          <MediaTile
            v-for="row in ownRows"
            :key="row.mediaId"
            :title="row.title"
            :facts="row.facts"
            :cover="row.cover"
            :color="row.color"
            :mark="row.mark"
            :own="row.own"
            :done="row.done"
            :soon="row.soon"
            :play="row.play"
            :adult="row.adult"
            @open="open(row.mediaId)"
          />
        </ul>
      </section>

      <section v-for="shelf in recs" :key="shelf.key" class="am-shelf">
        <div class="am-bar">
          <h2 class="am-h2">{{ shelf.title }}</h2>
        </div>

        <ul class="am-rail">
          <MediaTile
            v-for="row in shelf.rows"
            :key="row.mediaId"
            :title="row.title"
            :facts="row.facts"
            :cover="row.cover"
            :color="row.color"
            :score="row.score"
            :mark="row.mark"
            :repeat="row.repeat"
            :note="row.note"
            :own="row.own"
            :done="row.done"
            :soon="row.soon"
            :play="row.play"
            :adult="row.adult"
            hidable
            @open="open(row.mediaId)"
            @hide="hideOne(row.mediaId)"
          />
        </ul>
      </section>

      <div v-if="!recsPending && ownRows.length === 0 && recs.length === 0" class="am-empty">
        <span class="am-empty__mark" aria-hidden="true">✧</span>
        <span>Свой список пуст, а каталог не ответил.</span>
        <span>Когда сеть вернётся, здесь появятся рекомендации.</span>

        <div class="am-empty__acts">
          <button class="am-btn" type="button" @click="toSearch">Найти тайтл</button>
          <button class="am-btn am-btn--ghost" type="button" @click="toSettings">
            Перенести список с AniList
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* Приветствие: первое, что видно при запуске. Форма — лист, а не карточка:
   один угол срезан и полоса перестаёт быть прямоугольником среди прямоугольников. */
.am-hey {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  padding: clamp(24px, 3.4vw, 40px) clamp(24px, 3.6vw, 44px);
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-leaf);
  box-shadow:
    var(--am-sh-2),
    inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur-strong)) saturate(1.5);
}

/* Две капли под стеклом: без них размывать нечего и панель выглядит
   грязным серым прямоугольником. Форма текучая и медленно ездит. */
.am-hey__blob {
  position: absolute;
  z-index: -1;
  border-radius: var(--am-r-blob);
  filter: blur(42px);
  pointer-events: none;
}

.am-hey__blob--a {
  top: -40%;
  right: -6%;
  width: 46%;
  height: 210%;
  background: rgb(var(--am-accent-2-rgb) / 0.34);
  animation: am-hey-float var(--am-drift) var(--am-ease-soft) infinite alternate;
}

.am-hey__blob--b {
  bottom: -80%;
  left: 12%;
  width: 34%;
  height: 170%;
  background: rgb(var(--am-accent-rgb) / 0.3);
  animation: am-hey-float calc(var(--am-drift) * 1.4) var(--am-ease-soft) infinite alternate-reverse;
}

@keyframes am-hey-float {
  from {
    transform: translate3d(-6%, -4%, 0) scale(1);
  }
  to {
    transform: translate3d(7%, 5%, 0) scale(1.14);
  }
}

.am-hey__text {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 74ch;
}

.am-hey__title {
  margin: 0;
  font-size: clamp(24px, 2.6vw, 34px);
  font-weight: 700;
  letter-spacing: -0.025em;
}

.am-hey__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

/* Жанры одной лентой: восемнадцать чипов переносом занимали три строки
   и уводили первую полку за сгиб. Края растворяются маской: обрезанный
   по краю чип честно говорит, что ряд прокручивается. */
.am-choose {
  display: flex;
  padding: 2px 0;
  overflow-x: auto;
  scrollbar-width: none;
  mask-image: linear-gradient(90deg, transparent, #000 18px, #000 calc(100% - 28px), transparent);
  overscroll-behavior-x: contain;
}

.am-choose::-webkit-scrollbar {
  height: 0;
}

/* Центровка автоотступами, а не justify-content: когда лента шире экрана,
   автоотступ обращается в нуль и начало ряда остаётся доступным прокруткой,
   а центрованный флекс в этом случае срезал бы первые жанры насовсем. */
.am-choose__row {
  display: flex;
  gap: 8px;
  width: max-content;
  margin-inline: auto;
}

.am-choose .am-chip {
  flex: 0 0 auto;
}

/* Кнопки в пустом состоянии: выход есть сразу, а не в совете текстом. */
.am-empty__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  margin-top: 6px;
}

.am-shelf {
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: am-shelf-in var(--am-slow) var(--am-ease) both;
}

@keyframes am-shelf-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Своя полка важнее советов каталога, поэтому лежит на стекле:
   раньше все полки были одного веса и глаз не знал, где своё. */
.am-shelf--mine {
  padding: 16px 18px 8px;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-drop);
  box-shadow: inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur)) saturate(1.4);
}

/* Заголовок полки с акцентной засечкой: шесть одинаковых заголовков
   подряд читались сплошным текстом. */
.am-shelf .am-h2 {
  display: flex;
  gap: 10px;
  align-items: center;
}

.am-shelf .am-h2::before {
  width: 3px;
  height: 15px;
  content: '';
  background: linear-gradient(180deg, var(--am-accent), var(--am-accent-2));
  border-radius: var(--am-r-cap);
}

.am-rail {
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
