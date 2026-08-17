<script setup lang="ts">
// Настройки: вход в AniList и распоряжение своими данными.
// Каждая кнопка здесь что-то делает: обещаний на будущее на экране нет.
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import { currentUserId, entryCount, forgetCollection, refreshFromServer } from '@/core/collection'
import { clearCache, getDbStats } from '@/core/db'
import type { DbStats } from '@/core/types'

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
const platform = __ANIMORI_PLATFORM__

const desktop = isDesktop()

// Ошибки показываются рядом с кнопкой, а не глотаются: молчаливый catch
// здесь означал бы кнопку, которая не делает ничего и не говорит почему.
const error = ref('')
const busy = ref(false)
const manual = ref('')
const manualOpen = ref(false)

// Ответ Rust на нажатие «Войти». Держится до входа или до ухода с экрана:
// из него берётся срок ожидания для подсказки.
const login = ref<LoginStart | null>(null)

// События панели данных: сброс и обновление идут молча, и без явного
// ответа человек не поймёт, случилось ли что-нибудь вообще.
const note = ref('')
const cleared = ref(false)

const listCount = ref(0)
const ownerId = ref<number | null>(null)
const stats = ref<DbStats | null>(null)
const statsError = ref('')

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

/// Состояние своих данных переспрашивается после каждой своей кнопки:
/// числа на экране должны совпадать с тем, что лежит внутри.
async function readState(): Promise<void> {
  listCount.value = entryCount()
  ownerId.value = currentUserId()

  const got = await getDbStats()
  if ('error' in got) {
    stats.value = null
    statsError.value = got.error
    return
  }

  stats.value = got
  statsError.value = ''
}

function onLogin(): void {
  void guard(async () => {
    login.value = await startLogin()
  })
}

