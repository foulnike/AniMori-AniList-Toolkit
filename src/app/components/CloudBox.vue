<script setup lang="ts">
// Облачная копия: место, вход, копия туда и обратно. Само облако ничего
// не начинает — каждую кнопку нажимает человек, и обратный путь всегда
// спрашивает: копия ложится поверх живого списка.
//
// Своим узлом, а не частью экрана настроек: с двумя местами панель выросла
// вдвое, а экран настроек и без неё самый большой файл в приложении. Наружу
// нужны всего два числа — сколько записей в списке и как звать это устройство
// в файле копии, — и одна весть обратно: список сменился, числа наверху пора
// переспросить.
//
// ДВА МЕСТА, ДВА РАЗНЫХ ВХОДА
// У Яндекса пропуск выдают руками, и его вставляют в поле. Google руками
// не даёт ничего: там вход идёт кодом с устройства — картинка с адресом
// и восемь знаков, — поэтому он живёт отдельным узлом CloudGoogle.vue,
// а сюда возвращает готовые ключи: хранить их дело настроек, а не панели
// входа. Ниже выбора места разницы уже нет: числа, запись и возвращение
// у обоих мест общие.
//
// ЗАПИСЬ ПОВЕРХ НЕЗНАКОМОЙ КОПИИ СПРАШИВАЕТ
// Ядро отказывает третьим состоянием: не «ok» и не ошибка, а вопрос —
// в облаке лежит копия, которую писали не мы. Здесь этот отказ и становится
// вопросом с размером и временем чужой копии: цифры дают понять, свежее
// там или старее, а решение остаётся за человеком. Красной строкой такое
// показывать нельзя — это не поломка, и пугать здесь нечем.
//
// Оформление берётся из settings-screen.css: классы панели живут там же,
// где остальные настройки, и разводить их по двум файлам пока незачем.
import { onMounted, ref } from 'vue'

import type { GoogleKeys } from '@/api/google-oauth'
import { Bridge } from '@/bridge'
import {
  checkChosenPlace,
  checkPlace,
  choosePlace,
  cloudPathText,
  copyInfo,
  keepGoogleLogin,
  pullCopy,
  saveCopy,
  signOutGoogle,
  type CloudStranger,
} from '@/core/cloud'
import type { PullMode } from '@/core/collection'
import { saveSetting, settings, type CloudPlace } from '@/core/settings'

import CloudGoogle from './CloudGoogle.vue'

const props = defineProps<{
  /** Записей в списке сейчас: это число стоит в вопросах перед заменой. */
  list: number
  /** Как звать это устройство в файле копии. */
  device: string
}>()

/** Список сменился: копия легла поверх, и числа снаружи пора переспросить. */
const emit = defineEmits<{ changed: [] }>()

/**
 * Где лежит копия. Значение списывается с настроек один раз: общий объект
 * настроек не реактивен, и разметка по его полю не обновилась бы после клика.
 */
const cloudPlace = ref(settings.cloudPlace)

/**
 * Есть ли сохранённый пропуск Яндекса. Хранится признак, а не сам пропуск:
 * в разметку ему попадать незачем ни в каком виде.
 */
const cloudSaved = ref(settings.cloudToken !== '')

/** Вставленный, но ещё не проверенный пропуск. Живёт только до сохранения. */
const tokenDraft = ref('')

/** Открыто ли поле пропуска при уже сохранённом: смена бывает редко. */
const tokenOpen = ref(false)

/**
 * Ключи своего приложения Google. Номер приложения секретом не считается,
 * пароль считается и стоит под точками, но лежат оба здесь же, на этом
 * устройстве: отдавать их куда-то ещё незачем.
 */
const gClient = ref(settings.cloudGoogleClient)
const gSecret = ref(settings.cloudGoogleSecret)

/** Открыты ли поля ключей при уже пройденном входе: смена бывает редко. */
const keysOpen = ref(false)

/**
 * Пройден ли вход в Google. Опять признак, а не сам пропуск: обновляемый
 * ключ живёт в настройках, и разметке о нём знать нечего.
 */
const gSigned = ref(settings.cloudGoogleRefresh !== '')

const cloudSavedAt = ref(settings.cloudSavedAt)
const cloudSavedCount = ref(settings.cloudSavedCount)

