<script setup lang="ts">
// Пункт 3.5: списки одним экраном на оба вида. Данные, обновление и
// снимок у аниме и манги общие, разные только подписи и счёт частей.
// Здесь же поиск по своему списку и порядок показа: и то и другое про список.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

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
import { formatWord, partsShort, statusList } from '../labels'
import { navigate } from '../router'

/**
 * Сколько записей рисуется за раз и на сколько растёт потолок при доборе.
 * Полный список бывает на тысячи записей, а каждая требует обложки
 * и русского названия, поэтому сразу всё мы не рисуем.
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

/** За сколько до конца списка заказывать добор: раньше видного края. */
const TAIL_MARGIN = '600px'

/** Подвкладки вида. Сервер знает только эти два типа записей. */
const KIND_TABS: ReadonlyArray<{ key: MediaType; title: string }> = [
  { key: 'ANIME', title: 'Аниме' },
  { key: 'MANGA', title: 'Манга' },
]

/** Порядки показа. Все считаются на месте: сети сортировка не требует. */
type SortName = 'updated' | 'score' | 'rating' | 'nameUp' | 'nameDown' | 'parts'

const SORT_TABS: ReadonlyArray<{ key: SortName; title: string }> = [
  { key: 'updated', title: 'Свежие правки' },
  { key: 'score', title: 'Своя оценка' },
  { key: 'rating', title: 'Оценка каталога' },
  { key: 'nameUp', title: 'Название А—Я' },
  { key: 'nameDown', title: 'Название Я—А' },
  { key: 'parts', title: 'Счёт частей' },
]

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
const sortKey = ref<SortName>('updated')
const word = ref('')
const rows = ref<Row[]>([])
const counts = ref<Map<string, number>>(new Map())
const total = ref(0)

/**
 * Сколько строк показываем сейчас. Растёт шагом PAGE_LIMIT по добору,
 * а на любой смене отбора возвращается к первой сотне.
 */
const limit = ref(PAGE_LIMIT)

/** Сколько строк отобралось до обрезки потолком. */
const picked = ref(0)

/** Метка конца списка: по её появлению в окне заказывается добор. */
const tailMark = ref<HTMLElement | null>(null)

/** Подписи закладок зависят только от вида. */
const statusTabs = computed(() => statusList(kind.value))
const searching = computed(() => word.value.trim() !== '')
const shown = computed(() =>
  searching.value ? total.value : (counts.value.get(activeStatus.value) ?? 0),
)

/** Остался ли хвост за потолком. */
const hasMore = computed(() => picked.value > rows.value.length)

/** Сколько ещё скрыто: число на кнопке честнее голого «ещё». */
const restCount = computed(() => Math.max(0, picked.value - rows.value.length))

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

/** Смотритель за меткой конца списка. */
let watcher: IntersectionObserver | null = null

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Короткая подпись под названием: вид и год. Больше в две строки не влезает. */
function factsText(look: MediaLook | null): string {
  if (look === null) return ''

  const parts: string[] = []

  const kindWord = formatWord(look.format)
  if (kindWord !== null) parts.push(kindWord)
  if (look.seasonYear !== null) parts.push(String(look.seasonYear))

  return parts.join(' · ')
}

/** Свой счёт частей на постере. Неизвестный итог не выдумывается. */
function ownText(entry: SnapshotEntry, parts: number | null): string | null {
  const short = partsShort(entry.type)
  if (parts === null) return entry.progress > 0 ? `${entry.progress} ${short}` : null
  return `${entry.progress} / ${parts} ${short}`
}

/** Доля пройденного для полосы. Завершённое залито целиком даже без итога. */
function donePart(entry: SnapshotEntry, parts: number | null): number {
  if (entry.status === 'COMPLETED') return 1
  if (parts === null || parts <= 0 || entry.progress <= 0) return 0
  return Math.min(1, entry.progress / parts)
}

/**
 * Название записи: русское, латиница, английское, номер. Номер остаётся
 * только у записи, созданной правкой до ответа сервера.
 */
function titleOf(entry: SnapshotEntry): string {
  return (
    peekRussianName(entry.mediaId) ??
    entry.romaji ??
    entry.english ??
    peekLook(entry.mediaId)?.romaji ??
    `Тайтл #${entry.mediaId}`
  )
}

/** Средняя оценка каталога для порядка: неизвестная уходит в конец. */
function ratingOf(entry: SnapshotEntry): number {
  return peekLook(entry.mediaId)?.averageScore ?? -1
}

/**
 * Порядок показа. Названия сравниваются по-русски, поэтому список может
 * слегка переставиться, когда доберутся переводы: до них сравнивать нечего.
 */
