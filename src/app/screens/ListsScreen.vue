<script setup lang="ts">
// Пункт 3.5: свой список одним экраном. Данные, обновление и снимок лежат
// в коллекции, сборка строки с порядком показа и доборами — в lists-row.
// Здесь остаётся отбор: закладка, слово, потолок показа и перенос с AniList.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { initCollection, refreshFromServer } from '@/core/collection'
import { countByStatus, countEntries, selectEntries } from '@/core/collection-view'
import { startEditSender } from '@/core/edit-sender'
import { searchOwnList } from '@/core/media-search'
import type { SnapshotEntry } from '@/core/snapshot'
import { Logger } from '@/utils/logger'

import MediaTile from '../components/MediaTile.vue'
import { statusList } from '../labels'
import { navigate } from '../router'

import { keptSort, keptStatus, keptWord, type SortName } from './lists-keep'
import { sortEntries, toRow, useRowWarm, type Row } from './lists-row'

/**
 * Сколько записей рисуется за раз и на сколько растёт потолок при доборе.
 * Полный список бывает на тысячи записей, а каждая требует обложки
 * и русского названия, поэтому сразу всё мы не рисуем.
 */
const PAGE_LIMIT = 100

/** Сколько найденного показывать. Слово из двух букв иначе вывалит весь список. */
const FOUND_LIMIT = 60

/** Пауза после последнего нажатия. Поиск идёт в памяти, поэтому пауза короткая. */
const TYPING_PAUSE_MS = 250

/** Сколько плиток-заглушек показать на время подъёма списка. */
const HOLD_COUNT = 18

/** За сколько до конца списка заказывать добор: раньше видного края. */
const TAIL_MARGIN = '600px'

/** Порядки показа. Все считаются на месте: сети сортировка не требует. */
const SORT_TABS: ReadonlyArray<{ key: SortName; title: string }> = [
  { key: 'updated', title: 'Свежие правки' },
  { key: 'score', title: 'Своя оценка' },
  { key: 'rating', title: 'Оценка каталога' },
  { key: 'nameUp', title: 'Название А—Я' },
  { key: 'nameDown', title: 'Название Я—А' },
]

/** Идёт ли работа со списком: подъём снимка или ответ сервера. */
const busy = ref(true)

/** Идёт ли отбор по слову. На кириллице перед отбором поднимается склад. */
const searchBusy = ref(false)

const trouble = ref('')

/**
 * Исход переноса словами. Перенос бывает раз в месяц, и человек должен
 * увидеть, что он случился: молча меняется слишком много.
 */
const note = ref('')

/**
 * Спрошено ли подтверждение переноса. Замена списка целиком не делается
 * одним промахом мыши, поэтому кнопка сначала спрашивает.
 */
const asking = ref(false)

// Закладка, порядок и слово берутся из памяти между показами:
// иначе возврат с карточки открывал чужую закладку.
const activeStatus = keptStatus
const sortKey = keptSort
const word = keptWord

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

/** Закладки статуса. Список теперь одного вида, и подписи у него одни. */
const statusTabs = statusList('ANIME')

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

/** Номер идущего поиска: старый видит, что его ответ больше не нужен. */
let searchRun = 0

/** Таймер паузы набора. */
let timer: ReturnType<typeof setTimeout> | null = null

/** Смотритель за меткой конца списка. */
let watcher: IntersectionObserver | null = null

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Снимает кусок коллекции в свои плитки. При идущем поиске плитки берутся
 * из находок: закладка тогда не главная, а слово главное. Порядок выбирает
 * человек, поэтому потолок отрезается уже после сортировки всей закладки.
 */
function redraw(): void {
  counts.value = countByStatus({ type: 'ANIME' })
  total.value = countEntries({ type: 'ANIME' })

  const list = searching.value
    ? foundEntries
    : selectEntries({ type: 'ANIME', status: [activeStatus.value] })

  picked.value = list.length
  rows.value = sortEntries(list, sortKey.value).slice(0, limit.value).map(toRow)
}

// Доборы обложек и названий живут рядом со сборкой строки: экран отдаёт
// свои строки и перерисовку. Флажки нужны подвалу и кнопок не держат.
const { looksBusy, titlesBusy, fillLooks, fillTitles } = useRowWarm(rows, redraw)

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
 * Отбор по слову по всем закладкам сразу. Сети не требует,
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
    const found = await searchOwnList(asked, 'ANIME', FOUND_LIMIT)
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
 * Переносит список с AniList с заменой местного. Зовётся только из
 * подтверждения: сам по себе экран в сеть за списком не ходит.
 *
 * Отказ показанные данные не стирает: у нас остаётся прежний снимок.
 */
