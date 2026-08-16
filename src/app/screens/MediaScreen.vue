<script setup lang="ts">
// Пункт 3.4: карточка тайтла. Номер из адреса, подробности с сервера,
// а состояние списка — из памяти: там правда свежее чужого ответа.
// Правки уходят в очередь отправщика, сети этот экран не касается.
import { computed, onMounted, ref, watch } from 'vue'

import { fetchMediaCard, type MediaCard } from '@/api/anilist-media'
import { getEntry } from '@/core/collection'
import { queueEdit } from '@/core/edit-sender'
import { getRussianTitle, type RussianTitle } from '@/core/media-title'
import { Logger } from '@/utils/logger'

import { currentRoute, goBack } from '../router'

/** Шаг оценки. Десятибалльная шкала у AniList дробная, половины достаточно. */
const SCORE_STEP = 0.5

/** Закладки аниме и манги: ключи сервера общие, подписи разные. */
const ANIME_STATUSES: ReadonlyArray<{ key: string; title: string }> = [
  { key: 'CURRENT', title: 'Смотрю' },
  { key: 'REPEATING', title: 'Пересматриваю' },
  { key: 'PLANNING', title: 'В планах' },
  { key: 'COMPLETED', title: 'Просмотрено' },
  { key: 'PAUSED', title: 'Отложено' },
  { key: 'DROPPED', title: 'Брошено' },
]

const MANGA_STATUSES: ReadonlyArray<{ key: string; title: string }> = [
  { key: 'CURRENT', title: 'Читаю' },
  { key: 'REPEATING', title: 'Перечитываю' },
  { key: 'PLANNING', title: 'В планах' },
  { key: 'COMPLETED', title: 'Прочитано' },
  { key: 'PAUSED', title: 'Отложено' },
  { key: 'DROPPED', title: 'Брошено' },
]

const card = ref<MediaCard | null>(null)
const russian = ref<RussianTitle | null>(null)
const busy = ref(true)
const trouble = ref('')

/** Счётчик правок этого показа: заставляет пересчитать взятое из памяти. */
const editStamp = ref(0)

/** Номер показа: ответ на старый тайтл пришёл не вовремя и ему места нет. */
let run = 0