function sortEntries(list: SnapshotEntry[]): SnapshotEntry[] {
  const out = [...list]

  switch (sortKey.value) {
    case 'score':
      out.sort((a, b) => b.score10 - a.score10 || b.updatedAt - a.updatedAt)
      break
    case 'rating':
      out.sort((a, b) => ratingOf(b) - ratingOf(a) || b.updatedAt - a.updatedAt)
      break
    case 'parts':
      out.sort((a, b) => b.progress - a.progress || b.updatedAt - a.updatedAt)
      break
    case 'nameUp':
      out.sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'ru'))
      break
    case 'nameDown':
      out.sort((a, b) => titleOf(b).localeCompare(titleOf(a), 'ru'))
      break
    default:
      out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  return out
}

/** Запись памяти в плитку. */
function toRow(entry: SnapshotEntry): Row {
  const look = peekLook(entry.mediaId)
  const parts = entry.type === 'MANGA' ? (look?.chapters ?? null) : (look?.episodes ?? null)

  return {
    mediaId: entry.mediaId,
    title: titleOf(entry),
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
 * Снимает кусок коллекции в свои плитки. При идущем поиске плитки берутся
 * из находок: закладка тогда не главная, а слово главное. Порядок выбирает
 * человек, поэтому потолок отрезается уже после сортировки всей закладки.
 */
function redraw(): void {
  counts.value = countByStatus({ type: kind.value })
  total.value = countEntries({ type: kind.value })

  const list = searching.value
    ? foundEntries
    : selectEntries({ type: kind.value, status: [activeStatus.value] })

  picked.value = list.length
  rows.value = sortEntries(list).slice(0, limit.value).map(toRow)
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

/** Возврат к первой сотне: любая смена отбора начинает показ сначала. */
function resetLimit(): void {
  limit.value = PAGE_LIMIT
}

/** Добор следующей сотни. За концом списка ничего не делает. */
function showMore(): void {
  if (!hasMore.value) return

  limit.value += PAGE_LIMIT
  refill()
}

/**
 * Отбор по слову по всем закладкам выбранного вида. Сети не требует,
 * но на кириллице сначала поднимает склад русских названий.
 */
async function runSearch(): Promise<void> {
  const mine = ++searchRun
  const asked = word.value.trim()

  resetLimit()

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
  resetLimit()
  refill()
}

/** Переключение вида. Сети не требует: в памяти лежат оба вида сразу. */
function pickKind(next: MediaType): void {
  if (kind.value === next) return

  kind.value = next
  activeStatus.value = 'CURRENT'
  resetLimit()

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
  resetLimit()
  refill()
}

/** Смена порядка: пересобираем показ, новым строкам нужны обложки и названия. */
function pickSort(): void {
  resetLimit()
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
  // Смотритель за концом списка: добор заказывается заранее, до самого края.
  // На старых окружениях смотрителя может не быть: останется кнопка.
  if (tailMark.value !== null && typeof IntersectionObserver !== 'undefined') {
    watcher = new IntersectionObserver(
      (marks) => {
        if (marks.some((mark) => mark.isIntersecting)) showMore()
      },
      { rootMargin: TAIL_MARGIN },
    )

    watcher.observe(tailMark.value)
  }

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

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)

  watcher?.disconnect()
  watcher = null
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

      <label class="am-sort">
        <span class="am-sort__name">Порядок</span>
        <select v-model="sortKey" class="am-sort__pick" @change="pickSort">
          <option v-for="item in SORT_TABS" :key="item.key" :value="item.key">
            {{ item.title }}
          </option>
        </select>
      </label>

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
      <span>Попробуйте поискать в каталоге.</span>
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

    <!-- Метка конца списка живёт всегда: смотритель берёт её один раз при сборке. -->
    <div ref="tailMark" class="am-tail">
      <button v-if="hasMore" class="am-btn am-btn--soft" type="button" @click="showMore">
        Показать ещё · осталось {{ restCount }}
      </button>
    </div>

    <p class="am-meta">
      Всего {{ total }} · показано {{ rows.length }} из {{ shown }}
      <template v-if="looksBusy"> · обложки грузятся…</template>
      <template v-if="titlesBusy"> · названия грузятся…</template>
    </p>
  </section>
</template>

<style scoped>
.am-sort {
  display: inline-flex;
  flex: none;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  color: var(--am-dim);
}

.am-sort__pick {
  padding: 8px 14px;
  font: inherit;
  font-size: 13px;
  color: var(--am-text);
  cursor: pointer;
  background: var(--am-panel-2);
  border: 1px solid var(--am-line);
  border-radius: 999px;
}

.am-sort__pick:hover {
  background: var(--am-hover);
}

/* Конец списка: место под кнопку добора и сама метка для смотрителя. */
.am-tail {
  display: flex;
  justify-content: center;
  min-height: 8px;
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
