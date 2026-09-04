<script setup lang="ts">
// Окошко персонажа или автора поверх основного интерфейса (пункт 3.9б).
// Русские имя и описание докидываются фоном из person-title.ts (пункт 3.9а),
// а названия работ — из media-title.ts: у AniList они только латиницей.
// Сэйю открывается в том же окне со стеком назад: башня затемнений не нужна.
//
// Показанного человека может подменить слой окошка (app/person-layer.ts):
// ссылка из описания ведёт на другого. Поэтому загрузка висит не только
// на onMounted, но и на смене свойства.
import { onBeforeUnmount, onMounted, ref, shallowReactive, watch } from 'vue'

import {
  fetchCharacterCard,
  fetchStaffCard,
  type CharacterCard,
  type PersonTarget,
  type StaffCard,
} from '@/api/anilist-person'
import { fetchStaffWorks, type StaffWork } from '@/api/anilist-staff-works'
import { keepAllowed } from '@/core/adult'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import {
  getRussianPerson,
  getRussianPersonFull,
  peekRussianPerson,
  type RussianPerson,
} from '@/core/person-title'
import { settings } from '@/core/settings'
import { Logger } from '@/utils/logger'

import { genderWord, langWord, occupationWord } from '../labels'
import { navigate } from '../router'

import RichText from './RichText.vue'
import SakuraBloom from './SakuraBloom.vue'

const props = defineProps<{ start: PersonTarget }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/** Длина описания, после которой оно складывается под кнопку. */
const DESC_LIMIT = 600

/** По скольку работ спрашиваем названия за раз: полка редко длиннее пачки. */
const WORK_CHUNK = 10

/** Сэйю из карточки персонажа. */
type VoiceActor = NonNullable<CharacterCard['media']>['edges'][number]['voiceActors'][number]

/** Кто показан сейчас: из окна персонажа можно шагнуть в карточку сэйю. */
const current = ref<PersonTarget>(props.start)

/** Цепочка «персонаж → сэйю» для кнопки «Назад» внутри окна. */
const history: PersonTarget[] = []

/** Глубина цепочки реактивно: шаблон читает только её. */
const depth = ref(0)

const charCard = ref<CharacterCard | null>(null)
const staffCard = ref<StaffCard | null>(null)
const busy = ref(true)
const expanded = ref(false)

/** Главные работы автора: полка постеров под описанием. */
const works = ref<StaffWork[]>([])

/** Русские названия работ по номерам тайтлов: подставляются по готовности. */
const ruWorks = shallowReactive(new Map<number, string>())

/** Коробка окна: при переходе к сэйю её прокрутка возвращается наверх. */
const box = ref<HTMLElement | null>(null)

/** Русская карточка человека: имя и описание. */
const ruPerson = ref<RussianPerson | null>(null)

/** Русские имена сэйю по их номерам: подставляются по готовности. */
const ruVoices = shallowReactive(new Map<number, string>())

/** Окно на экране: закрытое окно очередь не продолжает. */
let alive = true

/** Номер показа: ответ на прежнего человека приходит уже не к месту. */
let run = 0

/** Разрешён ли русский проход для этого человека настройками. */
function translateAllowed(): boolean {
  return current.value.kind === 'character' ? settings.translateCharacters : settings.translateStaff
}

/** Описание из загруженных данных. Русское, когда есть, важнее английского. */
function rawDesc(): string {
  if (ruPerson.value?.description) return ruPerson.value.description
  return (
    (current.value.kind === 'character'
      ? charCard.value?.description
      : staffCard.value?.description) ?? ''
  )
}

/**
 * Длинное ли описание. Резать текст больше нельзя: в нём разметка,
 * и рез по символам попадал в середину тега. Длина теперь только признак
 * того, что описание надо сложить по высоте.
 */
function longDesc(): boolean {
  return rawDesc().length > DESC_LIMIT
}

/** Видимые работы: отбор 18+ живёт на слое показа, а не в запросе. */
function shownWorks(): readonly StaffWork[] {
  return keepAllowed(works.value, (work) => work.isAdult)
}

/** Название работы: русское, когда фон уже добыл, иначе как пришло. */
function workName(work: StaffWork): string {
  return ruWorks.get(work.mediaId) ?? work.name
}

function fullName(): string {
  const card = current.value.kind === 'character' ? charCard.value : staffCard.value
  return card?.name.full ?? current.value.name
}

