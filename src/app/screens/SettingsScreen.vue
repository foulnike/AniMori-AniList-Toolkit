<script setup lang="ts">
// Пункт 2.2: вход в аккаунт AniList. Остальные настройки, словарь и свои
// ссылки — пункт 3.6, кнопка запасного вида — пункт 3.7.
import { onBeforeUnmount, onMounted, ref } from 'vue'

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

// Ответ Rust на нажатие «Войти»: адреса и картинка QR. Держится до входа
// или до ухода с экрана: повторный вызов ничего нового не даст.
const login = ref<LoginStart | null>(null)

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

function onLogin(): void {
  void guard(async () => {
    login.value = await startLogin()
  })
}

function onLogout(): void {
  void guard(async () => {
    await logout()
    login.value = null
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
  <section class="am-screen">
    <div class="am-card">
      <h2 class="am-card__title">Аккаунт AniList</h2>

      <p v-if="!desktop" class="am-screen__hint">
        Вход работает только в приложении: в браузере нет моста к Rust. Запустите
        <code>npm run tauri dev</code>.
      </p>

      <template v-else>
        <p v-if="authStatus.authorized" class="am-screen__hint">
          Вход выполнен · {{ expiryText(authStatus.expiresAt) }}
        </p>
        <p v-else class="am-screen__hint">
          Без входа доступен только поиск. Свои списки и оценки появятся после входа.
        </p>

        <div class="am-card__row">
          <button
            v-if="!authStatus.authorized"
            class="am-btn"
            type="button"
            :disabled="busy"
            @click="onLogin"
          >
            Войти через AniList
          </button>
          <button v-else class="am-btn" type="button" :disabled="busy" @click="onLogout">
            Выйти
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

        <!-- Показывается только после нажатия: до него приёмник не слушает, и
             картинка вела бы в никуда. -->
        <div v-if="login && !authStatus.authorized" class="am-login">
          <p class="am-screen__hint">
            В браузере открылась страница входа AniList. После разрешения приложение
            узнает о входе само. Ожидание — {{ waitText(login.waitSecs) }}.
          </p>

          <template v-if="login.qrSvg && login.lanUrl">
            <p class="am-screen__hint">
              Или войдите с телефона: наведите камеру на код. Телефон должен быть в той же
              сети и без VPN.
            </p>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="am-login__qr" v-html="login.qrSvg"></div>
            <p class="am-screen__meta">{{ login.lanUrl }}</p>
          </template>
          <p v-else class="am-screen__hint">
            Адрес в домашней сети не определён, вход с телефона сейчас невозможен.
          </p>
        </div>

        <div v-if="manualOpen && !authStatus.authorized" class="am-card__row">
          <input
            v-model="manual"
            class="am-screen__input"
            type="text"
            placeholder="Токен доступа AniList"
          />
          <button class="am-btn" type="button" :disabled="busy || !manual.trim()" @click="onManual">
            Сохранить
          </button>
        </div>

        <p v-if="error" class="am-card__error">{{ error }}</p>
      </template>
    </div>

    <p class="am-screen__hint">
      Остальные настройки переедут сюда в пункте 3.6. Кнопка «Открыть настоящий сайт»
      появится в пункте 3.7: само окно и команда для него уже готовы.
    </p>
    <p class="am-screen__meta">Версия {{ version }} · площадка {{ platform }}</p>
  </section>
</template>

<style scoped>
.am-screen {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: flex-start;
}

.am-screen__hint {
  max-width: 640px;
  margin: 0;
  color: var(--am-dim);
}

.am-screen__meta {
  margin: 0;
  font-size: 13px;
  color: var(--am-dim);
}

.am-screen__input {
  min-width: 320px;
  padding: 8px 10px;
  color: var(--am-text);
  background: var(--am-bg);
  border: 1px solid var(--am-line);
  border-radius: 8px;
}

.am-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 640px;
  padding: 16px;
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: 12px;
}

.am-card__title {
  margin: 0;
  font-size: 16px;
}

.am-card__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.am-card__error {
  margin: 0;
  font-size: 13px;
  color: #ff8a8a;
}

.am-login {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding-top: 4px;
  border-top: 1px solid var(--am-line);
}

.am-login__qr {
  padding: 8px;
  line-height: 0;
  background: #ffffff;
  border-radius: 8px;
}

.am-btn {
  padding: 8px 14px;
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

.am-btn--ghost:hover {
  background: var(--am-hover);
}
</style>
