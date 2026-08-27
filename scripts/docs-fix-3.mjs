// Одноразовый патч, часть 3: два огреха, оставленных частью 1, и два
// мёртвых комментария в мосте. Запускать из корня ветки app-3.0-dev:
//   node scripts/docs-fix-3.mjs
//   npm run format && npm run typecheck:all
//
// В коде правятся только комментарии. Поведение не меняется ни на строку.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Многострочный якорь: строки задаются по одной, чтобы не экранировать переводы. */
const P = (...lines) => lines.join('\n')

const swap = (name, find, to) => ({ name, find, to })

const files = [
  {
    file: 'docs/ARCHITECTURE-SHELL.md',
    edits: [
      swap(
        'перенос строк в составе профиля',
        P(
          '. В нём файл настроек `animori-settings.json` — там же лежит',
          'и пропуск AniList, ключи `auth_token` и `auth_expires_at`. Рядом дубль',
        ),
        P(
          '.',
          'В нём файл настроек `animori-settings.json` — там же лежит и пропуск',
          'AniList, ключи `auth_token` и `auth_expires_at`. Рядом дубль',
        ),
      ),
      swap(
        'перенос строк в имени каталога',
        P(
          'Имя каталога — это `identifier` из конфига,',
          'поэтому его смена равносильна потере настроек у всех установленных копий.',
        ),
        P(
          'Имя каталога — это `identifier` из конфига, поэтому его смена равносильна',
          'потере настроек у всех установленных копий.',
        ),
      ),
    ],
  },
  {
    file: 'docs/ARCHITECTURE.md',
    edits: [
      swap(
        'обрезанная строка про правила перевода',
        P(
          '- Правила переводчика для глав и томов: `rxAct`, `rxLabel` и `rxUnit`',
          '- Тип `MediaType` и раздел манги в поиске персон. Второе снимать нельзя',
        ),
        P(
          '- Правила переводчика для глав и томов: `rxAct`, `rxLabel` и `rxUnit`',
          '  в `core/constants.ts`.',
          '- Тип `MediaType` и раздел манги в поиске персон. Второе снимать нельзя',
        ),
      ),
      swap(
        'строка датасета в таблице зависимостей',
        '| `objects.githubusercontent` | датасет названий, этап 2 | зеркалом |',
        '| `objects.githubusercontent` | датасет русских названий | сетью, медленнее |',
      ),
    ],
  },
  {
    file: 'src/shared/bridge/TauriBridge.ts',
    edits: [
      swap(
        'чужой сайт в openExternal',
        '    // Проверка схемы на стороне Rust: этот код исполняется в контексте чужого сайта.',
        '    // Проверка схемы на стороне Rust: разметка вправе позвать это с любым адресом.',
      ),
      swap(
        'маршрутизатор AniList в back',
        '    // Через историю WebView: маршрутизатор AniList ждёт popstate.',
        '    // Через историю WebView: шаг по истории окна, а не по своему стеку экранов.',
      ),
    ],
  },
]

if (!existsSync('docs/CONVENTIONS.md')) {
  console.error('Запускать из корня репозитория: docs/CONVENTIONS.md не найден.')
  process.exit(1)
}

let bad = 0

for (const item of files) {
  if (!existsSync(item.file)) {
    console.error(`НЕТ ФАЙЛА ${item.file}`)
    bad++
    continue
  }

  let text = readFileSync(item.file, 'utf8')
  const errors = []

  for (const edit of item.edits) {
    const at = text.indexOf(edit.find)
    if (at < 0) {
      errors.push(`    ${edit.name}: якорь не найден`)
      continue
    }
    if (text.indexOf(edit.find, at + 1) >= 0) {
      errors.push(`    ${edit.name}: якорь встречается дважды`)
      continue
    }
    text = text.slice(0, at) + edit.to + text.slice(at + edit.find.length)
  }

  if (errors.length > 0) {
    console.error(`НЕ ТРОНУТ ${item.file}`)
    errors.forEach((e) => console.error(e))
    bad += errors.length
    continue
  }

  writeFileSync(item.file, text, 'utf8')
  console.log(`готово ${item.file}: правок ${item.edits.length}`)
}

console.log(
  bad > 0
    ? `\nНеприменённых правок: ${bad}. Файлы с ошибками не изменены.`
    : '\nВсе правки применены. Дальше: npm run format && npm run typecheck:all.',
)

process.exit(bad > 0 ? 1 : 0)
