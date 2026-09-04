// Пользовательские настройки: читать `settings.x` в момент использования, не копировать.
// До `await loadSettings()` здесь дефолты, а импорты выполняются до start() в app/main.ts.
// Логгер недоступен: utils/logger сам читает этот модуль, импорт дал бы цикл.

import { Bridge } from '@/bridge'

export type TitleSource = 'shikimori' | 'anime365' | 'off' | 'none'
export type AccentPreset =
  'site' | 'sakura' | 'mono' | 'catppuccin' | 'nord' | 'dracula' | 'matcha' | 'sunset' | 'custom'

/**
 * Оформление окна. Слово «тема» здесь уже занято музыкальными темами
 * (`enableThemes`, `api/animethemes.ts`), поэтому ключ называется оформлением:
 * два смысла одного слова в одном модуле читаются неверно.
 *
 * `amoled` — не «тёмная погуще»: там чёрный ноль, потому что на OLED он не
 * светится вовсе, а полутон панелей выдал бы серую рамку вокруг окна.
 */
export type AppearanceName = 'dark' | 'light' | 'amoled'

/**
 * Где живёт облачная копия списка — этап 6. Значение 'none' означает «нигде»:
 * облако выключено, и наружу по своей воле не уходит ни один запрос.
 *
 * Место хранится строкой, а не флажком «включено», именно ради второго
 * провайдера: Google Drive станет ещё одним значением, а не вторым ключом
 * с отдельной логикой включения.
 */
export type CloudPlace = 'none' | 'yandex'

export interface AniMoriSettings {
  translateInterface: boolean
  titlePrimary: TitleSource
  titleFallback: TitleSource
  translateCharacters: boolean
  translateStaff: boolean
  enablePlayer: boolean
  enableRatings: boolean
  enableFranchise: boolean
  enableThemes: boolean
  enableExtLinks: boolean
  enableLinkRutracker: boolean
  enableLinkYummy: boolean
  enableLinkAnimego: boolean
  yummyDomain: string
  animegoDomain: string
  enableLogger: boolean
  accentPreset: AccentPreset
  /**
   * Цвет пресета `custom` в виде hex. Пустая строка и любой кривой ввод
   * равны теме сайта: разбор живёт в core/accent.ts.
   */
  accentCustom: string
  /** Оформление окна: тёмное, светлое или AMOLED. */
  appearance: AppearanceName
  /**
   * Блокировать всплывающие окна плеера. Kodik крутится в кросс-доменном
   * фрейме, поэтому работает только перехват on_new_window в Tauri.
   * Тот ловит НОВЫЕ окна: редиректы текущего фрейма и оверлеи им не отсекаются.
   * Выключен по умолчанию вместе с hideAds: блокировка режет рекламу партнёров
   * источников, и такое решение принимает человек, а не установщик. Дефолт общий
   * с hideAds: один тумблер панели пишет оба ключа, и при разных значениях он
   * выглядел бы включённым, ничего не блокируя.
   */
  blockPlayerPopups: boolean
  /**
   * Резать рекламные блоки самого AniList. В отличие от blockPlayerPopups работает
   * всюду: баннеры живут в главном фрейме на том же домене, что и скрипт.
   */
  hideAds: boolean
  /**
   * Показывать ли взрослое (18+) в поиске и каталоге — пункт 3.8.
   *
   * Выключено по умолчанию. Раньше вопроса не было вовсе: взрослое прятал
   * сам AniList у себя, а мы жили на его страницах. Своё окно спрашивает
   * каталог напрямую, и отбирать теперь нам.
   *
   * Своего списка ключ не касается: спрятанная своя запись — это враньё
   * в числах и потеря своих же данных, а метка 18+ на плитке есть и так.
   */
  showAdult: boolean
  /**
   * Показывать ли пилюлю «Перенос». Скрывается только кнопка: окно остаётся
   * смонтированным и доступным программно, смысл ключа чисто интерфейсный.
   */
  showSyncButton: boolean
  /**
   * Показывать ли пилюлю ⇄ (сравнение списков). Отдельный ключ, а не общий
   * с переносом: объединение заставило бы прятать обе кнопки ради одной.
   */
  showCompareButton: boolean
  /**
   * Папка для выгрузок списка в XML — пункт 3.3. Пустая строка значит
   * «ещё не выбрана»: тогда файл уходит загрузкой окна, и экран говорит
   * об этом вслух. Подставлять сюда домашний каталог за человека нельзя:
   * молчаливая запись куда-то и была тем дефектом, ради которого всё затеяно.
   *
   * Хранится полным путём, а не именем: окно выбора возвращает путь,
   * и папка привязана к этой машине. В снимок списка ключ не попадает
   * и на другое устройство не едет.
   */
  exportDir: string
  /**
   * Где держать облачную копию списка — этап 6. По умолчанию нигде: облако
   * включает человек, а не установщик, и до его выбора наружу не уходит
   * ни один запрос.
   */
  cloudPlace: CloudPlace
  /**
   * Пропуск (токен OAuth) выбранного облака. Пустая строка значит «облако
   * выбрано, но входа нет»: сохранять и забирать копию нечем.
   *
   * Лежит в хранилище окна открытым текстом, как и остальные настройки, —
   * это файл store в приватном каталоге приложения на этой машине. Пропуск
   * AniList хранится строже, в оболочке (src-tauri/src/auth.rs), и облачный
   * со временем стоит перенести туда же; пока он здесь, и молчать об этом
   * было бы нечестно.
   *
   * В копию списка пропуск не попадает никогда: в core/cloud-file.ts поля
   * записи перечислены поимённо, и лишнее туда не проходит.
   */
  cloudToken: string
  /**
   * Когда копия ушла в облако в последний раз, в миллисекундах. Ноль значит
   * «ни разу»: экран тогда честно говорит, что копии нет, вместо показа
   * начала эпохи Unix.
   */
  cloudSavedAt: number
  /**
   * Сколько записей было в последней копии. Нужно ровно для одного вопроса
   * человека перед восстановлением: «а сколько там вообще лежит?». Число
   * своё, а не спрошенное у облака: узнать его без сети тоже надо.
   */
  cloudSavedCount: number
  /**
   * Время правки файла копии, каким его назвало само облако после нашего
   * последнего касания. Пустая строка значит «этот файл мы не писали».
   *
   * Ключ нужен ровно для одного вопроса перед сохранением: наша ли копия
   * лежит в облаке сейчас. Запись шла с перезаписью не глядя, и сохранение
   * с устройства, где список беднее, молча затирало копию другого.
   *
   * Сравнивать своё cloudSavedAt с временем файла нельзя: их ставят разные
   * часы, и разница в минуту читалась бы как чужая правка. Здесь лежит
   * ровно та строка, которую отдало облако, и сравнение идёт знак в знак.
   */
  cloudSeenModified: string
  /** Производная: тайтлы включены, пока основной источник != 'off'. */
  translateTitles: boolean
}

