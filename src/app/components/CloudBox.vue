<script setup lang="ts">
// Облачная копия: место, вход, копия туда и обратно. Само облако ничего
// не начинает — каждую кнопку нажимает человек, и обратный путь всегда
// спрашивает: копия ложится поверх живого списка.
//
// Своим узлом, а не частью экрана настроек: экран настроек и без неё самый
// большой файл в приложении. Наружу нужны всего два числа — сколько записей
// в списке и как звать это устройство в файле копии, — и одна весть обратно:
// список сменился, числа наверху пора переспросить.
//
// ОДНО МЕСТО
// Мест было два, Google Диск убран целиком (причины — в шапке core/cloud.ts).
// Выбор оставлен кнопкой, а не убран совсем: место можно и отключить, и это
// разные состояния. Кому в настройках досталось прежнее «google», панель
// говорит об этом прямо и просит выбрать Яндекс: тихо подставить другое
// облако вместо выбранного — последнее, что программа вправе сделать
// со чужими данными.
//
// ЗАПИСЬ ПОВЕРХ НЕЗНАКОМОЙ КОПИИ СПРАШИВАЕТ
// Ядро отказывает третьим состоянием: не «ok» и не ошибка, а вопрос —
// в облаке лежит копия, которую писали не мы. Здесь этот отказ и становится
// вопросом с размером и временем чужой копии: цифры дают понять, свежее
// там или старее, а решение остаётся за человеком. Красной строкой такое
// показывать нельзя — это не поломка, и пугать здесь нечем.
//
// ССЫЛКА: ОТДАТЬ И ЗАБРАТЬ
// Пропуск Диска — строка под шесть десятков знаков, и набрать её пультом
// нельзя. Поэтому у копии два конца.
//
// «Поделиться копией» публикует файл и показывает ссылку. Набирать на
// телевизоре нужно не её целиком, а только хвост — десяток знаков после
// последней косой черты, — и хвост поэтому вынесен отдельной строкой
// крупнее адреса.
//
// «Забрать по ссылке» стоит ниже всего прочего и живёт своей жизнью: он
// не требует ни пропуска, ни выбранного места, потому что ровно для этого
// и сделан — первый запуск на устройстве, где вводить нечем. Сперва по
// ссылке спрашивается размер и время, и только потом предлагается положить
// копию: замена списка вслепую по строке из пульта — способ потерять список
// из-за одной опечатки.
//
// Оформление берётся из settings-screen.css: классы панели живут там же,
// где остальные настройки, и разводить их по двум файлам пока незачем.
import { onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import {
  checkChosenPlace,
  checkPlace,
  choosePlace,
  cloudPathText,
  copyInfo,
  linkInfo,
  pullByLink,
  pullCopy,
  saveCopy,
  shareCopy,
  unshareCopy,
  type CloudLink,
  type CloudStranger,
} from '@/core/cloud'
import type { PullMode } from '@/core/collection'
import { saveSetting, settings, type CloudPlace } from '@/core/settings'

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
 * Есть ли сохранённый пропуск. Хранится признак, а не сам пропуск: в разметку
 * ему попадать незачем ни в каком виде.
 */
const cloudSaved = ref(settings.cloudToken !== '')

/** Вставленный, но ещё не проверенный пропуск. Живёт только до сохранения. */
const tokenDraft = ref('')

/** Открыто ли поле пропуска при уже сохранённом: смена бывает редко. */
const tokenOpen = ref(false)

const cloudSavedAt = ref(settings.cloudSavedAt)
const cloudSavedCount = ref(settings.cloudSavedCount)

/** Что лежит в облаке сейчас, строкой. Пустая строка — «не спрашивали». */
const cloudThere = ref('')

/**
 * Ссылка на нашу копию или пустая строка. Не хранится в настройках нарочно:
 * публикация живёт на стороне Диска и может пропасть при перезаписи файла,
 * поэтому ссылку всегда спрашивают у облака заново.
 */
const shareLink = ref('')

/** Ссылка, введённая для чтения чужой копии. */
const linkDraft = ref('')

/** Что нашлось по введённой ссылке. null — ещё не искали или не нашли. */
const linkFound = ref<CloudLink | null>(null)

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

/** Готово ли облако к работе: место выбрано и пропуск к нему сохранён. */
function cloudOn(): boolean {
  return cloudPlace.value === 'yandex' && cloudSaved.value
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

/// Хвост ссылки: то немногое, что придётся набирать пультом. Ядро принимает
/// и хвост, и ссылку целиком, поэтому показываем короткое.
function linkTail(link: string): string {
  const cut = link.replace(/\/+$/, '')
  return cut.slice(cut.lastIndexOf('/') + 1)
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
    shareLink.value = ''
    return
  }

  const got = await copyInfo()
  if (!got.ok) {
    cloudThere.value = 'спросить не удалось'
    return
  }

  // Ссылка приходит вместе со сведениями о файле: отдельный запрос ради неё
  // был бы лишним, а пропавшую публикацию видно сразу.
  shareLink.value = got.value.share ?? ''

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
    shareLink.value = ''

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

/**
 * Проверка связи по кнопке. Нужна не для порядка: пропуск живёт не вечно,
 * его можно отозвать со стороны, и узнать об этом лучше сейчас, чем в тот
 * вечер, когда копия понадобится.
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

    // Список сменился: числа снаружи переспрашивает тот, кто их показывает.
    emit('changed')

    // Прочитанная копия теперь знакомая, и панель говорит о ней же:
    // числа обновляет ядро, здесь остаётся их переспросить.
    cloudSavedAt.value = settings.cloudSavedAt
    cloudSavedCount.value = settings.cloudSavedCount

    cloudNote.value = pullText(done.value)
    await readCloud()
  })
}

/// Итог возвращения словами. Один текст на оба пути — по пропуску и по
/// ссылке: человеку важно одно и то же, а разница видна по кнопке, которую
/// он нажал.
function pullText(got: {
  mode: PullMode
  total: number
  added: number
  updated: number
  kept: number
  onlyHere: number
  dropped: number
  from: { device: string }
}): string {
  const from = got.from.device === '' ? '' : ` Копия с устройства «${got.from.device}».`
  const lost = got.dropped > 0 ? ` Битых записей в копии: ${got.dropped} — их пропустили.` : ''

  return got.mode === 'replace'
    ? `Список замещён копией: записей ${got.total}.${from}${lost}`
    : `Копия приложена: всего ${got.total}, новых ${got.added}, ` +
        `обновлено ${got.updated}, своих правок сохранено ${got.kept}, ` +
        `только здесь ${got.onlyHere}.${from}${lost}`
}

/**
 * Публикация копии. Единственное место, где список становится доступен
 * кому-то ещё, поэтому и кнопка, и предупреждение стоят рядом: по ссылке
 * копию прочитает любой, кто её знает.
 *
 * Повторное нажатие законно и просто вернёт ту же ссылку — на случай, если
 * перезапись файла сбросила публикацию.
 */
function onShare(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await shareCopy()
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    shareLink.value = done.value
    cloudNote.value = 'Ссылка готова. На другом устройстве достаточно набрать её хвост.'
  })
}

