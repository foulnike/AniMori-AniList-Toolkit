// Одноразовый патч документации после разделения snapshot.ts.
// Каждая правка — дословный якорь из файла. Якорь не найден или найден
// дважды — файл не пишется вовсе, чтобы не угадывать место.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const P = (...lines) => lines.join('\n')

let bad = 0

function apply(file, edits) {
  if (!existsSync(file)) {
    console.log(`НЕ НАЙДЕН ${file}`)
    bad++
    return
  }

  const before = readFileSync(file, 'utf8')
  let text = before
  let done = 0

  for (const [name, from, to] of edits) {
    const at = text.indexOf(from)
    if (at === -1) {
      console.log(`НЕ ТРОНУТ ${file}: якорь не найден — ${name}`)
      bad++
      return
    }
    if (text.indexOf(from, at + from.length) !== -1) {
      console.log(`НЕ ТРОНУТ ${file}: якорь встречается дважды — ${name}`)
      bad++
      return
    }
    text = text.slice(0, at) + to + text.slice(at + from.length)
    done++
  }

  writeFileSync(file, text)
  console.log(`готово ${file}: правок ${done}`)
}

function scan(title, needles) {
  const files = [
    'README.md',
    'CHANGELOG.md',
    'package.json',
    'docs/ARCHITECTURE.md',
    'docs/ARCHITECTURE-SHELL.md',
    'docs/ARCHITECTURE-UI.md',
    'docs/ARCHITECTURE-VIDEO.md',
    'docs/CONVENTIONS.md',
    'docs/DATA-PIPELINE.md',
    'docs/DECISIONS.md',
    'docs/README.md',
    'docs/REPO-LAYOUT.md',
    'docs/ROADMAP.md',
    'docs/STORAGE-AND-SYNC.md',
  ]

  console.log('')
  console.log(title)
  let found = 0

  for (const file of files) {
    if (!existsSync(file)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (needles.some((n) => line.includes(n))) {
        console.log(`${file}:${i + 1}: ${line.trim()}`)
        found++
      }
    })
  }

  if (found === 0) console.log('  нет ни одной строки')
}

apply('docs/ARCHITECTURE.md', [
  [
    'схема слоя данных: путь правки',
    '  ├─ edit-sender.ts      queueEdit → collection.ts → snapshot.ts',
    '  ├─ edit-sender.ts      queueEdit → collection.ts → edit-queue.ts',
  ],
  [
    'схема слоя данных: подвал',
    P('collection.ts  ← api/anilist-list.ts', 'edit-sender.ts → api/anilist-edit.ts'),
    P(
      'collection.ts  ← api/anilist-list.ts;  → snapshot.ts, edit-queue.ts',
      'edit-sender.ts → api/anilist-edit.ts;  → edit-queue.ts',
      'snapshot.ts, edit-queue.ts → store-chain.ts   общее звено записей',
    ),
  ],
  [
    'снимок и очередь: три файла',
    P(
      'Подробно — в `STORAGE-AND-SYNC.md`. Коротко: две записи в хранилище моста,',
      '`AM_SNAPSHOT` и `AM_EDIT_QUEUE`, плюс второй экземпляр снимка в файле.',
    ),
    P(
      'Подробно — в `STORAGE-AND-SYNC.md`. Коротко: две записи в хранилище моста,',
      '`AM_SNAPSHOT` и `AM_EDIT_QUEUE`, плюс второй экземпляр снимка в файле.',
      '',
      'Код разведён по трём файлам: снимок — `core/snapshot.ts`, очередь —',
      '`core/edit-queue.ts`, общее звено записей — `core/store-chain.ts`. Звено',
      'общее не по недосмотру: у снимка и очереди один черёд на двоих, иначе две',
      'одновременные записи легли бы в том порядке, в каком хранилище успело',
      'ответить. Отказ одной записи черёд не рвёт, но виден вызывающему.',
    ),
  ],
])

