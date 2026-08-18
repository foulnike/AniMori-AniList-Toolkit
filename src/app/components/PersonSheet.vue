<script setup lang="ts">
// Пункт 3.9: человек окошком поверх экрана. Своя история переходов:
// от персонажа к его сэйю и обратно, без ухода с карточки тайтла.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  fetchPersonCard,
  peekPersonCard,
  type PersonCard,
  type PersonRef,
  type PersonTarget,
} from '@/api/anilist-person'
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

const props = defineProps<{ start: PersonTarget }>()

const emit = defineEmits<{ (e: 'close'): void }>()

/** Кого смотрим сейчас и куда вернёт «Назад». */
const view = ref<PersonTarget>(props.start)
const path = ref<PersonTarget[]>([])

const card = ref<PersonCard | null>(peekPersonCard(props.start.kind, props.start.personId))
const busy = ref(false)

/** Номер показа: ответ на прежнего человека приходит уже не к месту. */
let run = 0

const kicker = computed<string>(() =>
  view.value.kind === 'character' ? 'Персонаж' : 'Автор',
)

/** Имя и портрет берутся из плитки, пока ответ ещё в пути. */
const name = computed<string>(() => card.value?.name ?? view.value.name)
const native = computed<string | null>(() => card.value?.native ?? view.value.native)
const image = computed<string | null>(() => card.value?.image ?? view.value.image)
const siteUrl = computed<string | null>(() => card.value?.siteUrl ?? view.value.siteUrl)

const letter = computed<string>(() => name.value.slice(0, 1).toUpperCase())

async function load(): Promise<void> {
  const mine = ++run
  const ready = peekPersonCard(view.value.kind, view.value.personId)

  card.value = ready
  if (ready !== null) return

  busy.value = true

  try {
    const found = await fetchPersonCard(view.value.kind, view.value.personId)
    if (mine !== run) return

    card.value = found
  } catch (e) {
    // Окно остаётся с именем и портретом из плитки: это лучше пустоты.
    Logger('WARN', `Человек ${view.value.personId}: добыть не вышло`, e)
  } finally {
    if (mine === run) busy.value = false
  }
}

/** Переход к сэйю: голос — тот же автор, просто с другой стороны. */
function onVoice(person: PersonRef): void {
  path.value.push(view.value)
  view.value = { kind: 'staff', ...person }
}

function onBack(): void {
  const prev = path.value.pop()
  if (prev !== undefined) view.value = prev
}

/** Уводит наружу через оболочку: в окне приложения переход унёс бы само окно. */
function onOpen(): void {
  const url = siteUrl.value
  if (url === null) return

  void Bridge.shell.openExternal(url).catch((e) => {
    Logger('WARN', `Человек: внешняя ссылка не открылась (${url})`, e)
  })
}

/** Escape возвращает на шаг назад, а с первого шага закрывает окно. */
function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return

  if (path.value.length > 0) onBack()
  else emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  void load()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})

watch(
  () => `${view.value.kind}:${view.value.personId}`,
  () => {
    void load()
  },
)
</script>