const mediaId = computed<number>(() => {
  const raw = Number(currentRoute.value.params.id ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
})

/** Закладки под тип тайтла. До ответа сервера считаем тайтл аниме. */
const statuses = computed(() =>
  card.value?.type === 'MANGA' ? MANGA_STATUSES : ANIME_STATUSES,
)

/** Своя запись из памяти. Счётчик правок в зависимостях не случаен: */
/** мап коллекции вне реактивности Vue, сам он пересчёт не закажет. */
const own = computed(() => {
  void editStamp.value
  return mediaId.value > 0 ? getEntry(mediaId.value) : undefined
})

/** Статус для выбора: память главнее ответа, ответ — запас на первый показ. */
const status = computed<string>(() => own.value?.status ?? card.value?.ownEntry?.status ?? '')

const score10 = computed<number>(() => own.value?.score10 ?? card.value?.ownEntry?.score10 ?? 0)

const progress = computed<number>(() => own.value?.progress ?? card.value?.ownEntry?.progress ?? 0)

const volumes = computed<number>(() => own.value?.volumes ?? card.value?.ownEntry?.volumes ?? 0)

/** Всего частей: у аниме эпизоды, у манги главы. Неизвестное не ограничивает. */
const partsTotal = computed<number | null>(() =>
  card.value?.type === 'MANGA' ? (card.value?.chapters ?? null) : (card.value?.episodes ?? null),
)

/** Подпись строки счёта: «Глав» у манги и «Эпизодов» у аниме. */
const partsWord = computed<string>(() => (card.value?.type === 'MANGA' ? 'Главы' : 'Эпизоды'))

/** Главное название: русское, латиница, английское, номер. */
const mainTitle = computed<string>(
  () =>
    russian.value?.russian ??
    card.value?.romaji ??
    card.value?.english ??
    `Тайтл #${mediaId.value}`,
)

/**
 * Разошлось ли наше состояние с сервером. Говорится вслух: чаще всего это
 * неотправленная правка, а молчание выглядит как потеря данных.
 */
const drifted = computed<boolean>(() => {
  const server = card.value?.ownEntry
  const mine = own.value
  if (!server || !mine) return false

  return (
    server.status !== mine.status ||
    server.score10 !== mine.score10 ||
    server.progress !== mine.progress
  )
})

/** Описание без разметки: сервер и без HTML оставляет переносы тегом. */
const about = computed<string>(() => {
  const text = russian.value?.description ?? card.value?.description ?? ''
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim()
})

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function scoreText(value: number): string {
  return value > 0 ? value.toFixed(1) : '—'
}

/** Строка счёта частей вида «7 из 12». Неизвестный итог не выдумывается. */
const partsText = computed<string>(() => {
  const total = partsTotal.value
  return total === null ? String(progress.value) : `${progress.value} из ${total}`
})

/** Забирает подробности и русскую карточку. Порядок важен: тип из первого ответа. */
async function load(): Promise<void> {
  const mine = ++run
  const id = mediaId.value

  card.value = null
  russian.value = null
  trouble.value = ''

  if (id === 0) {
    busy.value = false
    return
  }

  busy.value = true

  try {
    const found = await fetchMediaCard(id)
    if (mine !== run) return

    if (!found) {
      trouble.value = 'Сервер не отдал этот тайтл. Попробуйте позже.'
      return
    }

    card.value = found
  } catch (e) {
    if (mine !== run) return
    trouble.value = describe(e)
    return
  } finally {
    if (mine === run) busy.value = false
  }

  try {
    // Тип передаётся явно: у русских источников аниме и манга в разных разделах.
    const found = await getRussianTitle(id, card.value?.type ?? 'ANIME')
    if (mine === run) russian.value = found
  } catch (e) {
    // Без русского названия карточка живая: останется латиница.
    Logger('WARN', `Карточка ${id}: русское название не добылось`, e)
  }
}

/** Отправляет одну правку в очередь и обновляет показ по памяти. */
async function send(kind: 'status' | 'score' | 'progress', value: string | number): Promise<void> {
  if (mediaId.value === 0) return

  try {
    await queueEdit(mediaId.value, kind, value)
    editStamp.value += 1
  } catch (e) {
    trouble.value = describe(e)
  }
}

function onStatus(event: Event): void {
  const next = (event.target as HTMLSelectElement).value
  if (next === '' || next === status.value) return
  void send('status', next)
}

/** Оценка по шагу шкалы, с обрезкой по краям: сервер знает только 0—10. */
function bumpScore(delta: number): void {
  const next = Math.round((score10.value + delta) / SCORE_STEP) * SCORE_STEP
  const fixed = Math.min(10, Math.max(0, Math.round(next * 10) / 10))
  if (fixed === score10.value) return
  void send('score', fixed)
}

/** Счёт частей. Выше известного итога не пускаем: такую правку сервер отвергнет. */
function bumpProgress(delta: number): void {
  const total = partsTotal.value
  const next = progress.value + delta
  const fixed = Math.max(0, total === null ? next : Math.min(total, next))
  if (fixed === progress.value) return
  void send('progress', fixed)
}

function onBack(): void {
  goBack()
}

function onReload(): void {
  void load()
}

onMounted(() => {
  void load()
})

// Переход с карточки на карточку не пересобирает экран: грузим сами.
watch(mediaId, () => {
  void load()
})
</script>

<template>
  <section class="am-card">
    <button class="am-card__back" type="button" @click="onBack">← Назад</button>

    <p v-if="mediaId === 0" class="am-card__hint">
      Тайтл не выбран: в адресе нет номера. Откройте карточку из списков.
    </p>

    <template v-else>
      <p v-if="trouble" class="am-card__error">{{ trouble }}</p>
      <p v-if="busy" class="am-card__hint">Карточка загружается…</p>

      <template v-if="card">
        <div class="am-card__head">
          <img v-if="card.cover" class="am-card__cover" :src="card.cover" :alt="mainTitle" />

          <div class="am-card__about">
            <h2 class="am-card__title">{{ mainTitle }}</h2>
            <p v-if="card.romaji" class="am-card__sub">{{ card.romaji }}</p>
            <p v-if="card.native" class="am-card__sub">{{ card.native }}</p>

            <ul class="am-facts">
              <li v-if="card.format">{{ card.format }}</li>
              <li v-if="card.seasonYear">{{ card.seasonYear }}</li>
              <li v-if="partsTotal !== null">{{ partsWord }}: {{ partsTotal }}</li>
              <li v-if="card.volumes">Тома: {{ card.volumes }}</li>
              <li v-if="card.duration">{{ card.duration }} мин</li>
              <li v-if="card.averageScore">Средняя {{ card.averageScore }} из 100</li>
              <li v-if="card.isAdult" class="am-facts__mark">18+</li>
            </ul>

            <p v-if="card.genres.length > 0" class="am-card__genres">
              {{ card.genres.join(' · ') }}
            </p>
          </div>
        </div>

        <div class="am-edit">
          <label class="am-edit__row">
            <span class="am-edit__name">Закладка</span>
            <select class="am-edit__pick" :value="status" @change="onStatus">
              <option value="" disabled>не в списке</option>
              <option v-for="item in statuses" :key="item.key" :value="item.key">
                {{ item.title }}
              </option>
            </select>
          </label>

          <div class="am-edit__row">
            <span class="am-edit__name">Оценка</span>
            <button class="am-step" type="button" @click="bumpScore(-SCORE_STEP)">−</button>
            <span class="am-edit__value">{{ scoreText(score10) }}</span>
            <button class="am-step" type="button" @click="bumpScore(SCORE_STEP)">+</button>
          </div>

          <div class="am-edit__row">
            <span class="am-edit__name">{{ partsWord }}</span>
            <button class="am-step" type="button" @click="bumpProgress(-1)">−</button>
            <span class="am-edit__value">{{ partsText }}</span>
            <button class="am-step" type="button" @click="bumpProgress(1)">+</button>
          </div>

          <p v-if="card.type === 'MANGA'" class="am-card__hint">
            Прочитано томов: {{ volumes }}. Правка томов появится вместе с её видом в очереди.
          </p>

          <p v-if="drifted" class="am-card__hint">
            Состояние расходится с сервером: правка ещё в очереди на отправку.
          </p>
        </div>

        <p v-if="about" class="am-card__text">{{ about }}</p>

        <div class="am-card__foot">
          <button class="am-btn am-btn--ghost" type="button" :disabled="busy" @click="onReload">
            Обновить карточку
          </button>
          <span class="am-card__meta">
            AniList #{{ card.mediaId }}
            <template v-if="card.malId"> · MAL #{{ card.malId }}</template>
            <template v-if="russian"> · описание: {{ russian.sourceName }}</template>
          </span>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.am-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: flex-start;
  width: 100%;
  max-width: 720px;
}