function nativeName(): string | null {
  const card = current.value.kind === 'character' ? charCard.value : staffCard.value
  return card?.name.native ?? current.value.native ?? null
}

function altNames(): string[] {
  const card = current.value.kind === 'character' ? charCard.value : staffCard.value
  return card?.name.alternative?.filter((n) => n.trim() !== '') ?? []
}

function largeImage(): string | null {
  const card = current.value.kind === 'character' ? charCard.value : staffCard.value
  return card?.image?.large ?? current.value.image ?? null
}

const MONTHS_RU = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

const MONTHS_RU_NOM = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
]

/** Дата { year, month, day } по-русски: «4 декабря», «декабрь 1995», «1995». */
function fmtDate(
  d: { year: number | null; month: number | null; day: number | null } | null,
): string {
  if (!d) return ''
  const day = d.day ?? 0
  const month = d.month ?? 0
  const year = d.year ?? 0
  if (month < 1 || month > 12) return year > 0 ? String(year) : ''
  // Диапазон месяца проверен выше, элемент есть всегда.
  const monthGen = MONTHS_RU[month - 1]!
  const monthNom = MONTHS_RU_NOM[month - 1]!
  if (day > 0) return year > 0 ? `${day} ${monthGen} ${year}` : `${day} ${monthGen}`
  return year > 0 ? `${monthNom} ${year}` : monthNom
}

/** Сэйю без повторов: один человек — одна строка, сколько бы аниме ни было. */
function voiceActors(): VoiceActor[] {
  const edges = charCard.value?.media?.edges
  if (!edges) return []
  const seen = new Set<number>()
  const out: VoiceActor[] = []
  for (const edge of edges) {
    const va =
      edge.voiceActors.find((v) => v.language?.toLowerCase() === 'japanese') ?? edge.voiceActors[0]
    if (!va || seen.has(va.id)) continue
    seen.add(va.id)
    out.push(va)
  }
  return out.slice(0, 6)
}

/** Имя сэйю: русское, когда фон уже добыл. */
function vaName(va: VoiceActor): string {
  return ruVoices.get(va.id) ?? va.name.full
}

/** Переход на карточку работы: окно закрывается, иначе оно заслонит карточку. */
function openWork(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // Escape идёт на шаг назад по цепочке, а окно закрывает только в корне.
  if (depth.value > 0) goBackPerson()
  else emit('close')
}

/**
 * Русские названия работ. Полка приезжает латиницей: у AniList у тайтла
 * есть только romaji и english, и полка работ оставалась единственным
 * местом окна, где название не по-русски.
 *
 * Сначала подставляется известное без сети (датасет и склад имён),
 * дальше идут пачки: четырнадцать поодиночке сожгли бы темп шикимори.
 */
async function beginWorkNames(mine: number, list: readonly StaffWork[]): Promise<void> {
  const ids = list.map((work) => work.mediaId)

  for (const id of ids) {
    const known = peekRussianName(id)
    if (known) ruWorks.set(id, known)
  }

  for (let from = 0; from < ids.length; from += WORK_CHUNK) {
    if (!alive || mine !== run) return

    const chunk = ids.slice(from, from + WORK_CHUNK)
    await prefetchRussianNames(chunk)
    if (!alive || mine !== run) return

    for (const id of chunk) {
      const found = peekRussianName(id)
      if (found) ruWorks.set(id, found)
    }
  }
}

/**
 * Русские имя и описание: окно их не держит, докидываются по готовности.
 * Гарда тёзок тут нет: списка тайтлов человека под рукой нет, а пара
 * имя + кандзи даёт точный балл и без него. Главному лицу спрашивается
 * полная карточка: имя из списка ролей добирает описание одним запросом.
 */
async function beginRussian(mine: number, target: PersonTarget): Promise<void> {
  if (translateAllowed()) {
    const card = await getRussianPersonFull(target.kind, target)
    if (!alive || mine !== run) return
    if (card) ruPerson.value = card
  }

  if (settings.translateStaff) {
    for (const va of voiceActors()) {
      if (!alive || mine !== run) return
      const found = await getRussianPerson('staff', {
        personId: va.id,
        name: va.name.full,
        native: va.name.native,
        image: va.image?.large ?? va.image?.medium ?? null,
        siteUrl: va.siteUrl,
      })
      if (!alive || mine !== run) return
      if (found) ruVoices.set(va.id, found.russian)
    }
  }
}

