<script setup lang="ts">
// Пункт 3.4: карточка тайтла. Номер из адреса, подробности с сервера,
// а состояние списка — из памяти: там правда свежее чужого ответа.
// Настройки записи живут в окне правки, отсюда оно только открывается.
//
// Здесь осталась только разметка: данные в media-card.ts, оформление
// в media-screen.css. Собранный в одном файле экран переставал поддаваться
// точечной правке.
import { computed, onMounted, ref, watch } from 'vue'

import EntrySheet from '../components/EntrySheet.vue'
import PeopleBox from '../components/PeopleBox.vue'
import { genreWord } from '../labels'
import { currentRoute } from '../router'

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
  boardClass,
  load,
  studioLogo,
  franchiseName,
  franchiseStatus,
  franchiseHint,
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
                <li v-if="score10 > 0" class="am-pill am-pill--mine" title="Моя оценка">
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

              <ul v-if="ratings.length > 0" class="am-pills">
                <li
                  v-for="rate in ratings"
                  :key="rate.key"
                  class="am-pill am-pill--rate"
                  :title="`Средняя оценка на ${rate.label}`"
                >
                  <span class="am-pill__src">{{ rate.label }}</span>
                  ★ {{ rate.value }}
                </li>
              </ul>

              <ul v-if="card.studios.length > 0" class="am-pills">
                <li v-for="studio in card.studios" :key="studio.studioId">
                  <button
                    class="am-pill am-pill--studio"
                    :class="{ 'am-pill--studio-main': studio.main }"
                    type="button"
                    :title="`Работы студии ${studio.name}`"
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
            </div>
          </div>
        </div>

        <div class="am-board" :class="boardClass">
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
            <div class="am-mine">
              <button
                class="am-mine__pick"
                :class="{ 'am-mine__pick--empty': !listed }"
                type="button"
                @click="sheetOpen = true"
              >
                <span v-if="listed" class="am-mine__dot" aria-hidden="true" />
                {{ listLabel }}
                <span v-if="listed" class="am-mine__hint">Изменить</span>
              </button>

              <div v-if="listed" class="am-mine__progress">
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
                Правка сохранена и ждёт отправки на AniList.
              </p>
            </div>
          </aside>

          <div v-if="franchiseRows.length > 0" class="am-panel am-fran">
            <h3 class="am-h3">Франшиза</h3>

            <div ref="franList" class="am-rail">
              <article
                v-for="work in franchiseRows"
                :key="work.malId ?? work.name"
                class="am-part"
              >
                <button
                  v-if="work.mediaId !== null && work.mediaId !== mediaId"
                  class="am-part__hit"
                  type="button"
                  :title="franchiseHint(work)"
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
                  <span v-if="franchiseStatus(work)" class="am-part__status">
                    {{ franchiseStatus(work) }}
                  </span>
                </button>
                <div
                  v-else
                  class="am-part__hit am-part__hit--still"
                  :class="{ 'am-part__hit--here': work.mediaId === mediaId }"
                  :title="franchiseHint(work)"
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
            <PeopleBox :media-id="mediaId" :type="card.type" />
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
