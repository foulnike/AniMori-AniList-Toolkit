<script setup lang="ts">
// Пункт 3.4: карточка тайтла. Номер из адреса, подробности с сервера,
// а состояние списка — из памяти: там правда свежее чужого ответа.
// Настройки записи живут в окне правки, отсюда оно только открывается.
//
// Здесь осталась только разметка: данные в media-card.ts, оформление
// в media-screen.css. Собранный в одном файле экран переставал поддаваться
// точечной правке.
//
// Порядок модулей: герой с действиями у постера, описание широкой
// колонкой, своя запись и оценки площадок справа, ниже франшиза
// и люди. Главные действия стояли в правой колонке и на широком
// окне уезжали от названия на полметра.
import { computed, onMounted, ref, watch } from 'vue'

import EntrySheet from '../components/EntrySheet.vue'
import PeopleBox from '../components/PeopleBox.vue'
import RichText from '../components/RichText.vue'
import { genreWord } from '../labels'
import { currentRoute, navigate } from '../router'

import { scoreText, useMediaCard } from './media-card'

/** Открыто ли окно правки записи. */
const sheetOpen = ref(false)

const mediaId = computed<number>(() => {
  const raw = Number(currentRoute.value.params.id ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
})

const {
  card,
  busy,
  trouble,
  franList,
  status,
  score10,
  progress,
  repeat,
  startedAt,
  completedAt,
  notes,
  partsTotal,
  listed,
  listLabel,
  mainTitle,
  heroStyle,
  donePart,
  progressText,
  drifted,
  about,
  aboutLinks,
  facts,
  ratings,
  mineFacts,
  franchiseRows,
  franchiseHidden,
  load,
  studioLogo,
  franchiseName,
  franchiseStatus,
  franchiseHint,
  franchisePlay,
  openFranchiseWork,
  openStudio,
  onOpen,
  onPickStatus,
  onPickScore,
  onPickProgress,
  onPickRepeat,
  onPickStarted,
  onPickCompleted,
  onPickNotes,
} = useMediaCard(mediaId)

// Просмотр — отдельный экран со своим адресом, а не окно поверх карточки:
// его можно обновить, а тяжёлая карточка не висит в памяти под видео.
function openPlayer(): void {
  if (mediaId.value > 0) navigate('player', { id: String(mediaId.value) })
}

onMounted(() => {
  void load()
})

// Переход с карточки на карточку не пересобирает экран: грузим сами.
// Окно правки закрывается заодно: оно про запись прошлого тайтла.
watch(mediaId, () => {
  sheetOpen.value = false
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
                <li v-if="score10 > 0" v-tip="'Моя оценка'" class="am-pill am-pill--mine">
                  ★ {{ scoreText(score10) }}
                </li>
                <li v-for="item in facts" :key="item" class="am-pill">{{ item }}</li>
                <li v-if="card.isAdult" class="am-pill am-pill--adult">18+</li>
              </ul>

              <ul v-if="card.genres.length > 0" class="am-pills">
                <li v-for="genre in card.genres" :key="genre" class="am-pill am-pill--soft">
                  {{ genreWord(genre) }}
                </li>
              </ul>

              <ul v-if="card.studios.length > 0" class="am-pills">
                <li v-for="studio in card.studios" :key="studio.studioId">
                  <button
                    v-tip="`Работы студии ${studio.name}`"
                    class="am-pill am-pill--studio"
                    :class="{ 'am-pill--studio-main': studio.main }"
                    type="button"
                    @click="openStudio(studio.studioId)"
                  >
                    <img
                      v-if="studioLogo(studio.name)"
                      class="am-pill__logo"
                      :src="studioLogo(studio.name)!"
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                    {{ studio.name }}
                  </button>
                </li>
              </ul>

              <div class="am-acts">
                <button
                  v-tip="'Источники спрашиваются при открытии плеера'"
                  class="am-acts__play"
                  type="button"
                  @click="openPlayer"
                >
                  <span aria-hidden="true">▶</span>
                  <span>Смотреть</span>
                </button>

                <button class="am-acts__save" type="button" @click="sheetOpen = true">
                  <span v-if="listed" class="am-acts__dot" aria-hidden="true" />
                  {{ listLabel }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="am-board">
          <div class="am-split__main">
            <div class="am-panel am-about-box">
              <h3 class="am-h3">Описание</h3>
              <!-- Разметка источника живая: ссылки, спойлеры и начертания рисует
                   компонент, а типографика .am-about остаётся на его корне. -->
              <RichText v-if="about" class="am-about" :text="about" />
              <p v-else class="am-dim">Описания ни один источник не дал.</p>

              <p v-if="aboutLinks.length > 0" class="am-about__tail">
                <template v-for="(link, at) in aboutLinks" :key="link.key">
                  <span v-if="at > 0" class="am-about__dot" aria-hidden="true">·</span>
                  <a
                    v-tip="link.hint"
                    class="am-about__link"
                    :href="link.url"
                    @click.prevent="onOpen(link.url)"
                    >{{ link.text }}</a
                  >
                </template>
              </p>
            </div>
          </div>

          <aside class="am-split__side">
            <div class="am-panel am-mine">
              <div class="am-mine__head">
                <h3 class="am-h3">Моя запись</h3>
                <button class="am-mine__edit" type="button" @click="sheetOpen = true">
                  {{ listed ? 'Изменить' : 'Добавить' }}
                </button>
              </div>

              <template v-if="listed">
                <div class="am-mine__progress">
                  <div class="am-mine__prow">
                    <span class="am-mine__pname">Эпизоды</span>
                    <span class="am-mine__pval">{{ progressText }}</span>
                  </div>
                  <span class="am-line am-mine__line">
                    <span class="am-line__fill" :style="{ width: donePart }" />
                  </span>
                </div>

                <dl v-if="mineFacts.length > 0" class="am-mine__rows">
                  <div v-for="fact in mineFacts" :key="fact.key" class="am-mine__row">
                    <dt class="am-mine__rname">{{ fact.name }}</dt>
                    <dd class="am-mine__rval">{{ fact.value }}</dd>
                  </div>
                </dl>

                <p v-if="notes" class="am-mine__note">{{ notes }}</p>

                <p v-if="drifted" class="am-mine__drift">
                  Запись изменена здесь. На AniList она осталась прежней.
                </p>
              </template>

              <p v-else class="am-mine__none">Тайтла нет в ваших списках.</p>
            </div>

            <div v-if="ratings.length > 0" class="am-panel am-rates">
              <h3 class="am-h3">Оценки площадок</h3>

              <ul class="am-rates__list">
                <li
                  v-for="rate in ratings"
                  :key="rate.key"
                  v-tip="`Средняя оценка на ${rate.label}`"
                  class="am-rates__row"
                >
                  <span class="am-rates__src">{{ rate.label }}</span>
                  <span class="am-rates__val">★ {{ rate.value }}</span>
                </li>
              </ul>
            </div>
          </aside>

          <div v-if="franchiseRows.length > 0" class="am-panel am-fran">
            <h3 class="am-h3">Франшиза</h3>

            <div ref="franList" class="am-rail">
              <article v-for="work in franchiseRows" :key="work.malId ?? work.name" class="am-part">
                <button
                  v-if="work.mediaId !== null && work.mediaId !== mediaId"
                  v-tip="franchiseHint(work)"
                  class="am-part__hit"
                  type="button"
                  @click="openFranchiseWork(work)"
                >
                  <img
                    v-if="work.cover"
                    class="am-part__art"
                    :src="work.cover"
                    :alt="work.name"
                    loading="lazy"
                    decoding="async"
                  />
                  <span v-else class="am-part__art am-part__art--empty" aria-hidden="true">
                    {{ work.name.slice(0, 1) }}
                  </span>
                  <span class="am-part__year">{{ work.year ?? '···' }}</span>
                  <span class="am-part__name">{{ franchiseName(work) }}</span>
                  <!-- Молчание метки — это «не спрашивали или не нашли», а не «нет»:
                       на маленькой карточке честнее не рисовать ничего. -->
                  <span v-if="franchisePlay(work) === 'yes'" class="am-part__play">Есть видео</span>
                  <span v-if="franchiseStatus(work)" class="am-part__status">
                    {{ franchiseStatus(work) }}
                  </span>
                </button>
                <div
                  v-else
                  v-tip="franchiseHint(work)"
                  class="am-part__hit am-part__hit--still"
                  :class="{ 'am-part__hit--here': work.mediaId === mediaId }"
                >
                  <img
                    v-if="work.cover"
                    class="am-part__art"
                    :src="work.cover"
                    :alt="work.name"
                    loading="lazy"
                    decoding="async"
                  />
                  <span v-else class="am-part__art am-part__art--empty" aria-hidden="true">
                    {{ work.name.slice(0, 1) }}
                  </span>
                  <span class="am-part__year">{{ work.year ?? '···' }}</span>
                  <span class="am-part__name">{{ franchiseName(work) }}</span>
                  <span v-if="franchisePlay(work) === 'yes'" class="am-part__play">Есть видео</span>
                  <span v-if="work.mediaId === mediaId" class="am-part__here">вы здесь</span>
                  <span v-else-if="franchiseStatus(work)" class="am-part__status">
                    {{ franchiseStatus(work) }}
                  </span>
                </div>
              </article>
            </div>

            <p v-if="franchiseHidden > 0" class="am-fran__hidden">
              Скрыто с меткой 18+: {{ franchiseHidden }}
            </p>
          </div>

          <div class="am-board__folk">
            <PeopleBox :media-id="mediaId" />
          </div>
        </div>

        <EntrySheet
          v-if="sheetOpen"
          :title="mainTitle"
          :status="status"
          :score10="score10"
          :progress="progress"
          :parts-total="partsTotal"
          :repeat="repeat"
          :started-at="startedAt"
          :completed-at="completedAt"
          :notes="notes"
          @close="sheetOpen = false"
          @status="onPickStatus"
          @score="onPickScore"
          @progress="onPickProgress"
          @repeat="onPickRepeat"
          @started-at="onPickStarted"
          @completed-at="onPickCompleted"
          @notes="onPickNotes"
        />
      </template>
    </template>
  </section>
</template>

<style scoped src="./media-screen.css"></style>

<!-- Оформление карточки франшизы живёт в media-screen.css. Здесь только метка
     доступности: одно правило рядом с разметкой, которая его завела. -->
<style scoped>
.am-part__play {
  align-self: center;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 600;
  color: var(--am-accent);
  background: rgb(var(--am-accent-rgb) / 0.16);
  border-radius: var(--am-r-cap);
}
</style>
