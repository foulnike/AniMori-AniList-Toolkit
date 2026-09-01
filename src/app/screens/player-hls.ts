// Обёртка над hls.js: открыть манифест, сесть на нужную секунду, пережить
// срыв сети и убрать за собой. Больше никто в приложении про hls.js не знает.
//
// Почему библиотека, а не тег <video> напрямую: WebView2 на Windows не умеет
// HLS вовсе, а все наши источники отдают именно его. Где HLS родной
// (Safari, WebKitGTK), библиотека не нужна и только мешала бы.
//
// Смена качества у нас — это другой манифест, а не другая дорожка внутри
// одного: Kodik отдаёт каждое качество своим адресом без общего списка.
// Поэтому open() всегда принимает секунду, с которой продолжать.
import Hls from 'hls.js'

import { Logger } from '@/utils/logger'

/** Что экран умеет с воспроизведением. */
export interface Playback {
  /** Открывает манифест и садится на startAt секунд. */
  open: (url: string, startAt: number) => void
  /** Гасит воспроизведение и освобождает память под буферы. */
  close: () => void
}

/** Обратные вызовы экрана. */
export interface PlaybackHooks {
  /** Непоправимая ошибка: ссылка мертва или поток не читается. */
  onFatal: (text: string) => void
}

/**
 * Числа с рабочего плеера Kodik. Заводские вдвое скромнее, и на тонком
 * канале фрагменты не успевают приехать до своей секунды.
 */
const TUNE = {
  maxBufferSize: 7e7,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  liveSyncDuration: 30,
  fragLoadingTimeOut: 30000,
  manifestLoadingTimeOut: 20000,
  enableWorker: true,
  lowLatencyMode: false,
}

/** Сколько раз поднимать загрузку после срыва сети, прежде чем сдаться. */
const NET_TRIES = 2

/** Родной HLS есть только у WebKit; проверка дешёвая и честная. */
function nativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== ''
}

/**
 * Привязывает воспроизведение к тегу. Один тег — одна обёртка на всю жизнь
 * экрана: пересоздание hls.js на каждую серию оставляло бы висеть чужие
 * буферы: по семьдесят мегабайт на каждую.
 */
export function attachPlayback(video: HTMLVideoElement, hooks: PlaybackHooks): Playback {
  let hls: Hls | null = null
  let tries = 0
  let want = 0

  /** Посадка на нужную секунду: раньше готовности перемотка молча теряется. */
  function seat(): void {
    if (want <= 0) return
    video.currentTime = want
    want = 0
  }

  function play(): void {
    void video.play().catch((e: unknown) => {
      // Автозапуск мог быть запрещён — это не отказ, кнопка на месте.
      Logger('WARN', 'Плеер: автозапуск не случился', e)
    })
  }

  function drop(): void {
    hls?.destroy()
    hls = null
  }

  /** Разбор отказа: сеть и звук лечатся на месте, остальное — наверх. */
  function onError(details: string, kind: string): void {
    if (hls === null) return

    if (kind === Hls.ErrorTypes.NETWORK_ERROR && tries < NET_TRIES) {
      tries += 1
      Logger('WARN', `Плеер: срыв сети (${details}), попытка ${tries}`)
      hls.startLoad()
      return
    }

    if (kind === Hls.ErrorTypes.MEDIA_ERROR) {
      Logger('WARN', `Плеер: сбой потока (${details}), восстанавливаю`)
      hls.recoverMediaError()
      return
    }

    Logger('ERROR', `Плеер: воспроизведение остановлено (${details})`)
    drop()
    hooks.onFatal('Поток оборвался. Ссылка могла устареть: переспросите её.')
  }

  function open(url: string, startAt: number): void {
    want = startAt
    tries = 0

    // Родной путь: браузер сам разберёт манифест, обёртка лишняя.
    if (!Hls.isSupported()) {
      if (!nativeHls(video)) {
        hooks.onFatal('Этот движок не умеет HLS: смотреть нечем.')
        return
      }

      video.src = url
      video.addEventListener('loadedmetadata', seat, { once: true })
      play()
      return
    }

    drop()

    const next = new Hls(TUNE)
    hls = next

    next.on(Hls.Events.MANIFEST_PARSED, () => {
      seat()
      play()
    })

    next.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return
      onError(String(data.details), String(data.type))
    })

    next.loadSource(url)
    next.attachMedia(video)
  }

  function close(): void {
    drop()
    video.removeAttribute('src')
    video.load()
  }

  return { open, close }
}
