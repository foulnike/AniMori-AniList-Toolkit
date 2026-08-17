<script setup lang="ts">
// Настройки: вход в AniList и распоряжение своими данными.
// На экране только то, что человеку решать: как всё устроено внутри —
// дело документации, а не карточки настроек.
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import {
  entryCount,
  forgetCollection,
  refreshFromServer,
  unlinkCollection,
} from '@/core/collection'
import { clearCache, getDbStats } from '@/core/db'

import {
  authStatus,
  isDesktop,
  logout,
  refreshAuth,
  startLogin,
  submitToken,
  watchAuth,
  type LoginStart,
} from '../auth/session'

const version = __ANIMORI_VERSION__

const desktop = isDesktop()

/// Человеку важна его система, а не имя нашей сборки: слово «app» ему
/// не говорит ничего, а «Windows» отвечает на вопрос сразу.
function systemName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Android/i.test(ua)) return 'Android'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS X/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'неизвестна'
}

const system = systemName()

// Ошибки показываются рядом с кнопкой, а не глотаются: молчаливый catch
// здесь означал бы кнопку, которая не делает ничего и не говорит почему.
const error = ref('')
const busy = ref(false)
const manual = ref('')
const manualOpen = ref(false)

// Ответ Rust на нажатие «Войти». Держится до входа или до ухода с экрана:
// из него берётся срок ожидания для подсказки.
const login = ref<LoginStart | null>(null)

// Сброс и перенос идут молча, и без явного ответа человек не поймёт,
// случилось ли что-нибудь вообще.
const note = ref('')
const cleared = ref(false)

/**
 * Спрошено ли подтверждение переноса. Перенос замещает список целиком,
 * а такое не делают одним промахом мыши.
 */
const asking = ref(false)

/**
 * Спрошено ли подтверждение удаления списка. Спрашивается всегда:
 * местные записи вернуть потом неоткуда, их нет ни на каком сервере.
 */
const askingDrop = ref(false)

const listCount = ref(0)
const usedSize = ref('')

let stopWatch: (() => void) | null = null

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function guard(action: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (e) {
    error.value = describe(e)
  } finally {
    busy.value = false
  }
}

/// Числа переспрашиваются после каждой кнопки: показанное должно совпадать
/// с тем, что лежит внутри.
async function readState(): Promise<void> {
  listCount.value = entryCount()

  const got = await getDbStats()
  usedSize.value = 'error' in got ? '' : got.estimatedSize
}

function onLogin(): void {
  void guard(async () => {
    login.value = await startLogin()
  })
}

/**
 * Отключение счёта: связь рвётся, список остаётся здесь местным (пункт 3.16).
 * Раньше выход уносил список совсем, и человек терял данные там, где ждал
 * всего лишь отключения сайта.
 */
function onLogout(): void {
  void guard(async () => {
    note.value = ''
    asking.value = false

    await logout()
    const left = await unlinkCollection()
    login.value = null
    await readState()

    note.value =
      left > 0
        ? `Счёт отключён. Список остался здесь местным: записей ${left}.`
        : 'Счёт отключён.'
  })
}

function onManual(): void {
  void guard(async () => {
    await submitToken(manual.value)
    manual.value = ''
    manualOpen.value = false
    login.value = null
  })
}

/**
 * Перенос списка с AniList: оба типа целиком и с заменой местного.
 * Зовётся только из подтверждения и никогда сам по входу.
 */
function onPull(): void {
  asking.value = false

  void guard(async () => {
    note.value = ''
    const count = await refreshFromServer()
    await readState()
    note.value = `Список перенесён с AniList: записей ${count}.`
  })
}

/** Нажатие на кнопку переноса: сначала вопрос, действие потом. */
function onAsk(): void {
  note.value = ''
  error.value = ''
  asking.value = true
}

function onCancel(): void {
  asking.value = false
}

/** Нажатие на удаление списка: тоже только вопрос, без действия. */
function onAskDrop(): void {
  note.value = ''
  error.value = ''
  askingDrop.value = true
}

function onCancelDrop(): void {
  askingDrop.value = false
}

/**
 * Удаление своего списка по прямой просьбе. Счёт при этом не трогается:
 * список можно стереть и перенести заново, не входя второй раз.
 *
 * На AniList это не отражается никак: удаляем только то, что лежит у нас.
 */
