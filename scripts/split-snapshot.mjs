// Одноразовый скрипт этапа 3: развести снимок списка и очередь правок.
//
// snapshot.ts делится на три файла:
//   store-chain.ts — общее звено записей в хранилище (было одно на обоих),
//   snapshot.ts    — только снимок списка,
//   edit-queue.ts  — только очередь неотправленных правок.
//
// Куски переносятся дословно: скрипт режет исходный файл по якорям, а не
// пересказывает его своими словами. Перед резкой файл сверяется с хешем
// blob — на другом содержимом скрипт не тронет ничего.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const P = (...lines) => lines.join('\n')

const SNAPSHOT = 'src/shared/core/snapshot.ts'
const QUEUE = 'src/shared/core/edit-queue.ts'
const CHAIN = 'src/shared/core/store-chain.ts'
const EXPECT_BLOB = 'ae7ccf3ae6031c440f5bfe65e1e70dd75bf4c878'

function die(...lines) {
  for (const line of lines) console.log(line)
  console.log('Ничего не записано.')
  process.exit(1)
}

function blobSha(text) {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.from('blob ' + body.length, 'utf8')
  return createHash('sha1')
    .update(Buffer.concat([head, Buffer.from([0]), body]))
    .digest('hex')
}

function subIn(text, name, from, to) {
  const at = text.indexOf(from)
  if (at < 0) die('НЕ НАЙДЕН якорь: ' + name)
  if (text.indexOf(from, at + from.length) >= 0) die('ЯКОРЬ ДВАЖДЫ: ' + name)
  return text.slice(0, at) + to + text.slice(at + from.length)
}

function takeIn(text, name, from, to) {
  const a = text.indexOf(from)
  if (a < 0) die('НЕ НАЙДЕН якорь: ' + name)
  const b = text.indexOf(to, a)
  if (b < 0) die('НЕ НАЙДЕН конец якоря: ' + name)
  return [text.slice(a, b + to.length), text.slice(0, a) + text.slice(b + to.length)]
}

if (!existsSync(SNAPSHOT)) die('НЕ НАЙДЕН ' + SNAPSHOT + ': запускать надо из корня репозитория.')
if (existsSync(QUEUE)) die('УЖЕ ЕСТЬ ' + QUEUE + ': похоже, скрипт уже отработал.')
if (existsSync(CHAIN)) die('УЖЕ ЕСТЬ ' + CHAIN + ': похоже, скрипт уже отработал.')

const orig = readFileSync(SNAPSHOT, 'utf8')
const got = blobSha(orig)
if (got !== EXPECT_BLOB) {
  die(
    'НЕ ТОТ ' + SNAPSHOT + ':',
    '  ожидался blob ' + EXPECT_BLOB,
    '  на диске blob ' + got,
    'Скрипт режет файл по якорям, и на изменённом содержимом врал бы.',
  )
}

// 1. Хвост файла целиком — очередь правок: от isEdit и до конца.
const TAIL_MARK =
  '/** Годна ли запись очереди. Битые правки отправлять нельзя и держать бессмысленно. */'
const cut = orig.indexOf(TAIL_MARK)
if (cut < 0) die('НЕ НАЙДЕН хвост очереди правок.')

let snap = orig.slice(0, cut).trimEnd() + '\n'
let tail = orig.slice(cut)

// 2. Из головы уходят ключ очереди, её потолок и виды правок.
snap = subIn(snap, 'ключ очереди', "const QUEUE_KEY = 'AM_EDIT_QUEUE'\n", '')
snap = subIn(snap, 'заголовок ключей', '/** Ключи хранилища моста.', '/** Ключ хранилища моста.')

const limit = takeIn(
  snap,
  'потолок очереди',
  '/**\n * Потолок очереди правок',
  'const QUEUE_LIMIT = 500\n\n',
)
const limitBlock = limit[0]
snap = limit[1]

const kinds = takeIn(
  snap,
  'виды правок',
  '/**\n * Что именно правили в записи списка.',
  '  attempts: number\n}\n\n',
)
const kindsBlock = kinds[0]
snap = kinds[1]

