<script setup lang="ts">
// Пункт 3.4: карточка тайтла. Номер из адреса, подробности с сервера,
// а состояние списка — из памяти: там правда свежее чужого ответа.
// Настройки записи живут в окне правки, отсюда оно только открывается.
import { computed, onMounted, ref, watch } from 'vue'

import { fetchMediaCard, type MediaCard } from '@/api/anilist-media'
import { Bridge } from '@/bridge'
import { getEntry } from '@/core/collection'
import { queueEdit, type EntryLook } from '@/core/edit-sender'
import { partsOut } from '@/core/media-looks'
import { getRussianTitle, type RussianTitle } from '@/core/media-title'
import { Logger } from '@/utils/logger'

import EntrySheet from '../components/EntrySheet.vue'
import PeopleBox from '../components/PeopleBox.vue'
import { formatWord, partsWord as partsWordFor, statusWord } from '../labels'
import { mediaLinks, type MediaLink } from '../media-links'
import { currentRoute } from '../router'

const card = ref<MediaCard | null>(null)
const russian = ref<RussianTitle | null>(null)
const busy = ref(true)
const trouble = ref('')

/** Открыто ли окно правки записи. */
const sheetOpen = ref(false)

/** Счётчик правок этого показа: заставляет пересчитать взятое из памяти. */
const editStamp = ref(0)

/** Номер показа: ответ на старый тайтл пришёл не вовремя и ему места нет. */
let run = 0

