<script setup lang="ts">
// Окошко персонажа или автора поверх основного интерфейса (пункт 3.9б).
import { onBeforeUnmount, onMounted, ref } from 'vue'

import {
  fetchCharacterCard,
  fetchStaffCard,
  type CharacterCard,
  type PersonTarget,
  type StaffCard,
} from '@/api/anilist-person'
import { Bridge } from '@/bridge'

const props = defineProps<{ start: PersonTarget }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/** Предел описания до кнопки «Ещё». */
const DESC_LIMIT = 400

const charCard = ref<CharacterCard | null>(null)
const staffCard = ref<StaffCard | null>(null)
const busy = ref(true)
const expanded = ref(false)

/** Описание из загруженных данных. */
function rawDesc(): string {
  return (
    (props.start.kind === 'character'
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

function fullName(): string {
  const card = props.start.kind === 'character' ? charCard.value : staffCard.value
  return card?.name.full ?? props.start.name
}

function nativeName(): string | null {
  const card = props.start.kind === 'character' ? charCard.value : staffCard.value
  return card?.name.native ?? props.start.native ?? null
}

function altNames(): string[] {
  const card = props.start.kind === 'character' ? charCard.value : staffCard.value
  return card?.name.alternative?.filter((n) => n.trim() !== '') ?? []
}

function largeImage(): string | null {
  const card = props.start.kind === 'character' ? charCard.value : staffCard.value
  return card?.image?.large ?? props.start.image ?? null
}

/** Форматирует дату { year, month, day } в читаемый вид. */
function fmtDate(
  d: { year: number | null; month: number | null; day: number | null } | null,
): string {
  if (!d) return ''
  const parts: string[] = []
  if (d.day) parts.push(String(d.day))
  if (d.month) parts.push(String(d.month))
  if (d.year) parts.push(String(d.year))
  return parts.join('.')
}

/** Первый голос из каждого аниме (приоритет JA, затем любой). */
function voiceRows() {
  if (!charCard.value?.media?.edges) return []
  return charCard.value.media.edges
    .map((edge) => {
      const ja = edge.voiceActors.find((v) => v.language === 'JAPANESE')
      const va = ja ?? edge.voiceActors[0] ?? null
      return va ? { va, media: edge.node, role: edge.characterRole } : null
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .slice(0, 6)
}

function openSite(): void {
  const url = props.start.siteUrl
  if (url === null) return
  Bridge.shell.openExternal(url).catch(() => {})
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  if (props.start.kind === 'character') {
    charCard.value = await fetchCharacterCard(props.start.personId)
  } else {
    staffCard.value = await fetchStaffCard(props.start.personId)
  }
  busy.value = false
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="am-sheet" role="dialog" aria-modal="true" @click.self="emit('close')">
    <div class="am-sheet__box">
      <!-- Шапка -->
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
          <p v-if="nativeName()" class="am-ps-names__native">{{ nativeName() }}</p>
          <p v-if="altNames().length" class="am-ps-names__alt">
            {{ altNames().join(' · ') }}
          </p>

          <!-- Стафф: занятия, язык, город -->
          <template v-if="start.kind === 'staff' && staffCard">
            <p v-if="staffCard.primaryOccupations?.length" class="am-dim am-ps-names__occ">
              {{ staffCard.primaryOccupations.join(', ') }}
            </p>
            <p v-if="staffCard.languageV2" class="am-dim">
              {{ staffCard.languageV2
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
          <template v-if="start.kind === 'character' && charCard">
            <p v-if="charCard.gender || charCard.age" class="am-dim">
              <template v-if="charCard.gender">{{ charCard.gender }}</template
              ><template v-if="charCard.gender && charCard.age"> · </template
              ><template v-if="charCard.age">{{ charCard.age }}</template>
            </p>
            <p v-if="fmtDate(charCard.dateOfBirth)" class="am-dim">
              {{ fmtDate(charCard.dateOfBirth) }}
            </p>
          </template>
        </div>

        <button class="am-sheet__close" type="button" aria-label="Закрыть" @click="emit('close')">
          ×
        </button>
      </div>

      <!-- Скелетон -->
      <template v-if="busy">
        <span class="am-skeleton am-ps-skel" />
        <span class="am-skeleton am-ps-skel" />
        <span class="am-skeleton am-ps-skel am-ps-skel--short" />
      </template>

      <!-- Описание -->
      <template v-else>
        <p v-if="rawDesc()" class="am-ps-desc">
          {{ shortDesc() }}
        </p>
        <button v-if="hasMore()" class="am-btn am-btn--ghost" type="button" @click="expanded = true">
          Показать полностью
        </button>

        <!-- Сэйю (только для персонажей) -->
        <template v-if="start.kind === 'character' && voiceRows().length">
          <h4 class="am-ps-sub">Голоса</h4>
          <div class="am-ps-voices">
            <div v-for="row in voiceRows()" :key="row.va.id" class="am-ps-va">
              <img
                v-if="row.va.image?.medium || row.va.image?.large"
                class="am-ps-va__art"
                :src="(row.va.image.medium ?? row.va.image.large)!"
                :alt="row.va.name.full"
                loading="lazy"
                decoding="async"
              />
              <span v-else class="am-ps-va__art am-ps-va__art--empty" aria-hidden="true">
                {{ row.va.name.full.slice(0, 1) }}
              </span>
              <span class="am-ps-va__info">
                <span class="am-ps-va__name">{{ row.va.name.full }}</span>
                <span class="am-ps-va__media am-dim">
                  {{ row.media.title.romaji ?? row.media.title.english ?? '' }}
                </span>
              </span>
            </div>
          </div>
        </template>
      </template>

      <!-- Футер -->
      <div v-if="start.siteUrl" class="am-sheet__foot">
        <button class="am-btn am-btn--ghost" type="button" @click="openSite()">
          Открыть на AniList
        </button>
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
  padding: 24px;
  background: rgba(4, 7, 12, 0.72);
  backdrop-filter: blur(6px);
}

.am-sheet__box {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 780px;
  max-height: 90vh;
  padding: 26px;
  overflow-y: auto;
  background: linear-gradient(180deg, var(--am-panel-2), var(--am-panel));
  border-radius: var(--am-r-l);
  box-shadow: var(--am-sh-2);
}

.am-sheet__close {
  flex: none;
  align-self: flex-start;
  width: 44px;
  height: 44px;
  padding: 0;
  font-size: 22px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: 50%;
}

.am-sheet__close:hover,
.am-sheet__close:focus-visible {
  color: var(--am-text);
  background: var(--am-hover);
}

.am-sheet__foot {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
  border-top: 1px solid var(--am-line-soft);
}

/* Шапка */
.am-ps-top {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.am-ps-portrait {
  flex: none;
}

.am-ps-portrait__img {
  width: 110px;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  background: var(--am-panel-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-ps-portrait__img--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  color: var(--am-faint);
}

.am-ps-names {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding-top: 4px;
}

.am-ps-names__full {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.25;
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

/* Описание */
.am-ps-desc {
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-line;
  color: var(--am-dim);
}

/* Голоса */
.am-ps-sub {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--am-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.am-ps-voices {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.am-ps-va {
  display: flex;
  gap: 10px;
  align-items: center;
}

.am-ps-va__art {
  flex: none;
  width: 40px;
  height: 40px;
  object-fit: cover;
  background: var(--am-panel-2);
  border-radius: 50%;
}

.am-ps-va__art--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: var(--am-faint);
}

.am-ps-va__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.am-ps-va__name {
  font-size: 13.5px;
  font-weight: 600;
}

.am-ps-va__media {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
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
</style>
