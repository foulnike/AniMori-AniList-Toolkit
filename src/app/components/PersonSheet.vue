<script setup lang="ts">
// Окошко персонажа или автора поверх основного интерфейса (пункт 3.9б).
// Русские имя и описание докидываются фоном из person-title.ts (пункт 3.9а).
// Сэйю открывается в том же окне со стеком назад: башня затемнений не нужна.
import { onBeforeUnmount, onMounted, ref, shallowReactive } from 'vue'

import {
  fetchCharacterCard,
  fetchStaffCard,
  type CharacterCard,
  type PersonTarget,
  type StaffCard,
} from '@/api/anilist-person'
import { Bridge } from '@/bridge'
import {
  getRussianPerson,
  getRussianPersonFull,
  peekRussianPerson,
  type RussianPerson,
} from '@/core/person-title'
import { settings } from '@/core/settings'
import { Logger } from '@/utils/logger'

import { genderWord, langWord, occupationWord } from '../labels'

const props = defineProps<{ start: PersonTarget }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/** Предел описания до кнопки «Ещё». */
const DESC_LIMIT = 400

/** Сэйю из карточки персонажа. */
type VoiceActor = NonNullable<CharacterCard['media']>['edges'][number]['voiceActors'][number]

/** Кусок описания: просто текст или ссылка наружу. */
interface DescPart {
  text: string
  url: string | null
}

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

function shortDesc(): string {
  const d = rawDesc()
  return expanded.value || d.length <= DESC_LIMIT ? d : d.slice(0, DESC_LIMIT) + '…'
}

function hasMore(): boolean {
  return rawDesc().length > DESC_LIMIT && !expanded.value
}

/** Описание кусками: маркдаун-ссылки AniList становятся кликабельными. */
function descParts(): DescPart[] {
  const d = shortDesc()
  const parts: DescPart[] = []
  const link = /\[([^\]]+)\]\((https?:[^)\s]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = link.exec(d)) !== null) {
    if (m.index > last) parts.push({ text: d.slice(last, m.index), url: null })
    // Обе группы гарантированы самим выражением: [текст](url).
    parts.push({ text: m[1]!, url: m[2]! })
    last = m.index + m[0].length
  }
  if (last < d.length) parts.push({ text: d.slice(last), url: null })
  return parts
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

function openLink(url: string): void {
  Bridge.shell.openExternal(url).catch(() => {})
}

function openSite(): void {
  const url = current.value.siteUrl
  if (url === null) return
  Bridge.shell.openExternal(url).catch(() => {})
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // Escape идёт на шаг назад по цепочке, а окно закрывает только в корне.
  if (depth.value > 0) goBackPerson()
  else emit('close')
}

/**
 * Русские имя и описание: окно они не держат, докидываются по готовности.
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
  ruVoices.clear()
  expanded.value = false
  busy.value = true
  box.value?.scrollTo({ top: 0 })

  // Известное с прошлого показа подставляется сразу, сеть не ждётся.
  ruPerson.value = translateAllowed() ? peekRussianPerson(target.kind, target.personId) : null

  if (target.kind === 'character') {
    charCard.value = await fetchCharacterCard(target.personId)
  } else {
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
          <p v-if="rawDesc()" class="am-ps-desc">
            <template v-for="(part, i) in descParts()" :key="i">
              <a v-if="part.url" class="am-ps-link" href="#" @click.prevent="openLink(part.url)">{{
                part.text
              }}</a>
              <template v-else>{{ part.text }}</template>
            </template>
          </p>
          <button
            v-if="hasMore()"
            class="am-btn am-btn--ghost am-ps-wide"
            type="button"
            @click="expanded = true"
          >
            Показать полностью
          </button>

          <!-- Сэйю (только для персонажей): строка кликабельна, окно то же -->
          <template v-if="current.kind === 'character' && voiceActors().length">
            <h4 class="am-ps-sub">Голоса</h4>
            <div class="am-ps-voices">
              <button
                v-for="va in voiceActors()"
                :key="va.id"
                class="am-ps-va"
                type="button"
                :title="`Карточка: ${va.name.full}`"
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

      <!-- Футер -->
      <footer v-if="current.siteUrl" class="am-sheet__foot">
        <button class="am-btn am-btn--ghost" type="button" @click="openSite()">
          Открыть на AniList
        </button>
      </footer>
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

/* Три этажа: шапка, прокручиваемое тело и подвал со ссылкой наружу. */
.am-sheet__box {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
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

/* Цель нажатия в 44 пикселя и форма, плывущая к окружности под курсором —
   точно так же, как в окне правки записи. */
.am-sheet__close {
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
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-drop);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-radius var(--am-mid) var(--am-ease);
}

.am-sheet__close:hover,
.am-sheet__close:focus-visible {
  color: var(--am-text);
  background: var(--am-fill-2);
  border-radius: var(--am-r-cap);
}

.am-sheet__foot {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding-top: 14px;
  border-top: 1px solid var(--am-line-soft);
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

/* Описание лежит на своей подложке: стена текста без границ не читалась. */
.am-ps-desc {
  margin: 0;
  padding: 14px 16px;
  font-size: 14px;
  line-height: 1.65;
  color: var(--am-dim);
  white-space: pre-line;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
}

.am-ps-link {
  color: var(--am-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.am-ps-link:hover,
.am-ps-link:focus-visible {
  color: var(--am-accent);
}

.am-ps-wide {
  align-self: flex-start;
}

/* Голоса */
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
}

@media (prefers-reduced-motion: reduce) {
  .am-sheet,
  .am-sheet__box {
    animation: none;
  }

  .am-ps-va:hover,
  .am-ps-va:focus-visible,
  .am-ps-va:hover .am-ps-va__go {
    transform: none;
  }
}
</style>