const mediaId = computed<number>(() => {
  const raw = Number(currentRoute.value.params.id ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
})

/** Своя запись из памяти. Счётчик правок в зависимостях не случаен: */
/** мап коллекции вне реактивности Vue, сам он пересчёт не закажет. */
const own = computed(() => {
  void editStamp.value
  return mediaId.value > 0 ? getEntry(mediaId.value) : undefined
})

/**
 * Облик тайтла для записи списка: тип, латинские имена и метка взрослого.
 * Идёт вместе с правкой, иначе запись, созданная без входа, останется
 * безымянной: имена и метку до сих пор приносил только ответ сервера.
 */
const look = computed<EntryLook | undefined>(() => {
  const found = card.value
  if (found === null) return undefined

  return {
    type: found.type,
    romaji: found.romaji,
    english: found.english,
    isAdult: found.isAdult,
  }
})

/** Статус для выбора: память главнее ответа, ответ — запас на первый показ. */
const status = computed<string>(() => own.value?.status ?? card.value?.ownEntry?.status ?? '')

const score10 = computed<number>(() => own.value?.score10 ?? card.value?.ownEntry?.score10 ?? 0)

const progress = computed<number>(() => own.value?.progress ?? card.value?.ownEntry?.progress ?? 0)

const volumes = computed<number>(() => own.value?.volumes ?? card.value?.ownEntry?.volumes ?? 0)

/** Пересмотры и перечитывания. Правило то же: память впереди ответа. */
const repeat = computed<number>(() => own.value?.repeat ?? card.value?.ownEntry?.repeat ?? 0)

const startedAt = computed<string | null>(
  () => own.value?.startedAt ?? card.value?.ownEntry?.startedAt ?? null,
)

const completedAt = computed<string | null>(
  () => own.value?.completedAt ?? card.value?.ownEntry?.completedAt ?? null,
)

const notes = computed<string | null>(() => own.value?.notes ?? card.value?.ownEntry?.notes ?? null)

/**
 * Сколько частей уже вышло: именно по этому числу считается полоса и шаг.
 * У идущего сезона объявленного итога часто нет вовсе.
 */
const partsTotal = computed<number | null>(() =>
  card.value === null ? null : partsOut(card.value, card.value.type),
)

/** Объявленный итог: то, сколько частей всего обещано. */
const partsPlanned = computed<number | null>(() =>
  card.value?.type === 'MANGA' ? (card.value?.chapters ?? null) : (card.value?.episodes ?? null),
)

/** Всего томов у манги. У аниме поле всегда пустое. */
const volumesTotal = computed<number | null>(() => card.value?.volumes ?? null)

/** Подпись строки счёта: «Главы» у манги и «Эпизоды» у аниме. */
const partsWord = computed<string>(() => partsWordFor(card.value?.type ?? 'ANIME'))

/** Слово для пересмотров: у манги читают, а не смотрят. */
const repeatWord = computed<string>(() =>
  card.value?.type === 'MANGA' ? 'Перечитывания' : 'Пересмотры',
)

/** Надпись главной кнопки: своя закладка, а без неё приглашение добавить. */
const listLabel = computed<string>(() => {
  const word = statusWord(card.value?.type ?? 'ANIME', status.value === '' ? null : status.value)
  return word ?? 'Добавить в список'
})

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

/** Доля пройденного для полосы в сводке. */
const doneShare = computed<number>(() => {
  const total = partsTotal.value
  if (total === null || total <= 0) return status.value === 'COMPLETED' ? 1 : 0

  return Math.min(1, Math.max(0, progress.value / total))
})

const donePart = computed<string>(() => `${Math.round(doneShare.value * 100)}%`)

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
    server.progress !== mine.progress ||
    server.volumes !== mine.volumes ||
    server.repeat !== mine.repeat ||
    server.startedAt !== mine.startedAt ||
    server.completedAt !== mine.completedAt ||
    server.notes !== mine.notes
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

/**
 * Бледный хвост под описанием: номера каталогов и источник текста,
 * теперь ссылками. Сборка адресов — в media-links.ts.
 */
const aboutLinks = computed<MediaLink[]>(() => {
  const found = card.value
  if (found === null) return []

  return mediaLinks({
    mediaId: found.mediaId,
    malId: found.malId,
    type: found.type,
    sourceUrl: russian.value?.url ?? null,
    sourceName: russian.value?.sourceName ?? null,
  })
})

/** Факты пилюлями под названием: только то, что сервер впрямь назвал. */
const facts = computed<string[]>(() => {
  const found = card.value
  if (found === null) return []

  const list: string[] = []
  const kindWord = formatWord(found.format)
  if (kindWord !== null) list.push(kindWord)
  if (found.seasonYear !== null) list.push(String(found.seasonYear))
  if (partsPlanned.value !== null) list.push(`${partsWord.value}: ${partsPlanned.value}`)

  // У идущего сезона важно не обещанное, а то, что уже можно смотреть.
  if (found.airingEpisode !== null && partsTotal.value !== null) {
    list.push(`Вышло: ${partsTotal.value}`)
  }

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

/**
 * Дата человеческим видом. Строка разбирается вручную: прогон через Date
 * счёл бы её полночью по Гринвичу и сдвинул день назад у половины мира.
 */
function dateText(value: string | null): string {
  if (value === null) return '—'

  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!parts) return value

  return `${parts[3]}.${parts[2]}.${parts[1]}`
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
  sheetOpen.value = false

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

/**
 * Уводит наружу через оболочку: в WebView2 переход в новом окне молча
 * отбрасывается, а переход в том же окне унёс бы само приложение.
 */
function onOpen(url: string): void {
  void Bridge.shell.openExternal(url).catch((e) => {
    Logger('WARN', `Карточка: внешняя ссылка не открылась (${url})`, e)
  })
}

/** Виды правки, доступные с карточки. Удаление записи сюда пока не входит. */
type CardEdit =
  'status' | 'score' | 'progress' | 'volumes' | 'repeat' | 'startedAt' | 'completedAt' | 'notes'

/** Отправляет одну правку в очередь и обновляет показ по памяти. */
async function send(kind: CardEdit, value: string | number): Promise<void> {
  if (mediaId.value === 0) return

  try {
    // Облик идёт вместе с правкой: без входа его больше взять негде.
    await queueEdit(mediaId.value, kind, value, look.value)
    editStamp.value += 1
  } catch (e) {
    trouble.value = describe(e)
  }
}

function onPickStatus(value: string): void {
  if (value === status.value) return
  void send('status', value)
}

function onPickScore(value: number): void {
  void send('score', value)
}

function onPickProgress(value: number): void {
  void send('progress', value)
}

function onPickVolumes(value: number): void {
  void send('volumes', value)
}

function onPickRepeat(value: number): void {
  void send('repeat', value)
}

function onPickStarted(value: string): void {
  void send('startedAt', value)
}

function onPickCompleted(value: string): void {
  void send('completedAt', value)
}

function onPickNotes(value: string): void {
  void send('notes', value)
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
            <div class="am-panel am-about-box">
              <h3 class="am-h3">Описание</h3>
              <p v-if="about" class="am-about">{{ about }}</p>
              <p v-else class="am-dim">Описания ни один источник не дал.</p>

              <p v-if="aboutLinks.length > 0" class="am-about__tail">
                <template v-for="(link, at) in aboutLinks" :key="link.key">
                  <span v-if="at > 0" class="am-about__dot" aria-hidden="true">·</span>
                  <a
                    class="am-about__link"
                    :href="link.url"
                    :title="link.hint"
                    @click.prevent="onOpen(link.url)"
                    >{{ link.text }}</a
                  >
                </template>
              </p>
            </div>
          </div>

          <aside class="am-split__side">
            <div class="am-panel am-mine">
              <button
                class="am-btn am-btn--wide am-mine__pick"
                type="button"
                @click="sheetOpen = true"
              >
                {{ listLabel }}
              </button>

              <div class="am-mine__bar">
                <span class="am-line">
                  <span class="am-line__fill" :style="{ width: donePart }" />
                </span>
                <span class="am-mine__share">{{ donePart }}</span>
              </div>

              <dl class="am-tiles">
                <div class="am-tile-fact">
                  <dt class="am-tile-fact__name">Оценка</dt>
                  <dd class="am-tile-fact__value">{{ scoreText(score10) }}</dd>
                </div>

                <div class="am-tile-fact">
                  <dt class="am-tile-fact__name">{{ partsWord }}</dt>
                  <dd class="am-tile-fact__value">{{ partsText }}</dd>
                </div>

                <div v-if="card.type === 'MANGA'" class="am-tile-fact">
                  <dt class="am-tile-fact__name">Тома</dt>
                  <dd class="am-tile-fact__value">{{ volumes }}</dd>
                </div>

                <div class="am-tile-fact">
                  <dt class="am-tile-fact__name">{{ repeatWord }}</dt>
                  <dd class="am-tile-fact__value">{{ repeat }}</dd>
                </div>

                <div class="am-tile-fact">
                  <dt class="am-tile-fact__name">Начато</dt>
                  <dd class="am-tile-fact__value">{{ dateText(startedAt) }}</dd>
                </div>

                <div class="am-tile-fact">
                  <dt class="am-tile-fact__name">Закончено</dt>
                  <dd class="am-tile-fact__value">{{ dateText(completedAt) }}</dd>
                </div>
              </dl>

              <p v-if="notes" class="am-mine__note">{{ notes }}</p>

              <p v-if="drifted" class="am-meta">Правка сохранена и ждёт отправки на AniList.</p>
            </div>
          </aside>
        </div>

        <PeopleBox :media-id="mediaId" :type="card.type" />

        <EntrySheet
          v-if="sheetOpen"
          :type="card.type"
          :title="mainTitle"
          :status="status"
          :score10="score10"
          :progress="progress"
          :volumes="volumes"
          :parts-total="partsTotal"
          :volumes-total="volumesTotal"
          :repeat="repeat"
          :started-at="startedAt"
          :completed-at="completedAt"
          :notes="notes"
          @close="sheetOpen = false"
          @status="onPickStatus"
          @score="onPickScore"
          @progress="onPickProgress"
          @volumes="onPickVolumes"
          @repeat="onPickRepeat"
          @started-at="onPickStarted"
          @completed-at="onPickCompleted"
          @notes="onPickNotes"
        />
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

/* Колонка описания равна длине строки, а не всей ширине окна:
   иначе панель тянется дальше текста и правая половина пустует. */
.am-split {
  display: grid;
  grid-template-columns: minmax(0, 84ch) 380px;
  gap: 18px;
  align-items: stretch;
  justify-content: start;
}

.am-split__main,
.am-split__side {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

/* Обе панели растягиваются до высоты большей из двух. */
.am-about-box,
.am-mine {
  flex: 1;
}

/* Одна колонка с ограниченной длиной строки: разбивка на столбцы
   короткое описание резала на три столбика по одной строке. */
.am-about {
  max-width: 78ch;
  margin: 0;
  line-height: 1.65;
  color: #d7e0ee;
  white-space: pre-line;
}

/* Справка хвостом описания сидит у низа панели, где бы ни кончился текст. */
.am-about__tail {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: var(--am-faint);
}

/* Номера в хвосте — ссылки наружу. Подчёркивание появляется под мышью:
   бледная справка не должна рябить линиями в покое. */
.am-about__link {
  color: var(--am-dim);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  cursor: pointer;
}

.am-about__link:hover,
.am-about__link:focus-visible {
  color: var(--am-accent);
  border-bottom-color: currentcolor;
}

.am-about__dot {
  margin: 0 7px;
}

.am-about-box {
  display: flex;
  flex-direction: column;
}

.am-about-box .am-about__tail {
  margin-top: auto;
  padding-top: 14px;
}

/* Панель записи дышит: между блоками воздух, а не слипшиеся строки. */
.am-mine {
  gap: 20px;
}

/* Главная кнопка крупная и надпись у неё по центру: с дивана и пультом
   мелкую не нажать, а вторая подпись внутри только смещала текст. */
.am-mine__pick {
  min-height: 52px;
  font-size: 15px;
  font-weight: 650;
}

/* Полоса стоит отдельно от кнопки и плиток: вплотную к ним она
   читалась как часть кнопки. */
.am-mine__bar {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 2px 0 6px;
}

.am-mine__share {
  flex: none;
  min-width: 42px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--am-dim);
  text-align: right;
}

/* Факты плитками по две в ряд: каждое значение со своей подписью. */
.am-tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.am-tile-fact {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-tile-fact__name {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--am-faint);
  text-transform: uppercase;
}

.am-tile-fact__value {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

/* Комментарий выделен полосой сбоку: это чужой текст, а не наша подпись. */
.am-mine__note {
  margin: 0;
  padding: 10px 14px;
  font-size: 13.5px;
  line-height: 1.5;
  color: #d7e0ee;
  white-space: pre-line;
  background: rgba(255, 255, 255, 0.03);
  border-left: 2px solid var(--am-accent);
  border-radius: 0 var(--am-r-s) var(--am-r-s) 0;
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
