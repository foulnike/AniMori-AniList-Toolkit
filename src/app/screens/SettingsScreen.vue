<script setup lang="ts">
// Настройки: вход в AniList, внешность и распоряжение своими данными.
// На экране только то, что человеку решать: как всё устроено внутри —
// дело документации, а не карточки настроек.
//
// Раскладка — две колонки известной ширины, а не сетка auto-fit: панели
// разной высоты расползались по всему фуллскрину, и глазу негде было
// зацепиться. Слева то, что делают руками, справа — вид и справка.
//
// Внутри панели данных тот же порядок: сначала числа, потом необратимое
// одной строкой, потом выгрузка своим узлом. Пояснения убраны сознательно:
// подписи кнопок и строка пути говорят то же самое и короче.
//
// Облачная копия живая с этого захода, но по-прежнему только по кнопке:
// само по себе облако ничего не начинает и в фоне не ходит.
//
// ВОПРОСЫ КОРОТКИЕ, ОТВЕТ ЖИВЁТ В КНОПКАХ
// Раньше подтверждения объясняли разницу способов абзацем на три строки.
// Абзац этот никто не читал: под ним стоят «Добавить недостающее»
// и «Заменить целиком», и подписи говорят то же самое точнее и короче.
// Осталось одно число — сколько записей под ударом, — и оно единственное,
// чего из подписей не узнать.
//
// Оформление живёт в settings-screen.css — так же, как у карточки и плеера.
import { onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import { checkPlace, CLOUD_PATH, copyInfo, pullCopy, saveCopy } from '@/core/cloud'
import {
  eachEntry,
  entryCount,
  forgetCollection,
  initCollection,
  refreshFromServer,
  unlinkCollection,
  type PullMode,
} from '@/core/collection'
import { datasetStatus, initDatasetNames } from '@/core/dataset-names'
import { clearCache, getDbStats } from '@/core/db'
import { buildMalXml, malXmlFileName } from '@/core/mal-xml'
import { saveSetting, settings } from '@/core/settings'

import { APPEARANCES, appearance, setAppearance } from '../appearance'
import {
  authStatus,
  isDesktop,
  logout,
  refreshAuth,
  startLogin,
  submitToken,
  type LoginStart,
} from '../auth/session'
import { saveXmlFile } from '../save-file'

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

/**
 * Адрес датасета названий. Ссылка осталась и после ухода на CC0-1.0, но
 * обязанностью быть перестала: атрибуции эта лицензия не требует вовсе,
 * а назвать единственный источник кириллицы — вежливость. Разбор —
 * в docs/DATA-PIPELINE.md, раздел «Права: CC0».
 */
const DATASET_URL = 'https://github.com/foulnike/animori-data'

/**
 * Где человек берёт пропуск к Яндекс Диску. Своего зарегистрированного
 * приложения у сборки нет, и честнее отправить за токеном напрямую, чем
 * делать вид, что окно входа сейчас откроется само.
 */
const YANDEX_OAUTH_URL = 'https://oauth.yandex.com/client/new/'

/// Внешние ссылки из окна открываются только оболочкой: target="_blank"
/// в WebView2 отбрасывается молча, без окна и без ошибки.
function onDatasetLink(): void {
  void Bridge.shell.openExternal(DATASET_URL)
}

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
 * Спрошено ли подтверждение переноса. Спрашивается всегда: даже слияние
 * двигает записи, а замена вовсе вычищает список — такое не делают
 * одним промахом мыши.
 */
const asking = ref(false)

/**
 * Спрошено ли подтверждение удаления списка. Спрашивается всегда:
 * местные записи вернуть потом неоткуда, их нет ни на каком сервере.
 */
const askingDrop = ref(false)

const listCount = ref(0)
const usedSize = ref('')

/** Состояние датасета названий строкой: журнала нет, видно хотя бы здесь. */
const datasetText = ref('')

/**
 * Датасет старше STALE_DAYS. Отдельный признак, а не слово внутри строки:
 * число дней человек прочитает и не заметит, а подсветку — заметит.
 */
const datasetStale = ref(false)

/**
 * Порог, после которого возраст датасета подсвечивается. Тридцать дней —
 * это три пропущенные недельные сборки: одна могла упасть случайно,
 * три подряд означают, что расписание уснуло и его надо будить руками.
 *
 * Сторож в репозитории программы кричит раньше, на десятом дне, но письмо
 * можно и пропустить, а этот экран человек открывает сам.
 */
const STALE_DAYS = 30

/**
 * Показ взрослого (пункт 3.8). Значение списывается с памяти настроек один раз:
 * общий объект настроек не реактивен, и v-model по его полю не дал бы ответа на клик.
 */
const adult = ref(settings.showAdult)

/**
 * Папка для выгрузок (пункт 3.3). Значение списывается один раз по той же
 * причине, что и adult: поле общего объекта настроек в разметке не обновилось
 * бы после выбора, и человек не увидел бы, что папка сменилась.
 */
const exportDir = ref(settings.exportDir)

/**
 * Умеет ли площадка спрашивать папку. Окно выбора родное и живёт в оболочке;
 * в браузере его нет, и там строку честнее спрятать, чем показать неработающей.
 */
const canPickDir = Bridge.exportFile.available

/**
 * Облачная копия (этап 6). Значения списываются с настроек один раз,
 * как adult и exportDir выше, и по той же причине.
 */
const cloudPlace = ref(settings.cloudPlace)

/**
 * Есть ли сохранённый пропуск. Хранится признак, а не сам пропуск:
 * в разметку ему попадать незачем ни в каком виде.
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

// Свои заметка и ошибка: отказ облака не должен красить панель AniList
// выше и не должен затирать ответ выгрузки в соседней панели.
const cloudNote = ref('')
const cloudError = ref('')
const cloudBusy = ref(false)

/** Спрошено ли подтверждение перед тем, как копия ляжет поверх списка. */
const askingCloud = ref(false)

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

/// То же самое для облака, но со своими признаками: панель у него своя,
/// и чужая красная строка в соседней только сбивала бы с толку.
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

/// Числа переспрашиваются после каждой кнопки: показанное должно совпадать
/// с тем, что лежит внутри.
///
/// Подъём обязателен: настройки открывают раньше списков, и без него
/// сводка показывала ноль при живом списке на диске. Сам подъём
/// идемпотентен и в сеть не ходит.
async function readState(): Promise<void> {
  await initCollection()
  listCount.value = entryCount()

  const got = await getDbStats()
  usedSize.value = 'error' in got ? '' : got.estimatedSize

  // Датасет поднимается тем же общим обещанием, что и на старте:
  // второй цены чтения здесь нет.
  await initDatasetNames()
  const ds = datasetStatus()
  if (ds.loaded && ds.builtAt !== null) {
    const date = new Date(ds.builtAt).toLocaleDateString('ru-RU')
    const count = ds.names.toLocaleString('ru-RU')
    const days = daysSince(ds.builtAt)

    // Возраст рядом с датой: дата отвечает «когда собран», а возраст —
    // «пора ли дёргать репозиторий», и здесь важнее второй вопрос.
    const age = days === null ? '' : ` · ${ageText(days)}`
    datasetText.value = `${date} · ${count} записей${age}`
    datasetStale.value = days !== null && days > STALE_DAYS
  } else {
    datasetText.value = 'не загружен'
    datasetStale.value = false
  }
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
      left > 0 ? `Счёт отключён. Список остался здесь местным: записей ${left}.` : 'Счёт отключён.'
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
 * Перенос списка с AniList одним из двух способов. Зовётся только
 * из подтверждения и никогда сам по входу.
 *
 * Итог говорится числами, а не одним «перенесено N»: после слияния
 * важно не общее число, а что стало с набранным здесь.
 */
function onPull(mode: PullMode): void {
  asking.value = false

  void guard(async () => {
    note.value = ''
    const done = await refreshFromServer(mode)
    await readState()

    // Способ берётся из ответа, а не из просьбы: смена счёта переключает
    // перенос на замену сама, и сказать надо о том, что случилось на деле.
    if (done.mode === 'replace') {
      note.value = `Список замещён списком с AniList: записей ${done.total}.`
      return
    }

    note.value =
      `Списки слиты: всего ${done.total}, новых ${done.added}, ` +
      `обновлено ${done.updated}, своих правок сохранено ${done.kept}, ` +
      `только здесь ${done.onlyHere}.`
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

/**
 * Выбор папки для выгрузок. Спрашивается один раз, дальше выгрузка идёт молча:
 * человек просил не окно на каждый файл, а место, о котором он знает.
 *
 * Закрытое окно выбора ошибкой не считается и ничего не меняет: null здесь
 * значит «передумал», и прежняя папка остаётся на месте.
 *
 * Ответа словами нет намеренно: новый путь встаёт в ту же строку, которую
 * человек только что нажал, и это виднее любой заметки.
 */
function onPickDir(): void {
  void guard(async () => {
    note.value = ''

    const picked = await Bridge.exportFile.pickDir()
    if (picked === null) return

    exportDir.value = picked
    await saveSetting('exportDir', 'set_export_dir', picked)
  })
}

/**
 * Выгрузка списка файлом XML. Формат чужой и старый, зато его понимают
 * все: Шикимори, AniList, Kitsu и сам MyAnimeList.
 *
 * Записи без номера MAL выразить в нём нечем, и их число говорится
 * вслух: молча потерять часть списка при переезде в другой сервис —
 * худшее, что здесь может случиться.
 *
 * Путь показывается целиком, а кнопки «показать в папке» нет сознательно:
 * строку можно прочитать и вставить куда угодно, а право открывать
 * проводник ради этого выдавать не за что.
 */
function onExport(): void {
  void guard(async () => {
    note.value = ''
    await initCollection()

    const built = buildMalXml({ entries: eachEntry() })
    if (built.exported === 0) {
      note.value = 'Выгружать нечего: ни одной записи с закладкой и номером MAL.'
      return
    }

    // Отказ записи прилетает исключением и попадает в error силами guard:
    // текст приходит из Rust готовым, вида «Папка не найдена: …».
    const saved = await saveXmlFile(malXmlFileName(), built.xml)

    const lost = built.noMalId.length
    const tail = lost > 0 ? ` Без номера MAL осталось ${lost} — их в файле нет.` : ''

    note.value = saved.toFolder
      ? `Выгружено записей: ${built.exported}. Файл: ${saved.path}${tail}`
      : `Выгружено записей: ${built.exported}. Папка не выбрана, файл ушёл в загрузки окна.${tail}`
  })
}

/** Готово ли облако к работе: место выбрано и пропуск сохранён. */
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
 * Выбор места. Пока место одно, но ключ в настройках строковый:
 * Google Drive встанет рядом вторым значением, а не вторым флажком.
 */
function onPickYandex(): void {
  if (cloudPlace.value === 'yandex') return

  void cloudGuard(async () => {
    cloudNote.value = ''
    cloudPlace.value = 'yandex'
    await saveSetting('cloudPlace', 'am_cloud_place', 'yandex')
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
 * Сохранение копии. Метка устройства идёт в файл, чтобы потом было видно,
 * с какой машины копия: на ТВ это единственный способ понять, свежая ли она.
 */
function onCloudSave(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await saveCopy(system)
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    cloudSavedAt.value = done.value.savedAt
    cloudSavedCount.value = done.value.count
    cloudNote.value = `Копия сохранена: записей ${done.value.count}, ${sizeText(done.value.bytes)}.`
    await readCloud()
  })
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
    await readState()

    const from = got.from.device === '' ? '' : ` Копия с устройства «${got.from.device}».`
    const lost = got.dropped > 0 ? ` Битых записей в копии: ${got.dropped} — их пропустили.` : ''

    cloudNote.value =
      got.mode === 'replace'
        ? `Список замещён копией: записей ${got.total}.${from}${lost}`
        : `Копия приложена: всего ${got.total}, новых ${got.added}, ` +
          `обновлено ${got.updated}, своих правок сохранено ${got.kept}, ` +
          `только здесь ${got.onlyHere}.${from}${lost}`
  })
}

/**
 * Отключение облака. Файл на Диске остаётся нетронутым: стирать чужое
 * хранилище по кнопке «отключить» программа не вправе.
 */
function onCloudForget(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    await saveSetting('cloudToken', 'am_cloud_token', '')
    await saveSetting('cloudPlace', 'am_cloud_place', 'none')
    await saveSetting('cloudSavedAt', 'am_cloud_saved_at', 0)
    await saveSetting('cloudSavedCount', 'am_cloud_saved_count', 0)

    cloudPlace.value = 'none'
    cloudSaved.value = false
    cloudSavedAt.value = 0
    cloudSavedCount.value = 0
    cloudThere.value = ''
    tokenDraft.value = ''
    tokenOpen.value = false

    cloudNote.value = 'Облако отключено. Файл копии на Диске остался нетронутым.'
  })
}

/**
 * Переключение показа взрослого. Отбор живёт в core/adult.ts и читает ключ
 * в момент вопроса, поэтому перезапуска не нужно: следующий поиск уже другой.
 *
 * Заметки об исходе нет: сам тумблер и есть ответ, а прежняя строка писалась
 * в панель другой колонки и читалась там как чужая.
 */
function onAdult(): void {
  void saveSetting('showAdult', 'set_adult', adult.value)
}

// Память сбрасывается только руками. Перезагрузка не делается сама:
// человек может быть в середине правок.
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

/// Возраст сборки в днях. null — когда дата не читается: «NaN дней назад»
/// хуже, чем отсутствие возраста вовсе.
function daysSince(iso: string): number | null {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 86400000)
}

/// Возраст словами: «собран сегодня», «1 день назад», «6 дней назад».
/// Развёрнуто, а не вложенными тернарниками: падежи русских числительных
/// в одну строку не читаются.
function ageText(days: number): string {
  if (days <= 0) return 'собран сегодня'

  const tail = days % 100
  const last = days % 10
  let word = 'дней'
  if (tail < 11 || tail > 19) {
    if (last === 1) word = 'день'
    else if (last >= 2 && last <= 4) word = 'дня'
  }

  return `${days} ${word} назад`
}

onMounted(() => {
  void guard(refreshAuth)
  void readState()
  void readCloud()
})
</script>

<template>
  <section class="am-page">
    <div class="am-set">
      <!-- Левая колонка — действия: подключение счёта, распоряжение данными
           и облачная копия. Все панели здесь умеют менять то, что на диске. -->
      <div class="am-set__col">
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
                  : 'Подключите аккаунт, чтобы перенести свой список сюда. Правки остаются здесь: обратно на AniList программа ничего не отправляет.'
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
                  v-tip="'Забрать список с AniList: слиянием или с заменой'"
                  class="am-btn"
                  type="button"
                  :disabled="busy"
                  @click="onAsk"
                >
                  {{ busy ? 'Переносим…' : 'Перенести список с AniList' }}
                </button>
                <button
                  v-tip="'Разорвать связь с AniList. Список останется здесь'"
                  class="am-btn am-btn--ghost"
                  type="button"
                  :disabled="busy"
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

            <!-- Вопрос перед переносом: одно число и два способа рядом.
                 Разницу говорят подписи кнопок, поэтому абзац объяснений
                 здесь убран — он повторял их втрое длиннее. -->
            <div v-if="asking" class="am-ask">
              <p class="am-ask__text">Записей: {{ listCount }}.</p>

              <div class="am-row">
                <button class="am-btn" type="button" :disabled="busy" @click="onPull('merge')">
                  Добавить недостающее
                </button>
                <button
                  class="am-btn am-btn--ghost"
                  type="button"
                  :disabled="busy"
                  @click="onPull('replace')"
                >
                  Заменить целиком
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

          <!-- Необратимое одной строкой: сброс памяти и удаление списка стоят
               рядом, потому что оба про то, что лежит на этом диске. -->
          <div class="am-row">
            <button
              v-tip="'Убрать сохранённые названия, описания и обложки'"
              class="am-btn am-btn--ghost"
              type="button"
              :disabled="busy"
              @click="onClear"
            >
              Очистить память
            </button>

            <button
              v-if="listCount > 0"
              v-tip="'Удалить свой список с этого устройства'"
              class="am-btn am-btn--ghost"
              type="button"
              :disabled="busy"
              @click="onAskDrop"
            >
              Удалить мой список
            </button>

            <button v-if="cleared" class="am-btn am-btn--ghost" type="button" @click="onReload">
              Перезагрузить
            </button>
          </div>

          <!-- Выгрузка отдельным узлом строкой ниже: место и действие рядом.
               Строка папки нажимается целиком, и путь виден всегда.

               Класс свой, am-dir, а не am-pick: тем в styles/theme.css одет
               нативный select, и совпадение имён отдавало этой строке чужие
               правила — плотный фон списка и снятую обводку фокуса. -->
          <div v-if="canPickDir || listCount > 0" class="am-out">
            <button
              v-if="canPickDir"
              v-tip="'Сменить папку, куда уходят выгрузки XML'"
              class="am-dir"
              type="button"
              :disabled="busy"
              @click="onPickDir"
            >
              <span class="am-dir__mark" aria-hidden="true">📁</span>
              <span class="am-dir__text">
                <span class="am-dir__name">Папка выгрузок</span>
                <span class="am-dir__path" :class="{ 'am-dir__path--none': !exportDir }">
                  {{ exportDir || 'Не выбрана — файл уйдёт в загрузки окна' }}
                </span>
              </span>
              <span class="am-dir__act">{{ exportDir ? 'Сменить' : 'Выбрать' }}</span>
            </button>

            <button
              v-if="listCount > 0"
              v-tip="'Сохранить список файлом XML для переноса в другой сервис'"
              class="am-btn am-btn--ghost"
              type="button"
              :disabled="busy"
              @click="onExport"
            >
              Выгрузить в XML
            </button>
          </div>

          <!-- Удаление списка необратимо для местных записей: спрашиваем всегда.
               Вопрос коротким: подпись кнопки под ним и есть весь ответ. -->
          <div v-if="askingDrop" class="am-ask">
            <p class="am-ask__text">Удалить список с этого устройства?</p>

            <div class="am-row">
              <button class="am-btn" type="button" :disabled="busy" @click="onDropList">
                Удалить список
              </button>
              <button class="am-btn am-btn--ghost" type="button" @click="onCancelDrop">
                Отмена
              </button>
            </div>
          </div>

          <p v-if="note" class="am-note">{{ note }}</p>
        </div>

        <!-- Облачная копия: место, пропуск, копия туда и обратно. Само облако
             ничего не начинает — обе кнопки нажимает человек, и обратный путь
             всегда спрашивает: копия ложится поверх живого списка. Формат
             файла — core/cloud-file.ts, порядок действий — core/cloud.ts,
             сеть — api/yandex-disk.ts. -->
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
              @click="onPickYandex"
            >
              <svg
                class="am-cloud__mark"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <rect width="24" height="24" rx="6" fill="#fc3f1d" />
                <path
                  fill="#fff"
                  fill-rule="evenodd"
                  d="M16 4.8h-3.9c-2.5 0-4.2 1.6-4.2 4 0 1.8 1 3.1 2.7 3.7L7.9 19.2h2.7l2.6-6.2h0.7v6.2H16Zm-2.1 2.1h-1.7c-1.3 0-2.1 0.8-2.1 2 0 1.2 0.8 2 2.1 2h1.7Z"
                />
              </svg>
              <span class="am-cloud__name">Яндекс Диск</span>
            </button>
            <button class="am-cloud__pick" type="button" disabled>
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
                  <path fill="#00832d" d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
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
              <span class="am-cloud__name">Google Drive</span>
              <span class="am-cloud__soon">позже</span>
            </button>
          </div>

          <template v-if="cloudPlace === 'yandex'">
            <p v-if="!cloudSaved || tokenOpen" class="am-meta">
              Пропуск выдаёт сам Яндекс: заведите приложение с правом на Диск на
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
                <span class="am-fact__value"><code>{{ CLOUD_PATH }}</code></span>
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
                v-tip="'Записать нынешний список в облако поверх прежней копии'"
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

            <!-- Копия ложится поверх живого списка: спрашиваем всегда, теми же
                 словами и тем же узлом, что и перенос с AniList. -->
            <div v-if="askingCloud" class="am-ask">
              <p class="am-ask__text">Записей: {{ listCount }}.</p>

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
      </div>

      <!-- Правая колонка — вид и справка: то, что смотрят, а не то, чем правят. -->
      <div class="am-set__col">
        <div class="am-panel am-box">
          <h3 class="am-h3">Оформление</h3>

          <div class="am-skins">
            <button
              v-for="item in APPEARANCES"
              :key="item.name"
              v-tip="item.hint"
              class="am-skins__btn"
              :class="{ 'am-skins__btn--on': item.name === appearance }"
              type="button"
              @click="setAppearance(item.name)"
            >
              <span class="am-skins__mark" aria-hidden="true">{{ item.mark }}</span>
              <span class="am-skins__name">{{ item.title }}</span>
            </button>
          </div>

          <label class="am-switch">
            <input v-model="adult" type="checkbox" class="am-switch__box" @change="onAdult" />
            <span class="am-switch__name">Показывать контент для взрослых (18+)</span>
          </label>
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
            <li class="am-fact">
              <span class="am-fact__name">Датасет названий</span>
              <span class="am-fact__value" :class="{ 'am-fact__value--stale': datasetStale }">
                {{ datasetText }}
              </span>
            </li>
          </ul>

          <!-- Имя источника, лицензия и ссылка. Обязанностью строка быть
               перестала: CC0-1.0 атрибуции не требует, и это вежливость
               к единственному источнику кириллицы. Манами из цепочки убрана
               3 сентября 2026 — номера теперь свои, перечислением каталога. -->
          <p class="am-meta am-fine">
            Русские названия поставляет датасет
            <button class="am-link" type="button" @click="onDatasetLink">animori-data</button>
            (лицензия CC0-1.0): номера и связки собраны перечислением каталога Шикимори,
            сами названия — из открытых API Шикимори и anime365.
          </p>

          <!-- Свежесть датасета — единственное, за чем человеку приходится следить
               руками, поэтому про просрочку говорим словами, а не одной цифрой выше. -->
          <p v-if="datasetStale" class="am-stale">
            Датасет не обновлялся больше {{ STALE_DAYS }} дней. Названия, которых в нём нет,
            программа добирает из сети по одному — это медленно. Загляните в
            <button class="am-link" type="button" @click="onDatasetLink">animori-data</button>
            и запустите сборку кнопкой.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./settings-screen.css"></style>
