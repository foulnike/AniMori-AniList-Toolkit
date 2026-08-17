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

import { formatWord, partsWord as partsWordFor, statusList } from '../labels'
import { currentRoute } from '../router'

/** Шаг оценки. Десятибалльная шкала у AniList дробная, половины достаточно. */
const SCORE_STEP = 0.5

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
const statuses = computed(() => statusList(card.value?.type ?? 'ANIME'))

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

/** Подпись строки счёта: «Главы» у манги и «Эпизоды» у аниме. */
const partsWord = computed<string>(() => partsWordFor(card.value?.type ?? 'ANIME'))

/** Главное название: русское, латиница, английское, номер. */
const mainTitle = computed<string>(
  () =>
    russian.value?.russian ??
    card.value?.romaji ??
    card.value?.english ??
    `Тайтл #${mediaId.value}`,
)

/** Подложка героя: баннер сервера, а без него тон обложки. */
const heroStyle = computed(() => {
  const banner = card.value?.banner
  if (banner) return { backgroundImage: `url("${banner}")` }

  const tone = card.value?.color ?? '#1b2534'
  return { backgroundImage: `linear-gradient(120deg, ${tone}, #0b1018)` }
})

/** Доля пройденного для полосы в панели правки. */
const donePart = computed<string>(() => {
  const total = partsTotal.value
  if (total === null || total <= 0) return status.value === 'COMPLETED' ? '100%' : '0%'

  const part = Math.min(1, Math.max(0, progress.value / total))
  return `${Math.round(part * 100)}%`
})

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

/** Факты пилюлями под названием: только то, что сервер впрямь назвал. */
const facts = computed<string[]>(() => {
  const found = card.value
  if (found === null) return []

  const list: string[] = []
  const kindWord = formatWord(found.format)
  if (kindWord !== null) list.push(kindWord)
  if (found.seasonYear !== null) list.push(String(found.seasonYear))
  if (partsTotal.value !== null) list.push(`${partsWord.value}: ${partsTotal.value}`)
  if (found.volumes) list.push(`Тома: ${found.volumes}`)
  if (found.duration) list.push(`${found.duration} мин`)
  if (found.averageScore !== null) list.push(`Средняя ${found.averageScore}%`)

  return list
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
  <section class="am-page">
    <div v-if="mediaId === 0" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⊘</span>
      <span>Тайтл не выбран: в адресе нет номера.</span>
      <span>Откройте карточку из списков или поиска.</span>
    </div>

    <template v-else>
      <p v-if="trouble" class="am-error">{{ trouble }}</p>

      <div v-if="busy && !card" class="am-wait">
        <span class="am-skeleton am-wait__hero" />
        <span class="am-skeleton am-wait__line" />
        <span class="am-skeleton am-wait__line am-wait__line--short" />
      </div>

      <template v-if="card">
        <div class="am-hero">
          <div class="am-hero__art" :style="heroStyle" />
          <div class="am-hero__veil" />

          <div class="am-hero__body">
            <img
              v-if="card.cover"
              class="am-hero__cover"
              :src="card.cover"
              :alt="mainTitle"
              decoding="async"
            />
            <span v-else class="am-hero__cover am-hero__cover--empty" aria-hidden="true">?</span>

            <div class="am-hero__text">
              <h2 class="am-hero__title">{{ mainTitle }}</h2>
              <p v-if="card.romaji" class="am-hero__sub">{{ card.romaji }}</p>
              <p v-if="card.native" class="am-hero__sub">{{ card.native }}</p>

              <ul class="am-pills">
                <li v-for="item in facts" :key="item" class="am-pill">{{ item }}</li>
                <li v-if="card.isAdult" class="am-pill am-pill--adult">18+</li>
              </ul>

              <ul v-if="card.genres.length > 0" class="am-pills">
                <li v-for="genre in card.genres" :key="genre" class="am-pill am-pill--soft">
                  {{ genre }}
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div class="am-split">
          <div class="am-split__main">
            <div v-if="about" class="am-panel">
              <h3 class="am-h3">Описание</h3>
              <p class="am-about">{{ about }}</p>
            </div>

            <div v-else class="am-panel am-dim">Описания ни один источник не дал.</div>
          </div>

          <aside class="am-split__side">
            <div class="am-panel">
              <h3 class="am-h3">Моё состояние</h3>

              <label class="am-set">
                <span class="am-set__name">Закладка</span>
                <select class="am-pick" :value="status" @change="onStatus">
                  <option value="" disabled>не в списке</option>
                  <option v-for="item in statuses" :key="item.key" :value="item.key">
                    {{ item.title }}
                  </option>
                </select>
              </label>

              <div class="am-set">
                <span class="am-set__name">Оценка</span>
                <div class="am-set__pick">
                  <button class="am-step" type="button" @click="bumpScore(-SCORE_STEP)">−</button>
                  <span class="am-set__value">{{ scoreText(score10) }}</span>
                  <button class="am-step" type="button" @click="bumpScore(SCORE_STEP)">+</button>
                </div>
              </div>

              <div class="am-set">
                <span class="am-set__name">{{ partsWord }}</span>
                <div class="am-set__pick">
                  <button class="am-step" type="button" @click="bumpProgress(-1)">−</button>
                  <span class="am-set__value">{{ partsText }}</span>
                  <button class="am-step" type="button" @click="bumpProgress(1)">+</button>
                </div>
              </div>

              <span class="am-line">
                <span class="am-line__fill" :style="{ width: donePart }" />
              </span>

              <p v-if="card.type === 'MANGA'" class="am-meta">
                Прочитано томов: {{ volumes }}. Правка томов появится вместе с её видом в очереди.
              </p>

              <p v-if="drifted" class="am-meta">
                Состояние расходится с сервером: правка ещё в очереди на отправку.
              </p>
            </div>

            <div class="am-panel">
              <h3 class="am-h3">Справка</h3>
              <p class="am-meta">
                AniList #{{ card.mediaId }}
                <template v-if="card.malId"> · MAL #{{ card.malId }}</template>
                <template v-if="russian"> · описание: {{ russian.sourceName }}</template>
              </p>

              <button
                class="am-btn am-btn--soft am-btn--wide"
                type="button"
                :disabled="busy"
                @click="onReload"
              >
                {{ busy ? 'Обновляем…' : 'Обновить карточку' }}
              </button>
            </div>
          </aside>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.am-wait {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.am-wait__hero {
  display: block;
  height: 280px;
  border-radius: var(--am-r-xl);
}

.am-wait__line {
  display: block;
  width: 60%;
  height: 14px;
  border-radius: var(--am-r-s);
}

.am-wait__line--short {
  width: 34%;
}

/* Герой карточки: баннер фоном, текст поверх тёмной завеси. */
.am-hero {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-xl);
  box-shadow: var(--am-sh-2);
}

.am-hero__art {
  position: absolute;
  inset: 0;
  background-position: center 22%;
  background-size: cover;
  filter: saturate(1.05);
}

.am-hero__veil {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(6, 9, 15, 0.35) 0%, rgba(6, 9, 15, 0.86) 62%, var(--am-bg-2) 100%),
    linear-gradient(90deg, rgba(6, 9, 15, 0.8) 0%, rgba(6, 9, 15, 0.25) 60%);
}

.am-hero__body {
  position: relative;
  display: flex;
  gap: 26px;
  align-items: flex-end;
  padding: 78px 30px 26px;
}

.am-hero__cover {
  flex: none;
  width: 208px;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
  box-shadow: 0 26px 54px rgba(2, 5, 10, 0.72);
}

.am-hero__cover--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 42px;
  color: rgba(255, 255, 255, 0.3);
  background: linear-gradient(160deg, #1b2534, #0f151e);
}

.am-hero__text {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding-bottom: 6px;
}

.am-hero__title {
  margin: 0;
  font-size: 30px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.6);
}