.am-card__back {
  padding: 6px 10px;
  font: inherit;
  color: var(--am-dim);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-card__back:hover {
  color: var(--am-text);
  background: var(--am-hover);
}

.am-card__head {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  width: 100%;
}

.am-card__cover {
  width: 148px;
  border: 1px solid var(--am-line);
  border-radius: 10px;
}

.am-card__about {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.am-card__title {
  margin: 0;
  font-size: 20px;
}

.am-card__sub {
  margin: 0;
  font-size: 13px;
  color: var(--am-dim);
}

.am-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 4px 0 0;
  padding: 0;
  font-size: 13px;
  color: var(--am-dim);
  list-style: none;
}

.am-facts__mark {
  color: #ff8a8a;
}

.am-card__genres {
  margin: 0;
  font-size: 13px;
  color: var(--am-dim);
}

.am-edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  padding: 12px;
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: 12px;
}

.am-edit__row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.am-edit__name {
  min-width: 96px;
  font-size: 13px;
  color: var(--am-dim);
}

.am-edit__value {
  min-width: 72px;
}

.am-edit__pick {
  padding: 6px 8px;
  font: inherit;
  color: var(--am-text);
  background: var(--am-bg);
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-step {
  width: 30px;
  height: 30px;
  font: inherit;
  color: var(--am-text);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-step:hover {
  background: var(--am-hover);
}

.am-card__text {
  margin: 0;
  white-space: pre-line;
}

.am-card__hint {
  margin: 0;
  font-size: 13px;
  color: var(--am-dim);
}

.am-card__error {
  margin: 0;
  font-size: 13px;
  color: #ff8a8a;
}

.am-card__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.am-card__meta {
  font-size: 13px;
  color: var(--am-dim);
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
