<script setup lang="ts">
// Вход в Google с устройства: картинка кода, короткий код и терпеливое
// ожидание подтверждения. Сеть и разбор ответов живут в api/google-oauth.ts,
// сама картинка — в core/qr.ts, а здесь только то, что видит человек.
//
// Своей панелью, а не куском экрана настроек: у этого входа шесть состояний
// и свой темп опроса, и держать их в файле, где уже живут AniList, свои
// данные и оформление, значило бы утопить и то и другое.
//
// ПРОПУСК ЗДЕСЬ НЕ ЗАДЕРЖИВАЕТСЯ
// Выданные ключи уходят наверх событием: где их хранить и когда продлевать —
// дело core/cloud.ts, и знать об этом панели незачем. Ключи клиента приходят
// сверху по той же причине: настройки читает экран, а не панель.
//
// ОЖИДАНИЕ ПРЕРЫВАЕТСЯ УХОДОМ
// Человек вправе закрыть настройки посреди входа. Ожидание держится
// признаком жизни и номером захода: после уборки ни один запоздавший ответ
// Google на экране ничего не меняет, а повторное нажатие отменяет прежний
// заход — иначе два опроса спорили бы за одну панель.
import { onBeforeUnmount, ref } from 'vue'

import {
  GOOGLE_SCOPE,
  pollDeviceLogin,
  startDeviceLogin,
  type DeviceStart,
  type GoogleKeys,
} from '@/api/google-oauth'
import { Bridge } from '@/bridge'
import { makeQr, qrSvg } from '@/core/qr'

const props = defineProps<{
  /** Ключи клиента Google. Пустые — входить нечем, и об этом говорится прямо. */
  client: string
  secret: string
  /** Пройден ли вход. Признак держит экран: сами ключи сюда не попадают. */
  signed: boolean
}>()

const emit = defineEmits<{
  keys: [keys: GoogleKeys]
  out: []
}>()

/** Что показывать. Ожидание — обычное состояние этого входа, а не заминка. */
type Stage = 'idle' | 'waiting' | 'denied' | 'expired'

const stage = ref<Stage>('idle')
const start = ref<DeviceStart | null>(null)

/** Готовая разметка картинки кода. Пустая строка — картинки нет. */
const qr = ref('')

const problem = ref('')
const asking = ref(false)
const copied = ref(false)

/** Сколько минут годен код. Считается один раз при получении. */
const mins = ref(0)

// Признак жизни, номер захода и таймер паузы. Не ref: в разметке им нечего
// делать, а менять их должен только код ниже.
let alive = true
let run = 0
let timer: ReturnType<typeof setTimeout> | null = null

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Пауза между вопросами. Ссылка на таймер нужна, чтобы уход его снял. */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    timer = setTimeout(done, ms)
  })
}

/** Наш ли это заход: экран не закрыт и поверх не начали новый. */
function mine(id: number): boolean {
  return alive && id === run
}

/** Убрать показанное. Ключей здесь нет, стирать нечего. */
function forget(): void {
  start.value = null
  qr.value = ''
  copied.value = false
}

/**
 * Ожидание подтверждения. Темп задаёт Google: свой интервал он присылает
 * вместе с кодом, а просьбу сбавить — по ходу дела, и её надо слушаться,
 * иначе следующим ответом будет отказ за частые вопросы.
 *
 * Срок кода проверяется до вопроса, а не после: спрашивать о просроченном
 * коде незачем, и человеку честнее сказать сразу.
 */
async function watch(id: number): Promise<void> {
  const at = start.value
  if (at === null) return

  let step = at.intervalMs

  while (mine(id)) {
    if (Date.now() >= at.expiresAt) {
      stage.value = 'expired'
      forget()
      return
    }

    await sleep(step)
    if (!mine(id)) return

    const got = await pollDeviceLogin(props.client, props.secret, at.deviceCode)
    if (!mine(id)) return

    if (!got.ok) {
      problem.value = got.problem
      stage.value = 'idle'
      forget()
      return
    }

    const said = got.value

    if (said.state === 'waiting') continue

    if (said.state === 'slower') {
      step += said.intervalMs
      continue
    }

    if (said.state === 'denied') {
      stage.value = 'denied'
      forget()
      return
    }

    if (said.state === 'expired') {
      stage.value = 'expired'
      forget()
      return
    }

    // Подтверждено. Ключи уходят наверх, а панель возвращается в покой:
    // о том, что вход пройден, ей скажут признаком сверху.
    stage.value = 'idle'
    forget()
    emit('keys', said.keys)
    return
  }
}

/**
 * Начало входа. Отменяет прежний заход номером: человек мог нажать
 * «Войти» второй раз, не дождавшись первого кода.
 */
function onStart(): void {
  run += 1
  const id = run

  problem.value = ''
  stage.value = 'idle'
  forget()
  asking.value = true

  void (async () => {
    const got = await startDeviceLogin(props.client)
    if (!mine(id)) return

    asking.value = false

    if (!got.ok) {
      problem.value = got.problem
      return
    }

    start.value = got.value
    mins.value = Math.max(1, Math.round((got.value.expiresAt - Date.now()) / 60000))

    // Неудача картинки входу не мешает: код рядом виден всегда, и его
    // можно ввести руками. Поэтому это не ошибка, а пустая картинка.
    const drawn = makeQr(got.value.verifyUrlWithCode)
    qr.value = drawn.ok ? qrSvg(drawn.value, { quiet: 3 }) : ''

    stage.value = 'waiting'
    await watch(id)
  })()
}

