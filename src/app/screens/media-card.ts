// Данные карточки тайтла: подробности с сервера, русская карточка,
// оценки площадок, франшиза и правки записи. За экраном осталась
// разметка: в одном файле карточка перестала поддаваться правке.
//
// Состояние списка берётся из памяти коллекции, а не из ответа: список
// односторонний, правки живут только здесь, и правда тоже здесь.
import { computed, nextTick, ref, type ComputedRef, type Ref } from 'vue'

import { fetchMediaCard, type MediaCard } from '@/api/anilist-media'
import { setupVideoSources } from '@/api/video-sources'
import { Bridge } from '@/bridge'
import { hiddenCount, keepAllowed } from '@/core/adult'
import { editEntry, getEntry, type EntryLook } from '@/core/collection'
import { fetchFranchise, type FranchiseWork } from '@/core/franchise'
import { partsOut } from '@/core/media-looks'
import {
  getRussianTitle,
  peekRussianName,
  prefetchRussianNames,
  type RussianTitle,
} from '@/core/media-title'
import {
  peekPlayable,
  primePlayable,
  warmPlayable,
  type PlayAsk,
  type PlayState,
} from '@/core/playable'
import { getTitleRatings, type TitleRatings } from '@/core/ratings'
import { studioLogos } from '@/core/studio-logos'
import { Logger } from '@/utils/logger'

import { formatWord, statusWord } from '../labels'
import { mediaLinks, type MediaLink } from '../media-links'
import { navigate } from '../router'

/**
 * Скольким частям франшизы добирать метку доступности сетью. Со склада
 * поднимается вся полка даром, а в сеть идёт начало дерева.
 *
 * Сорок частей — потолок любого известного дерева, и такая глубина стала
 * посильной только с оптовым вопросом: два десятка номеров уходят к источнику
 * одним запросом, и вся франшиза закрывается двумя-тремя. Прежние восемь
 * стояли здесь ровно потому, что каждая часть стоила запроса к каждому
 * источнику, и полка подлиннее не доходила до конца никогда.
 */
const PLAY_DEPTH = 40

/** Оценка площадки для героя. */
export interface Rating {
  key: string
  label: string
  value: string
}

/** Факт записи для строки в колонке справа. */
export interface MineFact {
  key: string
  name: string
  value: string
}

/** Виды правки, доступные с карточки. Удаление записи сюда пока не входит. */
type CardEdit = 'status' | 'score' | 'progress' | 'repeat' | 'startedAt' | 'completedAt' | 'notes'

/** Всё, что разметка карточки берёт готовым. */
export interface MediaCardView {
  card: Ref<MediaCard | null>
  busy: Ref<boolean>
  trouble: Ref<string>
  franList: Ref<HTMLElement | null>
  status: ComputedRef<string>
  score10: ComputedRef<number>
  progress: ComputedRef<number>
  repeat: ComputedRef<number>
  startedAt: ComputedRef<string | null>
  completedAt: ComputedRef<string | null>
  notes: ComputedRef<string | null>
  partsTotal: ComputedRef<number | null>
  listed: ComputedRef<boolean>
  listLabel: ComputedRef<string>
  mainTitle: ComputedRef<string>
  heroStyle: ComputedRef<{ backgroundImage: string }>
  donePart: ComputedRef<string>
  progressText: ComputedRef<string>
  drifted: ComputedRef<boolean>
  about: ComputedRef<string>
  aboutLinks: ComputedRef<MediaLink[]>
  facts: ComputedRef<string[]>
  ratings: ComputedRef<Rating[]>
  mineFacts: ComputedRef<MineFact[]>
  franchiseRows: ComputedRef<readonly FranchiseWork[]>
  franchiseHidden: ComputedRef<number>
  load: () => Promise<void>
  studioLogo: (name: string) => string | null
  franchiseName: (work: FranchiseWork) => string
  franchiseStatus: (work: FranchiseWork) => string | null
  franchiseHint: (work: FranchiseWork) => string
  franchisePlay: (work: FranchiseWork) => PlayState | null
  openFranchiseWork: (work: FranchiseWork) => void
  openStudio: (studioId: number) => void
  onOpen: (url: string) => void
  onPickStatus: (value: string) => void
  onPickScore: (value: number) => void
  onPickProgress: (value: number) => void
  onPickRepeat: (value: number) => void
  onPickStarted: (value: string) => void
  onPickCompleted: (value: string) => void
  onPickNotes: (value: string) => void
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Оценка числом или прочерк: нуль значит «не оценено». */
export function scoreText(value: number): string {
  return value > 0 ? value.toFixed(1) : '—'
}

/**
 * Дата человеческим видом. Строка разбирается вручную: прогон через Date
 * счёл бы её полночью по Гринвичу и сдвинул день назад у половины мира.
 */
export function dateText(value: string | null): string {
  if (value === null) return '—'

  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!parts) return value

