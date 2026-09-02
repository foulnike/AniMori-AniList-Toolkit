// Проверки выгрузки списка в XML экспорта MyAnimeList.
//
// Модуль чистый: ни сети, ни диска, ни DOM — потому заглушки не нужны
// вовсе. Путь к модулю относительный, а не через @/: тест не должен
// зависеть от настройки псевдонимов сборщика.
//
// Смотрим именно там, где формат теряет смысл или ломается целиком.

import { describe, expect, it } from 'vitest'

import { buildMalXml, malDate, malScore, malStatus } from '../src/shared/core/mal-xml'

import type { SnapshotEntry } from '../src/shared/core/snapshot'

/** Запись со всеми полями на месте: тест меняет только то, что проверяет. */
function entry(over: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    mediaId: 1,
    malId: 100,
    status: 'CURRENT',
    score10: 0,
    progress: 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
    updatedAt: 0,
    isAdult: false,
    romaji: 'Romaji Name',
    english: 'English Name',
    ...over,
  }
}

describe('malStatus', () => {
  it('переводит закладки в слова MAL', () => {
    expect(malStatus('CURRENT')).toBe('Watching')
    expect(malStatus('COMPLETED')).toBe('Completed')
    expect(malStatus('PAUSED')).toBe('On-Hold')
    expect(malStatus('DROPPED')).toBe('Dropped')
    expect(malStatus('PLANNING')).toBe('Plan to Watch')
  })

  it('сводит пересмотр к «Watching»: у MAL такой закладки нет', () => {
    expect(malStatus('REPEATING')).toBe('Watching')
  })

  it('незнакомую и пустую закладку считает отсутствием', () => {
    expect(malStatus('SOMETHING')).toBeNull()
    expect(malStatus('')).toBeNull()
    expect(malStatus(null)).toBeNull()
  })
})

describe('malScore', () => {
  it('округляет десятые до целого балла', () => {
    expect(malScore(7.5)).toBe(8)
    expect(malScore(7.4)).toBe(7)
    expect(malScore(10)).toBe(10)
  })

  it('держится в границах шкалы', () => {
    expect(malScore(0)).toBe(0)
    expect(malScore(-3)).toBe(0)
    expect(malScore(42)).toBe(10)
    expect(malScore(Number.NaN)).toBe(0)
  })
})

describe('malDate', () => {
  it('пропускает дату формы ГГГГ-ММ-ДД', () => {
    expect(malDate('2026-01-31')).toBe('2026-01-31')
  })

  it('отсутствие и обломки даты отдаёт пустой датой формата', () => {
    expect(malDate(null)).toBe('0000-00-00')
    expect(malDate('2026-01')).toBe('0000-00-00')
    expect(malDate('')).toBe('0000-00-00')
  })
})

