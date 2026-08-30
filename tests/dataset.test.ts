import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installMockBridge, resetMockBridge } from './mocks/bridge-module'

const INDEX_URL = 'https://github.com/foulnike/animori-data/releases/latest/download/index.json'
const TITLES_URL = 'https://github.com/foulnike/animori-data/releases/latest/download/titles-anime.json.gz'

const validIndex = {
  version: 1,
  builtAt: '2026-08-22T20:05:38.311Z',
  source: 'manami-project/anime-offline-database',
  sourceTag: '2026-27',
  license: 'ODbL-1.0',
  files: [
    {
      name: 'titles-anime.json.gz',
      bytes: 0,
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  ],
}

describe('dataset api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockBridge()
  })

  it('парсит валидную опись выпуска', async () => {
    const mock = installMockBridge()
    mock.setHttpResponse(INDEX_URL, { text: JSON.stringify(validIndex) })

    const { fetchDatasetIndex: fetchIndex } = await import('@/api/dataset')
    const index = await fetchIndex()
    expect(mock.calls.http[0]?.url).toBe(INDEX_URL)

    expect(index?.version).toBe(1)
    expect(index?.builtAt).toBe(validIndex.builtAt)
    expect(index?.files).toHaveLength(1)
  })

  it('отклоняет опись без даты сборки', async () => {
    const mock = installMockBridge()
    mock.setHttpResponse(INDEX_URL, { text: JSON.stringify({ version: 1, files: [] }) })

    const { fetchDatasetIndex: fetchIndex } = await import('@/api/dataset')
    await expect(fetchIndex()).resolves.toBeNull()
  })

  it('отклоняет файл описи без отпечатка', async () => {
    const mock = installMockBridge()
    mock.setHttpResponse(INDEX_URL, {
      text: JSON.stringify({
        ...validIndex,
        files: [{ name: 'titles-anime.json.gz', bytes: 1, sha256: '' }],
      }),
    })

    const { fetchDatasetIndex: fetchIndex } = await import('@/api/dataset')
    await expect(fetchIndex()).resolves.toBeNull()
  })

  it('проверяет hash перед распаковкой', async () => {
    const mock = installMockBridge()
    mock.setHttpResponse(INDEX_URL, { text: JSON.stringify(validIndex) })
    mock.setHttpBytes(TITLES_URL, gzipSync(Buffer.from(JSON.stringify({ v: 1, titles: [] }))))

    const { fetchDatasetIndex: fetchIndex, fetchDatasetPayload: fetchPayload } = await import(
      '@/api/dataset'
    )
    const index = await fetchIndex()
    const file = index?.files[0]
    if (!file) throw new Error('нет файла датасета')

    await expect(fetchPayload({ ...file, sha256: 'bad' })).resolves.toBeNull()
  })
})
