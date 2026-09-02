// Сохранение текстового файла на диск через средства самого окна.
//
// Место — app/, а не shared/core/: здесь Blob, URL и <a download>, то есть DOM,
// а ядро обязано оставаться независимым от площадки.
//
// Мост и разрешения Tauri сюда не втянуты сознательно. Запись через files.rs
// умеет только три разрешённых имени в служебном каталоге, куда человеку
// не добраться, а выбор каталога потребовал бы новой команды в Rust
// и разрешения на диалог. Для выгрузки списка хватает загрузки окна.

import { Logger } from '@/utils/logger'

/**
 * Сколько держать временный адрес живым. Мгновенный отзыв обрывает загрузку
 * на полпути: механизм окна читает поток уже после нажатия, а не во время.
 */
const KEEP_MS = 20000

/**
 * Отдаёт текст человеку файлом. Куда именно он ляжет — дело окна:
 * в браузере и в WebView2 это папка загрузок или спрос места.
 *
 * Кодировка названа явно: без неё часть импортёров читает русские заметки
 * в однобайтной кодировке и портит их вопросительными знаками.
 *
 * @returns Удалось ли вообще начать сохранение. Отказ механизма окна после
 * нажатия отсюда не виден, и обещать больше было бы нечестно.
 */
export function saveTextFile(
  name: string,
  text: string,
  mime = 'application/xml',
): boolean {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` })
    const href = URL.createObjectURL(blob)

    const link = document.createElement('a')
    link.href = href
    link.download = name
    link.rel = 'noopener'
    link.style.display = 'none'

    // Ссылка вставляется в документ, а не жмётся воздухе: часть движков
    // игнорирует нажатие на узле вне дерева.
    document.body.append(link)
    link.click()
    link.remove()

    window.setTimeout(() => URL.revokeObjectURL(href), KEEP_MS)

    Logger('DB', `Выгрузка отдана окну: ${name}, байт ${blob.size}`)
    return true
  } catch (e) {
    Logger('WARN', `Выгрузку не начать: ${String(e)}`)
    return false
  }
}