function onDropList(): void {
  askingDrop.value = false

  void guard(async () => {
    note.value = ''
    await forgetCollection()
    await readState()
    note.value = 'Список удалён. На AniList ваши записи остались нетронутыми.'
  })
}

// Память сбрасывается только руками. Перезагрузка не дёргается сама:
// человек может быть середине правок.
function onClear(): void {
  void guard(async () => {
    note.value = ''
    await clearCache()
    cleared.value = true
    await readState()
    note.value = 'Память очищена. Названия и описания загрузятся заново.'
  })
}

function onReload(): void {
  void Bridge.shell.reload()
}

/// Срок человеку показывается местным временем: в секундах эпохи он
/// ничего не значит.
function expiryText(seconds: number | null): string {
  if (seconds === null) return 'срок неизвестен'
  return `до ${new Date(seconds * 1000).toLocaleDateString('ru-RU')}`
}

/// Ожидание в минутах: секунды читать неудобно.
function waitText(seconds: number): string {
  return `${Math.round(seconds / 60)} мин`
}

onMounted(() => {
  void guard(refreshAuth)
  void readState()
  void watchAuth().then((stop) => {
    stopWatch = stop
  })
})

onBeforeUnmount(() => {
  stopWatch?.()
  stopWatch = null
})
</script>

