<!--
  Карточка прокси в панели настроек, только для десктопной сборки.
  Решения и подводные камни — docs/DECISIONS.md.
-->
<template>
  <div class="amk-card" v-if="isDesktop">
    <div class="amk-card-title">Прокси</div>
    <div class="amk-row-hint" style="padding: 2px 2px 8px; line-height: 1.5">
      Через прокси пойдут и запросы AniMori к источникам, и трафик самого сайта. Настройка вступает
      в силу после перезапуска приложения.
    </div>

    <div class="amk-row">
      <span class="amk-row-label"><b>Использовать прокси</b></span>
      <label class="amk-switch">
        <input type="checkbox" id="set_proxy_on" v-model="enabled" @change="onEnabledChange()" />
        <span class="amk-track"></span><span class="amk-thumb"></span>
      </label>
    </div>

    <div class="amk-row" style="gap: 8px; border-top: none; padding-top: 0">
      <select
        class="amk-select"
        id="set_proxy_kind"
        style="flex: 0 0 110px"
        :value="kind"
        @change="onKindChange($event)"
      >
        <option value="http">HTTP</option>
        <option value="socks5">SOCKS5</option>
      </select>
      <input
        class="amk-input amk-mono"
        id="set_proxy_host"
        style="flex: 1"
        placeholder="127.0.0.1"
        title="Адрес прокси без схемы: 127.0.0.1 или proxy.local"
        :value="host"
        @change="onHostChange($event)"
      />
      <input
        class="amk-input amk-mono"
        id="set_proxy_port"
        style="flex: 0 0 92px"
        placeholder="порт"
        :value="portDraft"
        @change="onPortChange($event)"
      />
    </div>

    <div class="amk-row" style="gap: 8px; border-top: none; padding-top: 0">
      <input
        class="amk-input amk-mono"
        id="set_proxy_login"
        style="flex: 1"
        placeholder="логин"
        :value="login"
        @change="onLoginChange($event)"
      />
      <input
        class="amk-input amk-mono"
        id="set_proxy_pass"
        type="password"
        style="flex: 1"
        placeholder="пароль"
        :value="password"
        @change="onPasswordChange($event)"
      />
    </div>

    <div class="amk-row">
      <span class="amk-row-label"
        ><b>Без прокси</b
        ><span class="amk-row-hint">адреса через запятую — пойдут напрямую</span></span
      >
    </div>
    <div class="amk-row" style="border-top: none; padding-top: 0">
      <input
        class="amk-input amk-mono"
        id="set_proxy_bypass"
        style="flex: 1"
        placeholder="localhost, 127.0.0.1"
        :value="bypass"
        @change="onBypassChange($event)"
      />
    </div>

    <div
      v-if="showBadConfig"
      class="amk-row-hint"
      style="padding: 8px 2px 0; line-height: 1.5"
      :style="{ color: 'rgb(var(--color-red, 243,139,168))' }"
    >
      Прокси включён, но адрес или порт заданы неверно — трафик пойдёт напрямую.
    </div>

    <div v-if="showPasswordNote" class="amk-row-hint" style="padding: 8px 2px 0; line-height: 1.5">
      Пароль хранится в файле настроек в открытом виде — не используйте здесь пароль, который где-то
      ещё что-то значит. Окно авторизуется у прокси само, вводить логин ещё раз не потребуется.
    </div>

    <div
      v-if="showSocksAuthNote"
      class="amk-row-hint"
      style="padding: 8px 2px 0; line-height: 1.5"
      :style="{ color: 'rgb(var(--color-red, 243,139,168))' }"
    >
      SOCKS5 с логином движок окна не поддерживает: сайт пойдёт через такой прокси без авторизации
      и, скорее всего, получит отказ. Запросы AniMori логин и пароль используют, поэтому источники
      продолжат работать.
    </div>

    <div v-if="needsRestart" class="amk-row-hint" style="padding: 8px 2px 0; line-height: 1.5">
      Изменения сохранены и заработают после перезапуска приложения — кнопка «Применить и
      перезагрузить» здесь не поможет и обновит только страницу.
    </div>

    <!-- Состояние — запуск и авторизация, проверка — жив ли адрес сейчас. -->
    <div class="amk-row" style="padding-top: 10px">
      <span class="amk-row-label"
        ><b>Состояние</b><span class="amk-row-hint">{{ statusText }}</span></span
      >
    </div>

    <!-- Вид ghost обязателен: базовый amk-btn без фона даёт белую кнопку. -->
    <div class="amk-row" style="border-top: none; padding-top: 0">
      <button
        class="amk-btn amk-btn-ghost amk-btn-block"
        id="am-proxy-check"
        :disabled="checking"
        @click="check()"
      >
        {{ checking ? 'Проверяем…' : 'Проверить сейчас' }}
      </button>
    </div>

    <div
      v-if="checkText"
      class="amk-row-hint"
      style="padding: 8px 2px 0; line-height: 1.5"
      :style="{
        color: checkOk
          ? 'rgb(var(--color-green, 166,227,161))'
          : 'rgb(var(--color-red, 243,139,168))',
      }"
    >
      {{ checkText }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import type { ProxyStatus } from '@/bridge'
import {
  DEFAULT_PROXY,
  PROXY_KEYS,
  isProxyUsable,
  normalizeProxyKind,
  normalizeProxyPort,
} from '../../core/proxy'
import type { ProxyKind } from '../../core/proxy'
import { Logger } from '../../utils/logger'

/** Константа на всю сессию, поэтому не ref: платформа за время жизни окна не меняется. */
const isDesktop = Bridge.platform === 'tauri'

/** Цель боевого запроса: домен уже разрешён в capabilities/default.json. */
const PROBE_URL =
  'https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/README.md'

/** Предел ожидания боевого запроса. Дольше человек всё равно считает кнопку зависшей. */
const CHECK_TIMEOUT_MS = 8000

const enabled = ref(DEFAULT_PROXY.enabled)
const kind = ref<ProxyKind>(DEFAULT_PROXY.kind)
const host = ref(DEFAULT_PROXY.host)
const login = ref(DEFAULT_PROXY.login)
const password = ref(DEFAULT_PROXY.password)
const bypass = ref(DEFAULT_PROXY.bypass)

/** Порт держим строкой: иначе опечатка мгновенно превращалась бы в ноль. */
const portDraft = ref(String(DEFAULT_PROXY.port))

/** Была ли хотя бы одна запись за время жизни панели. */
const needsRestart = ref(false)

/** Что произошло с прокси при запуске и как идёт авторизация. Наполняется из Rust. */
const status = ref<ProxyStatus | null>(null)

const checking = ref(false)
const checkText = ref('')
const checkOk = ref(false)

const showBadConfig = computed(
  () =>
    enabled.value &&
    !isProxyUsable({
      enabled: enabled.value,
      kind: kind.value,
      host: host.value,
      port: normalizeProxyPort(portDraft.value),
      login: login.value,
      password: password.value,
      bypass: bypass.value,
    }),
)

const showPasswordNote = computed(() => password.value.length > 0)

/** Отталкиваемся от логина: без него SOCKS5 работает в окне безукоризненно. */
const showSocksAuthNote = computed(() => kind.value === 'socks5' && login.value.length > 0)

/** Говорит о запуске и авторизации, а не о том, что набрано в полях сейчас. */
const statusText = computed(() => {
  const s = status.value
  if (!s) return 'читаем…'

  if (s.outcome === 'off') return 'при запуске прокси был выключен — трафик идёт напрямую'
  if (s.outcome === 'invalid')
    return 'при запуске прокси был включён, но адрес негоден — трафик идёт напрямую'
  if (s.outcome === 'unreachable')
    return `при запуске ${s.server} не ответил — трафик идёт напрямую`

  if (s.auth === 'rejected')
    return `${s.server} применён, но логин или пароль он не принял — страница останется пустой`
  if (s.auth === 'pending') return `${s.server} применён, авторизация запрошена и ответа пока нет`
  if (s.auth === 'accepted') return `применён ${s.server}, авторизация пройдена`

  return `при запуске применён ${s.server}${s.hasCredentials ? ' (с логином)' : ''}`
})

/**
 * Проверка по кнопке: щуп TCP со стороны Rust плюс боевой запрос через мост.
 * Шага два, потому что они ловят разные беды — docs/DECISIONS.md.
 */
async function check(): Promise<void> {
  if (checking.value) return

  checking.value = true
  checkText.value = ''

  // Авторизация могла случиться после того, как панель открыли.
  void loadStatus()

  try {
    const probe = await Bridge.proxyDiagnostics.probe()

    // Боевой запрос тут только запутал бы: он ушёл бы напрямую и успешно.
    if (probe.outcome === 'off') {
      checkOk.value = false
      checkText.value = 'Прокси выключен — проверять нечего.'
      return
    }

    if (probe.outcome === 'invalid') {
      checkOk.value = false
      checkText.value = 'Адрес или порт заданы неверно — проверять нечего.'
      return
    }

    // Запрос идёт и при молчащем щупе: прокси может не принимать голое TCP, но работать.
    let reached = false
    try {
      const res = await Bridge.http.request({
        url: PROBE_URL,
        method: 'GET',
        timeoutMs: CHECK_TIMEOUT_MS,
        credentials: 'omit',
      })
      reached = res.ok
    } catch (e) {
      Logger('WARN', 'Проверка прокси: боевой запрос не прошёл', e)
    }

    // Каждое сочетание описано словами: человеку нужно знать, что чинить.
    if (probe.reachable && reached) {
      checkOk.value = true
      checkText.value = `Прокси ${probe.server} ответил за ${probe.latencyMs} мс, запрос через него прошёл.`
    } else if (probe.reachable && !reached) {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} ответил, но наружу не пустил: проверьте логин, пароль и вид прокси.`
    } else if (!probe.reachable && reached) {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} не отвечает, а запрос всё равно прошёл — значит, он ушёл напрямую, мимо прокси. Так будет до перезапуска, если прокси включён только что.`
    } else {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} не отвечает, и запрос не прошёл.`
    }
  } catch (e) {
    checkOk.value = false
    checkText.value = 'Не удалось выполнить проверку — подробности в журнале.'
    Logger('ERROR', 'Не удалось проверить прокси', e)
  } finally {
    checking.value = false
  }
}

/**
 * Обработчики событий синхронны, а хранилище асинхронное, поэтому результата не ждём.
 * Об отказе записи сообщаем обязательно (инвариант 4).
 */
function save(key: string, value: unknown): void {
  needsRestart.value = true
  void Bridge.storage.set(key, value).catch((e: unknown) => {
    Logger('ERROR', 'Не удалось сохранить настройку прокси: ' + key, e)
  })
}

function inputValue(e: Event): string {
  const el = e.target
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : ''
}

function onEnabledChange(): void {
  save(PROXY_KEYS.enabled, enabled.value)
}

function onKindChange(e: Event): void {
  kind.value = normalizeProxyKind(inputValue(e))
  save(PROXY_KEYS.kind, kind.value)
}

function onHostChange(e: Event): void {
  // Схема отрезается: вид прокси задаёт соседний список, иначе выйдет http://http://…
  host.value = inputValue(e)
    .trim()
    .replace(/^\w+:\/\//, '')
    .replace(/\/$/, '')
  save(PROXY_KEYS.host, host.value)
}

function onPortChange(e: Event): void {
  const raw = inputValue(e).trim()
  const port = normalizeProxyPort(raw)
  // В поле остаётся набранное, даже если это не порт: о негодном скажет красная строка.
  portDraft.value = raw
  save(PROXY_KEYS.port, port)
}

function onLoginChange(e: Event): void {
  login.value = inputValue(e).trim()
  save(PROXY_KEYS.login, login.value)
}

function onPasswordChange(e: Event): void {
  // Трима нет: пробел внутри пароля законен, а тихая правка дала бы отказ авторизации.
  password.value = inputValue(e)
  save(PROXY_KEYS.password, password.value)
}

function onBypassChange(e: Event): void {
  bypass.value = inputValue(e)
  save(PROXY_KEYS.bypass, bypass.value)
}

/** Чтение одним Promise.all: в десктопной сборке каждое чтение — вызов до бэкенда. */
async function load(): Promise<void> {
  try {
    const [rawEnabled, rawKind, rawHost, rawPort, rawLogin, rawPassword, rawBypass] =
      await Promise.all([
        Bridge.storage.get<boolean>(PROXY_KEYS.enabled, DEFAULT_PROXY.enabled),
        Bridge.storage.get<string>(PROXY_KEYS.kind, DEFAULT_PROXY.kind),
        Bridge.storage.get<string>(PROXY_KEYS.host, DEFAULT_PROXY.host),
        Bridge.storage.get<number>(PROXY_KEYS.port, DEFAULT_PROXY.port),
        Bridge.storage.get<string>(PROXY_KEYS.login, DEFAULT_PROXY.login),
        Bridge.storage.get<string>(PROXY_KEYS.password, DEFAULT_PROXY.password),
        Bridge.storage.get<string>(PROXY_KEYS.bypass, DEFAULT_PROXY.bypass),
      ])

    enabled.value = rawEnabled === true
    kind.value = normalizeProxyKind(rawKind)
    host.value = String(rawHost)
    portDraft.value = String(rawPort)
    login.value = String(rawLogin)
    password.value = String(rawPassword)
    bypass.value = String(rawBypass)

    // Загрузка — не правка: напоминание о перезапуске появляется после действий человека.
    needsRestart.value = false
  } catch (e) {
    Logger('ERROR', 'Не удалось прочитать настройки прокси', e)
  }
}

/** Исход запуска и авторизация на сейчас. Читается из оболочки, сеть не трогается. */
async function loadStatus(): Promise<void> {
  try {
    status.value = await Bridge.proxyDiagnostics.status()
  } catch (e) {
    Logger('ERROR', 'Не удалось прочитать состояние прокси', e)
  }
}

onMounted(() => {
  if (!isDesktop) return
  void load()
  void loadStatus()
})
</script>
