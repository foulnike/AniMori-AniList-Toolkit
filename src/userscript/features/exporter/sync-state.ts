// Состояние модуля переноса: точка монтирования и компонент не импортируют
// друг друга, всё общее живёт здесь.
//
// Токен не хранится здесь: его кэш живёт в api/anilist.ts, отсюда только геттер
// и сеттер. Для переноса это критично: токен сохраняется ровно перед серией
// авторизованных запросов, и если бы запись шла только в асинхронное хранилище,
// первый же запрос мог бы уйти без токена и весь экспорт упал бы на первом шаге.

import { computed, ref } from 'vue'
import { Logger } from '@/utils/logger'
import {
  fetchShikiHistoryDates,
  fetchShikiUserId,
  fetchShikimoriFavorites,
  fetchShikimoriListV2,
  getExistingAnilistFavorites,
  getSyncFailures,
  resetSyncFailures,
  syncShikiToAlFavorites,
  syncShikiToAlList,
  type AniListUser,
  type HistoryDates,
} from './sync-api'
import { getSavedShikiLogin, loadScannerStorage, saveShikiLogin } from '../scanner/compare'
import { anilistQuery, getStoredAlToken, setAlToken } from '@/api/anilist'

/** Подпись кнопки в покое. */
export const IDLE_LABEL = 'Экспорт'

/**
 * Направление переноса. Окно открывается только на AniList и тянет данные со стороны,
 * то есть с точки зрения пользователя это импорт. Тип оставлен с двумя вариантами:
 * он описывает направление, а не домен, и пригодится при обратной выгрузке.
 */
export type SyncMode = 'export' | 'import'

export const syncMode: SyncMode = 'import'

export const isSyncOpen = ref(false)

/** Идёт ли перенос. На время работы кнопка блокируется. */
export const isRunning = ref(false)

/** Текущая подпись кнопки: она же индикатор прогресса. */
export const buttonLabel = ref(IDLE_LABEL)

/**
 * То же самое для пилюли в панели действий: пусто в покое, текст во время работы.
 *
 * Пустая строка, а не IDLE_LABEL: в покое кнопка должна показывать иконку, а слово
 * «Экспорт» растянуло бы пилюлю и сломало равнение с остальными кнопками.
 */
export const pillProgress = computed(() =>
  buttonLabel.value === IDLE_LABEL ? '' : buttonLabel.value,
)

export const shikiUser = ref('')
export const alToken = ref('')
export const clientId = ref('')

/** Ссылка авторизации; пустая строка значит «ещё не создавали». */
export const authUrl = ref('')

export const optAnime = ref(true)
export const optManga = ref(true)
export const optFavs = ref(true)
export const optDates = ref(true)

// Абсолютные адреса собираются конкатенацией — то же правило, что в панели настроек.
const AL_HOST = 'https://' + 'anilist.co'
export const AL_DEVELOPER_URL = AL_HOST + '/settings/developer'
export const AL_REDIRECT_URL = AL_HOST + '/api/v2/oauth/pin'

/**
 * Открывает окно переноса.
 *
 * Асинхронная: запомненный логин лежит в хранилище моста, а оно асинхронное. Сначала
 * прогревается кэш сканера, потом подставляются поля. Поле, в которое пользователь
 * уже что-то ввёл, не затирается.
 */
export async function openSyncModal(): Promise<void> {
  await loadScannerStorage()
  if (!shikiUser.value) shikiUser.value = getSavedShikiLogin()
  alToken.value = getStoredAlToken()
  isSyncOpen.value = true
}

export function closeSyncModal(): void {
  isSyncOpen.value = false
}

/** Создаёт ссылку авторизации по Client ID. */
export function generateAuthUrl(): void {
  const cid = clientId.value.trim()
  if (!cid) {
    alert('Введите Client ID')
    return
  }
  authUrl.value = AL_HOST + '/api/v2/oauth/authorize?client_id=' + cid + '&response_type=token'
}

/**
 * Отказался ли AniList принимать токен.
 *
 * anilistQuery() бросает обычный Error с текстом `Error <код>` либо с текстом
 * GraphQL-ошибки, отдельного типа там нет. Заводить его ради одной ветки здесь значило бы
 * трогать клиент, которым пользуется весь проект, поэтому распознаём по тексту.
 * AniList отвечает 401 на протухший или чужой токен и 400 с GraphQL-ошибкой
 * Invalid token — на синтаксически испорченный.
 */