/** Что лежит в облаке сейчас, строкой. Пустая строка — «не спрашивали». */
const cloudThere = ref('')

// Своя заметка и своя ошибка: отказ облака не должен красить соседние панели
// настроек и затирать их ответы.
const cloudNote = ref('')
const cloudError = ref('')
const cloudBusy = ref(false)

/** Спрошено ли подтверждение перед тем, как копия ляжет поверх списка. */
const askingCloud = ref(false)

/**
 * Незнакомая копия, найденная перед записью. null — вопроса нет. Хранится
 * сама находка, а не флажок: размер и время чужой копии и есть то, по чему
 * человек решает, замещать её или сперва забрать.
 */
const strangerAsk = ref<CloudStranger | null>(null)

/** Где человек берёт пропуск к Яндекс Диску. Своего приложения у сборки нет. */
const YANDEX_OAUTH_URL = 'https://oauth.yandex.com/client/new/'

/**
 * Где человек заводит своё приложение Google. Причина та же, что и у Яндекса,
 * только строже: устройству без клавиатуры Google выдаёт вход лишь через
 * приложение вида «ТВ и устройства с ограниченным вводом».
 */
const GOOGLE_CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials'

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/// Ошибки показываются рядом с кнопкой, а не глотаются: молчаливый catch
/// здесь означал бы кнопку, которая не делает ничего и не говорит почему.
async function cloudGuard(action: () => Promise<void>): Promise<void> {
  cloudBusy.value = true
  cloudError.value = ''
  try {
    await action()
  } catch (e) {
    cloudError.value = describe(e)
  } finally {
    cloudBusy.value = false
  }
}

/**
 * Готово ли облако к работе: место выбрано и вход в него пройден. У Яндекса
 * вход — это сохранённый пропуск, у Google — пройденный вход с устройства.
 */
function cloudOn(): boolean {
  if (cloudPlace.value === 'yandex') return cloudSaved.value
  if (cloudPlace.value === 'google') return gSigned.value

  return false
}

/// Время человеку — местное и словами. Ноль и нечитаемая дата дают прочерк:
/// «1 января 1970» на месте «копии не было» хуже пустоты.
function whenText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleString('ru-RU')
}