/** Показ человека: сброс прошлого, карточка с сервера, русский проход фоном. */
async function load(target: PersonTarget): Promise<void> {
  const mine = ++run
  current.value = target
  charCard.value = null
  staffCard.value = null
  works.value = []
  ruWorks.clear()
  ruVoices.clear()
  expanded.value = false
  busy.value = true
  box.value?.scrollTo({ top: 0 })

  // Известное с прошлого показа подставляется сразу, сеть не ждётся.
  ruPerson.value = translateAllowed() ? peekRussianPerson(target.kind, target.personId) : null

  if (target.kind === 'character') {
    charCard.value = await fetchCharacterCard(target.personId)
  } else {
    // Полка работ идёт своим доходом: карточка её не ждёт, а без работ она живая.
    void fetchStaffWorks(target.personId)
      .then((list) => {
        if (!alive || mine !== run) return
        works.value = list

        // Названия догоняют полку: постеры видны сразу, имена меняются по ходу.
        void beginWorkNames(mine, list).catch((e) => {
          Logger('WARN', 'Карточка персоны: русские названия работ не доехали', e)
        })
      })
      .catch((e) => {
        Logger('WARN', 'Карточка персоны: работы не загрузились', e)
      })

    staffCard.value = await fetchStaffCard(target.personId)
  }
  if (!alive || mine !== run) return
  busy.value = false

  void beginRussian(mine, target)
}

/** Переход к сэйю в том же окне: второй слой затемнения не нужен. */
function openVoice(va: VoiceActor): void {
  history.push(current.value)
  depth.value = history.length
  void load({
    kind: 'staff',
    personId: va.id,
    name: va.name.full,
    native: va.name.native,
    image: va.image?.large ?? va.image?.medium ?? null,
    siteUrl: va.siteUrl,
  })
}

/** Шаг назад по цепочке «персонаж → сэйю». */
function goBackPerson(): void {
  const prev = history.pop()
  depth.value = history.length
  if (prev) void load(prev)
}

/**
 * Слой окошка подменил человека: ссылка из описания ведёт на другого.
 * Прежний уходит в ту же цепочку, что и переход к сэйю, — «Назад» и Escape
 * работают одинаково независимо от того, откуда пришёл новый человек.
 */
watch(
  () => props.start,
  (next) => {
    const now = current.value
    if (next.kind === now.kind && next.personId === now.personId) return

    history.push(now)
    depth.value = history.length
    void load(next).catch((e) => {
      Logger('WARN', 'Карточка персоны: загрузка не удалась', e)
    })
  },
)

onMounted(() => {
  window.addEventListener('keydown', onKey)
  void load(props.start).catch((e) => {
    Logger('WARN', 'Карточка персоны: загрузка не удалась', e)
  })
})

