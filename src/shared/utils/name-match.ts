// Единый скоринговый матчер имён.
//
// Живёт в utils, а не в api: это чистые функции без сети, нужны и клиенту Shikimori,
// и сканеру дельты.
//
// Шкалу баллов нельзя менять без проверки на живых данных:
//   100 — точное совпадение кандзи      85 — тот же набор токенов ромадзи
//    90 — кандзи как подстрока          80 — совпадение после сжатия долгих гласных
//    55 — почти полное пересечение       30 — общая длинная подстрока (слабо)
//
// Пороги потребителей: 80 — поиск по имени во всём каталоге, 55 — поиск среди
// ролей конкретного тайтла (кандидаты уже ограничены, можно мягче).

export interface NameCandidate {
  name?: string | null
  russian?: string | null
  japanese?: string | null
}

export interface NameTarget {
  full?: string | null
  native?: string | null
}

/** Ромадзи -> нижний регистр без диакритики, апострофов и пунктуации. */
export function amNormRomaji(str: string | null | undefined): string {
  if (!str) return ''
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019\u02bc`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Сжимает долгие гласные: Yuuki = Yuki, Ryou = Ryo, Kaneda = Kaneda. */
export function amCollapseVowels(str: string): string {
  return str
    .replace(/ou/g, 'o')
    .replace(/oo/g, 'o')
    .replace(/uu/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/ee/g, 'e')
    .replace(/ii/g, 'i')
}

/** Нормализованные токены имени. */
export function amTokens(str: string | null | undefined): string[] {
  return amNormRomaji(str).split(' ').filter(Boolean)
}

/** Кандзи и кана: убираем все пробелы — разделители в источниках разные. */
export function amNormNative(str: string | null | undefined): string {
  return (str ?? '').replace(/\s+/g, '').trim()
}

/**
 * Оценивает уверенность совпадения кандидата Shikimori с целью AniList.
 * @returns Балл 0..100 (100 = точный кандзи, 80+ = точный ромадзи).
 */
export function scoreNameMatch(cand: NameCandidate, target: NameTarget): number {
  // Кандзи надёжнее ромадзи: транслитераций много, оригинал один.
  const tNative = amNormNative(target.native)
  const cNative = amNormNative(cand.japanese)
  if (tNative && cNative) {
    if (tNative === cNative) return 100
    if (cNative.includes(tNative) || tNative.includes(cNative)) return 90
  }

  const tTok = amTokens(target.full)
  const cTok = amTokens(cand.name)
  if (tTok.length && cTok.length) {
    // Порядок токенов игнорируем: "Hajime Isayama" = "Isayama Hajime".
    const tSet = [...tTok].sort().join(' ')
    const cSet = [...cTok].sort().join(' ')
    if (tSet === cSet) return 85
    if (amCollapseVowels(tSet) === amCollapseVowels(cSet)) return 80

    // Одно имя может иметь лишний токен (среднее имя, титул) — допускаем ровно один.
    const tS = new Set(tTok.map(amCollapseVowels))
    const cS = new Set(cTok.map(amCollapseVowels))
    const small = tS.size <= cS.size ? tS : cS
    const big = tS.size <= cS.size ? cS : tS
    let all = true
    for (const x of small) {
      if (!big.has(x)) {
        all = false
        break
      }
    }
    if (all && small.size >= 2 && small.size >= big.size - 1) return 55

    // Самый слабый сигнал: ограничение на 5 символов гасит мусор вроде "Ai" в "Aiko".
    const tJoin = amCollapseVowels(tTok.join(''))
    const cJoin = amCollapseVowels(cTok.join(''))
    if (
      tJoin.length >= 5 &&
      cJoin.length >= 5 &&
      (cJoin.includes(tJoin) || tJoin.includes(cJoin))
    ) {
      return 30
    }
  }

  return 0
}