// Выход уводит и список: чужой список не вправе пережить выход,
// иначе следующий вошедший увидит на главной предыдущие полки.
function onLogout(): void {
  void guard(async () => {
    await logout()
    await forgetCollection()
    login.value = null
    note.value = 'Выход выполнен: список забыт, склад описаний остался.'
    await readState()
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

// Полное обновление: оба типа целиком вместо одного вида на экране
// списков. Удалённое на сайте уйдёт и у нас — только здесь и только так.
function onPull(): void {
  void guard(async () => {
    note.value = ''
    const count = await refreshFromServer()
    await readState()
    note.value = `Список взят с сервера заново: записей ${count}.`
  })
}

// Склад сбрасывается только руками: срока жизни у записей нет.
// Перезагрузка не дёргается сама: человек может быть середине правок.
function onClear(): void {
  void guard(async () => {
    note.value = ''
    await clearCache()
    cleared.value = true
    await readState()
    note.value =
      'Склад описаний и обликов пуст. Русские названия наберутся заново по мере показа.'
  })
}

function onReload(): void {
  void Bridge.shell.reload()
}

/// Срок человеку показывается местным временем: в секундах эпохи он
/// ничего не значит.
function expiryText(seconds: number | null): string {
  if (seconds === null) return 'срок неизвестен'
  return `до ${new Date(seconds * 1000).toLocaleString('ru-RU')}`
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
          <h3 class="am-h3">Аккаунт AniList</h3>
          <span class="am-bar__gap" />
          <span class="am-flag" :class="{ 'am-flag--on': authStatus.authorized }">
            <span class="am-flag__dot" aria-hidden="true" />
            {{ authStatus.authorized ? 'вход выполнен' : 'без входа' }}
          </span>
        </div>

        <p v-if="!desktop" class="am-meta">
          Вход работает только в приложении: в браузере нет моста к Rust. Запустите
          <code>npm run tauri dev</code>.
        </p>

        <template v-else>
          <p v-if="authStatus.authorized" class="am-meta">
            Доступ действует {{ expiryText(authStatus.expiresAt) }}.
          </p>
          <p v-else class="am-meta">
            Без входа доступен только поиск. Свои списки и оценки появятся после входа.
          </p>

          <div class="am-row">
            <button
              v-if="!authStatus.authorized"
              class="am-btn"
              type="button"
              :disabled="busy"
              @click="onLogin"
            >
              Войти через AniList
            </button>
            <button
              v-else
              class="am-btn am-btn--ghost"
              type="button"
              :disabled="busy"
              @click="onLogout"
            >
              Выйти и забыть список
            </button>

            <button
              v-if="!authStatus.authorized"
              class="am-btn am-btn--ghost"
              type="button"
              @click="manualOpen = !manualOpen"
            >
              Вставить токен вручную
            </button>
          </div>

          <!-- Показывается только после нажатия: до него окна входа нет и ждать
               человеку нечего. -->
          <p v-if="login && !authStatus.authorized" class="am-meta">
            Открылось окно входа AniList — оно идёт через наш прокси. После разрешения окно
            закроется само. Ожидание — {{ waitText(login.waitSecs) }}.
          </p>

          <div v-if="manualOpen && !authStatus.authorized" class="am-row">
            <label class="am-field">
              <input
                v-model="manual"
                class="am-input"
                type="text"
                placeholder="Токен доступа AniList"
              />
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

        <p class="am-meta">
          Список живёт снимком в памяти и на диске, описания и облик — в складе без срока
          годности. Стареет склад только здесь, кнопкой.
        </p>

        <ul class="am-facts">
          <li class="am-fact">
            <span class="am-fact__name">Записей в списке</span>
            <span class="am-fact__value">{{ listCount }}</span>
          </li>
          <li class="am-fact">
            <span class="am-fact__name">Список принадлежит</span>
            <span class="am-fact__value">{{
              ownerId === null ? 'никому: входа не было' : `#${ownerId}`
            }}</span>
          </li>
          <li v-if="stats" class="am-fact">
            <span class="am-fact__name">Записей в складе</span>
            <span class="am-fact__value">{{ stats.totalCacheRecords }}</span>
          </li>
          <li v-if="stats" class="am-fact">
            <span class="am-fact__name">Номеров MAL сопоставлено</span>
            <span class="am-fact__value">{{ stats.malMappings }}</span>
          </li>
          <li v-if="stats" class="am-fact">
            <span class="am-fact__name">Занято на диске</span>
            <span class="am-fact__value">{{ stats.estimatedSize }}</span>
          </li>
        </ul>

        <p v-if="statsError" class="am-meta">Склад не ответил: {{ statsError }}</p>

        <div class="am-row">
          <button
            class="am-btn"
            type="button"
            :disabled="busy || !authStatus.authorized"
            title="Забрать аниме и мангу с сервера целиком, с учётом удалённого на сайте"
            @click="onPull"
          >
            Взять список с сервера заново
          </button>

          <button
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="busy"
            title="Убрать русские названия, описания и облик тайтлов из склада"
            @click="onClear"
          >
            Сбросить склад описаний
          </button>

          <button v-if="cleared" class="am-btn am-btn--ghost" type="button" @click="onReload">
            Перезагрузить окно
          </button>
        </div>

        <p v-if="note" class="am-note">{{ note }}</p>

        <p v-if="!authStatus.authorized" class="am-meta">
          Список с сервера берётся только после входа. Склад сбрасывается и без него.
        </p>
      </div>

      <div class="am-panel am-box">
        <h3 class="am-h3">О программе</h3>

        <ul class="am-facts">
          <li class="am-fact">
            <span class="am-fact__name">Версия</span>
            <span class="am-fact__value">{{ version }}</span>
          </li>
          <li class="am-fact">
            <span class="am-fact__name">Площадка</span>
            <span class="am-fact__value">{{ platform }}</span>
          </li>
          <li class="am-fact">
            <span class="am-fact__name">Списки</span>
            <span class="am-fact__value">снимок в памяти и очередь правок</span>
          </li>
          <li class="am-fact">
            <span class="am-fact__name">Русские названия</span>
            <span class="am-fact__value">Шикимори, склад без срока</span>
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
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
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

/* Исход действия: виден сразу и не путается с пояснениями рядом. */
.am-note {
  margin: 0;
  font-size: 13px;
  color: var(--am-good);
}

/* Состояние входа точкой: видно без чтения. */
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