// 3. Звено записей уходит в свой файл: его зовут обе половины.
snap = subIn(
  snap,
  'звено записей',
  '/** Идущая запись: вторая встаёт в очередь за первой, а не перегоняет её. */\nlet writeChain: Promise<void> = Promise.resolve()\n\n',
  '',
)
snap = subIn(
  snap,
  'звено снимка',
  '  writeChain = writeChain.then(async () => {',
  '  return serialWrite(async () => {',
)
snap = subIn(snap, 'возврат снимка', '  })\n\n  return writeChain\n}', '  })\n}')
snap = subIn(
  snap,
  'импорты снимка',
  "import { Logger } from '../utils/logger'\n",
  "import { Logger } from '../utils/logger'\nimport { serialWrite } from './store-chain'\n",
)
snap = subIn(
  snap,
  'заголовок снимка',
  P(
    '// Снимок данных пользователя и очередь правок: вторая половина слоя хранения.',
    '// Склад ответов сети живёт в db.ts и расходен; здесь то, что потерять нельзя.',
  ),
  P(
    '// Снимок данных пользователя: то из слоя хранения, что потерять нельзя.',
    '// Склад ответов сети живёт в db.ts и расходен, очередь правок — в edit-queue.ts.',
  ),
)

tail = subIn(
  tail,
  'звено очереди',
  '  writeChain = writeChain.then(async () => {',
  '  return serialWrite(async () => {',
)
tail = subIn(tail, 'возврат очереди', '  })\n\n  return writeChain\n}', '  })\n}')

const chainBody = P(
  '// Общее звено записей в хранилище моста: один порядок на всех писателей.',
  '// Выделено из snapshot.ts на этапе 3. Звено было у снимка и очереди правок',
  '// одно, и развести их по разным файлам, не поделив его, значило бы дать',
  '// каждому свою цепочку и потерять порядок записей между собой.',
  '',
  '/**',
  ' * Идущая запись. Вторая встаёт за первой, а не перегоняет её: хранилище',
  ' * моста про транзакции ничего не знает, и две одновременные записи легли бы',
  ' * в том порядке, в каком успели ответить, а не в том, в каком их начали.',
  ' */',
  'let chain: Promise<void> = Promise.resolve()',
  '',
  '/**',
  ' * Ставит запись в общий черёд и отдаёт обещание её окончания.',
  ' *',
  ' * Отказ задачи цепочку не рвёт: следующие записи пойдут своим ходом, иначе',
  ' * одна неудачная запись отменила бы все последующие до перезапуска. Самому',
  ' * вызывающему отказ виден: наружу отдаётся обещание задачи, а не цепочки.',
  ' */',
  'export function serialWrite(task: () => Promise<void>): Promise<void> {',
  '  const done = chain.then(task)',
  '  chain = done.catch(() => {})',
  '  return done',
  '}',
  '',
)

const queueHead = P(
  '// Очередь неотправленных правок списка: данные, которые негде взять заново.',
  '// Снимок списка живёт в snapshot.ts, склад ответов сети — в db.ts.',
  '// Отправкой на сервер занимается edit-sender.ts, здесь хранение и порядок.',
  '',
  "import { Bridge } from '@/bridge'",
  "import { Logger } from '../utils/logger'",
  "import { serialWrite } from './store-chain'",
  '',
  '/** Ключ хранилища моста. Приставка AM_ занята только нашими записями. */',
  "const QUEUE_KEY = 'AM_EDIT_QUEUE'",
  '',
  '',
)

const queueBody = queueHead + limitBlock + kindsBlock + tail

writeFileSync(CHAIN, chainBody)
writeFileSync(QUEUE, queueBody)
writeFileSync(SNAPSHOT, snap)

const rows = (text) => text.split('\n').length - 1
console.log('создан ' + CHAIN + ': строк ' + rows(chainBody))
console.log('создан ' + QUEUE + ': строк ' + rows(queueBody))
console.log('переписан ' + SNAPSHOT + ': строк ' + rows(snap) + ', было ' + rows(orig))

