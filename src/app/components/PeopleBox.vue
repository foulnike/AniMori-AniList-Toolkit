<script setup lang="ts">
// Пункт 3.9: люди тайтла под двумя колонками карточки. Добыча своя:
// ответ тяжелее карточки, и ждать его сверху экрана незачем.
import { computed, onBeforeUnmount, onMounted, ref, shallowReactive, watch } from 'vue'

import { fetchMalIds } from '@/api/anilist-media'
import {
  fetchMediaPeople,
  type CharacterRef,
  type PersonRef,
  type StaffRef,
} from '@/api/anilist-people'
import type { PersonTarget } from '@/api/anilist-person'
import {
  getRussianPerson,
  peekRussianPerson,
  prefetchRussianPeople,
  type PersonKind,
  type RussianPerson,
} from '@/core/person-title'
import { settings } from '@/core/settings'
import { Logger } from '@/utils/logger'

import { CREW_WORDS } from './crew-words'
import PersonSheet from './PersonSheet.vue'

const props = defineProps<{ mediaId: number }>()

/** Сколько авторов видно до раскрытия хвоста. */
const STAFF_HEAD = 6

/** Роли персонажей: сервер называет их тремя словами и других не бывает. */
const ROLE_WORDS: Record<string, string> = {
  MAIN: 'Главный',
  SUPPORTING: 'Второстепенный',
  BACKGROUND: 'Массовка',
}

const folk = ref<CharacterRef[]>([])
const crew = ref<StaffRef[]>([])
const busy = ref(false)

/** Раскрыт ли хвост списка авторов. */
const wide = ref(false)

/** Открытый человек или `null`. Окно живёт здесь: плитки о нём не знают. */
const shown = ref<PersonTarget | null>(null)

/** Номер показа: ответ на прежний тайтл приходит уже не к месту. */
let run = 0

/** Русские имена, добытые фоном: ключ — `${kind}:${personId}`. */
const russian = shallowReactive(new Map<string, RussianPerson>())

const shownCrew = computed<StaffRef[]>(() =>
  wide.value ? crew.value : crew.value.slice(0, STAFF_HEAD),
)

const hiddenCrew = computed<number>(() => Math.max(0, crew.value.length - STAFF_HEAD))

const empty = computed<boolean>(() => folk.value.length === 0 && crew.value.length === 0)

/** Роль персонажа словом. Незнакомое значение лучше не показывать вовсе. */
function roleWord(role: string | null): string {
  return role === null ? '' : (ROLE_WORDS[role] ?? '')
}

/** Роль автора по-русски. Составная роль переводится по частям. */
function crewWord(role: string | null): string {
  if (role === null) return ''

  return role
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => CREW_WORDS[part] ?? part)
    .join(', ')
}

/** Первая буква имени: стоит на месте не приехавшего портрета. */
function letter(name: string): string {
  return name.slice(0, 1).toUpperCase()
}

function personKey(kind: PersonKind, personId: number): string {
  return `${kind}:${personId}`
}

/** Имя для плитки: русское, когда фон уже добыл. */
function displayName(kind: PersonKind, person: PersonRef): string {
  return russian.get(personKey(kind, person.personId))?.russian ?? person.name
}

async function load(): Promise<void> {
  const mine = ++run

  folk.value = []
  crew.value = []
  wide.value = false
  shown.value = null

  if (props.mediaId === 0) return

  busy.value = true

  try {
    const found = await fetchMediaPeople(props.mediaId)
    if (mine !== run) return

    folk.value = found.characters
    crew.value = found.staff
    void beginRussian(mine)
  } catch (e) {
    // Без людей карточка полноценна, поэтому секция просто не появится.
    Logger('WARN', `Люди тайтла ${props.mediaId}: добыть не вышло`, e)
  } finally {
    if (mine === run) busy.value = false
  }
}

/**
 * Фоновый проход по русским именам. Основная масса приходит одним запросом —
 * списком ролей тайтла; точечный поиск достаётся несопоставленным. Уход
 * с тайтла обрывает очередь тем же номером показа, что и основная добыча.
 */
async function beginRussian(mine: number): Promise<void> {
  const queue: Array<{ kind: PersonKind; person: PersonRef }> = []
  if (settings.translateCharacters) {
    for (const person of folk.value) queue.push({ kind: 'character', person })
  }
  if (settings.translateStaff) {
    for (const person of crew.value) queue.push({ kind: 'staff', person })
    for (const person of folk.value) {
      if (person.voice) queue.push({ kind: 'staff', person: person.voice })
    }
  }
  if (queue.length === 0) return

  // MAL id текущего тайтла: на нём висят и массовый проход, и гард тёзок.
  let malId: number | undefined
  try {
    malId = (await fetchMalIds([props.mediaId])).get(props.mediaId)
  } catch (e) {
    Logger('WARN', `Русские имена: MAL id тайтла ${props.mediaId} не добыт`, e)
  }

  if (malId) {
    const left = await prefetchRussianPeople(malId, queue)
    if (mine !== run) return

    // Список ролей разрешил большинство разом: подметаем их в плитки.
    for (const entry of queue) {
      const card = peekRussianPerson(entry.kind, entry.person.personId)
      if (card) russian.set(personKey(entry.kind, entry.person.personId), card)
    }

    // Кого список не покрыл, добираем точечно, по одному.
    for (const entry of left) {
      if (mine !== run) return
      const card = await getRussianPerson(entry.kind, entry.person, [malId])
      if (mine !== run) return
      if (card) russian.set(personKey(entry.kind, entry.person.personId), card)
    }
    return
  }

  // Без номера MAL массового прохода нет: все идут точечным поиском.
  for (const entry of queue) {
    if (mine !== run) return
    const card = await getRussianPerson(entry.kind, entry.person)
    if (mine !== run) return
    if (card) russian.set(personKey(entry.kind, entry.person.personId), card)
  }
}

