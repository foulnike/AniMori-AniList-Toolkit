// Проба обхода перед сборкой датасета русских имён (этап 2, шаг 3 в docs/ROADMAP.md).
//
// Отвечает на три вопроса, без которых собирать нечего:
//   1. ПОКРЫТИЕ — скольким тайтлам из манами Шикимори отдаёт русское имя;
//   2. ПРОПУСК — пускает ли Шикимори адреса дата-центра GitHub и на каком темпе;
//   3. ВЕС И ВРЕМЯ — влезает ли полный обход в потолок прогона и сколько весит выпуск.
//
// Зеркала те же, что у клиента (SHIKI_DOMAINS в src/shared/core/constants.ts): сначала
// shikimori.io, следом shikimori.rip. Главный адрес shikimori.one клиент не знает, но
// сборщику ходить теми же дверьми не обязательно: он работает раз в неделю и не
// в браузере, поэтому .one пробуется третьим, когда оба зеркала клиента молчат.
// Двери anime365 только осматриваются: их API отдаёт по одному тайтлу за запрос,
// и обход в тридцать тысяч запросов — отдельный разговор, но знать, пускают ли
// туда вообще, надо уже сейчас.
//
// Проба ничего не выкладывает: пишет probe-result.json и сводку в итог прогона.
// Запуск только руками, из .github/workflows/probe-titles.yml.
//
// Зависимостей нет намеренно: npm ci ради одной пробы — минута на пустом месте,
// а всё нужное есть в Node 20.

import { spawnSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

/** Потолок Шикимори на один запрос. */
const BATCH = 50
/** Зеркала клиента, в том же порядке. */
const MIRRORS = ['shikimori.io', 'shikimori.rip']
/** Главный адрес Шикимори: запасной ход для сборщика, но не для клиента. */
const MAIN = 'shikimori.one'
/** Адреса anime365 (ANIME365_DOMAINS в constants.ts): только осмотр. */
const A365 = ['smotret-anime.online', 'anime365.ru']
/** Форма запроса взята из api/anime365.ts: по одному тайтлу по номеру MAL. */
const A365_PATH = '/api/series?myAnimeListId=1&limit=1&fields=titles'
/** Шикимори требует внятный User-Agent: без него ответом будет отказ. */
const UA = 'AniMori/3.0 (+https://github.com/foulnike/AniMori-AniList-Toolkit)'
/** Адреса складываются из частей, как зеркала в api/shikimori.ts. */
const GITHUB_API = 'https://api.github.com'
const SHIKI_PATH = '/api/animes?ids='
/** Потолок одного запроса: виснувшее соединение не должно съесть весь прогон. */
const TIMEOUT_MS = 15000
/** Откуда берутся номера тайтлов. */
const MANAMI = 'manami-project/anime-offline-database'
/** Имя базы в выпуске. Точное: рядом лежат тёзки по маске. */
const ASSET = 'anime-offline-database-minified.json'
/** Столькими пачками проверяется второе зеркало, когда первое живо. */
const CHECK_BATCHES = 5
/** Пол выборки: в базе манами около 40 тысяч записей. Меньше — скачалось не то. */
const MIN_ENTRIES = 20000
const MIN_MAL = 15000
/** Метки источников в записи манами. Без регэкспов: строк тут сотня тысяч. */
const MAL_MARK = 'myanimelist.net/anime/'
const ANI_MARK = 'anilist.co/anime/'
const CYRILLIC = /[А-Яа-яЁё]/

const SAMPLE = Number(process.env.PROBE_SAMPLE || 3000)
const PAUSE_MS = Number(process.env.PROBE_PAUSE || 700)
const SEED = Number(process.env.PROBE_SEED || 20260822)

/** Итоги осмотра адресов: заполняется до обхода, печатается в конце. */
const doors = []

/**
 * Падаем громко: тихий выход с нулём — это ложный зелёный прогон. Причина едет
 * и в итог прогона, иначе за ней приходится лезть в лог шага.
 */
function fail(message) {
  console.error(`ПРОБА НЕ СОСТОЯЛАСЬ: ${message}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const line = `**Проба не состоялась:** ${message}\n`
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, line, 'utf8')
  }
  process.exit(1)
}

/**
 * Разбор отказа сети. У Node в message всегда одно и то же «fetch failed»,
 * а самое нужное лежит в cause: ENOTFOUND — не разобралось имя, ECONNREFUSED и
 * ETIMEDOUT — адрес закрыт, UND_ERR_CONNECT_TIMEOUT — соединение молча уронили.
 */
function why(e) {
  const cause = e.cause || {}
  return cause.code || cause.message || e.message || String(e)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const round1 = (n) => Math.round(n * 10) / 10
const pct = (n) => `${Math.round(n * 1000) / 10}%`

function bump(counter, key) {
  counter[key] = (counter[key] || 0) + 1
}

/** Генератор с зерном: одно зерно — та же выборка, два прогона сравнимы. */
function seeded(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Выбор без повторов: тасуем копию по Фишеру — Йетсу и берём начало. */
function pickSome(list, count, rand) {
  const copy = [...list]
  const size = Math.min(count, copy.length)
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(rand() * (copy.length - i))
    const swap = copy[i]
    copy[i] = copy[j]
    copy[j] = swap
  }
  return copy.slice(0, size)
}

async function github(path) {
  const headers = { 'user-agent': UA, accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const answer = await fetch(GITHUB_API + path, { headers })
  if (!answer.ok) fail(`GitHub ответил ${answer.status} на ${path}`)
  return answer.json()
}

/**
 * Файл базы в выпуске манами. Берётся по точному имени: под маску «minified»
 * подходят и соседи вроде anidb-minified.json — списки мёртвых записей на
 * десятки килобайт. Разбор такого файла проходит, массива data в нём нет.
 * Несжатый идёт первым: расжатие — лишняя развилка, а качается он быстро.
 */
function pickAsset(assets) {
  for (const ext of ['', '.zst', '.gz']) {
    const hit = assets.find((a) => a.name === ASSET + ext)
    if (hit) return hit
  }
  fail(`в выпуске манами нет ${ASSET}, лежит: ${assets.map((a) => a.name).join(', ')}`)
}

/**
 * Расжатие. zstd на ubuntu-latest стоит из коробки, но гоним через файл:
 * у spawnSync потолок буфера в мегабайт, а база на два порядка больше.
 */
function decompress(name, body) {
  if (name.endsWith('.gz')) return gunzipSync(body)
  if (!name.endsWith('.zst')) return body

  const dir = mkdtempSync(join(tmpdir(), 'manami-'))
  const packed = join(dir, 'base.zst')
  const plain = join(dir, 'base.json')
  writeFileSync(packed, body)
  const run = spawnSync('zstd', ['-d', '-f', '-o', plain, packed], { stdio: 'inherit' })
  if (run.status !== 0) fail(`zstd не расжал базу манами (код ${run.status})`)
  return readFileSync(plain)
}

/**
 * Последний выпуск манами. Именно выпуск, а не raw из ветки: база живёт
 * в релизах, а сырые ссылки на большие файлы отдают что попало.
 */
async function loadManami() {
  const release = await github(`/repos/${MANAMI}/releases/latest`)
  const asset = pickAsset(release.assets || [])
  const sizeMb = round1(asset.size / 1048576)
  console.log(`Манами: выпуск ${release.tag_name}, файл ${asset.name}, ${sizeMb} МБ`)

  const answer = await fetch(asset.browser_download_url, { headers: { 'user-agent': UA } })
  if (!answer.ok) fail(`файл выпуска манами не скачался: HTTP ${answer.status}`)
  const raw = decompress(asset.name, Buffer.from(await answer.arrayBuffer()))

  let base = null
  try {
    base = JSON.parse(raw.toString('utf8'))
  } catch (e) {
    fail(`файл выпуска манами не разобрался как JSON: ${e.message}`)
  }

  const entries = base.data
  if (!Array.isArray(entries)) {
    fail(`в файле ${asset.name} нет массива data, а есть: ${Object.keys(base).join(', ')}`)
  }
  if (entries.length < MIN_ENTRIES) {
    fail(`в базе манами ${entries.length} записей, ждали хотя бы ${MIN_ENTRIES}`)
  }
  return { tag: release.tag_name, asset: asset.name, entries }
}

/** Из записи манами нужны только номера: имена всё равно приедут с Шикимори. */
function collectIds(entries) {
  const mal = []
  let paired = 0

  for (const entry of entries) {
    let m = 0
    let a = 0
    for (const source of entry.sources || []) {
      if (!m) {
        const at = source.indexOf(MAL_MARK)
        if (at >= 0) m = Number(source.slice(at + MAL_MARK.length))
      }
      if (!a) {
        const at = source.indexOf(ANI_MARK)
        if (at >= 0) a = Number(source.slice(at + ANI_MARK.length))
      }
    }
    if (Number.isFinite(m) && m > 0) {
      mal.push(m)
      if (Number.isFinite(a) && a > 0) paired++
    }
  }

  return { mal, paired }
}

/**
 * Осмотр одной двери до обхода: разрешается ли имя и что отвечает адрес.
 * Без этого в логе одинаковое «fetch failed» и на мёртвом имени, и на закрытом порту.
 */
async function diagnose(domain, path) {
  let ips = ''
  try {
    const found = await lookup(domain, { all: true })
    ips = found.map((a) => a.address).join(', ')
  } catch (e) {
    doors.push({ domain, ips: `имя не разобралось: ${why(e)}`, answer: 'не спрашивали' })
    console.log(`${domain}: имя не разобралось — ${why(e)}`)
    return
  }

  const started = Date.now()
  let answer = ''
  try {
    const res = await fetch('https://' + domain + path, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    answer = `HTTP ${res.status} за ${Date.now() - started} мс`
  } catch (e) {
    answer = `${why(e)} за ${Date.now() - started} мс`
  }

  doors.push({ domain, ips, answer })
  console.log(`${domain}: ${ips} — ${answer}`)
}

/**
 * Одна пачка к зеркалу. Куки не шлём — клиент их тоже не шлёт: с ними заголовок
 * разрастался и Шикимори отвечал 400.
 */
async function ask(domain, batch) {
  const url = 'https://' + domain + SHIKI_PATH + batch.join(',') + '&limit=' + BATCH
  const started = Date.now()

  try {
    const answer = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const took = Date.now() - started

    if (answer.status !== 200) {
      const retryAfter = Number(answer.headers.get('retry-after') || 0)
      return { status: answer.status, took, retryAfter }
    }

    const items = await answer.json()
    if (!Array.isArray(items)) return { status: 'ответ не массив', took }
    return { status: 200, took, items }
  } catch (e) {
    return { status: `сеть: ${why(e)}`, took: Date.now() - started }
  }
}

async function probeMirror(domain, sample) {
  const stat = {
    domain,
    requests: 0,
    ok: 0,
    codes: {},
    asked: 0,
    answered: 0,
    withRussian: 0,
    withCyrillic: 0,
    tookMs: 0,
  }
  const rows = []
  const startedAll = Date.now()

  for (let at = 0; at < sample.length; at += BATCH) {
    const batch = sample.slice(at, at + BATCH)
    let answer = await ask(domain, batch)

    // Один повтор на 429: сборщику этот отказ переживать всё равно придётся,
    // и важно знать, отпускает ли лимит вообще.
    if (answer.status === 429) {
      const wait = Math.max(answer.retryAfter * 1000, 5000)
      console.log(`${domain}: 429, ждём ${wait} мс и повторяем ту же пачку`)
      stat.requests++
      bump(stat.codes, 429)
      await sleep(wait)
      answer = await ask(domain, batch)
    }

    stat.requests++
    stat.asked += batch.length
    bump(stat.codes, answer.status)

    if (answer.status === 200) {
      stat.ok++
      for (const item of answer.items) {
        const russian = (item.russian || '').trim()
        stat.answered++
        if (russian) stat.withRussian++
        if (CYRILLIC.test(russian)) stat.withCyrillic++
        // Ровно шесть полей — состав будущего выпуска (docs/DATA-PIPELINE.md).
        rows.push({
          id: item.id,
          name: item.name,
          russian,
          kind: item.kind,
          aired_on: item.aired_on,
          score: item.score,
        })
      }
    } else {
      console.log(`${domain}: пачка ${1 + at / BATCH} — ${answer.status}`)
    }

    await sleep(PAUSE_MS)
  }

  stat.tookMs = Date.now() - startedAll
  return { stat, rows }
}

/**
 * Вес выпуска по факту: сжимаем то, что реально приехало, и умножаем на базу.
 * Пары для карты подделаны из номера MAL дважды — важен порядок величины
 * сжатого числа, а не сами значения.
 */
function weigh(rows, totalTitles, paired) {
  if (rows.length === 0) return null
  const titlesGz = gzipSync(Buffer.from(JSON.stringify(rows), 'utf8')).length
  const pairs = rows.map((row) => [row.id, row.id])
  const mapGz = gzipSync(Buffer.from(JSON.stringify(pairs), 'utf8')).length
  return {
    perTitleBytes: round1(titlesGz / rows.length),
    titlesMb: round1((titlesGz / rows.length / 1048576) * totalTitles),
    mapMb: round1((mapGz / rows.length / 1048576) * paired),
  }
}

function codesText(stat) {
  const parts = Object.entries(stat.codes).map(([code, count]) => `${code} × ${count}`)
  return parts.join(', ') || 'ни одного ответа'
}

/** Печатает и в лог, и в итог прогона: за числами не надо лезть в артефакт. */
function report(lines) {
  const text = lines.join('\n')
  console.log(`\n${text}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`, 'utf8')
  }
}

async function main() {
  console.log(`Проба: выборка ${SAMPLE} номеров, пауза ${PAUSE_MS} мс, зерно ${SEED}`)

  // Сначала осмотр всех дверей: одно разрешение имени и один запрос на адрес.
  // Дешёво и сразу видно, куда дата-центр пускают, а куда нет.
  for (const domain of [...MIRRORS, MAIN]) await diagnose(domain, SHIKI_PATH + '1&limit=1')
  for (const domain of A365) await diagnose(domain, A365_PATH)

  const manami = await loadManami()
  const { mal, paired } = collectIds(manami.entries)
  if (mal.length < MIN_MAL) {
    fail(`номеров MyAnimeList всего ${mal.length}, ждали хотя бы ${MIN_MAL}`)
  }
  console.log(
    `Манами: записей ${manami.entries.length}, с номером MAL ${mal.length}, ` +
      `с парой MAL+AniList ${paired}`,
  )

  const sample = pickSome(mal, SAMPLE, seeded(SEED))
  const first = await probeMirror(MIRRORS[0], sample)

  // Второе зеркало нужно в двух случаях: подтвердить, что оно живо,
  // или заменить первое, если то не пустило.
  const firstPassed = first.stat.ok > 0
  const short = sample.slice(0, CHECK_BATCHES * BATCH)
  const second = await probeMirror(MIRRORS[1], firstPassed ? short : sample)

  // Оба зеркала клиента молчат — пробуем главный адрес.
  const attempts = [first, second]
  if (!firstPassed && second.stat.ok === 0) attempts.push(await probeMirror(MAIN, sample))
  const lead = attempts.find((a) => a.stat.ok > 0) || first

  const coverage = lead.stat.answered ? lead.stat.withCyrillic / lead.stat.answered : 0
  const known = lead.stat.asked ? lead.stat.answered / lead.stat.asked : 0
  const perRequest = lead.stat.requests ? lead.stat.tookMs / lead.stat.requests : 0
  const fullRequests = Math.ceil(mal.length / BATCH)
  const fullMinutes = round1((fullRequests * perRequest) / 60000)
  const weight = weigh(lead.rows, mal.length, paired)

  const verdict = []
  if (lead.stat.ok === 0) {
    verdict.push('Ни один адрес Шикимори не пустил дата-центр: шаг 3 закрыт.')
  } else if (lead !== first) {
    verdict.push(`Отвечает только ${lead.stat.domain} — собирать через него.`)
  } else if (lead.stat.codes[429]) {
    verdict.push(`Лимит сработал ${lead.stat.codes[429]} раз на паузе ${PAUSE_MS} мс: пауза мала.`)
  } else {
    verdict.push(`Обход проходит: ${lead.stat.requests} запросов подряд без единого отказа.`)
  }
  if (lead.stat.ok > 0 && coverage < 0.5) {
    verdict.push(`Кириллица лишь у ${pct(coverage)} ответов: датасет закроет меньше половины.`)
  }
  if (lead.stat.ok > 0 && fullMinutes > 300) {
    verdict.push(`Полный обход занял бы ${fullMinutes} мин — это впритык к потолку в 6 ч.`)
  }

  const weightRows = weight
    ? [`| Вес выпуска | имена ~${weight.titlesMb} МБ, карта ~${weight.mapMb} МБ (gzip) |`]
    : []

  report([
    `## Проба обхода: ${lead.stat.domain}`,
    '',
    '| Дверь | Адреса | Ответ |',
    '| --- | --- | --- |',
    ...doors.map((d) => `| ${d.domain} | ${d.ips} | ${d.answer} |`),
    '',
    '| Что | Сколько |',
    '| --- | --- |',
    `| Спрошено номеров | ${lead.stat.asked} |`,
    `| Шикимори знает | ${lead.stat.answered} (${pct(known)}) |`,
    `| Русское имя есть | ${lead.stat.withRussian} |`,
    `| Из них кириллицей | ${lead.stat.withCyrillic} (${pct(coverage)} от ответов) |`,
    `| Запросов | ${lead.stat.requests}, ответы: ${codesText(lead.stat)} |`,
    `| Время | ${round1(lead.stat.tookMs / 1000)} с, по ${Math.round(perRequest)} мс на запрос |`,
    `| Полный обход | ${fullRequests} запросов ≈ ${fullMinutes} мин |`,
    ...weightRows,
    ...attempts
      .filter((a) => a !== lead)
      .map((a) => `| Ещё пробовали | ${a.stat.domain}: ${codesText(a.stat)} |`),
    '',
    ...verdict.map((line) => `**${line}**`),
  ])

  writeFileSync(
    'probe-result.json',
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        settings: { sample: SAMPLE, pauseMs: PAUSE_MS, seed: SEED, batch: BATCH },
        doors,
        manami: {
          tag: manami.tag,
          asset: manami.asset,
          entries: manami.entries.length,
          malIds: mal.length,
          withAnilist: paired,
        },
        mirrors: attempts.map((a) => a.stat),
        lead: lead.stat.domain,
        coverage,
        known,
        projection: { requests: fullRequests, minutes: fullMinutes, weight },
        verdict,
        examples: lead.rows.slice(0, 20),
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log('Подробности: probe-result.json')
}

await main()