/// Размер копии в килобайтах: байты человеку ничего не говорят, а мегабайта
/// список не набирает даже в тысячу записей.
function sizeText(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`
}

/// Чужая копия одной строкой: размер и время правки. Ровно те два числа,
/// по которым видно, свежее там или старее нашего.
function strangerText(found: CloudStranger): string {
  const when = found.modified === null ? '' : ` · ${whenText(Date.parse(found.modified))}`
  return `${sizeText(found.bytes)}${when}`
}

/**
 * Спрашивает облако, что там лежит. Отказ здесь не кричит: это строка
 * факта, а не ответ на нажатие, и красная надпись при открытии настроек
 * пугала бы там, где всего лишь нет сети. Любая кнопка ниже об отказе
 * скажет громко.
 */
async function readCloud(): Promise<void> {
  if (!cloudOn()) {
    cloudThere.value = ''
    return
  }

  const got = await copyInfo()
  if (!got.ok) {
    cloudThere.value = 'спросить не удалось'
    return
  }
  if (!got.value.there) {
    cloudThere.value = 'копии нет'
    return
  }

  const when = got.value.modified === null ? '' : ` · ${whenText(Date.parse(got.value.modified))}`
  cloudThere.value = `${sizeText(got.value.bytes)}${when}`
}

/**
 * Выбор места. Смена места стирает память о чужой копии и числа прошлой
 * записи: в другом облаке лежит другой файл, и прежние цифры говорили бы
 * о нём неправду. Стиранием занимается ядро, здесь остаётся переспросить.
 */
function onPick(place: CloudPlace): void {
  if (cloudPlace.value === place) return

  void cloudGuard(async () => {
    cloudNote.value = ''
    strangerAsk.value = null

    await choosePlace(place)
    cloudPlace.value = place
    cloudSavedAt.value = settings.cloudSavedAt
    cloudSavedCount.value = settings.cloudSavedCount
    cloudThere.value = ''

    await readCloud()
  })
}

/**
 * Проверка и сохранение пропуска. Проверяется ДО записи: молча запомнить
 * негодную строку значит соврать, что облако подключено, а выяснится это
 * в самый неподходящий момент.
 */
function onCloudToken(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const token = tokenDraft.value.trim()
    const done = await checkPlace(token)
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    await saveSetting('cloudToken', 'am_cloud_token', token)
    cloudSaved.value = true
    tokenDraft.value = ''
    tokenOpen.value = false
    cloudNote.value = 'Пропуск принят: Яндекс Диск на связи.'
    await readCloud()
  })
}

/** Пропуск выдаёт сам Яндекс: адрес открывает оболочка, окно ходит только к API. */
function onCloudHelp(): void {
  void Bridge.shell.openExternal(YANDEX_OAUTH_URL)
}

/** Приложение Google человек заводит сам, там же, где и все ключи Google. */
function onGoogleHelp(): void {
  void Bridge.shell.openExternal(GOOGLE_CONSOLE_URL)
}

/**
 * Запись ключей приложения. Проверять их отдельно нечем: годность номера
 * и пароля выясняется только на входе, и скажет об этом сам вход.
 */
function onGoogleKeysSave(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const client = gClient.value.trim()
    const secret = gSecret.value.trim()
    await saveSetting('cloudGoogleClient', 'am_cloud_g_client', client)
    await saveSetting('cloudGoogleSecret', 'am_cloud_g_secret', secret)

    gClient.value = client
    gSecret.value = secret
    keysOpen.value = false

    // Прежний вход относился к прежнему приложению: с новыми ключами
    // обновляемый пропуск чужой, и Google откажет при первом обращении.
    cloudNote.value = gSigned.value
      ? 'Приложение записано. Прежний вход к нему не относится: войдите заново.'
      : 'Приложение записано. Теперь можно входить: код появится ниже.'
  })
}

/**
 * Вход пройден: узел входа отдал ключи, а хранить их — дело настроек.
 * Панель входа нарочно не пишет в память сама: ключи здесь одного рода
 * с пропуском Яндекса, и место у них одно.
 */
function onGoogleKeys(keys: GoogleKeys): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    await keepGoogleLogin(keys)
    gSigned.value = true
    keysOpen.value = false
    cloudNote.value = 'Вход в Google пройден: скрытая папка Диска на связи.'

    await readCloud()
  })
}

/**
 * Выход из Google. Ключи стираются всегда, даже если отзыв до Google
 * не дошёл: оставить их у себя после просьбы выйти хуже, чем не доложить
 * о выходе. Об отказе при этом говорится вслух.
 */
function onGoogleOut(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await signOutGoogle()
    gSigned.value = false
    cloudSavedAt.value = 0
    cloudSavedCount.value = 0
    cloudThere.value = ''
    strangerAsk.value = null

    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    cloudNote.value = 'Выход выполнен. Файл копии в скрытой папке Диска остался нетронутым.'
  })
}

/**
 * Проверка связи по кнопке. Нужна не для порядка: пропуск Яндекса живёт
 * не вечно, вход в Google можно отозвать со стороны, и узнать об этом
 * лучше сейчас, чем в тот вечер, когда копия понадобится.
 */
function onCloudCheck(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await checkChosenPlace()
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    cloudNote.value = 'Связь есть: пропуск годен и папка копии доступна.'
    await readCloud()
  })
}

/**
 * Запись копии. Метка устройства идёт в файл, чтобы потом было видно,
 * с какой машины копия: на ТВ это единственный способ понять, свежая ли она.
 *
 * Отказ разбирается на два разных: незнакомая копия — вопрос и живёт
 * в своём узле, всё прочее — ошибка красной строкой.
 */
async function writeCopy(force: boolean): Promise<void> {
  cloudNote.value = ''

  const done = await saveCopy(props.device, force)
  if (!done.ok) {
    if (done.stranger !== undefined) {
      strangerAsk.value = done.stranger
      return
    }

    cloudError.value = done.problem
    return
  }

  strangerAsk.value = null
  cloudSavedAt.value = done.value.savedAt
  cloudSavedCount.value = done.value.count
  cloudNote.value = `Копия сохранена: записей ${done.value.count}, ${sizeText(done.value.bytes)}.`
  await readCloud()
}

function onCloudSave(): void {
  strangerAsk.value = null
  void cloudGuard(() => writeCopy(false))
}

/** «Заменить»: та же запись, но с явным разрешением затереть чужую копию. */
function onCloudReplace(): void {
  strangerAsk.value = null
  void cloudGuard(() => writeCopy(true))
}

/// «Сначала забрать»: вопрос сменяется вопросом о способе, и ничего
/// не записывается. Человек почти всегда хочет именно этого — сперва
/// увидеть чужие записи у себя, а уже потом отдавать своё.
function onStrangerPull(): void {
  strangerAsk.value = null
  onCloudAsk()
}

function onStrangerCancel(): void {
  strangerAsk.value = null
}

/** Нажатие «Забрать копию»: сначала вопрос — копия ляжет поверх живого списка. */
function onCloudAsk(): void {
  cloudNote.value = ''
  cloudError.value = ''
  askingCloud.value = true
}

function onCloudCancel(): void {
  askingCloud.value = false
}

/**
 * Возвращение копии. Числа те же, что и у переноса с AniList, и по той же
 * причине: после слияния важно не общее число, а что стало с набранным здесь.
 */
function onCloudPull(mode: PullMode): void {
  askingCloud.value = false

  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await pullCopy(mode)
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    const got = done.value

    // Список сменился: числа снаружи переспрашивает тот, кто их показывает.
    emit('changed')

    // Прочитанная копия теперь знакомая, и панель говорит о ней же:
    // числа обновляет ядро, здесь остаётся их переспросить.
    cloudSavedAt.value = settings.cloudSavedAt
    cloudSavedCount.value = settings.cloudSavedCount

    const from = got.from.device === '' ? '' : ` Копия с устройства «${got.from.device}».`
    const lost = got.dropped > 0 ? ` Битых записей в копии: ${got.dropped} — их пропустили.` : ''

    cloudNote.value =
      got.mode === 'replace'
        ? `Список замещён копией: записей ${got.total}.${from}${lost}`
        : `Копия приложена: всего ${got.total}, новых ${got.added}, ` +
          `обновлено ${got.updated}, своих правок сохранено ${got.kept}, ` +
          `только здесь ${got.onlyHere}.${from}${lost}`

    await readCloud()
  })
}

/**
 * Отключение Яндекс Диска. Файл на Диске остаётся нетронутым: стирать чужое
 * хранилище по кнопке «отключить» программа не вправе.
 *
 * Память о времени правки стирается вместе с пропуском: с новым пропуском
 * это уже может быть другой Диск, и прежняя метка выдала бы чужую копию
 * за свою — ровно то, от чего сторож и поставлен. Этим занимается ядро,
 * когда место переставляют на «никуда».
 */
function onCloudForget(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    await saveSetting('cloudToken', 'am_cloud_token', '')
    await choosePlace('none')

    cloudPlace.value = 'none'
    cloudSaved.value = false
    cloudSavedAt.value = 0
    cloudSavedCount.value = 0
    cloudThere.value = ''
    tokenDraft.value = ''
    tokenOpen.value = false
    strangerAsk.value = null

    cloudNote.value = 'Облако отключено. Файл копии на Диске остался нетронутым.'
  })
}

onMounted(() => {
  void readCloud()
})
</script>

<template>
  <div class="am-panel am-box">
    <div class="am-bar">
      <h3 class="am-h3">Облачная копия</h3>
      <span class="am-bar__gap" />
      <span class="am-flag" :class="{ 'am-flag--on': cloudOn() }">
        <span class="am-flag__dot" aria-hidden="true" />
        {{ cloudOn() ? 'подключено' : 'не подключено' }}
      </span>
    </div>

    <!-- Знаки площадок нарисованы, а не набраны буквой: «Я» и «G» в рамке
         читались заготовкой, по которой не понять, куда ляжет копия.
         Рисунки свои и в фирменных цветах — сеть за картинками не ходит,
         и на любой теме они выглядят одинаково.

         Цвет знака не наследуется от карточки сознательно: у фирменного
         знака свой цвет, и подкрашивать его акцентом было бы неверно. -->
    <div class="am-cloud">
      <button
        v-tip="'Хранить копию списка на Яндекс Диске'"
        class="am-cloud__pick"
        :class="{ 'am-cloud__pick--on': cloudPlace === 'yandex' }"
        type="button"
        :disabled="cloudBusy"
        @click="onPick('yandex')"
      >
        <svg class="am-cloud__mark" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect width="24" height="24" rx="6" fill="#fc3f1d" />
          <path
            fill="#fff"
            fill-rule="evenodd"
            d="M16 4.8h-3.9c-2.5 0-4.2 1.6-4.2 4 0 1.8 1 3.1 2.7 3.7L7.9 19.2h2.7l2.6-6.2h0.7v6.2H16Zm-2.1 2.1h-1.7c-1.3 0-2.1 0.8-2.1 2 0 1.2 0.8 2 2.1 2h1.7Z"
          />
        </svg>
        <span class="am-cloud__name">Яндекс Диск</span>
      </button>
      <button
        v-tip="'Хранить копию в скрытой папке Google Диска'"
        class="am-cloud__pick"
        :class="{ 'am-cloud__pick--on': cloudPlace === 'google' }"
        type="button"
        :disabled="cloudBusy"
        @click="onPick('google')"
      >
        <svg
          class="am-cloud__mark"
          width="24"
          height="24"
          viewBox="0 0 87.3 87.3"
          aria-hidden="true"
        >
          <g transform="translate(0 4.65)">
            <path
              fill="#0066da"
              d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5z"
            />
            <path
              fill="#00ac47"
              d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44C.4 49.9 0 51.45 0 53h27.5z"
            />
            <path
              fill="#ea4335"
              d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.5z"
            />
            <path
              fill="#00832d"
              d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z"
            />
            <path
              fill="#2684fc"
              d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
            />
            <path
              fill="#ffba00"
              d="M73.4 26.5L60.7 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
            />
          </g>
        </svg>
        <span class="am-cloud__name">Google Диск</span>
      </button>
    </div>

    <!-- Яндекс: пропуск вставляется руками. -->
    <template v-if="cloudPlace === 'yandex'">
      <p v-if="!cloudSaved || tokenOpen" class="am-meta">
        Пропуск выдаёт сам Яндекс: заведите приложение с правом на папку приложения на Диске на
        <button class="am-link" type="button" @click="onCloudHelp">oauth.yandex.com</button>
        и вставьте выданный токен сюда. Он останется на этом устройстве.
      </p>

      <div v-if="!cloudSaved || tokenOpen" class="am-row">
        <label class="am-field">
          <input
            v-model="tokenDraft"
            class="am-input"
            type="password"
            placeholder="Пропуск Яндекс Диска"
          />
        </label>
        <button
          class="am-btn"
          type="button"
          :disabled="cloudBusy || !tokenDraft.trim()"
          @click="onCloudToken"
        >
          {{ cloudBusy ? 'Проверяем…' : 'Проверить и сохранить' }}
        </button>
      </div>
    </template>

    <!-- Google: свои ключи и вход кодом с устройства. Поля стоят здесь,
         а не в узле входа: ключи одного рода с пропуском Яндекса, и хранит
         их эта панель. Сам вход — CloudGoogle.vue. -->
    <template v-if="cloudPlace === 'google'">
      <p v-if="!gSigned || keysOpen" class="am-meta">
        Готовых пропусков Google не выдаёт: заведите на
        <button class="am-link" type="button" @click="onGoogleHelp">console.cloud.google.com</button>
        своё приложение вида «ТВ и устройства с ограниченным вводом», включите ему Google Drive API
        и впишите сюда номер и пароль приложения. Они останутся на этом устройстве.
      </p>

      <div v-if="!gSigned || keysOpen" class="am-row">
        <label class="am-field">
          <input
            v-model="gClient"
            class="am-input"
            type="text"
            placeholder="Номер приложения (client_id)"
          />
        </label>
        <label class="am-field">
          <input
            v-model="gSecret"
            class="am-input"
            type="password"
            placeholder="Пароль приложения (client_secret)"
          />
        </label>
        <button
          class="am-btn"
          type="button"
          :disabled="cloudBusy || !gClient.trim() || !gSecret.trim()"
          @click="onGoogleKeysSave"
        >
          Сохранить
        </button>
      </div>

      <CloudGoogle
        :client="gClient"
        :secret="gSecret"
        :signed="gSigned"
        @keys="onGoogleKeys"
        @out="onGoogleOut"
      />
    </template>

    <!-- Ниже выбора места разницы между площадками нет: числа, запись
         и возвращение у них общие. Особыми остаются только кнопки смены
         пропуска и отключения — их вид зависит от места. -->
    <template v-if="cloudPlace !== 'none'">
      <ul class="am-facts">
        <li class="am-fact">
          <span class="am-fact__name">Файл копии</span>
          <span class="am-fact__value"><code>{{ cloudPathText() }}</code></span>
        </li>
        <li class="am-fact">
          <span class="am-fact__name">Последняя копия</span>
          <span class="am-fact__value">{{ whenText(cloudSavedAt) }}</span>
        </li>
        <li class="am-fact">
          <span class="am-fact__name">Записей в копии</span>
          <span class="am-fact__value">
            {{ cloudSavedCount > 0 ? cloudSavedCount : '—' }}
          </span>
        </li>
        <li v-if="cloudThere" class="am-fact">
          <span class="am-fact__name">В облаке сейчас</span>
          <span class="am-fact__value">{{ cloudThere }}</span>
        </li>
      </ul>

      <div class="am-row">
        <button
          v-tip="'Записать нынешний список в облако. Незнакомую копию не затрёт без спроса'"
          class="am-btn"
          type="button"
          :disabled="!cloudOn() || cloudBusy"
          @click="onCloudSave"
        >
          {{ cloudBusy ? 'Работаем…' : 'Сохранить копию' }}
        </button>
        <button
          v-tip="'Забрать копию из облака: слиянием или с заменой'"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="!cloudOn() || cloudBusy"
          @click="onCloudAsk"
        >
          Забрать копию
        </button>
        <button
          v-if="cloudOn()"
          v-tip="'Спросить облако, годен ли пропуск и на месте ли папка копии'"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="onCloudCheck"
        >
          Проверить связь
        </button>
        <button
          v-if="cloudPlace === 'yandex' && cloudSaved && !tokenOpen"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="tokenOpen = true"
        >
          Сменить пропуск
        </button>
        <button
          v-if="cloudPlace === 'google' && gSigned && !keysOpen"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="keysOpen = true"
        >
          Сменить приложение
        </button>
        <button
          v-if="cloudPlace === 'yandex' && cloudSaved"
          v-tip="'Забыть пропуск. Файл копии в облаке останется'"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="onCloudForget"
        >
          Отключить облако
        </button>
      </div>

      <!-- Незнакомая копия: тот же узел вопроса, что и у переноса, но
           порядок кнопок обратный. Первым стоит «Сначала забрать»:
           замена здесь необратима для чужих записей, и предлагать её
           главной кнопкой значило бы толкать под руку. -->
      <div v-if="strangerAsk" class="am-ask">
        <p class="am-ask__text">
          В облаке копия, которую писали не мы: {{ strangerText(strangerAsk) }}. Здесь записей:
          {{ list }}.
        </p>

        <div class="am-row">
          <button class="am-btn" type="button" :disabled="cloudBusy" @click="onStrangerPull">
            Сначала забрать
          </button>
          <button
            v-tip="'Записать свой список поверх. Чужую копию не вернуть'"
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="cloudBusy"
            @click="onCloudReplace"
          >
            Заменить копию
          </button>
          <button class="am-btn am-btn--ghost" type="button" @click="onStrangerCancel">
            Отмена
          </button>
        </div>
      </div>

      <!-- Копия ложится поверх живого списка: спрашиваем всегда, теми же
           словами и тем же узлом, что и перенос с AniList. -->
      <div v-if="askingCloud" class="am-ask">
        <p class="am-ask__text">Записей: {{ list }}.</p>

        <div class="am-row">
          <button
            class="am-btn"
            type="button"
            :disabled="cloudBusy"
            @click="onCloudPull('merge')"
          >
            Добавить недостающее
          </button>
          <button
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="cloudBusy"
            @click="onCloudPull('replace')"
          >
            Заменить целиком
          </button>
          <button class="am-btn am-btn--ghost" type="button" @click="onCloudCancel">
            Отмена
          </button>
        </div>
      </div>
    </template>

    <p v-if="cloudError" class="am-error">{{ cloudError }}</p>
    <p v-if="cloudNote" class="am-note">{{ cloudNote }}</p>
  </div>
</template>

<style scoped src="../screens/settings-screen.css"></style>