/**
 * Значения НА СЛУЧАЙ ОТСУТСТВИЯ КЛЮЧА, а не «сброс к заводским»: чужое
 * сохранённое значение перебьёт любой дефолт отсюда.
 *
 * Фоллбэк именно Shikimori, а не 'none': anime365 знает не все русские названия,
 * и без фоллбэка на их месте оставалось бы английское название без объяснений.
 * Про мангу здесь речи больше нет: в приложении её не осталось.
 */
const DEFAULT_SETTINGS: AniMoriSettings = {
  translateInterface: true,
  titlePrimary: 'anime365',
  titleFallback: 'shikimori',
  translateCharacters: true,
  translateStaff: true,
  enablePlayer: true,
  enableRatings: true,
  enableFranchise: true,
  enableThemes: true,
  enableExtLinks: true,
  enableLinkRutracker: true,
  enableLinkYummy: true,
  enableLinkAnimego: true,
  yummyDomain: 'yummyanime.tv',
  animegoDomain: 'animego.org',
  enableLogger: true,
  accentPreset: 'site',
  accentCustom: '',
  appearance: 'dark',
  blockPlayerPopups: false,
  hideAds: false,
  showAdult: false,
  showSyncButton: true,
  showCompareButton: true,
  exportDir: '',
  cloudPlace: 'none',
  cloudToken: '',
  cloudSavedAt: 0,
  cloudSavedCount: 0,
  cloudSeenModified: '',
  translateTitles: true,
}