onBeforeUnmount(() => {
  alive = false
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="am-sheet" role="dialog" aria-modal="true" @click.self="emit('close')">
    <div class="am-sheet__box">
      <!-- Шапка стоит на месте: прокручивается только тело ниже. -->
      <header class="am-sheet__head">
        <button
          v-if="depth > 0"
          class="am-btn am-btn--ghost am-ps-back"
          type="button"
          @click="goBackPerson"
        >
          ← Назад
        </button>

        <div class="am-ps-top">
          <div class="am-ps-portrait">
            <img
              v-if="largeImage()"
              class="am-ps-portrait__img"
              :src="largeImage()!"
              :alt="fullName()"
              decoding="async"
            />
            <span v-else class="am-ps-portrait__img am-ps-portrait__img--empty" aria-hidden="true">
              {{ fullName().slice(0, 1) }}
            </span>
          </div>

          <div class="am-ps-names">
            <p class="am-ps-names__full">{{ fullName() }}</p>
            <p v-if="ruPerson" class="am-ps-names__russian">{{ ruPerson.russian }}</p>
            <p v-if="nativeName()" class="am-ps-names__native">{{ nativeName() }}</p>
            <p v-if="altNames().length" class="am-ps-names__alt">
              {{ altNames().join(' · ') }}
            </p>

            <!-- Стафф: занятия, язык, город -->
            <template v-if="current.kind === 'staff' && staffCard">
              <p v-if="staffCard.primaryOccupations?.length" class="am-dim am-ps-names__occ">
                {{ staffCard.primaryOccupations.map(occupationWord).join(', ') }}
              </p>
              <p v-if="staffCard.languageV2" class="am-dim">
                {{ langWord(staffCard.languageV2)
                }}<template v-if="staffCard.homeTown">, {{ staffCard.homeTown }}</template>
              </p>
              <p v-if="fmtDate(staffCard.dateOfBirth)" class="am-dim">
                {{ fmtDate(staffCard.dateOfBirth)
                }}<template v-if="fmtDate(staffCard.dateOfDeath)">
                  &nbsp;—&nbsp;{{ fmtDate(staffCard.dateOfDeath) }}</template
                >
              </p>
            </template>

            <!-- Персонаж: пол, возраст, дата рождения -->
            <template v-if="current.kind === 'character' && charCard">
              <p v-if="charCard.gender || charCard.age" class="am-dim">
                <template v-if="charCard.gender">{{ genderWord(charCard.gender) }}</template
                ><template v-if="charCard.gender && charCard.age"> · </template
                ><template v-if="charCard.age">{{ charCard.age }}</template>
              </p>
              <p v-if="fmtDate(charCard.dateOfBirth)" class="am-dim">
                {{ fmtDate(charCard.dateOfBirth) }}
              </p>
            </template>
          </div>

          <button class="am-sheet__close" type="button" aria-label="Закрыть" @click="emit('close')">
            <SakuraBloom />
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      <div ref="box" class="am-sheet__body">
        <!-- Скелетон -->
        <template v-if="busy">
          <span class="am-skeleton am-ps-skel" />
          <span class="am-skeleton am-ps-skel" />
          <span class="am-skeleton am-ps-skel am-ps-skel--short" />
        </template>

        <!-- Описание -->
        <template v-else>
          <div
            v-if="rawDesc()"
            class="am-ps-desc"
            :class="{ 'am-ps-desc--fold': longDesc() && !expanded }"
          >
            <!-- Ссылка на тайтл закрывает окно: иначе карточка откроется за ним
                 и останется незамеченной. Ссылка на другого человека окно
                 не закрывает — оно уже показывает нового. -->
            <RichText :text="rawDesc()" @inside="emit('close')" />
          </div>
          <button
            v-if="longDesc() && !expanded"
            class="am-btn am-btn--ghost am-ps-wide"
            type="button"
            @click="expanded = true"
          >
            Показать полностью
          </button>

          <!-- Работы (только для авторов): полка постеров с переходом внутрь -->
          <template v-if="current.kind === 'staff' && shownWorks().length">
            <h4 class="am-ps-sub">Работы</h4>
            <div class="am-rail am-ps-works">
              <button
                v-for="work in shownWorks()"
                :key="work.mediaId"
                v-tip="work.role ? `${workName(work)} · ${work.role}` : workName(work)"
                class="am-ps-work"
                type="button"
                @click="openWork(work.mediaId)"
              >
                <img
                  v-if="work.cover"
                  class="am-ps-work__art"
                  :src="work.cover"
                  :alt="workName(work)"
                  loading="lazy"
                  decoding="async"
                />
                <span v-else class="am-ps-work__art am-ps-work__art--empty" aria-hidden="true">
                  {{ workName(work).slice(0, 1) }}
                </span>
                <span class="am-ps-work__name">{{ workName(work) }}</span>
                <span v-if="work.year" class="am-ps-work__year">{{ work.year }}</span>
              </button>
            </div>
          </template>

          <!-- Сэйю (только для персонажей): строка кликабельна, окно то же -->
          <template v-if="current.kind === 'character' && voiceActors().length">
            <h4 class="am-ps-sub">Голоса</h4>
            <div class="am-ps-voices">
              <button
                v-for="va in voiceActors()"
                :key="va.id"
                v-tip="`Карточка: ${vaName(va)}`"
                class="am-ps-va"
                type="button"
                @click="openVoice(va)"
              >
                <img
                  v-if="va.image?.medium || va.image?.large"
                  class="am-ps-va__art"
                  :src="(va.image.medium ?? va.image.large)!"
                  :alt="va.name.full"
                  loading="lazy"
                  decoding="async"
                />
                <span v-else class="am-ps-va__art am-ps-va__art--empty" aria-hidden="true">
                  {{ va.name.full.slice(0, 1) }}
                </span>
                <span class="am-ps-va__name">{{ vaName(va) }}</span>
                <span class="am-ps-va__go" aria-hidden="true">→</span>
              </button>
            </div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.am-sheet {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 3vw, 40px);
  background: var(--am-veil);
  backdrop-filter: blur(8px);
  animation: am-veil-in var(--am-mid) var(--am-ease-soft) both;
}

/* Два этажа: шапка и прокручиваемое тело. Подвала больше нет: единственная
   его кнопка уводила на AniList, а пустая полка со границей только ела высоту. */
.am-sheet__box {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 16px;
  width: 100%;
  max-width: 820px;
  max-height: min(90vh, 940px);
  padding: clamp(18px, 2.2vw, 28px);
  overflow: hidden;
  background: linear-gradient(165deg, var(--am-glass-2), var(--am-glass));
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-xl);
  box-shadow:
    var(--am-sh-2),
    inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur-strong)) saturate(1.5);
  animation: am-sheet-in var(--am-mid) var(--am-ease) both;
}