describe('buildMalXml', () => {
  it('ставит шапку аниме и считает выгруженные записи', () => {
    const done = buildMalXml({
      entries: [entry({ mediaId: 1, malId: 5 }), entry({ mediaId: 2, malId: 7 })],
      userName: 'Роман',
    })

    expect(done.xml.startsWith('<?xml version="1.0" encoding="UTF-8" ?>\n')).toBe(true)
    expect(done.xml).toContain('<user_export_type>1</user_export_type>')
    expect(done.xml).toContain('<user_total_anime>2</user_total_anime>')
    expect(done.xml).toContain('<user_name><![CDATA[Роман]]></user_name>')
    expect(done.xml.trimEnd().endsWith('</myanimelist>')).toBe(true)
    expect(done.exported).toBe(2)
  })

  it('выгружает поля записи целиком', () => {
    const done = buildMalXml({
      entries: [
        entry({
          malId: 21,
          status: 'COMPLETED',
          score10: 8.5,
          progress: 12,
          repeat: 3,
          startedAt: '2025-03-04',
          completedAt: '2025-04-01',
          notes: 'отлично',
          english: 'One Piece',
        }),
      ],
    })

    expect(done.xml).toContain('<series_animedb_id>21</series_animedb_id>')
    expect(done.xml).toContain('<series_title><![CDATA[One Piece]]></series_title>')
    expect(done.xml).toContain('<my_watched_episodes>12</my_watched_episodes>')
    expect(done.xml).toContain('<my_start_date>2025-03-04</my_start_date>')
    expect(done.xml).toContain('<my_finish_date>2025-04-01</my_finish_date>')
    expect(done.xml).toContain('<my_score>9</my_score>')
    expect(done.xml).toContain('<my_status>Completed</my_status>')
    expect(done.xml).toContain('<my_times_watched>3</my_times_watched>')
    expect(done.xml).toContain('<my_comments><![CDATA[отлично]]></my_comments>')
    expect(done.xml).toContain('<update_on_import>1</update_on_import>')
  })

  it('числа серий тайтла не выдумывает: в снимке их нет', () => {
    const done = buildMalXml({ entries: [entry()] })
    expect(done.xml).not.toContain('<series_episodes>')
  })

  it('берёт ромадзи, когда английского имени нет', () => {
    const done = buildMalXml({ entries: [entry({ english: null })] })
    expect(done.xml).toContain('<series_title><![CDATA[Romaji Name]]></series_title>')
  })

  it('безымянную запись помечает номером, а не пустотой', () => {
    const done = buildMalXml({
      entries: [entry({ mediaId: 777, english: null, romaji: null })],
    })
    expect(done.xml).toContain('<series_title><![CDATA[Anime #777]]></series_title>')
  })

  it('записи без номера MAL отдаёт поимённо, а не пропускает молча', () => {
    const done = buildMalXml({
      entries: [
        entry({ mediaId: 1, malId: 11, english: 'Есть номер' }),
        entry({ mediaId: 2, malId: null, english: 'Без номера' }),
        entry({ mediaId: 3, malId: 0, english: 'Ноль тоже не номер' }),
      ],
    })

    expect(done.exported).toBe(1)
    expect(done.noMalId).toHaveLength(2)
    expect(done.noMalId).toContain('Без номера')
    expect(done.noMalId).toContain('Ноль тоже не номер')
    expect(done.xml).not.toContain('Без номера')
    expect(done.xml).toContain('<user_total_anime>1</user_total_anime>')
  })

  it('записи без закладки считает отдельно', () => {
    const done = buildMalXml({
      entries: [entry({ malId: 1 }), entry({ malId: 2, status: null })],
    })

    expect(done.exported).toBe(1)
    expect(done.noStatus).toBe(1)
    expect(done.noMalId).toHaveLength(0)
  })

  it('закрывающую скобку внутри заметки разрезает на два блока', () => {
    const done = buildMalXml({ entries: [entry({ notes: 'до]]>после' })] })

    expect(done.xml).toContain(
      '<my_comments><![CDATA[до]]]]><![CDATA[>после]]></my_comments>',
    )
  })

  it('пустая заметка остаётся пустым блоком', () => {
    const done = buildMalXml({ entries: [entry({ notes: null })] })
    expect(done.xml).toContain('<my_comments><![CDATA[]]></my_comments>')
  })

  it('кладёт записи по номеру MAL: две выгрузки одного списка совпадают', () => {
    const rows = [entry({ mediaId: 1, malId: 30 }), entry({ mediaId: 2, malId: 4 })]
    const straight = buildMalXml({ entries: rows })
    const flipped = buildMalXml({ entries: [...rows].reverse() })

    expect(straight.xml).toBe(flipped.xml)
    expect(straight.xml.indexOf('<series_animedb_id>4<')).toBeLessThan(
      straight.xml.indexOf('<series_animedb_id>30<'),
    )
  })

  it('на пустом списке даёт целый файл, а не обрывок', () => {
    const done = buildMalXml({ entries: [] })

    expect(done.exported).toBe(0)
    expect(done.xml).toContain('<user_total_anime>0</user_total_anime>')
    expect(done.xml).toContain('</myanimelist>')
    expect(done.xml).not.toContain('<anime>')
  })
})