<template>
  <div class="am-who" role="dialog" aria-modal="true" @click.self="emit('close')">
    <div class="am-who__box">
      <header class="am-who__top">
        <button
          v-if="path.length > 0"
          class="am-btn am-btn--ghost"
          type="button"
          @click="onBack"
        >
          ← Назад
        </button>

        <div class="am-who__text">
          <span class="am-who__kicker">{{ kicker }}</span>
          <h3 class="am-who__name">{{ name }}</h3>
          <span v-if="native" class="am-who__native">{{ native }}</span>
        </div>

        <button class="am-who__close" type="button" title="Закрыть" @click="emit('close')">
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div class="am-who__body">
        <div class="am-who__side">
          <img v-if="image" class="am-who__art" :src="image" :alt="name" decoding="async" />
          <span v-else class="am-who__art am-who__art--empty" aria-hidden="true">{{ letter }}</span>

          <dl v-if="card && card.facts.length > 0" class="am-who__facts">
            <div v-for="fact in card.facts" :key="fact.name" class="am-who__fact">
              <dt class="am-who__fact-name">{{ fact.name }}</dt>
              <dd class="am-who__fact-value">{{ fact.value }}</dd>
            </div>
          </dl>
        </div>

        <div class="am-who__main">
          <div v-if="busy && card === null" class="am-who__wait">
            <span class="am-skeleton am-who__line" />
            <span class="am-skeleton am-who__line" />
            <span class="am-skeleton am-who__line am-who__line--short" />
          </div>

          <p v-else-if="card && card.about" class="am-who__about">{{ card.about }}</p>
          <p v-else class="am-dim">Описания нет.</p>

          <section v-if="card && card.voices.length > 0" class="am-who__voices">
            <h4 class="am-who__sub">Голоса</h4>
            <div class="am-who__rail">
              <button
                v-for="person in card.voices"
                :key="person.personId"
                class="am-who__voice"
                type="button"
                :title="person.native ?? person.name"
                @click="onVoice(person)"
              >
                <img
                  v-if="person.image"
                  class="am-who__pic"
                  :src="person.image"
                  :alt="person.name"
                  loading="lazy"
                  decoding="async"
                />
                <span v-else class="am-who__pic am-who__pic--empty" aria-hidden="true">
                  {{ person.name.slice(0, 1) }}
                </span>

                <span class="am-who__voice-name">{{ person.name }}</span>
              </button>
            </div>
          </section>
        </div>
      </div>

      <footer class="am-who__foot">
        <button v-if="siteUrl" class="am-btn am-btn--soft" type="button" @click="onOpen">
          Открыть на AniList
        </button>

        <span class="am-bar__gap" />

        <button class="am-btn" type="button" @click="emit('close')">Готово</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Окно поверх экрана: затемнение гасит всё лишнее. */
.am-who {
  position: fixed;
  inset: 0;
  z-index: 32;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(4, 7, 12, 0.68);
  backdrop-filter: blur(6px);
}

.am-who__box {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
  max-width: 900px;
  max-height: 88vh;
  padding: 26px;
  background: linear-gradient(180deg, var(--am-panel-2), var(--am-panel));
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-l);
  box-shadow: var(--am-sh-2);
}

.am-who__top {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.am-who__text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.am-who__kicker {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--am-accent);
  text-transform: uppercase;
}

.am-who__name {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  line-height: 1.25;
}

.am-who__native {
  font-size: 13px;
  color: var(--am-faint);
}

.am-who__close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-left: auto;
  padding: 0;
  font: inherit;
  font-size: 22px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--am-line);
  border-radius: 999px;
}

.am-who__close:hover {
  color: var(--am-text);
  background: var(--am-hover);
}

/* Портрет с фактами слева, описание справа и прокручивается само. */
.am-who__body {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 20px;
  min-height: 0;
  overflow: hidden;
}

.am-who__side {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}

.am-who__art {
  width: 100%;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  background: var(--am-panel-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-who__art--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 44px;
  color: var(--am-faint);
}

.am-who__facts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
}

.am-who__fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.am-who__fact-name {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--am-faint);
  text-transform: uppercase;
}

.am-who__fact-value {
  margin: 0;
  font-size: 13.5px;
}

.am-who__main {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
  overflow-y: auto;
}

.am-who__about {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--am-text);
  white-space: pre-line;
}

.am-who__wait {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.am-who__line {
  height: 14px;
  border-radius: var(--am-r-s);
}

.am-who__line--short {
  width: 60%;
}

.am-who__sub {
  margin: 0 0 10px;
  font-size: 13px
  ;
  font-weight: 650;
  letter-spacing: 0.03em;
  color: var(--am-dim);
  text-transform: uppercase;
}

.am-who__rail {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 6px;
}

.am-who__voice {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  width: 92px;
  padding: 8px;
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-who__voice:hover,
.am-who__voice:focus-visible {
  background: var(--am-hover);
  border-color: var(--am-accent);
}

.am-who__pic {
  width: 60px;
  height: 60px;
  object-fit: cover;
  background: var(--am-panel-2);
  border-radius: 50%;
}

.am-who__pic--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: var(--am-faint);
}

.am-who__voice-name {
  font-size: 12px;
  line-height: 1.3;
  text-align: center;
}

.am-who__foot {
  display: flex;
  gap: 10px;
  align-items: center;
}

/* Узкое окно: портрет уходит наверх, столбец один. */
@media (max-width: 760px) {
  .am-who__body {
    grid-template-columns: minmax(0, 1fr);
    overflow-y: auto;
  }

  .am-who__art {
    max-width: 160px;
  }
}
</style>