@keyframes am-veil-in {
  from {
    opacity: 0;
  }
}

@keyframes am-sheet-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.985);
  }
}

.am-sheet__head {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.am-sheet__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
  overflow-y: auto;
}

/* Цель нажатия в 44 пикселя. Своей одежды у кнопки нет: круг и распускающуюся
   под курсором сакуру рисует вложенный слой, а сама кнопка остаётся
   прямоугольной — при ней остаются и попадание курсора по всей цели,
   и кольцо фокуса.

   Оттенки цветка берутся от --am-hover: это тон приподнятого управления
   в теме, тот самый, которым кнопка красилась под курсором раньше.
   Тень мелкая, --am-sh-1: над стеклом окна нужен намёк на слой, а не тот же
   плотный провал, что над постером. */
.am-sheet__close {
  --am-bloom-deep: var(--am-hover);
  --am-bloom-petal: color-mix(in srgb, var(--am-sakura) 30%, var(--am-hover));
  --am-bloom-shade: var(--am-sh-1);

  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: var(--am-touch);
  height: var(--am-touch);
  margin-left: auto;
  padding: 0;
  font: inherit;
  font-size: 22px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: none;
  border: 0;

  /* Ничего не красит: держит круглым только кольцо :focus-visible. */
  border-radius: var(--am-r-cap);
  transition: color var(--am-fast) var(--am-ease);
}

.am-sheet__close:hover,
.am-sheet__close:focus-visible {
  color: var(--am-text);
}

/* Знак поднят над цветком: тот лежит своим слоем, а по правилам рисования
   слой накрывает обычное содержимое. Центровку держит place-items родителя,
   и сдвиг её не сбивает. */
.am-sheet__close > span {
  position: relative;
  display: block;
  transition: transform var(--am-fast) var(--am-ease);
}

.am-sheet__close:hover > span,
.am-sheet__close:focus-visible > span {
  transform: translateY(-1px);
}

/* Шаг назад по цепочке «персонаж → сэйю»: сидит над шапкой слева. */
.am-ps-back {
  align-self: flex-start;
}

/* Шапка */
.am-ps-top {
  display: flex;
  gap: clamp(14px, 1.6vw, 22px);
  align-items: flex-start;
}

.am-ps-portrait {
  flex: none;
}

.am-ps-portrait__img {
  display: block;
  width: clamp(92px, 8vw, 128px);
  aspect-ratio: 2 / 3;
  object-fit: cover;
  background: var(--am-fill-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-leaf);
}

.am-ps-portrait__img--empty {
  display: grid;
  place-items: center;
  font-size: 32px;
  color: var(--am-faint);
}

.am-ps-names {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding-top: 2px;
}

/* У параграфов браузерные маргины, зазор держит только gap раскладки. */
.am-ps-names p {
  margin: 0;
}

.am-ps-names__full {
  font-size: clamp(17px, 1.6vw, 22px);
  font-weight: 700;
  line-height: 1.22;
  letter-spacing: -0.01em;
}

/* Русское имя читается первым по смыслу, поэтому ярче оригинала. */
.am-ps-names__russian {
  font-size: 14px;
  font-weight: 600;
  color: var(--am-accent);
}

.am-ps-names__native {
  font-size: 14px;
  color: var(--am-dim);
}

.am-ps-names__alt {
  font-size: 13px;
  color: var(--am-faint);
}

.am-ps-names__occ {
  margin-top: 4px;
}

/* Описание лежит на своей подложке: стена текста без границ не читалась.
   Переносы и разметку держит сам RichText, здесь только типографика. */
.am-ps-desc {
  margin: 0;
  padding: 14px 16px;
  font-size: 14px;
  line-height: 1.65;
  color: var(--am-dim);
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
}

/* Длинное описание складывается по высоте, а не режется по символам:
   рез размеченного текста ломал теги. Хвост гаснет маской — видно,
   что текст продолжается. */
