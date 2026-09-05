<script setup lang="ts">
// Настройки: импорт списка, свои данные, облачная копия, внешность и справка.
// На экране только то, что человеку решать: как всё устроено внутри —
// дело документации, а не карточки настроек.
//
// РАСКЛАДКА
// Панели собраны в три колонки-обёртки. Раньше они лежали прямо в сетке
// и разводились по местам через grid-template-areas — и сетка ставила их
// в общие строки: высокая панель облака держала строку, а под «Оформлением»
// и «Импортом» до самого низа зияла пустота. Колонка-обёртка такого не умеет:
// каждая набирает свои панели встык, и высота соседней ей безразлична.
//
// Порядок и ширина колонок под каждый размер окна живут в settings-screen.css,
// поэтому разметка здесь одна на все случаи: на фуллскрине колонок три,
// на половине экрана две, в узком окне одна.
//
// Справа налево на фуллскрине: облачная копия, импорт со своими данными,
// оформление со справкой.
//
// Внутри панели данных тот же порядок: сначала числа, потом необратимое
// одной строкой, потом выгрузка своим узлом. Пояснения убраны сознательно:
// подписи кнопок и строка пути говорят то же самое и короче.
//
// Облачная копия живёт своим узлом — components/CloudBox.vue. Наружу узлу
// нужны только число записей и метка устройства, а обратно — весть, что
// список сменился.
//
// ДВА ИСТОЧНИКА СПИСКА
// AniList и Шикимори стоят в панели импорта двумя одинаковыми половинами:
// знак сервиса, название, строка состояния, кнопки, свои ответы. Раньше они
// шли сплошняком, и граница между ними существовала только в голове того,
// кто это писал.
//
// Знаки сервисов рисует components/BrandMark.vue: вектор он берёт из файлов
// в src/app/brand, взятых у самих сервисов. Прежде они были нарисованы
// вручную прямо здесь, и кривизна букв была видна невооружённым глазом.
//
// Ошибки и итоги у них раздельные. Одна общая строка на две половины врала бы
// первым же промахом: отказ Шикимори читался бы как отказ AniList.
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
import {
  eachEntry,
  entryCount,
  forgetCollection,
  initCollection,
  pullFromShikimori,
  refreshFromServer,
  unlinkCollection,
  type PullMode,
  type ShikiPullResult,
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
import BrandMark from '../components/BrandMark.vue'
import CloudBox from '../components/CloudBox.vue'
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

/**
 * Ник на Шикимори. Списывается с памяти настроек один раз: общий объект
 * настроек не реактивен, и v-model по его полю не показал бы набранное.
 */
const shikiNick = ref(settings.shikiNick)

/** Спрошено ли подтверждение переноса с Шикимори. Спрашивается по тем же причинам. */
const askingShiki = ref(false)

/**
 * Занятость и ответы Шикимори держатся отдельно от общих busy/error/note.
 * Перенос списка идёт минутами, и общая занятость гасила бы на это время
 * кнопки AniList и своих данных, к делу непричастные. Общая строка ответа
 * к тому же встала бы в панели данных — далеко от кнопки, которую нажали.
 */
const shikiBusy = ref(false)
const shikiNote = ref('')
const shikiError = ref('')

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

/// Копия из облака легла поверх списка: числа в панели данных пора
/// переспросить. Своё состояние облачная панель ведёт сама.
function onCloudChanged(): void {
  void readState()
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

/**
 * Ник запоминается сразу по уходу из поля, а не только после переноса:
 * набирать его заново на телевизоре пультом — то ещё удовольствие.
 */
function onShikiNick(): void {
  const clean = shikiNick.value.trim()
  shikiNick.value = clean
  void saveSetting('shikiNick', 'am_shiki_nick', clean)
}

/** Нажатие на перенос с Шикимори: сначала вопрос, действие потом. */
function onShikiAsk(): void {
  shikiNote.value = ''
  shikiError.value = ''
  askingShiki.value = true
}

function onShikiCancel(): void {
  askingShiki.value = false
}

/**
 * Потери словами. Тайтлы, которых нет у AniList, в список не попадают вовсе,
 * и молчать об этом нельзя: человек считает записи глазами и решит, что
 * программа половину списка съела.
 */
function lostText(done: ShikiPullResult): string {
  if (done.lost === 0) return ''
  if (done.lostTitles.length === 0) return ` Без пары на AniList: ${done.lost}.`

  const more = done.lost > done.lostTitles.length ? ' и другие' : ''
  return ` Без пары на AniList ${done.lost}: ${done.lostTitles.join(', ')}${more}.`
}

/**
 * Перенос списка с Шикимори по нику. Способы те же два, и вопрос тот же:
 * замена вычищает всё, включая перенесённое с AniList и добавленное руками.
 */
function onShikiPull(mode: PullMode): void {
  askingShiki.value = false

  void (async () => {
    shikiBusy.value = true
    shikiError.value = ''
    shikiNote.value = ''

    try {
      // Ник сохраняется до переноса, а не после: перенос долгий, и уйти
      // с экрана посреди него человек вправе.
      onShikiNick()

      const done = await pullFromShikimori(shikiNick.value, mode)
      await readState()

      shikiNote.value =
        done.mode === 'replace'
          ? `Список замещён списком ${done.nick} с Шикимори: записей ${done.total}.` +
            lostText(done)
          : `Списки слиты: всего ${done.total}, новых ${done.added}, ` +
            `обновлено ${done.updated}, своих правок сохранено ${done.kept}, ` +
            `только здесь ${done.onlyHere}.` +
            lostText(done)
    } catch (e) {
      shikiError.value = describe(e)
    } finally {
      shikiBusy.value = false
    }
  })()
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
})
</script>

<template>
  <section class="am-page">
    <!-- Три колонки-обёртки: каждая набирает свои панели встык, и высота
         соседней ей безразлична. Порядок и ширина колонок под каждый размер
         окна живут в settings-screen.css. -->
    <div class="am-set">
      <div class="am-set__col am-set__col--main">
        <!-- Импорт списка: две половины одного вида. У каждой знак сервиса,
             название, строка состояния, кнопки и свои ответы. -->
        <div class="am-panel am-box">
          <h3 class="am-h3">Импорт списка</h3>

          <!-- AniList. Знак берёт components/BrandMark.vue из файла
               src/app/brand/anilist.svg: фирменный вектор, а не наш рисунок. -->
          <div class="am-serv">
            <div class="am-serv__head">
              <BrandMark class="am-serv__logo" name="anilist" />

              <span class="am-serv__text">
                <span class="am-serv__name">AniList</span>
                <span class="am-serv__note">
                  {{
                    authStatus.authorized
                      ? `Подключён ${expiryText(authStatus.expiresAt)}.`
                      : 'Нужен вход в аккаунт.'
                  }}
                </span>
              </span>

              <span class="am-flag" :class="{ 'am-flag--on': authStatus.authorized }">
                <span class="am-flag__dot" aria-hidden="true" />
                {{ authStatus.authorized ? 'подключён' : 'не подключён' }}
              </span>
            </div>

            <p v-if="!desktop" class="am-meta">
              Вход работает только в приложении. Запустите <code>npm run tauri dev</code>.
            </p>

            <template v-else>
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
                    {{ busy ? 'Переносим…' : 'Перенести список' }}
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
                  <button class="am-btn am-btn--ghost" type="button" @click="onCancel">
                    Отмена
                  </button>
                </div>
              </div>

              <!-- Показывается только после нажатия: до него окна входа нет
                   и ждать человеку нечего. -->
              <p v-if="login && !authStatus.authorized" class="am-meta">
                Окно AniList открыто, после разрешения оно закроется само. Ожидание —
                {{ waitText(login.waitSecs) }}.
              </p>

              <div v-if="manualOpen && !authStatus.authorized" class="am-row">
                <label class="am-field">
                  <input
                    v-model="manual"
                    class="am-input"
                    type="text"
                    placeholder="Токен AniList"
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

          <!-- Шикимори. Знак тоже фирменный, из src/app/brand/shikimori.svg.
               Вход не нужен: открытый профиль сайт отдаёт любому по нику. -->
          <div class="am-serv">
            <div class="am-serv__head">
              <BrandMark class="am-serv__logo" name="shikimori" />

              <span class="am-serv__text">
                <span class="am-serv__name">Шикимори</span>
                <span class="am-serv__note">Профиль на Шикимори должен быть открытым.</span>
              </span>

              <span class="am-flag">
                <span class="am-flag__dot" aria-hidden="true" />
                вход не нужен
              </span>
            </div>

            <div class="am-row">
              <label class="am-field">
                <input
                  v-model="shikiNick"
                  class="am-input"
                  type="text"
                  placeholder="Ник на Шикимори"
                  :disabled="shikiBusy"
                  @change="onShikiNick"
                />
              </label>
              <button
                v-tip="'Забрать список с Шикимори: слиянием или с заменой'"
                class="am-btn"
                type="button"
                :disabled="shikiBusy || !shikiNick.trim()"
                @click="onShikiAsk"
              >
                {{ shikiBusy ? 'Переносим…' : 'Перенести список' }}
              </button>
            </div>

            <!-- Вопрос тот же, что у AniList, и по той же причине: замена
                 вычищает список целиком, включая перенесённое и набранное
                 руками. -->
            <div v-if="askingShiki" class="am-ask">
              <p class="am-ask__text">Записей: {{ listCount }}.</p>

              <div class="am-row">
                <button
                  class="am-btn"
                  type="button"
                  :disabled="shikiBusy"
                  @click="onShikiPull('merge')"
                >
                  Добавить недостающее
                </button>
                <button
                  class="am-btn am-btn--ghost"
                  type="button"
                  :disabled="shikiBusy"
                  @click="onShikiPull('replace')"
                >
                  Заменить целиком
                </button>
                <button class="am-btn am-btn--ghost" type="button" @click="onShikiCancel">
                  Отмена
                </button>
              </div>
            </div>

            <p v-if="shikiNote" class="am-note">{{ shikiNote }}</p>
            <p v-if="shikiError" class="am-error">{{ shikiError }}</p>
          </div>
        </div>

        <!-- Данные: что лежит на этом диске и что с этим можно сделать. -->
        <div class="am-panel am-box">
          <h3 class="am-h3">Данные</h3>

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
      </div>

      <!-- Облачная копия своим узлом: площадка, вход и копия туда и обратно
           живут в components/CloudBox.vue. Ему нужны только число записей
           для вопросов и метка устройства для файла копии, а обратно
           приходит весть, что список сменился.

           Своя колонка: панель самая высокая на экране, и в общей строке
           с соседями она держала бы под ними пустоту. О раскладке сам узел
           по-прежнему ничего не знает. -->
      <div class="am-set__col am-set__col--cloud">
        <CloudBox :list="listCount" :device="system" @changed="onCloudChanged" />
      </div>

      <!-- Оформление и справка: то, что смотрят, а не то, чем правят. -->
      <div class="am-set__col am-set__col--look">
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
