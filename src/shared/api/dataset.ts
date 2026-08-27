// Загрузка датасета названий из выпусков animori-data: опись и два файла.
// Только сеть и превращение байтов в данные: хранение и чтение — в core/dataset-names.ts.
// Поля описи и файлов повторяют scripts/build-names.mjs репозитория данных.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'
import { githubLimiter } from './rate-limit'

/**
 * Постоянный адрес файлов последнего выпуска: тег в нём не участвует,
 * latest на него ведёт сам GitHub. Зеркала нет: jsDelivr файлы выпусков
 * не раздаёт (docs/DATA-PIPELINE.md).
 */
const RELEASE_BASE = 'https://github.com/foulnike/animori-data/releases/latest/download'

/** Таймауты: опись крошечная, файлы — до полутора мегабайт в сжатом виде. */
const INDEX_TIMEOUT_MS = 15000
const FILE_TIMEOUT_MS = 60000

/** Строка описи о файле выпуска: имя, размер и отпечаток сжатого тела. */
export interface DatasetFileRef {
  name: string
  bytes: number
  sha256: string
}

/** Опись выпуска. Единственный файл, который клиент тянет на каждой проверке. */
export interface DatasetIndex {
  version: number
  builtAt: string
  source: string
  sourceTag: string
  license: string
  files: DatasetFileRef[]
}

/** Запись имени в файле titles. Поле id — номер Шикимори, он же номер MAL. */
export interface DatasetTitleRow {
  id: number
  name: string
  /** Пустая строка — ответ «русского имени нет», а не пропуск записи. */
  russian: string
  kind: string
  aired_on: string | null
  score: string | null
}

/** Распакованный файл имён. */
export interface DatasetTitlesPayload {
  v: number
  tag: string
  builtAt: string
  count: number
  titles: DatasetTitleRow[]
}

/** Распакованный файл карты: пара — [номер MAL, номер AniList]. */
export interface DatasetMapPayload {
  v: number
  tag: string
  builtAt: string
  count: number
  pairs: Array<[number, number]>
}

/** Годна ли опись: без даты сборки и списка файлов она бесполезна. */
function parseIndex(raw: unknown): DatasetIndex | null {
  if (typeof raw !== 'object' || raw === null) return null

  const candidate = raw as Partial<DatasetIndex>
  if (typeof candidate.builtAt !== 'string' || candidate.builtAt === '') return null
  if (!Array.isArray(candidate.files)) return null

  const files: DatasetFileRef[] = []
  for (const item of candidate.files) {
    if (typeof item !== 'object' || item === null) return null
    const row = item as Partial<DatasetFileRef>
    if (typeof row.name !== 'string' || row.name === '') return null
    if (typeof row.sha256 !== 'string' || row.sha256 === '') return null
    files.push({
      name: row.name,
      bytes: typeof row.bytes === 'number' ? row.bytes : 0,
      sha256: row.sha256,
    })
  }

  return {
    version: typeof candidate.version === 'number' ? candidate.version : 0,
    builtAt: candidate.builtAt,
    source: typeof candidate.source === 'string' ? candidate.source : '',
    sourceTag: typeof candidate.sourceTag === 'string' ? candidate.sourceTag : '',
    license: typeof candidate.license === 'string' ? candidate.license : '',
    files,
  }
}

/**
 * base64 обратно в байты: бинарные данные через мост ходят только так.
 * Явный ArrayBuffer в типе возврата: без него выводится ArrayBufferLike,
 * а digest() и Blob ниже принимают только ArrayBuffer.
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text)
  const bytes = new Uint8Array(raw.length)
  for (let at = 0; at < raw.length; at++) bytes[at] = raw.charCodeAt(at)
  return bytes
}

/** Шестнадцатеричный отпечаток тела: сверка с описью до распаковки. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let hex = ''
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** Распаковка gzip штатным потоком WebView2: сторонней библиотеки нет сознательно. */
async function gunzipText(packed: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

/**
 * Опись последнего выпуска или null при любой неудаче: отсутствие описи
 * равно отсутствию обновления, а не ошибке. Куки не нужны вовсе.
 */
export async function fetchDatasetIndex(): Promise<DatasetIndex | null> {
  const url = `${RELEASE_BASE}/index.json`

  try {
    await githubLimiter.acquireSlot()
    const res = await Bridge.http.request({ url, timeoutMs: INDEX_TIMEOUT_MS, credentials: 'omit' })
    if (!res.ok) {
      Logger('WARN', `Датасет: опись ответила ${res.status}`)
      return null
    }

    const index = parseIndex(JSON.parse(res.text))
    if (!index) Logger('WARN', 'Датасет: опись не разобрана')
    return index
  } catch (e) {
    Logger('WARN', 'Датасет: опись не загрузилась', e)
    return null
  }
}

/**
 * Файл выпуска распакованным или null при любой неудаче. Отпечаток сверяется
 * до распаковки: половина архива, разобранная в базу, хуже отсутствия архива.
 */
export async function fetchDatasetPayload(file: DatasetFileRef): Promise<unknown | null> {
  const url = `${RELEASE_BASE}/${file.name}`

  try {
    await githubLimiter.acquireSlot()
    const res = await Bridge.http.requestBytes({
      url,
      timeoutMs: FILE_TIMEOUT_MS,
      credentials: 'omit',
    })
    if (!res.ok) {
      Logger('WARN', `Датасет: ${file.name} ответил ${res.status}`)
      return null
    }

    const packed = fromBase64(res.bytesBase64)

    const digest = await sha256Hex(packed)
    if (digest !== file.sha256) {
      Logger('WARN', `Датасет: отпечаток ${file.name} не сошёлся с описью`)
      return null
    }

    return JSON.parse(await gunzipText(packed)) as unknown
  } catch (e) {
    Logger('WARN', `Датасет: ${file.name} не загрузился или не разобрался`, e)
    return null
  }
}