// 4. Импорты у потребителей. Списки имён полные: незнакомое имя — отказ,
// а не догадка, иначе молча уехало бы не туда.
const SNAP_NAMES = new Set([
  'SNAPSHOT_VERSION',
  'emptySnapshot',
  'readSnapshot',
  'ownSnapshot',
  'markSnapshotDirty',
  'saveSnapshotNow',
  'SnapshotEntry',
  'UserSnapshot',
])

const QUEUE_NAMES = new Set([
  'readEditQueue',
  'enqueueEdit',
  'markEditAccepted',
  'clearEditQueue',
  'bumpEditAttempt',
  'EditKind',
  'PendingEdit',
])

const IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+(['"])([^'"]*snapshot)\3/g
const LOOSE_RE = /from\s+(['"])[^'"]*snapshot\1/g

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      walk(path, out)
      continue
    }
    if (name.endsWith('.ts') || name.endsWith('.vue')) out.push(path)
  }
  return out
}

let bad = 0
let fixed = 0

for (const path of walk('src', [])) {
  const text = readFileSync(path, 'utf8')
  const loose = text.match(LOOSE_RE)
  if (!loose) continue

  const seen = text.match(IMPORT_RE)
  if (!seen || seen.length !== loose.length) {
    console.log('НЕ РАЗОБРАН импорт снимка в ' + path + ' — правь руками.')
    bad++
    continue
  }

  let broke = false
  const next = text.replace(IMPORT_RE, (whole, typed, body, quote, spec) => {
    const names = body
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0)

    const snapNames = []
    const queueNames = []

    for (const name of names) {
      const bare = name.replace(/^type\s+/, '')
      if (bare.includes(' ')) {
        console.log('НЕ РАЗОБРАНО имя в ' + path + ': ' + name)
        broke = true
        return whole
      }
      if (SNAP_NAMES.has(bare)) {
        snapNames.push(name)
        continue
      }
      if (QUEUE_NAMES.has(bare)) {
        queueNames.push(name)
        continue
      }
      console.log('НЕЗНАКОМОЕ имя в ' + path + ': ' + bare)
      broke = true
      return whole
    }

    if (queueNames.length === 0) return whole

    const open = typed ? 'import type {' : 'import {'
    const out = []
    if (snapNames.length > 0) {
      out.push(open + ' ' + snapNames.join(', ') + ' } from ' + quote + spec + quote)
    }
    const qSpec = spec.replace(/snapshot$/, 'edit-queue')
    out.push(open + ' ' + queueNames.join(', ') + ' } from ' + quote + qSpec + quote)
    return out.join('\n')
  })

  if (broke) {
    bad++
    continue
  }
  if (next === text) continue

  writeFileSync(path, next)
  fixed++
  console.log('правлены импорты ' + path)
}

// 5. Что теперь врёт в документации. Не правится: якоря нужны точные,
// и выдумывать их вслепую — ровно та ошибка, которую мы уже разбирали.
const docs = ['README.md']
if (existsSync('docs')) {
  for (const name of readdirSync('docs')) if (name.endsWith('.md')) docs.push(join('docs', name))
}

console.log('')
console.log('Где документация говорит про snapshot.ts:')
let hits = 0
for (const file of docs) {
  if (!existsSync(file)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('snapshot.ts')) continue
    hits++
    if (hits <= 80) console.log('  ' + file + ':' + (i + 1) + ': ' + lines[i].trim())
  }
}
if (hits === 0) console.log('  ни одного упоминания.')
if (hits > 80) console.log('  ... и ещё строк: ' + (hits - 80))

console.log('')
if (bad > 0) {
  console.log('Файлы созданы, но импорты разобраны не все: ' + bad + '. Смотри строки выше.')
} else {
  console.log('Готово. Файлов с правлеными импортами: ' + fixed + '.')
  console.log('Дальше: npm run format && npm run typecheck:all.')
}
process.exit(bad > 0 ? 1 : 0)