/** Закрытие ссылки. Сам файл копии остаётся на месте и в работе. */
function onUnshare(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await unshareCopy()
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    shareLink.value = ''
    cloudNote.value = 'Ссылка закрыта. Файл копии остался на месте.'
  })
}

/** Адрес ссылки открывает оболочка: по нему браузер просто скачает файл. */
function onShareOpen(): void {
  if (shareLink.value === '') return
  void Bridge.shell.openExternal(shareLink.value)
}

/**
 * Поиск копии по ссылке. Пропуска не требует вовсе — на этом и держится
 * первый запуск на устройстве без клавиатуры. Показываются размер и время,
 * и только после этого предлагается положить копию поверх списка.
 */
function onLinkFind(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''
    linkFound.value = null

    const done = await linkInfo(linkDraft.value.trim())
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    linkFound.value = done.value
  })
}

function onLinkCancel(): void {
  linkFound.value = null
}

/** Чтение по ссылке. Отметок о своей копии не двигает: их у читателя нет. */
function onLinkPull(mode: PullMode): void {
  const found = linkFound.value
  if (found === null) return

  linkFound.value = null

  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await pullByLink(found.key, mode)
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    emit('changed')
    linkDraft.value = ''
    cloudNote.value = pullText(done.value)
  })
}

/**
 * Отключение облака. Файл на Диске остаётся нетронутым: стирать чужое
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
    shareLink.value = ''
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

    <!-- Знак площадки нарисован, а не набран буквой: «Я» в рамке читалась
         заготовкой, по которой не понять, куда ляжет копия. Рисунок свой
         и в фирменных цветах — сеть за картинкой не ходит, и на любой теме
         он выглядит одинаково.

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
    </div>

    <!-- Прежний выбор Google: место считается невыбранным, и об этом сказано
         прямо. Подставить другое облако молча программа не вправе. -->
    <p v-if="cloudPlace === 'google'" class="am-meta">
      Google Диск убран из программы: вход с устройства не давал скрытой папки, а без проверки
      Google пропуск умирал за неделю. Выберите Яндекс Диск — файл копии в Google Диске остался
      на месте и никуда не денется.
    </p>

    <!-- Пропуск вставляется руками: готовых Яндекс не выдаёт. -->
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
        <li v-if="shareLink" class="am-fact">
          <span class="am-fact__name">Хвост ссылки</span>
          <span class="am-fact__value"><code>{{ linkTail(shareLink) }}</code></span>
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
          v-if="cloudSaved && !tokenOpen"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="tokenOpen = true"
        >
          Сменить пропуск
        </button>
        <button
          v-if="cloudSaved"
          v-tip="'Забыть пропуск. Файл копии в облаке останется'"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="onCloudForget"
        >
          Отключить облако
        </button>
      </div>

      <!-- Ссылка на копию: то, чем список попадает на устройство, где нечем
           вводить пропуск. Предупреждение стоит здесь же, а не в подписи
           кнопки: открыть свой список — решение, а не настройка. -->
      <div v-if="cloudOn()" class="am-row">
        <button
          v-if="!shareLink"
          v-tip="'Опубликовать файл копии и получить короткую ссылку на него'"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="onShare"
        >
          Поделиться копией
        </button>

        <template v-if="shareLink">
          <label class="am-field">
            <input class="am-input" type="text" readonly :value="shareLink" />
          </label>
          <button
            v-tip="'Открыть ссылку в браузере'"
            class="am-btn am-btn--ghost"
            type="button"
            @click="onShareOpen"
          >
            Открыть
          </button>
          <button
            v-tip="'Закрыть ссылку. Файл копии останется на месте'"
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="cloudBusy"
            @click="onUnshare"
          >
            Закрыть ссылку
          </button>
        </template>
      </div>

      <p v-if="shareLink" class="am-meta">
        По этой ссылке копию прочитает любой, кто её знает: пропуск для чтения не нужен. На другом
        устройстве достаточно набрать хвост — <code>{{ linkTail(shareLink) }}</code> — в поле
        «Забрать по ссылке» ниже.
      </p>

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

    <!-- Чтение по ссылке стоит последним и живёт отдельно от места: ни
         пропуска, ни выбранного облака он не требует. Это первый запуск
         на устройстве, где вводить нечем, и единственное, что там можно
         набрать, — десяток знаков хвоста. -->
    <ul class="am-facts">
      <li class="am-fact">
        <span class="am-fact__name">Забрать по ссылке</span>
        <span class="am-fact__value">пропуск не нужен</span>
      </li>
    </ul>

    <div class="am-row">
      <label class="am-field">
        <input
          v-model="linkDraft"
          class="am-input"
          type="text"
          placeholder="Ссылка на копию или её хвост"
        />
      </label>
      <button
        v-tip="'Спросить, что лежит по ссылке. Список пока не меняется'"
        class="am-btn"
        type="button"
        :disabled="cloudBusy || !linkDraft.trim()"
        @click="onLinkFind"
      >
        {{ cloudBusy ? 'Смотрим…' : 'Найти копию' }}
      </button>
    </div>

    <div v-if="linkFound" class="am-ask">
      <p class="am-ask__text">
        По ссылке лежит копия: {{ sizeText(linkFound.bytes) }}<template v-if="linkFound.modified">
          · {{ whenText(Date.parse(linkFound.modified)) }}</template>. Здесь записей: {{ list }}.
      </p>

      <div class="am-row">
        <button
          class="am-btn"
          type="button"
          :disabled="cloudBusy"
          @click="onLinkPull('merge')"
        >
          Добавить недостающее
        </button>
        <button
          v-tip="'Заменить свой список копией по ссылке целиком'"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="onLinkPull('replace')"
        >
          Заменить целиком
        </button>
        <button class="am-btn am-btn--ghost" type="button" @click="onLinkCancel">Отмена</button>
      </div>
    </div>

    <p v-if="cloudError" class="am-error">{{ cloudError }}</p>
    <p v-if="cloudNote" class="am-note">{{ cloudNote }}</p>
  </div>
</template>

<style scoped src="../screens/settings-screen.css"></style>