/** Открывает человека окошком поверх экрана: уход на сайт тут ни к чему. */
function onShow(kind: PersonTarget['kind'], person: PersonRef): void {
  shown.value = { kind, ...person }
}

onMounted(() => {
  void load()
})

onBeforeUnmount(() => {
  run++
})

watch(
  () => props.mediaId,
  () => {
    void load()
  },
)
</script>

<template>
  <div v-if="busy && empty" class="am-panel am-folk">
    <h3 class="am-h3">Персонажи</h3>
    <div class="am-rail">
      <span v-for="at in 6" :key="at" class="am-skeleton am-face__wait" />
    </div>
  </div>

  <template v-else-if="!empty">
    <div v-if="folk.length > 0" class="am-panel am-folk">
      <h3 class="am-h3">Персонажи</h3>

      <div class="am-rail">
        <article v-for="person in folk" :key="person.personId" class="am-face">
          <button
            class="am-face__hit"
            type="button"
            :title="person.native ?? person.name"
            @click="onShow('character', person)"
          >
            <img
              v-if="person.image"
              class="am-face__art"
              :src="person.image"
              :alt="person.name"
              loading="lazy"
              decoding="async"
            />
            <span v-else class="am-face__art am-face__art--empty" aria-hidden="true">
              {{ letter(person.name) }}
            </span>

            <span class="am-face__name">{{ displayName('character', person) }}</span>
            <span v-if="roleWord(person.role)" class="am-face__role">
              {{ roleWord(person.role) }}
            </span>
          </button>

          <!-- Озвучка своей целью: это второй человек, и окно у него своё. -->
          <button
            v-if="person.voice"
            class="am-face__voice"
            type="button"
            :title="person.voice.native ?? person.voice.name"
            @click="onShow('staff', person.voice)"
          >
            {{ displayName('staff', person.voice) }}
          </button>
        </article>
      </div>
    </div>

    <div v-if="crew.length > 0" class="am-panel am-folk">
      <div class="am-bar">
        <h3 class="am-h3">Авторы</h3>
        <span class="am-bar__gap" />
        <button
          v-if="hiddenCrew > 0"
          class="am-btn am-btn--ghost"
          type="button"
          @click="wide = !wide"
        >
          {{ wide ? 'Свернуть' : `Ещё ${hiddenCrew}` }}
        </button>
      </div>

      <div class="am-crew">
        <button
          v-for="person in shownCrew"
          :key="`${person.personId}-${person.role ?? ''}`"
          class="am-mate"
          type="button"
          :title="person.native ?? person.name"
          @click="onShow('staff', person)"
        >
          <img
            v-if="person.image"
            class="am-mate__art"
            :src="person.image"
            :alt="person.name"
            loading="lazy"
            decoding="async"
          />
          <span v-else class="am-mate__art am-mate__art--empty" aria-hidden="true">
            {{ letter(person.name) }}
          </span>

          <span class="am-mate__text">
            <span class="am-mate__name">{{ displayName('staff', person) }}</span>
            <span v-if="crewWord(person.role)" class="am-mate__role">
              {{ crewWord(person.role) }}
            </span>
          </span>
        </button>
      </div>
    </div>
  </template>

  <PersonSheet v-if="shown" :start="shown" @close="shown = null" />
</template>

<style scoped>
.am-folk {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Общая полка растягивает треки на всю ширину: при горсти лиц это разнос.
   Трек фиксированный — лица жмутся влево. */
.am-folk .am-rail {
  grid-auto-columns: 132px;
}

/* Персонажи полкой, а не сеткой: их бывает два десятка, и сетка
   утопила бы панель записи в самый низ экрана. */
.am-face {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 4px;
  width: 132px;
}

.am-face__hit {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  cursor: pointer;
}

.am-face__art {
  width: 100%;
  aspect-ratio: 2 / 3;
  margin-bottom: 4px;
  object-fit: cover;
  background: var(--am-panel-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
  transition: transform 0.16s ease;
}

.am-face__hit:hover .am-face__art,
.am-face__hit:focus-visible .am-face__art {
  transform: translateY(-2px);
  border-color: var(--am-accent);
}

.am-face__art--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: var(--am-faint);
}

.am-face__wait {
  flex: none;
  width: 132px;
  aspect-ratio: 2 / 3;
  border-radius: var(--am-r-m);
}

.am-face__name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
}

.am-face__role {
  font-size: 11.5px;
  color: var(--am-faint);
}

/* Озвучка бледнее имени: это второй человек в той же плитке. */
.am-face__voice {
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--am-dim);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
}

.am-face__voice:hover,
.am-face__voice:focus-visible {
  color: var(--am-accent);
}

/* Авторов единицы, полка из четырёх плиток смотрелась бы обрубком. */
.am-crew {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.am-mate {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
  padding: 8px 10px;
  font: inherit;
  color: inherit;
  text-align: left;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
  cursor: pointer;
}

.am-mate:hover,
.am-mate:focus-visible {
  background: var(--am-hover);
  border-color: var(--am-accent);
}

.am-mate__art {
  flex: none;
  width: 44px;
  height: 44px;
  object-fit: cover;
  background: var(--am-panel-2);
  border-radius: 50%;
}

.am-mate__art--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  color: var(--am-faint);
}

.am-mate__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.am-mate__name {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-mate__role {
  font-size: 11.5px;
  color: var(--am-faint);
}
</style>
