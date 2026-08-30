import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installMockBridge, resetMockBridge } from './mocks/bridge-module'

const BASE = 'https://github.com/foulnike/animori-data/releases/latest/download'
const INDEX_URL = `${BASE}/index.json`
const TITLES_URL = `${BASE}/titles-anime.json.gz`
const MAP_URL = `${BASE}/map-mal-anilist.json.gz`
const FILE_NAME = 'animori-dataset.json'

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function makeRelease() {
  const titlesPayload = {
    v: 1,
    tag: '2026-27',
    builtAt: '2026-08-22T20:05:38.311Z',
    count: 2,
    titles: [
      { id: 5114, name: 'Fullmetal Alchemist: Brotherhood', russian: 'Стальной алхимик: Братство', kind: 'tv', aired_on: null, score: null },
      { id: 1000, name: 'Missing Russian', russian: '', kind: 'tv', aired_on: null, score: null },
    ],
  }
  const mapPayload = {
    v: 1,
    tag: '2026-27',
    builtAt: '2026-08-22T20:05:38.311Z',
    count: 2,
    pairs: [
      [5114, 16498],
      [1000, 2000],
    ],
  }

  const titlesBytes = gzipSync(Buffer.from(JSON.stringify(titlesPayload)))
  const mapBytes = gzipSync(Buffer.from(JSON.stringify(mapPayload)))

  return {
    index: {
      version: 1,
      builtAt: '2026-08-22T20:05:38.311Z',
      source: 'manami-project/anime-offline-database',
      sourceTag: '2026-27',
      license: 'ODbL-1.0',
      files: [
        { name: 'titles-anime.json.gz', bytes: titlesBytes.length, sha256: sha256Hex(titlesBytes) },
        { name: 'map-mal-anilist.json.gz', bytes: mapBytes.length, sha256: sha256Hex(mapBytes) },
      ],
    },
    titlesBytes,
    mapBytes,
  }
}

describe('dataset-names', () => {
  beforeEach(async () => {
    resetMockBridge()
    const mod = await import('@/core/dataset-names')
    mod.resetDatasetNames()
  })

  it('с чистого диска скачивает описи и файлы, проверяет и сохраняет слепок', async () => {
    const mock = installMockBridge()
    const release = makeRelease()
    mock.setHttpResponse(INDEX_URL, { text: JSON.stringify(release.index) })
    mock.setHttpBytes(TITLES_URL, release.titlesBytes)
    mock.setHttpBytes(MAP_URL, release.mapBytes)

    const { updateDatasetNamesInBackground, initDatasetNames, datasetStatus, lookupDatasetName } =
      await import('@/core/dataset-names')

    updateDatasetNamesInBackground()
    await vi.waitFor(() => expect(mock.getFile(FILE_NAME)).not.toBeNull())

    expect(await initDatasetNames()).toBe(true)
    expect(datasetStatus()).toEqual({
      loaded: true,
      builtAt: '2026-08-22T20:05:38.311Z',
      names: 2,
      pairs: 2,
    })
    await expect(lookupDatasetName(16498)).resolves.toEqual({
      kind: 'name',
      name: 'Стальной алхимик: Братство',
    })
    await expect(lookupDatasetName(2000)).resolves.toEqual({ kind: 'none' })
  })

  it('не качает файлы, если диск уже на той же дате сборки', async () => {
    const mock = installMockBridge()
    const release = makeRelease()
    mock.setFile(
      FILE_NAME,
      JSON.stringify({
        v: 1,
        builtAt: release.index.builtAt,
        sourceTag: release.index.sourceTag,
        license: release.index.license,
        titles: [
          { id: 5114, name: 'Fullmetal Alchemist: Brotherhood', russian: 'Стальной алхимик: Братство', kind: 'tv', aired_on: null, score: null },
        ],
        pairs: [[5114, 16498]],
      }),
    )
    mock.setHttpResponse(INDEX_URL, { text: JSON.stringify(release.index) })

    const { updateDatasetNamesInBackground, initDatasetNames, datasetStatus, lookupDatasetName } =
      await import('@/core/dataset-names')

    updateDatasetNamesInBackground()
    await vi.waitFor(() => expect(mock.calls.http).toHaveLength(1))

    expect(await initDatasetNames()).toBe(true)
    expect(datasetStatus().loaded).toBe(true)
    expect(mock.calls.httpBytes).toHaveLength(0)
    await expect(lookupDatasetName(16498)).resolves.toEqual({
      kind: 'name',
      name: 'Стальной алхимик: Братство',
    })
  })

  it('повреждённый файл считается отсутствующим и не блокирует работу', async () => {
    const mock = installMockBridge()
    mock.setFile(FILE_NAME, '{"v":1,"titles":')

    const { initDatasetNames, datasetStatus, lookupDatasetName } = await import(
      '@/core/dataset-names'
    )

    expect(await initDatasetNames()).toBe(false)
    expect(datasetStatus()).toEqual({ loaded: false, builtAt: null, names: 0, pairs: 0 })
    await expect(lookupDatasetName(16498)).resolves.toEqual({ kind: 'unknown' })
  })

  it('при отсутствии сети сохраняет старый слепок и продолжает работать', async () => {
    const mock = installMockBridge()
    const oldText = JSON.stringify({
      v: 1,
      builtAt: '2026-01-01T00:00:00.000Z',
      titles: [{ id: 5114, name: 'Fullmetal Alchemist: Brotherhood', russian: 'Старое имя', kind: 'tv', aired_on: null, score: null }],
      pairs: [[5114, 16498]],
    })
    mock.setFile(FILE_NAME, oldText)

    const { updateDatasetNamesInBackground, initDatasetNames, datasetStatus, lookupDatasetName } =
      await import('@/core/dataset-names')

    const update = updateDatasetNamesInBackground()
    await update
    expect(mock.calls.http).toHaveLength(1)

    expect(await initDatasetNames()).toBe(true)
    expect(datasetStatus().builtAt).toBe('2026-01-01T00:00:00.000Z')
    await expect(lookupDatasetName(16498)).resolves.toEqual({
      kind: 'name',
      name: 'Старое имя',
    })
  })

  it('отклоняет обновление при несовпадении hash и не перезаписывает старый слепок', async () => {
    const mock = installMockBridge()
    const oldText = JSON.stringify({
      v: 1,
      builtAt: '2026-01-01T00:00:00.000Z',
      titles: [{ id: 5114, name: 'img', russian: 'Старое имя', kind: 'tv', aired_on: null, score: null }],
      pairs: [[5114, 16498]],
    })
    mock.setFile(FILE_NAME, oldText)

    const release = makeRelease()
    const badTitles = release.index.files.map((file) =>
      file.name === 'titles-anime.json.gz' ? { ...file, sha256: 'bad' } : file,
    )
    mock.setHttpResponse(INDEX_URL, { text: JSON.stringify({ ...release.index, files: badTitles }) })
    mock.setHttpBytes(TITLES_URL, release.titlesBytes)
    mock.setHttpBytes(MAP_URL, release.mapBytes)

    const { updateDatasetNamesInBackground, initDatasetNames, datasetStatus } = await import(
      '@/core/dataset-names'
    )

    await updateDatasetNamesInBackground()
    expect(mock.calls.httpBytes).toHaveLength(2)

    expect(mock.getFile(FILE_NAME)).toBe(oldText)
    expect(await initDatasetNames()).toBe(true)
    expect(datasetStatus().builtAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