<template>
  <section class="am-page">
    <div class="am-split">
      <div class="am-panel am-box">
        <div class="am-bar">
          <h3 class="am-h3">AniList</h3>
          <span class="am-bar__gap" />
          <span class="am-flag" :class="{ 'am-flag--on': authStatus.authorized }">
            <span class="am-flag__dot" aria-hidden="true" />
            {{ authStatus.authorized ? 'подключён' : 'не подключён' }}
          </span>
        </div>

        <p v-if="!desktop" class="am-meta">
          Подключение работает только в приложении. Запустите <code>npm run tauri dev</code>.
        </p>

        <template v-else>
          <p class="am-meta">
            {{
              authStatus.authorized
                ? `Свой список подключён ${expiryText(authStatus.expiresAt)}.`
                : 'Подключите аккаунт, чтобы перенести свой список и править его на AniList. Поиск, карточки и свои записи работают и без него.'
            }}
          </p>

          <div class="am-row">
            <button
              v-if="!authStatus.authorized"
              class="am-btn"
              type="button"
              :disabled="busy"
              @click="onLogin"
            >
              Подключить аккаунт
            </button>
            <template v-else>
              <button
                class="am-btn"
                type="button"
                :disabled="busy"
                title="Забрать список с AniList и заменить им местный"
                @click="onAsk"
              >
                {{ busy ? 'Переносим…' : 'Перенести список с AniList' }}
              </button>
              <button
                class="am-btn am-btn--ghost"
                type="button"
                :disabled="busy"
                title="Разорвать связь с AniList. Список останется здесь"
                @click="onLogout"
              >
                Отключить
              </button>
            </template>

            <button
              v-if="!authStatus.authorized"
              class="am-btn am-btn--ghost"
              type="button"
              @click="manualOpen = !manualOpen"
            >
              Ввести токен
            </button>
          </div>

          <!-- Вопрос перед заменой: человек видит, что будет с местными записями. -->
          <div v-if="asking" class="am-ask">
            <p class="am-ask__text">
              Список с AniList заменит местный целиком. Записи, добавленные здесь без входа,
              будут потеряны, если их нет на AniList. Сейчас у нас записей: {{ listCount }}.
            </p>

            <div class="am-row">
              <button class="am-btn" type="button" :disabled="busy" @click="onPull">
                Перенести и заменить
              </button>
              <button class="am-btn am-btn--ghost" type="button" @click="onCancel">Отмена</button>
            </div>
          </div>

          <!-- Показывается только после нажатия: до него окна входа нет и ждать
               человеку нечего. -->
          <p v-if="login && !authStatus.authorized" class="am-meta">
            Окно AniList открыто, после разрешения оно закроется само. Ожидание —
            {{ waitText(login.waitSecs) }}.
          </p>

          <div v-if="manualOpen && !authStatus.authorized" class="am-row">
            <label class="am-field">
              <input v-model="manual" class="am-input" type="text" placeholder="Токен AniList" />
            </label>
            <button
              class="am-btn"
              type="button"
              :disabled="busy || !manual.trim()"
              @click="onManual"
            >
              Сохранить
            </button>
          </div>

          <p v-if="error" class="am-error">{{ error }}</p>
        </template>
      </div>

      <div class="am-panel am-box">
        <h3 class="am-h3">Свои данные</h3>

        <ul class="am-facts">
          <li class="am-fact">
            <span class="am-fact__name">Записей в списке</span>
            <span class="am-fact__value">{{ listCount }}</span>
          </li>
          <li v-if="usedSize" class="am-fact">
            <span class="am-fact__name">Занято на диске</span>
            <span class="am-fact__value">{{ usedSize }}</span>
          </li>
        </ul>

        <p class="am-meta">
          Список живёт здесь, на вашем диске, и от отключения счёта не исчезает. Память —
          это названия, описания и обложки: её можно сбросить без потерь.
        </p>

        <div class="am-row">
          <button
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="busy"
            title="Убрать сохранённые названия, описания и обложки"
            @click="onClear"
          >
            Очистить память
          </button>

          <button
            v-if="listCount > 0"
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="busy"
            title="Удалить свой список с этого устройства"
            @click="onAskDrop"
          >
            Удалить мой список
          </button>

          <button v-if="cleared" class="am-btn am-btn--ghost" type="button" @click="onReload">
            Перезагрузить
          </button>
        </div>

        <!-- Удаление списка необратимо для местных записей: спрашиваем всегда. -->
        <div v-if="askingDrop" class="am-ask">
          <p class="am-ask__text">
            Удалить список с этого устройства: записей {{ listCount }}. На AniList ваши
            записи останутся нетронутыми, а добавленные здесь без входа вернуть будет
            неоткуда.
          </p>

          <div class="am-row">
            <button class="am-btn" type="button" :disabled="busy" @click="onDropList">
              Удалить список
            </button>
            <button class="am-btn am-btn--ghost" type="button" @click="onCancelDrop">Отмена</button>
          </div>
        </div>

        <p v-if="note" class="am-note">{{ note }}</p>
      </div>

      <div class="am-panel am-box">
        <h3 class="am-h3">О программе</h3>

        <ul class="am-facts">
          <li class="am-fact">
            <span class="am-fact__name">Версия</span>
            <span class="am-fact__value">{{ version }}</span>
          </li>
          <li class="am-fact">
            <span class="am-fact__name">Система</span>
            <span class="am-fact__value">{{ system }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Широкое окно держит панели рядом, узкое ставит их друг под другом. */
.am-split {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 18px;
  align-items: start;
}

.am-box {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.am-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.am-field {
  flex: 1 1 240px;
  min-width: 200px;
}

/* Вопрос перед заменой списка: отделён рамкой, но без крика. */
.am-ask {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 13px 15px;
  background: rgba(255, 190, 90, 0.07);
  border: 1px solid rgba(255, 190, 90, 0.35);
  border-radius: var(--am-r-m);
}

.am-ask__text {
  margin: 0;
  font-size: 13px;
  color: var(--am-dim);
}

/* Исход действия: виден сразу и не путается с пояснениями рядом. */
.am-note {
  margin: 0;
  font-size: 13px;
  color: var(--am-good);
}

/* Состояние подключения точкой: видно без чтения. */
.am-flag {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  padding: 5px 12px;
  font-size: 12.5px;
  color: var(--am-dim);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--am-line);
  border-radius: 999px;
}

.am-flag__dot {
  width: 8px;
  height: 8px;
  background: var(--am-faint);
  border-radius: 50%;
}

.am-flag--on {
  color: var(--am-good);
  background: rgba(61, 220, 151, 0.12);
  border-color: rgba(61, 220, 151, 0.32);
}

.am-flag--on .am-flag__dot {
  background: var(--am-good);
  box-shadow: 0 0 8px rgba(61, 220, 151, 0.8);
}

.am-facts {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.am-fact {
  display: flex;
  gap: 12px;
  align-items: baseline;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid var(--am-line-soft);
}

.am-fact:last-child {
  border-bottom: 0;
}

.am-fact__name {
  font-size: 13px;
  color: var(--am-dim);
}

.am-fact__value {
  font-weight: 550;
  text-align: right;
}

code {
  padding: 1px 6px;
  font-size: 12.5px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: var(--am-r-s);
}
</style>