apply('docs/CONVENTIONS.md', [
  [
    'вступление к таблице размеров',
    'За потолком по-прежнему один файл, но снимок подошёл к нему вплотную:',
    'За потолком по-прежнему один файл, а снимок из этого списка ушёл — разрезан:',
  ],
  [
    'строка снимка в таблице',
    P(
      '| `src-tauri/src/auth.rs`       | 26 482 | за потолком                        |',
      '| `shared/core/snapshot.ts`     | 25 011 | у потолка, режется первым шагом этапа 3 |',
    ),
    '| `src-tauri/src/auth.rs`       | 26 482 | за потолком                        |',
  ],
  [
    'размер db.ts',
    '| `shared/core/db.ts`           | 22 556 | под наблюдением                    |',
    '| `shared/core/db.ts`           | 22 643 | под наблюдением                    |',
  ],
  [
    'граница разреза снимка',
    P(
      'Резать `snapshot.ts` есть по какой границе: снимок и очередь правок —',
      'две разные предметные области в одном файле.',
    ),
    P(
      '`snapshot.ts` разрезан по этой границе: снимок остался в `snapshot.ts`',
      '(18 301), очередь правок уехала в `edit-queue.ts` (7 105), общее звено',
      'записей — в `store-chain.ts` (1 627). Границу задал предмет, а не размер:',
      'размер был поводом взяться, а делить пришлось по областям.',
    ),
  ],
  [
    'размеры документов без байтов',
    P(
      'Под исключение сейчас попадают четыре документа:',
      '',
      '| Документ           | Размер |',
      '| ------------------ | -----: |',
      '| `DECISIONS.md`     | 44 156 |',
      '| `DATA-PIPELINE.md` | 32 302 |',
      '| `ARCHITECTURE.md`  | 29 622 |',
      '| `ROADMAP.md`       | 26 143 |',
      '',
      'Остальные заметно меньше: `STORAGE-AND-SYNC.md` (18 289),',
      '`ARCHITECTURE-UI.md` (17 531), `ARCHITECTURE-SHELL.md` (13 509),',
      '`ARCHITECTURE-VIDEO.md` (11 398), `REPO-LAYOUT.md` (8 066).',
    ),
    P(
      'Под исключение сейчас попадают четыре документа, от большего к меньшему:',
      '`DECISIONS.md`, `DATA-PIPELINE.md`, `ARCHITECTURE.md`, `ROADMAP.md`.',
      'Остальные заметно меньше.',
      '',
      'Байтов здесь нарочно нет. На размере документа не стоит ни одно решение —',
      'потолок на документацию не распространяется, — а числа эти стареют от любой',
      'правки соседнего абзаца: к моменту разреза снимка врали пять строк из девяти.',
      'Размер, когда он зачем-то нужен, смотрится в самом репозитории.',
    ),
  ],
])

apply('docs/ROADMAP.md', [
  [
    'этап 1.2: снимок разрезан',
    P(
      'Зато подобрался свой: `snapshot.ts` вырос до 25 011. Формально это ещё',
      'не нарушение, но границу записи через API он уже перешёл — значит правится',
      'только локально либо режется. Резать там есть что: снимок и очередь правок —',
      'две разные предметные области в одном файле, и разделение всё равно нужно',
      'первым шагом этапа 3.',
    ),
    P(
      'Свой нарушитель тоже подбирался — `snapshot.ts` дорос до 25 011 — и снят:',
      'файл разрезан по границе «снимок против очереди правок». Снимок остался',
      'в `snapshot.ts` (18 301), очередь правок уехала в `edit-queue.ts` (7 105),',
      'общее звено записей — в `store-chain.ts` (1 627).',
    ),
  ],
  [
    'этап 3: долг размера снят',
    P(
      'Первый шаг заодно снимает долг размера: разрезать `snapshot.ts` придётся',
      'именно по границе «снимок против очереди правок».',
    ),
    P(
      'Долг размера снят до начала этапа: `snapshot.ts` разрезан по границе',
      '«снимок против очереди правок», очередь живёт в `edit-queue.ts`, общее звено',
      'записей — в `store-chain.ts`. Первый шаг делается теперь в `edit-queue.ts`',
      'и `edit-sender.ts`.',
    ),
  ],
])

apply('docs/STORAGE-AND-SYNC.md', [
  [
    'цепь записей',
    'Записи выстраиваются в цепь: вторая ждёт первую, а не перегоняет её.',
    P(
      'Записи выстраиваются в цепь: вторая ждёт первую, а не перегоняет её. Цепь',
      'общая с очередью правок и живёт в `core/store-chain.ts`: черёд у них один',
      'на двоих, иначе снимок и очередь легли бы в том порядке, в каком хранилище',
      'успело ответить. Отказ одной записи цепь не рвёт.',
    ),
  ],
  [
    'очередь живёт своим файлом',
    P(
      'не задерживает. Сама очередь как хранилище лежит в `snapshot.ts` рядом',
      'со снимком: оттуда её придётся вырезать, потому что файл вышел за потолок',
      'исходника.',
    ),
    P(
      'не задерживает. Сама очередь как хранилище живёт в `core/edit-queue.ts`',
      'отдельным файлом от снимка: общее у них только звено записей',
      'в `core/store-chain.ts`.',
    ),
  ],
  [
    'где лежит markEditAccepted',
    P(
      'Обе развязки — успешная доставка и отказ после исчерпания попыток — ведут',
      'в одну и ту же функцию `markEditAccepted`. Хранилище не может отличить',
      '«сервис подтвердил» от «мы сдались».',
    ),
    P(
      'Обе развязки — успешная доставка и отказ после исчерпания попыток — ведут',
      'в одну и ту же функцию `markEditAccepted` в `core/edit-queue.ts`. Хранилище',
      'не может отличить «сервис подтвердил» от «мы сдались».',
    ),
  ],
  [
    'порядок работ: где делить',
    '1. Разделить доставленную правку и брошенную в `edit-sender.ts`.',
    '1. Разделить доставленную правку и брошенную: `edit-queue.ts` и `edit-sender.ts`.',
  ],
])

scan('Где документация говорит про снимок, очередь и звено записей:', [
  'snapshot.ts',
  'edit-queue.ts',
  'store-chain.ts',
])

scan('Где хоть что-то говорит про probe-titles:', ['probe-titles'])

console.log('')
if (bad > 0) {
  console.log(`Часть правок не применена: ${bad}.`)
} else {
  console.log('Все правки применены. Дальше: git diff и коммит.')
}
process.exit(bad > 0 ? 1 : 0)
