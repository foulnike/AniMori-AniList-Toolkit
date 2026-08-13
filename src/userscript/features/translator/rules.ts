// Правила перевода интерфейса AniList: чистые функции, без DOM, сети и кэша.
// null означает «перевода нет, оставляем оригинал».
// Порядок проверок менять нельзя: правила пересекаются, решает первое совпадение.

import {
  days,
  monthsFull,
  rxAct,
  rxAgo,
  rxAiringEp,
  rxAiringOnly,
  rxBday,
  rxDateFull,
  rxDayDate,
  rxHeight,
  rxLabel,
  rxLiked,
  rxListAdded,
  rxListUpdated,
  rxRanking,
  rxRecent,
  rxReviewBy,
  rxRole,
  rxRoleED,
  rxRoleEps,
  rxRoleOP,
  rxSeason,
  rxTimeComplex,
  rxUnit,
  seasons,
} from '@/core/constants'
import { dictionary } from '@/core/dictionary'
import { settings } from '@/core/settings'
import { getPlural } from '@/utils/dom'

/** Одна, две, много: 'минуту' / 'минуты' / 'минут'. */
type PluralForms = readonly [string, string, string]

/** Единицы времени для «через N …» и «N … назад». */
const TIME_FORMS: Record<string, PluralForms | undefined> = {
  second: ['секунду', 'секунды', 'секунд'],
  minute: ['минуту', 'минуты', 'минут'],
  min: ['минуту', 'минуты', 'минут'],
  hour: ['час', 'часа', 'часов'],
  day: ['день', 'дня', 'дней'],
  week: ['неделю', 'недели', 'недель'],
  month: ['месяц', 'месяца', 'месяцев'],
  year: ['год', 'года', 'лет'],
}

/** Счётные единицы интерфейса: «12 серий», «3 тома», «5 ответов». */
const UNIT_FORMS: Record<string, PluralForms | undefined> = {
  day: ['день', 'дня', 'дней'],
  hour: ['час', 'часа', 'часов'],
  hr: ['час', 'часа', 'часов'],
  minute: ['минуту', 'минуты', 'минут'],
  min: ['минуту', 'минуты', 'минут'],
  mins: ['минуту', 'минуты', 'минут'],
  sec: ['секунду', 'секунды', 'секунд'],
  episode: ['серия', 'серии', 'серий'],
  chapter: ['глава', 'главы', 'глав'],
  volume: ['том', 'тома', 'томов'],
  reply: ['ответ', 'ответа', 'ответов'],
  user: ['пользователь', 'пользователя', 'пользователей'],
}

/** Подписи полей в карточках тайтлов, персонажей и статистики. */
const LABELS: Record<string, string | undefined> = {
  Format: 'Формат',
  Status: 'Статус',
  Country: 'Страна',
  Chapters: 'Главы',
  Score: 'Оценка',
  Count: 'Количество',
  'Hours Watched': 'Часов просмотрено',
  'Mean Score': 'Средний балл',
  'Chapters Read': 'Глав прочитано',
  Episodes: 'Серии',
  Released: 'Выпущено',
  Started: 'Начато',
  Amount: 'Всего',
  Progress: 'Прогресс',
  'Finish Date': 'Дата завершения',
  Birthday: 'День рождения',
  Height: 'Рост',
  Age: 'Возраст',
  Gender: 'Пол',
  'Blood Type': 'Группа крови',
  'Blood type': 'Группа крови',
  Occupation: 'Род занятий',
  Affiliation: 'Принадлежность',
  Grade: 'Ранг',
}

/** Названия списков в ленте активности. */
const LIST_NAMES: Record<string, string | undefined> = {
  completed: 'Просмотрено',
  watching: 'Смотрю',
  reading: 'Читаю',
  planning: 'В планах',
  dropped: 'Брошено',
  paused: 'Отложено',
}

/** Сезон в родительном падеже: «за сезон зимы 2024 года». */
const SEASON_OF: Record<string, string | undefined> = {
  winter: 'зимы',
  spring: 'весны',
  summer: 'лета',
  fall: 'осени',
}