async function readSettings(): Promise<AniMoriSettings> {
  const storage = Bridge.storage

  // Все ключи читаются одним залпом: в Tauri последовательный await дал бы два
  // десятка вызовов через IPC на старте приложения.
  const [
    translateInterface,
    storedTitlePrimary,
    legacyTitles,
    titleFallback,
    translateCharacters,
    translateStaff,
    enablePlayer,
    enableRatings,
    enableFranchise,
    enableThemes,
    enableExtLinks,
    enableLinkRutracker,
    enableLinkYummy,
    enableLinkAnimego,
    yummyDomain,
    animegoDomain,
    enableLogger,
    accentPreset,
    accentCustom,
    appearance,
    blockPlayerPopups,
    hideAds,
    showAdult,
    showSyncButton,
    showCompareButton,
    exportDir,
    cloudPlace,
    cloudToken,
    cloudSavedAt,
    cloudSavedCount,
    cloudSeenModified,
  ] = await Promise.all([
    storage.get('set_interface', DEFAULT_SETTINGS.translateInterface),
    storage.get<TitleSource>('set_title_primary'),
    storage.get('set_titles', true),
    storage.get<TitleSource>('set_title_fallback', DEFAULT_SETTINGS.titleFallback),
    storage.get('set_chars', DEFAULT_SETTINGS.translateCharacters),
    storage.get('set_staff', DEFAULT_SETTINGS.translateStaff),
    storage.get('set_player', DEFAULT_SETTINGS.enablePlayer),
    storage.get('set_ratings', DEFAULT_SETTINGS.enableRatings),
    storage.get('set_franchise', DEFAULT_SETTINGS.enableFranchise),
    storage.get('set_themes', DEFAULT_SETTINGS.enableThemes),
    storage.get('set_extlinks', DEFAULT_SETTINGS.enableExtLinks),
    storage.get('set_link_rutracker', DEFAULT_SETTINGS.enableLinkRutracker),
    storage.get('set_link_yummy', DEFAULT_SETTINGS.enableLinkYummy),
    storage.get('set_link_animego', DEFAULT_SETTINGS.enableLinkAnimego),
    storage.get('set_yummy_domain', DEFAULT_SETTINGS.yummyDomain),
    storage.get('set_animego_domain', DEFAULT_SETTINGS.animegoDomain),
    storage.get('set_logger', DEFAULT_SETTINGS.enableLogger),
    storage.get<AccentPreset>('am_accent', DEFAULT_SETTINGS.accentPreset),
    storage.get('am_accent_custom', DEFAULT_SETTINGS.accentCustom),
    storage.get<AppearanceName>('am_appearance', DEFAULT_SETTINGS.appearance),
    storage.get('set_block_popups', DEFAULT_SETTINGS.blockPlayerPopups),
    storage.get('set_hide_ads', DEFAULT_SETTINGS.hideAds),
    storage.get('set_adult', DEFAULT_SETTINGS.showAdult),
    storage.get('set_btn_sync', DEFAULT_SETTINGS.showSyncButton),
    storage.get('set_btn_compare', DEFAULT_SETTINGS.showCompareButton),
    storage.get('set_export_dir', DEFAULT_SETTINGS.exportDir),
    storage.get<CloudPlace>('am_cloud_place', DEFAULT_SETTINGS.cloudPlace),
    storage.get('am_cloud_token', DEFAULT_SETTINGS.cloudToken),
    storage.get('am_cloud_saved_at', DEFAULT_SETTINGS.cloudSavedAt),
    storage.get('am_cloud_saved_count', DEFAULT_SETTINGS.cloudSavedCount),
    storage.get('am_cloud_seen_modified', DEFAULT_SETTINGS.cloudSeenModified),
  ])

  // Совместимость: старый set_titles применяется только при отсутствии нового ключа.
  // Литерал 'shikimori' здесь писать НЕЛЬЗЯ: старый ключ есть почти у всех,
  // и новый дефолт стал бы недостижим.
  const titlePrimary = storedTitlePrimary ?? (legacyTitles ? DEFAULT_SETTINGS.titlePrimary : 'off')

  return {
    translateInterface,
    titlePrimary,
    titleFallback,
    translateCharacters,
    translateStaff,
    enablePlayer,
    enableRatings,
    enableFranchise,
    enableThemes,
    enableExtLinks,
    enableLinkRutracker,
    enableLinkYummy,
    enableLinkAnimego,
    yummyDomain,
    animegoDomain,
    enableLogger,
    accentPreset,
    accentCustom,
    appearance,
    blockPlayerPopups,
    hideAds,
    showAdult,
    showSyncButton,
    showCompareButton,
    exportDir,
    cloudPlace,
    cloudToken,
    cloudSavedAt,
    cloudSavedCount,
    cloudSeenModified,
    translateTitles: titlePrimary !== 'off',
  }
}

/**
 * Единственный экземпляр настроек. Мутируется на месте, ссылка не меняется:
 * на этом держатся все потребители и реактивные модели панели настроек.
 */
export const settings: AniMoriSettings = { ...DEFAULT_SETTINGS }

/** Перечитать настройки из хранилища (вызывается из start() в app/main.ts). */
export async function loadSettings(): Promise<AniMoriSettings> {
  try {
    Object.assign(settings, await readSettings())
  } catch (e) {
    // Хранилище недоступно — работаем на дефолтах: без настроек приложение
    // ещё полезно, без запуска — уже нет.
    console.error('[AniMori] Не удалось прочитать настройки, используются значения по умолчанию', e)
  }
  return settings
}

/**
 * Записать одну настройку и сразу обновить производные. Память обновляется ДО записи:
 * интерфейс обязан ответить на клик мгновенно, а сбой записи не откатывает выбор.
 *
 * Сознательно НЕ отклоняется: вызывают её из сеттеров реактивных моделей,
 * где дождаться результата негде, а reject всплыл бы глобальным unhandledrejection.
 */
export async function saveSetting<K extends keyof AniMoriSettings>(
  key: K,
  storageKey: string,
  value: AniMoriSettings[K],
): Promise<void> {
  settings[key] = value
  settings.translateTitles = settings.titlePrimary !== 'off'

  try {
    await Bridge.storage.set(storageKey, value)
  } catch (e) {
    console.error('[AniMori] Не удалось сохранить настройку ' + storageKey, e)
  }
}