  return `${parts[3]}.${parts[2]}.${parts[1]}`
}

/**
 * Собирает всё состояние одной карточки вокруг номера тайтла из адреса.
 * Номер показа гасит ответы, пришедшие уже к другому тайтлу.
 */
export function useMediaCard(mediaId: Ref<number>): MediaCardView {
  const card = ref<MediaCard | null>(null)
  const russian = ref<RussianTitle | null>(null)
  const busy = ref(true)
  const trouble = ref('')

  /** Литографии студий с Шикимори: подставляются в чипы по готовности. */
  const logos = ref<Map<string, string> | null>(null)

  /** Оценки Шикимори и MAL: доход отдельный от русской карточки. */
  const platformRatings = ref<TitleRatings | null>(null)

  /** Хронология франшизы: null — дерева нет или оно не приехало. */
  const franchise = ref<FranchiseWork[] | null>(null)

  /** Счётчик добора русских имён франшизы: заставляет пересчитать строки. */
  const franchiseStamp = ref(0)

  /** Счётчик добора меток доступности: память ответов вне реактивности. */
  const playStamp = ref(0)

  /** Счётчик добора имени из датасета: заставляет пересчитать заголовок. */
  const nameStamp = ref(0)

  /** Полка франшизы: к текущему тайтлу она прокручивается сама. */
  const franList = ref<HTMLElement | null>(null)

  /** Счётчик правок этого показа: заставляет пересчитать взятое из памяти. */
  const editStamp = ref(0)

  /** Номер показа: ответ на старый тайтл пришёл не вовремя и ему места нет. */
  let run = 0

  /**
   * Своя запись из памяти. Счётчик правок в зависимостях не случаен:
   * мап коллекции вне реактивности Vue, сам он пересчёт не закажет.
   */
  const own = computed(() => {
    void editStamp.value
    return mediaId.value > 0 ? getEntry(mediaId.value) : undefined
  })

  /**
   * Облик тайтла для записи списка: латинские имена и метка взрослого.
   * Идёт вместе с правкой, иначе запись, созданная до переноса списка,
   * останется безымянной: имена и метку до сих пор приносил только
   * ответ сервера.
   */
  const look = computed<EntryLook | undefined>(() => {
    const found = card.value
    if (found === null) return undefined

    return {
      romaji: found.romaji,
      english: found.english,
      isAdult: found.isAdult,
    }
  })

  /** Статус для выбора: память главнее ответа, ответ — запас на первый показ. */
  const status = computed<string>(() => own.value?.status ?? card.value?.ownEntry?.status ?? '')

  const score10 = computed<number>(() => own.value?.score10 ?? card.value?.ownEntry?.score10 ?? 0)

  const progress = computed<number>(
    () => own.value?.progress ?? card.value?.ownEntry?.progress ?? 0,
  )

  /** Пересмотры. Правило то же: память впереди ответа. */
  const repeat = computed<number>(() => own.value?.repeat ?? card.value?.ownEntry?.repeat ?? 0)

  const startedAt = computed<string | null>(
    () => own.value?.startedAt ?? card.value?.ownEntry?.startedAt ?? null,
  )

  const completedAt = computed<string | null>(
    () => own.value?.completedAt ?? card.value?.ownEntry?.completedAt ?? null,
  )

  const notes = computed<string | null>(
    () => own.value?.notes ?? card.value?.ownEntry?.notes ?? null,
  )

  /**
   * Сколько серий уже вышло: именно по этому числу считается полоса и шаг.
   * У идущего сезона объявленного итога часто нет вовсе.
   */
  const partsTotal = computed<number | null>(() =>
    card.value === null ? null : partsOut(card.value),
  )

  /** Объявленный итог: сколько серий всего обещано. */
  const partsPlanned = computed<number | null>(() => card.value?.episodes ?? null)

  /** Надпись главной кнопки: своя закладка, а без неё приглашение добавить. */
  const listLabel = computed<string>(() => {
    const word = statusWord(status.value === '' ? null : status.value)
    return word ?? 'Добавить в список'
  })

  /** Главное название: русское из карточки, имя из датасета, латиница, английское, номер. */
  const mainTitle = computed<string>(() => {
    // Счётчик в зависимостях: добор имени фоном сам по себе пересчёт не закажет.
    void nameStamp.value
    return (
      russian.value?.russian ??
      peekRussianName(mediaId.value) ??
      card.value?.romaji ??
      card.value?.english ??
      `Тайтл #${mediaId.value}`
    )
  })

  /** Подложка героя: баннер сервера, а без него тон обложки. */
  const heroStyle = computed<{ backgroundImage: string }>(() => {
    const banner = card.value?.banner
    if (banner) return { backgroundImage: `url(\"${banner}\")` }

    const tone = card.value?.color ?? '#1b2534'
    return { backgroundImage: `linear-gradient(120deg, ${tone}, #0b1018)` }
  })

  /** Есть ли запись в списке: без неё панель — одна кнопка добавления. */
  const listed = computed<boolean>(() => status.value !== '')

  /** Доля пройденного для полосы в сводке. */
  const doneShare = computed<number>(() => {
    const total = partsTotal.value
    if (total === null || total <= 0) return status.value === 'COMPLETED' ? 1 : 0

    return Math.min(1, Math.max(0, progress.value / total))
  })

  const donePart = computed<string>(() => `${Math.round(doneShare.value * 100)}%`)

  /** Строка счёта серий вида «7 из 12». Неизвестный итог не выдумывается. */
  const partsText = computed<string>(() => {
    const total = partsTotal.value
    return total === null ? String(progress.value) : `${progress.value} из ${total}`
  })

  /** Правая часть строки прогресса, без процента при неизвестном итоге. */
  const progressText = computed<string>(() =>
    partsTotal.value === null ? partsText.value : `${partsText.value} · ${donePart.value}`,
  )

  /**
   * Разошлось ли наше состояние с тем, что лежит на сайте.
   *
   * Расхождение теперь не временное, а постоянное: правки на сервер
   * не уезжают вовсе, и после первой же правки здесь две копии записи
   * живут отдельно. Говорится вслух именно поэтому: человек должен
   * знать, что на сайте другие числа, прежде чем переносить список обратно.
   */
  const drifted = computed<boolean>(() => {
    const server = card.value?.ownEntry
    const mine = own.value
    if (!server || !mine) return false

    return (
      server.status !== mine.status ||
      server.score10 !== mine.score10 ||
      server.progress !== mine.progress ||
      server.repeat !== mine.repeat ||
      server.startedAt !== mine.startedAt ||
      server.completedAt !== mine.completedAt ||
      server.notes !== mine.notes
    )
  })

  /**
   * Описание как приехало: разметку разбирает RichText, ему нужен исходник.
   * Прежде теги срезались здесь, и до разбора не доживали ни перекрёстные
   * ссылки, ни спойлеры, ни начертания — то есть половина смысла текста.
   */
  const about = computed<string>(() => {
    // Пустая строка от русского источника не гасит английский текст с AniList.
    const ru = russian.value?.description?.trim() ?? ''
    const en = card.value?.description?.trim() ?? ''
    return ru !== '' ? ru : en
  })

  /**
   * Бледный хвост под описанием: номера каталогов и источник текста
   * ссылками. Сборка адресов — в media-links.ts.
   */
  const aboutLinks = computed<MediaLink[]>(() => {
    const found = card.value
    if (found === null) return []

    return mediaLinks({
      mediaId: found.mediaId,
      malId: found.malId,
      sourceUrl: russian.value?.url ?? null,
      sourceName: russian.value?.sourceName ?? null,
    })
  })

  /** Факты пилюлями под названием: только то, что сервер впрямь назвал. */
  const facts = computed<string[]>(() => {
    const found = card.value
    if (found === null) return []

    const list: string[] = []
    const kindWord = formatWord(found.format)
    if (kindWord !== null) list.push(kindWord)
    if (found.seasonYear !== null) list.push(String(found.seasonYear))
    if (partsPlanned.value !== null) list.push(`Серий: ${partsPlanned.value}`)

    // У идущего сезона важно не обещанное, а то, что уже можно смотреть.
    if (found.airingEpisode !== null && partsTotal.value !== null) {
      list.push(`Вышло: ${partsTotal.value}`)
    }

    if (found.duration) list.push(`${found.duration} мин`)

    return list
  })

  /**
   * Рейтинг трёх площадок. AniList — из карточки; Шикимори и MAL — своим
   * доходом: название мог добыть anime365, у которого оценок нет вовсе.
   */
  const ratings = computed<Rating[]>(() => {
    const list: Rating[] = []

    const al = card.value?.averageScore
    if (typeof al === 'number' && al > 0) {
      list.push({ key: 'al', label: 'AniList', value: (al / 10).toFixed(1) })
    }

    const marks = platformRatings.value
    if (marks?.shikimori) {
      list.push({ key: 'shiki', label: 'Шикимори', value: marks.shikimori.toFixed(1) })
    }
    if (marks?.mal) {
      list.push({ key: 'mal', label: 'MAL', value: marks.mal.toFixed(1) })
    }

    return list
  })

  /**
   * Факты записи строками: рисуются только с настоящим значением.
   * Серий в списке нет: их показывает полоса прогресса.
   */
  const mineFacts = computed<MineFact[]>(() => {
    const list: MineFact[] = []
    if (score10.value > 0)
      list.push({ key: 'score', name: 'Оценка', value: scoreText(score10.value) })
    if (repeat.value > 0)
      list.push({ key: 'repeat', name: 'Пересмотры', value: String(repeat.value) })
    if (startedAt.value !== null)
      list.push({ key: 'started', name: 'Начато', value: dateText(startedAt.value) })
    if (completedAt.value !== null)
      list.push({ key: 'completed', name: 'Закончено', value: dateText(completedAt.value) })
    return list
  })

  /**
   * Видимые части франшизы. Манга из дерева не показывается: открывать её
   * карточку больше нечем, а плитка без перехода вводит в заблуждение.
   * Взрослое убирается общим отбором.
   */
  const franchiseRows = computed<readonly FranchiseWork[]>(() => {
    // Закладки частей живут в памяти коллекции: пересчёт после своих правок.
    void editStamp.value
    void franchiseStamp.value

    const works = franchise.value
    if (works === null) return []

    return keepAllowed(
      works.filter((w) => w.type !== 'MANGA'),
      (w) => w.isAdult,
    )
  })

  /** Скрытые отбором части франшизы. */
  const franchiseHidden = computed<number>(() => {
    const works = franchise.value
    if (works === null) return 0

    return hiddenCount(
      works.filter((w) => w.type !== 'MANGA'),
      (w) => w.isAdult,
    )
  })

  /**
   * Метки доступности частям франшизы. Сначала склад — он отвечает даром
   * и разом по всей полке, — и только потом сеть, и то первым частям.
   *
   * Полка франшизы — то место, где метка полезнее всего: человек смотрит
   * на дерево именно чтобы решить, что смотреть дальше.
   */
  async function warmFranchisePlay(
    mine: number,
    works: readonly FranchiseWork[],
    ids: readonly number[],
  ): Promise<void> {
    const primed = await primePlayable(ids)
    if (mine !== run) return
    if (primed > 0) playStamp.value += 1

    const asks: PlayAsk[] = []

    for (const work of works) {
      if (asks.length >= PLAY_DEPTH) break

      const id = work.mediaId
      if (id === null || work.type === 'MANGA') continue
      if (peekPlayable(id) !== null) continue

      const names = [...new Set([work.name, peekRussianName(id) ?? ''])]

      asks.push({
        mediaId: id,
        malId: work.malId,
        titles: names.filter((name) => name !== ''),
        year: typeof work.year === 'number' ? work.year : undefined,
      })
    }

    if (asks.length === 0) return

    // Реестр источников собирает слой api: ядро своих поставщиков не зовёт.
    setupVideoSources()

    await warmPlayable(asks)
    if (mine !== run) return

    playStamp.value += 1
  }

  /** Дерево франшизы: склад или сеть, затем русские имена частей фоном. */
  async function beginFranchise(mine: number, id: number, found: MediaCard): Promise<void> {
    const works = await fetchFranchise(id, found.malId)
    if (mine !== run || works === null) return

    franchise.value = works
    void nextTick(() => {
      franList.value
        ?.querySelector('.am-part__hit--here')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })

    // Русские имена частей — тем же фоновым проходом. Манга из дерева
    // не показывается, и спрашивать её названия незачем.
    const ids = works.flatMap((w) => (w.type !== 'MANGA' && w.mediaId !== null ? [w.mediaId] : []))
    if (ids.length === 0) return

    await prefetchRussianNames(ids)
    if (mine !== run) return

    franchiseStamp.value += 1

    // Метки доступности — после имён: имя важнее, без него часть не узнать.
    await warmFranchisePlay(mine, works, ids)
  }

  /** Забирает подробности и русскую карточку. Фоновые доборы её не ждут. */
  async function load(): Promise<void> {
    const mine = ++run
    const id = mediaId.value

    card.value = null
    russian.value = null
    platformRatings.value = null
    franchise.value = null
    trouble.value = ''

    if (id === 0) {
      busy.value = false
      return
    }

    busy.value = true

    // Имя — сразу из памяти или датасета: ждать сетевую карточку ради
    // заголовка не нужно. Полная русская карточка с описанием доедет ниже.
    void prefetchRussianNames([id])
      .then(() => {
        if (mine === run) nameStamp.value += 1
      })
      .catch((e) => {
        Logger('WARN', `Карточка ${id}: фоновое имя не добралось`, e)
      })

    try {
      const found = await fetchMediaCard(id)
      if (mine !== run) return

      if (!found) {
        trouble.value = 'Сервер не отдал этот тайтл. Попробуйте позже.'
        return
      }

      card.value = found

      // Литографии подгружаются фоном: чипы студий их не ждут.
      if (found.studios.length > 0) {
        void studioLogos()
          .then((map) => {
            if (mine === run) logos.value = map
          })
          .catch((e) => {
            Logger('WARN', `Карточка ${id}: логотипы студий не загрузились`, e)
          })
      }

      // Оценки площадок — своим доходом: карточка их не ждёт.
      void getTitleRatings(id, found.malId)
        .then((marks) => {
          if (mine === run) platformRatings.value = marks
        })
        .catch((e) => {
          Logger('WARN', `Карточка ${id}: рейтинги не загрузились`, e)
        })

      // Дерево франшизы — фоном: полка его не ждёт.
      void beginFranchise(mine, id, found).catch((e) => {
        Logger('WARN', `Карточка ${id}: франшиза не загрузилась`, e)
      })
    } catch (e) {
      if (mine !== run) return
      trouble.value = describe(e)
      return
    } finally {
      if (mine === run) busy.value = false
    }

    try {
      const found = await getRussianTitle(id)
      if (mine === run) russian.value = found
    } catch (e) {
      // Без русского названия карточка живая: останется латиница.
      Logger('WARN', `Карточка ${id}: русское название не добылось`, e)
    }
  }

  /**
   * Уводит наружу через оболочку: в WebView2 переход в новом окне молча
   * отбрасывается, а переход в том же окне унёс бы само приложение.
   */
  function onOpen(url: string): void {
    void Bridge.shell.openExternal(url).catch((e) => {
      Logger('WARN', `Карточка: внешняя ссылка не открылась (${url})`, e)
    })
  }

  /** Работы студии — внутренним переходом, а не внешней ссылкой. */
  function openStudio(studioId: number): void {
    navigate('studio', { id: String(studioId) })
  }

  /** Литография студии по имени; промах — чип без картинки, это штатно. */
  function studioLogo(name: string): string | null {
    return logos.value?.get(name.trim().toLowerCase()) ?? null
  }

  /** Имя части франшизы: русское, когда фон уже добыл. */
  function franchiseName(work: FranchiseWork): string {
    return work.mediaId === null ? work.name : (peekRussianName(work.mediaId) ?? work.name)
  }

  /** Своя закладка на части франшизы словом, когда она есть. */
  function franchiseStatus(work: FranchiseWork): string | null {
    if (work.mediaId === null) return null
    return statusWord(getEntry(work.mediaId)?.status ?? null)
  }

  /** Подсказка части франшизы: полное имя и вид. */
  function franchiseHint(work: FranchiseWork): string {
    return work.kind === null ? work.name : `${work.name} · ${work.kind}`
  }

  /**
   * Есть ли часть у источников видео. Счётчик в зависимостях не случаен:
   * память ответов живёт вне реактивности Vue и пересчёт сама не закажет.
   */
  function franchisePlay(work: FranchiseWork): PlayState | null {
    void playStamp.value
    return work.mediaId === null ? null : peekPlayable(work.mediaId)
  }

  /** Переход на карточку части франшизы: текущая и несопоставленная не ведут. */
  function openFranchiseWork(work: FranchiseWork): void {
    if (work.mediaId === null || work.mediaId === mediaId.value) return
    navigate('media', { id: String(work.mediaId) })
  }

  /**
   * Кладёт одну правку в память и обновляет показ. Синхронно и без сети:
   * правка никуда не едет, а запись снимка уйдёт на диск отложенно.
   */
  function send(kind: CardEdit, value: string | number): void {
    if (mediaId.value === 0) return

    try {
      // Облик идёт вместе с правкой: без переноса списка его больше взять негде.
      editEntry(mediaId.value, kind, value, look.value)
      editStamp.value += 1
    } catch (e) {
      trouble.value = describe(e)
    }
  }

  function onPickStatus(value: string): void {
    if (value === status.value) return
    send('status', value)
  }

  function onPickScore(value: number): void {
    send('score', value)
  }

  function onPickProgress(value: number): void {
    send('progress', value)
  }

  function onPickRepeat(value: number): void {
    send('repeat', value)
  }

  function onPickStarted(value: string): void {
    send('startedAt', value)
  }

  function onPickCompleted(value: string): void {
    send('completedAt', value)
  }

  function onPickNotes(value: string): void {
    send('notes', value)
  }

  return {
    card,
    busy,
    trouble,
    franList,
    status,
    score10,
    progress,
    repeat,
    startedAt,
    completedAt,
    notes,
    partsTotal,
    listed,
    listLabel,
    mainTitle,
    heroStyle,
    donePart,
    progressText,
    drifted,
    about,
    aboutLinks,
    facts,
    ratings,
    mineFacts,
    franchiseRows,
    franchiseHidden,
    load,
    studioLogo,
    franchiseName,
    franchiseStatus,
    franchiseHint,
    franchisePlay,
    openFranchiseWork,
    openStudio,
    onOpen,
    onPickStatus,
    onPickScore,
    onPickProgress,
    onPickRepeat,
    onPickStarted,
    onPickCompleted,
    onPickNotes,
  }
}