/** Действие в ленте: [одна серия, несколько серий]. */
const ACT_FORMS: Record<string, readonly [string, string] | undefined> = {
  watched: ['Просмотрена', 'Просмотрены'],
  rewatched: ['Пересмотрена', 'Пересмотрены'],
  read: ['Прочитана', 'Прочитаны'],
  reread: ['Перечитана', 'Перечитаны'],
}

/** Объект действия: [одна, несколько]. */
const ITEM_FORMS: Record<string, readonly [string, string] | undefined> = {
  episode: ['серия', 'серии'],
  chapter: ['глава', 'главы'],
}

/**
 * Достаёт перевод из словаря.
 * hasOwnProperty: ключ вроде "constructor" не должен дать служебное свойство.
 */
function fromDictionary(key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(dictionary, key)) return null
  return dictionary[key] ?? null
}

/**
 * Ключ к виду "Jan" / "Mon" / "Winter": регэкспы регистронезависимы, таблицы — нет.
 * Без этого в интерфейс уезжает "undefined".
 */
function titleCaseKey(raw: string): string {
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
}

function monthName(raw: string): string {
  return monthsFull[titleCaseKey(raw)] ?? raw
}

function dayName(raw: string): string {
  return days[titleCaseKey(raw)] ?? raw
}

function seasonName(raw: string): string {
  return seasons[titleCaseKey(raw)] ?? raw
}

/**
 * Переводит одну строку интерфейса AniList.
 * @returns Перевод или null, если ни одно правило не подошло.
 */