function isAuthFailure(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return (
    message.includes('Error 401') ||
    message.includes('Error 403') ||
    message.toLowerCase().includes('invalid token')
  )
}

/** Текст для пользователя при отказе токена. */
const TOKEN_REJECTED_MESSAGE =
  'AniList отклонил токен: он неверный либо истёк. Токены действуют год, после чего ' +
  'его нужно выпустить заново: откройте окно переноса, создайте ссылку по Client ID ' +
  'и вставьте полученный токен в поле.'

/**
 * Перенос Shikimori → AniList. Порядок шагов, проверки, тексты alert и confirm
 * менять нельзя.
 */
export async function runSync(): Promise<void> {
  const user = shikiUser.value.trim()
  const token = alToken.value.trim()

  if (!user || !token) {
    alert('Заполните логин и токен!')
    return
  }
  if (!optAnime.value && !optManga.value && !optFavs.value) {
    alert('Выберите опции для экспорта!')
    return
  }

  // Логин запоминается тем же ключом, что и в окне сравнения: на AniList его больше
  // неоткуда взять, а требовать ввода при каждом открытии окна невежливо. Запись идёт
  // через scanner/compare.ts, а не напрямую в хранилище: там живёт кэш в памяти,
  // и мимо него запись оставила бы сканеру старое значение до конца сессии.
  saveShikiLogin(user)

  setAlToken(token)
  // Токен не остаётся в поле после сохранения.
  alToken.value = ''
  isSyncOpen.value = false
  isRunning.value = true

  const onProgress = (text: string) => {
    buttonLabel.value = text
  }

  try {
    resetSyncFailures()
    onProgress('Соединение с AniList...')

    // Первый авторизованный запрос — он же проверка токена. Разбираем его отказ
    // отдельно от остального переноса: дальше идти всё равно некуда, а причина
    // чинится ровно одним действием пользователя. Общий catch показал бы
    // «Ошибка: Error 401», по которой невозможно догадаться о протухшем токене,
    // а токены живут год — встреча с этим случаем гарантирована.
    let alUser: AniListUser
    try {
      const res = await anilistQuery<{ Viewer: AniListUser }>(
        'query{Viewer{id name mediaListOptions{scoreFormat}}}',
        {},
        true,
      )
      const viewer = res.data?.Viewer
      if (!viewer) {
        // Ответ 200 без Viewer — тоже отказ в авторизации: анониму AniList отдаёт null.
        throw new Error(TOKEN_REJECTED_MESSAGE)
      }
      alUser = viewer
    } catch (e) {
      if (isAuthFailure(e)) {
        Logger('ERROR', 'Перенос: AniList отклонил токен', e)
        throw new Error(TOKEN_REJECTED_MESSAGE)
      }
      throw e
    }

    onProgress('Поиск профиля Shiki...')
    const shikiId = await fetchShikiUserId(user)

    if (
      !confirm(
        `Начать перенос Shikimori ➜ AniList для профиля '${alUser.name}'?\n\nВнимание: Экспорт может занять некоторое время.`,
      )
    )
      return

    let historyDates: Record<string, HistoryDates> | null = null
    if (optDates.value && (optAnime.value || optManga.value))
      historyDates = await fetchShikiHistoryDates(shikiId, onProgress)
    if (optAnime.value) {
      const animeList = await fetchShikimoriListV2(shikiId, 'anime')
      await syncShikiToAlList(animeList, 'anime', alUser, historyDates, onProgress)
    }
    if (optManga.value) {
      const mangaList = await fetchShikimoriListV2(shikiId, 'manga')
      await syncShikiToAlList(mangaList, 'manga', alUser, historyDates, onProgress)
    }
    if (optFavs.value) {
      const exFavs = await getExistingAnilistFavorites(alUser.id, onProgress)
      const shikiFavs = await fetchShikimoriFavorites(user)
      await syncShikiToAlFavorites(shikiFavs, exFavs, onProgress)
    }

    const failures = getSyncFailures()
    if (failures > 0) {
      alert(`Экспорт завершён частично: ${failures} операций не выполнено. Подробности в логгере.`)
    } else {
      alert('Экспорт успешно завершен!')
    }
  } catch (e) {
    Logger('ERROR', 'Экспорт Shikimori → AniList: ошибка выполнения', e)
    alert('Ошибка: ' + ((e as Error).message || e))
  } finally {
    isRunning.value = false
    setTimeout(() => {
      buttonLabel.value = IDLE_LABEL
    }, 2000)
  }
}