.am-hero__sub {
  margin: 0;
  font-size: 13.5px;
  color: var(--am-dim);
}

.am-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.am-pill {
  padding: 4px 11px;
  font-size: 12px;
  font-weight: 550;
  color: #e6edf8;
  background: rgba(255, 255, 255, 0.09);
  border: 1px solid var(--am-line-soft);
  border-radius: 999px;
}

.am-pill--soft {
  color: var(--am-dim);
  background: rgba(255, 255, 255, 0.04);
}

.am-pill--adult {
  color: #ffd9d9;
  background: rgba(255, 90, 90, 0.24);
  border-color: rgba(255, 90, 90, 0.4);
}

/* Широкое окно делится надвое, узкое складывается в одну колонку. */
.am-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 18px;
  align-items: start;
}

.am-split__main,
.am-split__side {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.am-about {
  max-width: 78ch;
  margin: 0;
  line-height: 1.6;
  color: #d7e0ee;
  white-space: pre-line;
}

.am-set {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.am-set__name {
  font-size: 13px;
  color: var(--am-dim);
}

.am-set__pick {
  display: flex;
  gap: 8px;
  align-items: center;
}

.am-set__value {
  min-width: 68px;
  font-weight: 600;
  text-align: center;
}

.am-pick {
  padding: 7px 10px;
  font: inherit;
  color: var(--am-text);
  background: var(--am-bg-2);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-s);
}

.am-step {
  width: 32px;
  height: 32px;
  font: inherit;
  font-size: 16px;
  color: var(--am-text);
  cursor: pointer;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-s);
}

.am-step:hover {
  background: var(--am-hover);
  border-color: var(--am-accent);
}

@media (max-width: 1180px) {
  .am-split {
    grid-template-columns: minmax(0, 1fr);
  }

  .am-hero__body {
    gap: 18px;
    padding: 60px 20px 20px;
  }

  .am-hero__cover {
    width: 148px;
  }

  .am-hero__title {
    font-size: 24px;
  }
}
</style>