export function translateAdvanced(text: string | null | undefined): string | null {
  if (!settings.translateInterface) return null
  if (!text) return null

  const cleanText = text.replace(/\s+/g, ' ').trim()
  if (cleanText.length < 2) return null
  // Чистые числа и пунктуацию переводить нечего (и опасно: сломаем оценки/даты).
  if (/^[\d\s.,\-:[\]()]+$/.test(cleanText)) return null

  const exact = fromDictionary(cleanText)
  if (exact !== null) return exact

  // Составные подписи вида "TV · Airing · 24 eps" переводим по частям.
  if (cleanText.includes(' · ')) {
    return cleanText
      .split(' · ')
      .map((part) => {
        const p = part.trim()
        return fromDictionary(p) ?? translateAdvanced(p) ?? p
      })
      .join(' · ')
  }

  let m: RegExpMatchArray | null

  // "Director (eps 1-12)" -> "Режиссёр (сер. 1-12)"
  if ((m = cleanText.match(rxRole)) && m[1] && m[2]) {
    const role = m[1].trim()
    const episodes = m[2]
      .trim()
      .replace(rxRoleEps, 'сер.')
      .replace(rxRoleOP, 'OP')
      .replace(rxRoleED, 'ED')
    return `${fromDictionary(role) ?? role} (${episodes})`
  }

  // "#12 Highest Rated Fall 2023" -> "#12 в рейтинге за сезон осени 2023 года"
  if ((m = cleanText.match(rxRanking)) && m[1] && m[2] && m[3]) {
    const kind = m[2].toLowerCase() === 'highest rated' ? 'в рейтинге' : 'популярности'
    let time = m[3].toLowerCase()
    if (time === 'all time') {
      time = 'за всё время'
    } else {
      const season = time.match(/^(winter|spring|summer|fall)\s+(\d{4})$/)
      if (season && season[1] && season[2]) {
        time = `за сезон ${SEASON_OF[season[1]] ?? season[1]} ${season[2]} года`
      } else if (/^\d{4}$/.test(time)) {
        time = `за ${time} год`
      }
    }
    return `#${m[1]} ${kind} ${time}`
  }

  // "Ep 5 airing in 2 days" -> "5 серия выйдет через 2 дня"
  if ((m = cleanText.match(rxAiringEp)) && m[1] && m[2] && m[3]) {
    const forms = TIME_FORMS[m[3].toLowerCase()]
    if (forms) {
      return `${m[1]} серия выйдет через ${m[2]} ${getPlural(parseInt(m[2]), forms)}`
    }
  }

  // "Airing in 3 hours" -> "Выйдет через 3 часа"
  if ((m = cleanText.match(rxAiringOnly)) && m[1] && m[2]) {
    const forms = TIME_FORMS[m[2].toLowerCase()]
    if (forms) {
      return `Выйдет через ${m[1]} ${getPlural(parseInt(m[1]), forms)}`
    }
  }

  // "2 days, 4 hours" -> рекурсия по половинкам
  if ((m = cleanText.match(rxTimeComplex)) && m[1] && m[2]) {
    const p1 = translateAdvanced(m[1])
    const p2 = translateAdvanced(m[2])
    if (p1 && p2) return `${p1} ${p2}`
  }

  if ((m = cleanText.match(rxHeight)) && m[1]) {
    return `${m[1].trim()} см${m[2] ? ` (${m[2]})` : ''}`
  }

  if ((m = cleanText.match(rxLiked)) && m[1] && m[2]) {
    return `${m[1]} из ${m[2]} оценили этот отзыв`
  }

  if ((m = cleanText.match(rxDateFull)) && m[1] && m[2] && m[3]) {
    return `${m[2]} ${monthName(m[1])} ${m[3]} г.`
  }

  if ((m = cleanText.match(rxBday)) && m[1] && m[2]) {
    return m[2].length > 2 ? `${monthName(m[1])} ${m[2]} г.` : `${m[2]} ${monthName(m[1])}`
  }

  if ((m = cleanText.match(rxSeason)) && m[1] && m[2]) {
    return `${seasonName(m[1])} ${m[2]}`
  }

  // "Watched episode 3 of" -> "Просмотрена серия 3"
  if ((m = cleanText.match(rxAct)) && m[1] && m[2] && m[3]) {
    const isRange = m[3].includes('-') || m[3].includes('–')
    const act = ACT_FORMS[m[1].toLowerCase()]
    const item = ITEM_FORMS[m[2].toLowerCase()]
    if (act && item) {
      return `${isRange ? act[1] : act[0]} ${isRange ? item[1] : item[0]} ${m[3].trim()}`
    }
  }

  // "Status: Finished" -> "Статус: Завершён" (значение тоже прогоняем через правила)
  if ((m = cleanText.match(rxLabel)) && m[1] && m[2] !== undefined) {
    const val = m[2].trim()
    const label = LABELS[m[1]] ?? LABELS[titleCaseKey(m[1])] ?? m[1]
    return `${label}: ${fromDictionary(val) ?? translateAdvanced(val) ?? val}`
  }

  if ((m = cleanText.match(rxUnit)) && m[1] && m[2]) {
    const forms = UNIT_FORMS[m[2].toLowerCase()]
    if (forms) {
      const num = parseInt(m[1])
      return `${num} ${getPlural(num, forms)}`
    }
  }

  if ((m = cleanText.match(rxRecent)) && m[1] && m[2]) {
    return `${m[1]} недавно ${m[2].toLowerCase() === 'watched' ? 'смотрели' : 'читали'}`
  }

  if ((m = cleanText.match(rxReviewBy)) && m[1]) {
    return `отзыв от ${m[1]}`
  }

  if ((m = cleanText.match(rxDayDate)) && m[1] && m[2] && m[3] && m[4]) {
    return `${dayName(m[1])}, ${m[3]} ${monthName(m[2])} ${m[4]} г.`
  }

  if ((m = cleanText.match(rxAgo)) && m[1] && m[2]) {
    const forms = TIME_FORMS[m[2].toLowerCase()]
    if (forms) {
      return `${m[1]} ${getPlural(parseInt(m[1]), forms)} назад`
    }
  }

  if ((m = cleanText.match(rxListAdded)) && m[1] && m[2]) {
    const title = fromDictionary(m[1]) ?? m[1]
    const list = LIST_NAMES[m[2].toLowerCase()] ?? m[2]
    return `«${title}» добавлено в список «${list}»`
  }

  if ((m = cleanText.match(rxListUpdated)) && m[1]) {
    return `Запись «${fromDictionary(m[1]) ?? m[1]}» обновлена`
  }

  return null
}