async function pull(): Promise<void> {
  busy.value = true
  trouble.value = ''
  note.value = ''

  try {
    const count = await refreshFromServer()
    refill()
    note.value = `Список перенесён с AniList: записей ${count}.`
  } catch (e) {
    trouble.value = describe(e)
  } finally {
    busy.value = false
  }
}

/** Нажатие на кнопку переноса: сначала вопрос, действие потом. */
function onAsk(): void {
  note.value = ''
  trouble.value = ''
  asking.value = true
}

function onCancel(): void {
  asking.value = false
}

function onConfirm(): void {
  asking.value = false
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
      // Только снимок с диска: в сеть за списком экран сам не ходит.
      // Перенос заменяет список целиком, и решать это человеку, а не открытию экрана.
      await initCollection()
      refill()

      // Отправщик запускается только после подъёма: до него в памяти править нечего.
      startEditSender()
    } catch (e) {
      trouble.value = describe(e)
    } finally {
      busy.value = false
    }
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
      <label class="am-search am-search--wide">
        <span class="am-search__mark" aria-hidden="true">⌕</span>
        <input
          v-model="word"
          class="am-input"
          type="search"
          placeholder="Поиск по своему списку"
          @input="onType"
        />
      </label>

      <label class="am-sort">
        <span class="am-sort__mark" aria-hidden="true">⇅</span>
        <select v-model="sortKey" class="am-pick am-sort__pick" @change="pickSort">
          <option v-for="item in SORT_TABS" :key="item.key" :value="item.key">
            {{ item.title }}
          </option>
        </select>
      </label>

      <button v-if="searching" class="am-btn am-btn--ghost" type="button" @click="onClear">
        Сбросить
      </button>

      <button
        class="am-btn am-btn--ghost"
        type="button"
        :disabled="busy"
        title="Забрать список с AniList и заменить им местный"
        @click="onAsk"
      >
        {{ busy ? 'Переносим…' : 'Перенести с AniList' }}
      </button>
    </div>

    <!-- Вопрос перед заменой: видно, что именно случится с местными записями. -->
    <div v-if="asking" class="am-panel am-ask">
      <p class="am-ask__text">
        Список с AniList заменит местный целиком. Записи, добавленные здесь без входа, будут
        потеряны, если их нет на AniList.
      </p>

      <div class="am-ask__acts">
        <button class="am-btn" type="button" @click="onConfirm">Перенести и заменить</button>
        <button class="am-btn am-btn--ghost" type="button" @click="onCancel">Отмена</button>
      </div>
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
    <p v-if="note" class="am-done">{{ note }}</p>

    <ul v-if="busy && rows.length === 0" class="am-grid">
      <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
        <span class="am-skeleton am-hold__art" />
        <span class="am-skeleton am-hold__line" />
      </li>
    </ul>

    <div v-else-if="total === 0" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⊘</span>
      <span>Записей пока нет.</span>
      <span>Добавьте тайтл из поиска или перенесите список с AniList.</span>
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
        :repeat="row.repeat"
        :note="row.note"
        :ongoing="row.ongoing"
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
/* Поиск занимает всё свободное место ряда вместо распорки между частями. */
.am-search--wide {
  flex: 1 1 320px;
}

/* Выбор порядка выглядит такой же пилюлей, как кнопки и поле рядом. */
.am-sort {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
}

.am-sort__mark {
  position: absolute;
  left: 13px;
  font-size: 13px;
  color: var(--am-faint);
  pointer-events: none;
}

/* Общий вид выбора живёт в .am-pick, здесь только место под значок. */
.am-sort__pick {
  padding-left: 32px;
}

/* Вопрос перед заменой списка: заметнее обычной панели, но без крика. */
.am-ask {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-color: rgba(255, 190, 90, 0.35);
}

.am-ask__text {
  flex: 1 1 320px;
  margin: 0;
  font-size: 13px;
  color: var(--am-dim);
}

.am-ask__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

/* Исход переноса: тем же тоном, каким настройки отвечают о своих действиях. */
.am-done {
  margin: 0;
  font-size: 13px;
  color: var(--am-good);
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