.am-ps-desc--fold {
  max-height: 230px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(180deg, #000 68%, transparent);
  mask-image: linear-gradient(180deg, #000 68%, transparent);
}

.am-ps-wide {
  align-self: flex-start;
}

/* Подзаголовки тела: Голоса, Работы */
.am-ps-sub {
  display: flex;
  gap: 9px;
  align-items: center;
  margin: 6px 0 0;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  color: var(--am-faint);
  text-transform: uppercase;
}

.am-ps-sub::before {
  flex: 0 0 auto;
  width: 3px;
  height: 12px;
  content: '';
  background: linear-gradient(180deg, var(--am-accent), var(--am-accent-2));
  border-radius: var(--am-r-cap);
}

/* Полка работ автора: горизонтальная прокрутка берётся у общего .am-rail,
   а шаг колонки — свой. Общая полка размечена колонками в --am-tile
   (148…216 пикселей по ширине окна), а постер работы вдвое уже:
   остаток колонки становился пустотой, и чем шире окно и длиннее
   полка, тем больше таких дыр было видно сразу. */
.am-ps-works {
  --am-ps-art: 104px;

  grid-auto-columns: var(--am-ps-art);
  gap: 12px;
  padding-bottom: 4px;
}

.am-ps-work {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
}

.am-ps-work__art {
  display: block;
  width: 100%;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  background: var(--am-fill-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
  transition:
    border-color var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-ps-work__art--empty {
  display: grid;
  place-items: center;
  font-size: 26px;
  color: var(--am-faint);
}

.am-ps-work:hover .am-ps-work__art,
.am-ps-work:focus-visible .am-ps-work__art {
  border-color: rgb(var(--am-accent-rgb) / 0.55);
  transform: translateY(-2px);
}

/* Имя в две строки: одной не хватало почти ни одному тайтлу, а третья
   ломала ровный ряд постеров. */
.am-ps-work__name {
  display: -webkit-box;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.am-ps-work__year {
  font-size: 11px;
  color: var(--am-faint);
}

.am-ps-voices {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}

/* Строка сэйю — кнопка: из неё открывается его карточка в этом же окне.
   Капсула такая же, как у авторов в блоке людей карточки. */
.am-ps-va {
  display: flex;
  gap: 11px;
  align-items: center;
  width: 100%;
  min-width: 0;
  padding: 7px 12px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-ps-va:hover,
.am-ps-va:focus-visible {
  background: var(--am-hover);
  border-color: rgb(var(--am-accent-rgb) / 0.45);
  transform: translateY(-1px);
}

.am-ps-va:hover .am-ps-va__name {
  color: var(--am-accent);
}

.am-ps-va__art {
  flex: none;
  width: 40px;
  height: 40px;
  object-fit: cover;
  background: var(--am-fill-2);
  border-radius: var(--am-r-cap);
}

.am-ps-va__art--empty {
  display: grid;
  place-items: center;
  font-size: 16px;
  color: var(--am-faint);
}

.am-ps-va__name {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--am-fast) var(--am-ease);
}

/* Стрелка говорит, что строка ведёт дальше: без неё клик не угадать. */
.am-ps-va__go {
  margin-left: auto;
  font-size: 14px;
  color: var(--am-faint);
  transition: transform var(--am-fast) var(--am-ease);
}

.am-ps-va:hover .am-ps-va__go {
  color: var(--am-accent);
  transform: translateX(3px);
}

/* Скелетон */
.am-ps-skel {
  display: block;
  height: 16px;
  border-radius: var(--am-r-s);
}

.am-ps-skel--short {
  width: 60%;
}

/* Узкое окно: портрет и имена встают колонкой, иначе имена сжимает в нить. */
@media (max-width: 620px) {
  .am-ps-top {
    flex-wrap: wrap;
  }

  .am-ps-portrait__img {
    width: 84px;
  }

  /* На узком окне постер работы чуть мельче: четырёх колонок по 104
     в тело окна уже не влезало, и полка открывалась полупостером. */
  .am-ps-works {
    --am-ps-art: 92px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .am-sheet,
  .am-sheet__box {
    animation: none;
  }

  .am-sheet__close:hover > span,
  .am-sheet__close:focus-visible > span,
  .am-ps-work:hover .am-ps-work__art,
  .am-ps-work:focus-visible .am-ps-work__art,
  .am-ps-va:hover,
  .am-ps-va:focus-visible,
  .am-ps-va:hover .am-ps-va__go {
    transform: none;
  }
}
</style>
