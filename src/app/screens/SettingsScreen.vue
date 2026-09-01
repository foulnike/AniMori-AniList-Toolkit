<script setup lang="ts">
// Настройки: вход в AniList, внешность и распоряжение своими данными.
// На экране только то, что человеку решать: как всё устроено внутри —
// дело документации, а не карточки настроек.
//
// Раскладка — две колонки известной ширины, а не сетка auto-fit: панели
// разной высоты расползались по всему фуллскрину, и глазу негде было
// зацепиться. Слева то, что делают руками, справа — вид и справка.
import { onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import {
  entryCount,
  forgetCollection,
  initCollection,
  refreshFromServer,
  unlinkCollection,
} from '@/core/collection'
import { datasetStatus, initDatasetNames } from '@/core/dataset-names'
import { clearCache, getDbStats } from '@/core/db'
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
import { navigate } from '../router'

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

/** Адрес датасета названий: атрибуция по ODbL обязана вести на источник. */
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

/**
 * Переключение показа взрослого. Отбор живёт в core/adult.ts и читает ключ
 * в момент вопроса, поэтому перезапуска не нужно: следующий поиск уже другой.
 */
function onAdult(): void {
  note.value = ''

  void saveSetting('showAdult', 'set_adult', adult.value)

  note.value = adult.value
    ? 'Взрослое теперь видно в поиске и каталоге.'
    : 'Взрослое скрыто из поиска и каталога.'
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

/**
 * Переход в журнал. Кнопка живёт здесь, а не в меню: журнал нужен при разборе
 * поломки, а не каждый день, и спрашивают о нём именно отсюда.
 */
function onLog(): void {
  navigate('log')
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
    <div class="am-set">
      <!-- Левая колонка — действия: подключение счёта и распоряжение данными.
           Обе панели здесь умеют менять то, что лежит на диске. -->
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
                  v-tip="'Забрать список с AniList и заменить им местный'"
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

            <!-- Вопрос перед заменой: человек видит, что будет с местными записями. -->
            <div v-if="asking" class="am-ask">
              <p class="am-ask__text">
                Список с AniList заменит местный целиком. Записи, добавленные здесь без входа, будут
                потеряны, если их нет на AniList. Сейчас у нас записей: {{ listCount }}.
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
            Список живёт здесь, на вашем диске, и от отключения счёта не исчезает. Память — это
            названия, описания и обложки: её можно сбросить без потерь.
          </p>

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

          <!-- Удаление списка необратимо для местных записей: спрашиваем всегда. -->
          <div v-if="askingDrop" class="am-ask">
            <p class="am-ask__text">
              Удалить список с этого устройства: записей {{ listCount }}. На AniList ваши записи
              останутся нетронутыми, а добавленные здесь без входа вернуть будет неоткуда.
            </p>

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
            <span class="am-switch__text">
              <span class="am-switch__name">Показывать контент для взрослых (18+)</span>
              <span class="am-switch__hint">
                Контент для взрослых в поиске и каталоге. Своего списка это не касается: добавленные
                записи видны всегда.
              </span>
            </span>
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

          <!-- Атрибуция по ODbL: имя источника, лицензия и ссылка. Обязательна
               с первого имени, показанного из датасета. -->
          <p class="am-meta am-fine">
            Русские названия поставляет датасет
            <button class="am-link" type="button" @click="onDatasetLink">animori-data</button>
            (лицензия ODbL-1.0): номера и связки — manami-project/anime-offline-database, сами
            названия — из открытых API Шикимори и anime365.
          </p>

          <!-- Свежесть датасета — единственное, за чем человеку приходится следить
               руками, поэтому про просрочку говорим словами, а не одной цифрой выше. -->
          <p v-if="datasetStale" class="am-stale">
            Датасет не обновлялся больше {{ STALE_DAYS }} дней. Названия, которых в нём нет,
            программа добирает из сети по одному — это медленно. Загляните в
            <button class="am-link" type="button" @click="onDatasetLink">animori-data</button>
            и запустите сборку кнопкой.
          </p>

          <!-- Вход в журнал. Отсюда, а не из меню: читают его, когда что-то
               не работает, и спрашивают о нём ровно на этом экране. -->
          <div class="am-log-open">
            <button class="am-btn am-btn--soft" type="button" @click="onLog">Открыть журнал</button>
            <span class="am-meta">Записи этого запуска: сеть, склад, очередь правок, ошибки.</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Две колонки известной доли, а не auto-fit по минимальной ширине: на
   фуллскрине сетка разводила четыре панели в ряд, и настройки читались
   как россыпь окошек. Потолок ширины держит строку текста читаемой. */
.am-set {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: var(--am-gap);
  align-items: start;
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
}

/* Колонка сама столбец: панели в ней идут одна под другой с общим шагом. */
.am-set__col {
  display: flex;
  flex-direction: column;
  gap: var(--am-gap);
  min-width: 0;
}

@media (max-width: 980px) {
  .am-set {
    grid-template-columns: minmax(0, 1fr);
  }
}

.am-box {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  border-radius: var(--am-r-leaf);
  transition: border-color var(--am-mid) var(--am-ease);
}

.am-box:hover {
  border-color: var(--am-edge);
}

/* Засечка акцентом у заголовка: панели одинаковые, и глазу нужна зацепка. */
.am-box > .am-h3,
.am-box .am-bar .am-h3 {
  display: flex;
  gap: 9px;
  align-items: center;
}

.am-box > .am-h3::before,
.am-box .am-bar .am-h3::before {
  flex: 0 0 auto;
  width: 3px;
  height: 14px;
  content: '';
  background: linear-gradient(180deg, var(--am-accent), var(--am-accent-2));
  border-radius: var(--am-r-cap);
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

/* Выбор темы: три карточки рядом, выбранная подсвечена акцентом. */
.am-skins {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.am-skins__btn {
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: center;
  padding: 13px 8px;
  font: inherit;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease),
    border-radius var(--am-mid) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-skins__btn:hover {
  color: var(--am-text);
  background: var(--am-hover);
  border-radius: var(--am-r-drop);
  transform: translateY(-2px);
}

.am-skins__btn--on {
  color: var(--am-text);
  background: rgb(var(--am-accent-rgb) / 0.12);
  border-color: rgb(var(--am-accent-rgb) / 0.5);
  border-radius: var(--am-r-drop);
  box-shadow: var(--am-sh-glow);
}

.am-skins__mark {
  font-size: 20px;
  line-height: 1;
}

.am-skins__btn--on .am-skins__mark {
  color: var(--am-accent);
}

.am-skins__name {
  font-size: 12.5px;
  font-weight: 600;
}

/* Вопрос перед заменой списка: отделён рамкой, но без крика.
   Тон берётся от --am-warn: жёлтый литерал на светлой теме слепил. */
.am-ask {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 13px 15px;
  background: color-mix(in srgb, var(--am-warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--am-warn) 42%, transparent);
  border-radius: var(--am-r-l);
}

.am-ask__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--am-dim);
}

/* Просрочка датасета: тот же тон, что у вопроса перед заменой списка.
   Это подсказка, а не ошибка, и красным её показывать неправильно. */
.am-stale {
  margin: 0;
  padding: 11px 13px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--am-dim);
  background: color-mix(in srgb, var(--am-warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--am-warn) 42%, transparent);
  border-radius: var(--am-r-m);
}

/* Атрибуция обязана быть видна, но читают её раз в жизни: своим кеглем
   она уходит на второй план и не спорит с фактами выше. */
.am-fine {
  font-size: 12px;
  line-height: 1.5;
}

/* Вход в журнал: кнопка и пояснение рядом, а не строкой фактов выше —
   это действие, а не число. */
.am-log-open {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 11px 13px;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
}

/* Исход действия: виден сразу и не путается с пояснениями рядом. */
.am-note {
  margin: 0;
  font-size: 13px;
  color: var(--am-good);
}

/* Настройка-тумблер: вся строка нажимается, пояснение под названием. */
.am-switch {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 14px;
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
  transition: background-color var(--am-fast) var(--am-ease);
}

.am-switch:hover {
  background: var(--am-hover);
}

/* Свой переключатель вместо системной галочки: та игнорирует тему
   и рисуется по-своему в каждом движке. */
.am-switch__box {
  position: relative;
  flex: none;
  width: 42px;
  height: 24px;
  margin: 1px 0 0;
  appearance: none;
  cursor: pointer;
  background: var(--am-fill-3);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    background var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-switch__box::before {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  content: '';
  background: var(--am-faint);
  border-radius: var(--am-r-cap);
  transition:
    transform var(--am-mid) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

.am-switch__box:checked {
  background: linear-gradient(135deg, var(--am-accent), var(--am-accent-2));
  border-color: transparent;
}

.am-switch__box:checked::before {
  background: var(--am-bg);
  transform: translateX(18px);
}

.am-switch__text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.am-switch__name {
  font-weight: 600;
}

.am-switch__hint {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--am-dim);
}

/* Ссылка-кнопка в тексте: внешний адрес открывает оболочка, не разметка. */
.am-link {
  padding: 0;
  font: inherit;
  color: var(--am-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  background: none;
  border: 0;
}

/* Состояние подключения точкой: видно без чтения. */
.am-flag {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  padding: 5px 12px;
  font-size: 12.5px;
  color: var(--am-dim);
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
}

.am-flag__dot {
  width: 8px;
  height: 8px;
  background: var(--am-faint);
  border-radius: var(--am-r-cap);
}

.am-flag--on {
  color: var(--am-good);
  background: color-mix(in srgb, var(--am-good) 14%, transparent);
  border-color: color-mix(in srgb, var(--am-good) 38%, transparent);
}

.am-flag--on .am-flag__dot {
  background: var(--am-good);
  box-shadow: 0 0 8px color-mix(in srgb, var(--am-good) 80%, transparent);
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
  padding: 8px 0;
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
  font-weight: 600;
  text-align: right;
}

/* Возраст датасета сверх порога. Раньше здесь стоял литерал: жёлтого
   в наборе не было. Теперь --am-warn есть и подобран под каждую тему. */
.am-fact__value--stale {
  color: var(--am-warn);
}

code {
  padding: 1px 6px;
  font-size: 12.5px;
  background: var(--am-fill-2);
  border-radius: var(--am-r-s);
}

@media (prefers-reduced-motion: reduce) {
  .am-skins__btn:hover {
    transform: none;
  }
}
</style>