/** Отмена ожидания. Google об этом не сообщается: код просто перестаёт ждать. */
function onStop(): void {
  run += 1
  stage.value = 'idle'
  forget()
}

/// Страница подтверждения открывается оболочкой: target="_blank" в WebView2
/// отбрасывается молча, без окна и без ошибки.
function onOpen(): void {
  const at = start.value
  if (at === null) return

  void Bridge.shell.openExternal(at.verifyUrlWithCode)
}

/// Код в буфер — для того, кто подтверждает вход на этой же машине.
/// Отказ буфера говорится вслух: молча проглотить его значило бы оставить
/// человека с кнопкой, которая не делает ничего.
function onCopy(): void {
  const at = start.value
  if (at === null) return

  void Bridge.clipboard.writeText(at.userCode).then(
    () => {
      copied.value = true
    },
    (e: unknown) => {
      problem.value = `Код не скопировался: ${describe(e)}`
    },
  )
}

onBeforeUnmount(() => {
  alive = false
  if (timer !== null) clearTimeout(timer)
})
</script>

<template>
  <div class="am-gauth">
    <!-- Вход пройден: область называется вслух — человеку видно, что именно
         у него спросили и чего программа не просила. -->
    <template v-if="signed">
      <p class="am-meta">
        Вход пройден. Программа просила одну область — свои файлы на Диске:
        <code>{{ GOOGLE_SCOPE }}</code>
      </p>

      <div class="am-gauth__row">
        <button class="am-btn am-btn--ghost" type="button" @click="emit('out')">
          Выйти из Google
        </button>
      </div>
    </template>

    <!-- Ожидание: картинка слева, код и действия справа. Код крупнее всего
         на панели — его переносят в телефон глазами. -->
    <template v-else-if="stage === 'waiting' && start">
      <div class="am-gauth__wait">
        <div v-if="qr" class="am-gauth__qr" v-html="qr" />

        <div class="am-gauth__side">
          <p class="am-gauth__name">Код для входа</p>
          <p class="am-gauth__code">{{ start.userCode }}</p>

          <p class="am-meta">
            Наведите телефон на картинку или откройте <code>{{ start.verifyUrl }}</code> и введите
            код. Код годен около {{ mins }} мин — программа сама заметит подтверждение.
          </p>

          <p v-if="!qr" class="am-meta">Картинку кода собрать не удалось — введите код руками.</p>

          <div class="am-gauth__row">
            <button class="am-btn" type="button" @click="onOpen">Открыть в браузере</button>
            <button class="am-btn am-btn--ghost" type="button" @click="onCopy">
              {{ copied ? 'Код скопирован' : 'Скопировать код' }}
            </button>
            <button class="am-btn am-btn--ghost" type="button" @click="onStop">Отмена</button>
          </div>
        </div>
      </div>
    </template>

    <!-- Покой: чем это будет и чего для этого нужно. -->
    <template v-else>
      <p v-if="!client.trim()" class="am-meta">
        Для входа нужен свой клиент Google типа «ТВ и устройства с ограниченным вводом»: его ключи
        вписываются выше. Без них входить нечем.
      </p>
      <p v-else class="am-meta">
        Программа покажет картинку кода и короткий код. Подтвердить вход можно с телефона — ни
        клавиатура, ни браузер на этом устройстве не понадобятся. Просим одну область: свои файлы
        на Диске — чужих программа не видит.
      </p>

      <p v-if="stage === 'denied'" class="am-gauth__cold">
        Во входе отказано. Если это вышло случайно — можно начать заново.
      </p>
      <p v-if="stage === 'expired'" class="am-gauth__cold">
        Код просрочен: подтверждения так и не было. Начните вход заново.
      </p>

      <div class="am-gauth__row">
        <button
          class="am-btn"
          type="button"
          :disabled="!client.trim() || asking"
          @click="onStart"
        >
          {{ asking ? 'Просим код…' : 'Войти в Google' }}
        </button>
      </div>
    </template>

    <p v-if="problem" class="am-error">{{ problem }}</p>
  </div>
</template>

<style scoped>
.am-gauth {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.am-gauth__wait {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: flex-start;
}

/* Картинка кода всегда чёрным по белому, даже в тёмном оформлении: камера
   читает не вкус, а разницу яркостей. Белая подложка здесь не украшение,
   а часть кода — без светлого поля вокруг телефон его не найдёт. */
.am-gauth__qr {
  flex: none;
  width: 156px;
  height: 156px;
  padding: 8px;
  background: #fff;
  border-radius: var(--am-r-m);
  box-shadow: var(--am-sh-1);
}

.am-gauth__qr :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.am-gauth__side {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.am-gauth__name {
  margin: 0;
  font-size: 11.5px;
  color: var(--am-dim);
}

/* Код набран крупно и с разрядкой: его читают с дивана и переносят
   в телефон по знакам, а слитные восемь знаков в этом деле сливаются. */
.am-gauth__code {
  margin: 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--am-text);
  overflow-wrap: anywhere;
}

.am-gauth__row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

/* Отказ и просрочка — не поломка программы: тон тот же, что у вопросов
   на экране настроек, а не красная строка ошибки. */
.am-gauth__cold {
  margin: 0;
  padding: 11px 13px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--am-dim);
  background: color-mix(in srgb, var(--am-warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--am-warn) 42%, transparent);
  border-radius: var(--am-r-m);
}

code {
  padding: 1px 6px;
  font-size: 12px;
  background: var(--am-fill-2);
  border-radius: var(--am-r-s);
  overflow-wrap: anywhere;
}
</style>
