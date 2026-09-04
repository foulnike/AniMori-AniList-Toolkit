// Русские слова для тэгов каталога: справочник AniList приходит
// на английском, а меню отбора на главной должно читаться по-русски.
// Сосед labels.ts ведает жанрами и форматами; тэги вынесены отдельно:
// их сотни, и список растёт без нашего участия.
//
// Незнакомый ключ отдаётся как есть — правило общее с labels.ts. Новый
// тэг на сервере появляется раньше, чем строка здесь, и лучше показать
// английское имя, чем пустоту или «без названия».

/** Разделы справочника. Сервер шлёт их дорожкой вида «Theme-Sci Fi-Mecha». */
const GROUP_WORDS: Readonly<Record<string, string>> = {
  'Cast-Main Cast': 'Главные герои',
  'Cast-Traits': 'Черты героев',
  Demographic: 'Аудитория',
  'Setting-Scene': 'Место действия',
  'Setting-Time': 'Время действия',
  'Setting-Universe': 'Мир',
  'Sexual Content': 'Взрослое',
  Technical: 'Исполнение',
  'Theme-Action': 'Тема: боевик',
  'Theme-Arts': 'Тема: искусство',
  'Theme-Arts-Music': 'Тема: музыка',
  'Theme-Comedy': 'Тема: комедия',
  'Theme-Drama': 'Тема: драма',
  'Theme-Fantasy': 'Тема: фэнтези',
  'Theme-Game': 'Тема: игры',
  'Theme-Game-Card & Board Game': 'Тема: настольные игры',
  'Theme-Game-Sport': 'Тема: спорт',
  'Theme-Other': 'Тема: прочее',
  'Theme-Other-Organisations': 'Тема: организации',
  'Theme-Other-Vehicle': 'Тема: транспорт',
  'Theme-Romance': 'Тема: романтика',
  'Theme-Sci Fi': 'Тема: фантастика',
  'Theme-Sci Fi-Mecha': 'Тема: меха',
  'Theme-Slice of Life': 'Тема: повседневность',
}

/**
 * Слова тэгов. Здесь ходовые: полный список AniList близок к тысяче
 * и меняется чаще, чем выходят сборки.
 *
 * Устоявшиеся в среде слова не переводятся буквально: «Исекай», «Цундере»
 * и «Меха» узнаются быстрее любого точного перевода.
 */
const TAG_WORDS: Readonly<Record<string, string>> = {
  // Главные герои
  'Anti-Hero': 'Антигерой',
  'Elderly Protagonist': 'Пожилой герой',
  'Ensemble Cast': 'Ансамбль героев',
  'Female Protagonist': 'Героиня в центре',
  'Male Protagonist': 'Герой в центре',
  'Primarily Adult Cast': 'Взрослые герои',
  'Primarily Child Cast': 'Дети-герои',
  'Primarily Female Cast': 'Женский состав',
  'Primarily Male Cast': 'Мужской состав',
  'Primarily Teen Cast': 'Подростки-герои',

  // Черты героев
  Aliens: 'Пришельцы',
  Angels: 'Ангелы',
  Anthropomorphism: 'Звери как люди',
  'Artificial Intelligence': 'Искусственный разум',
  Assassins: 'Убийцы',
  Butler: 'Дворецкие',
  Chimera: 'Химеры',
  Clone: 'Клоны',
  Cyborg: 'Киборги',
  Delinquents: 'Хулиганы',
  Demons: 'Демоны',
  Detective: 'Сыщики',
  Dinosaurs: 'Динозавры',
  Dragons: 'Драконы',
  Elf: 'Эльфы',
  Fairy: 'Феи',
  Ghost: 'Призраки',
  Goblin: 'Гоблины',
  Gods: 'Боги',
  Gyaru: 'Гяру',
  Idol: 'Идолы',
  Kemonomimi: 'Звериные ушки',
  Knight: 'Рыцари',
  Kuudere: 'Куудере',
  Maids: 'Горничные',
  Mermaid: 'Русалки',
  'Monster Boy': 'Парни-нелюди',
  'Monster Girl': 'Девушки-нелюди',
  Nekomimi: 'Кошачьи ушки',
  Ninja: 'Ниндзя',
  Nun: 'Монахини',
  'Office Lady': 'Служащие',
  'Ojou-sama': 'Барышни',
  Pirates: 'Пираты',
  Robots: 'Роботы',
  Samurai: 'Самураи',
  'Shrine Maiden': 'Мико',
  Skeleton: 'Скелеты',
  Teacher: 'Учителя',
  Tsundere: 'Цундере',
  Twins: 'Близнецы',
  Vampire: 'Вампиры',
  Vikings: 'Викинги',
  Villainess: 'Злодейка',
  VTuber: 'Виртуальные ведущие',
  Werewolf: 'Оборотни',
  Witch: 'Ведьмы',
  Yandere: 'Яндере',
  Zombie: 'Зомби',

  // Аудитория
  Josei: 'Дзёсэй',
  Kids: 'Детское',
  Seinen: 'Сэйнэн',
  Shoujo: 'Сёдзё',
  Shounen: 'Сёнэн',

  // Место действия
  Bar: 'Бар',
  'Boarding School': 'Школа-интернат',
  Camping: 'Походы',
  Circus: 'Цирк',
  Coastal: 'Морской берег',
  College: 'Университет',
  Desert: 'Пустыня',
  Dungeon: 'Подземелья',
  Foreign: 'За рубежом',
  Inn: 'Постоялый двор',
  Islands: 'Острова',
  Japan: 'Япония',
  Konbini: 'Круглосуточный магазин',
  Medical: 'Больница',
  Military: 'Армия',
  Office: 'Офис',
  Orphanage: 'Приют',
  Outdoor: 'На природе',
  Prison: 'Тюрьма',
  Restaurant: 'Ресторан',
  Rural: 'Глубинка',
  School: 'Школа',
  'School Club': 'Школьный клуб',
  Snowscape: 'Снежные края',
  Space: 'Космос',
  Urban: 'Город',
  Work: 'Работа',

  // Время и мир
  'Achronological Order': 'Нелинейный рассказ',
  Afterlife: 'Загробный мир',
  'Alternate Universe': 'Другая вселенная',
  Anachronism: 'Анахронизм',
  'Ancient China': 'Древний Китай',
  'Augmented Reality': 'Дополненная реальность',
  Dystopian: 'Антиутопия',
  Historical: 'Историческое',
  Isekai: 'Исекай',
  'Post-Apocalyptic': 'Постапокалипсис',
  'Time Skip': 'Скачок во времени',
  'Urban Fantasy': 'Городское фэнтези',
  'Virtual World': 'Виртуальный мир',

  // Исполнение
  '4-koma': 'Ёнкома',
  Achromatic: 'Без цвета',
  Anthology: 'Антология',
  CGI: 'Компьютерная графика',
  Episodic: 'Отдельные истории',
  'Full CGI': 'Полностью трёхмерное',
  'Mixed Media': 'Смешанная техника',
  'No Dialogue': 'Без слов',
  'Non-fiction': 'Не вымысел',
  POV: 'От первого лица',
  Puppetry: 'Куклы',
  Rotoscoping: 'Ротоскопирование',
  'Stop Motion': 'Покадровая анимация',

  // Боевик
  Archery: 'Стрельба из лука',
  'Battle Royale': 'Битва насмерть',
  Espionage: 'Шпионаж',
  Fugitive: 'Беглец',
  Guns: 'Огнестрельное оружие',
  'Martial Arts': 'Единоборства',
  Swordplay: 'Фехтование на мечах',

  // Искусство и музыка
  Acting: 'Актёрство',
  Band: 'Музыкальная группа',
  Calligraphy: 'Каллиграфия',
  'Classic Literature': 'Классика литературы',
  'Classical Music': 'Классическая музыка',
  Dancing: 'Танцы',
  Drawing: 'Рисование',
  Fashion: 'Мода',
  Food: 'Еда',
  'Jazz Music': 'Джаз',
  'Metal Music': 'Метал',
  'Musical Theater': 'Мюзикл',
  Photography: 'Фотография',
  Rakugo: 'Ракуго',
  'Rock Music': 'Рок',
  Writing: 'Писательство',

  // Комедия и драма
  Bullying: 'Травля',
  'Class Struggle': 'Классовая борьба',
  'Coming of Age': 'Взросление',
  Conspiracy: 'Заговор',
  Parody: 'Пародия',
  Rehabilitation: 'Возвращение к жизни',
  Revenge: 'Месть',
  Satire: 'Сатира',
  Slapstick: 'Буффонада',
  Suicide: 'Самоубийство',
  'Surreal Comedy': 'Абсурдный юмор',
  Tragedy: 'Трагедия',

  // Фэнтези
  Alchemy: 'Алхимия',
  'Body Swapping': 'Обмен телами',
  Cultivation: 'Совершенствование',
  Curses: 'Проклятия',
  Exorcism: 'Экзорцизм',
  'Fairy Tale': 'Сказка',
  Henshin: 'Превращение героя',
  Kaiju: 'Кайдзю',
  Magic: 'Магия',
  Mythology: 'Мифология',
  Necromancy: 'Некромантия',
  Shapeshifting: 'Оборотничество',
  Steampunk: 'Стимпанк',
  'Super Power': 'Сверхспособности',
  Superhero: 'Супергерои',
  Wuxia: 'Уся',
  Youkai: 'Ёкаи',

  // Игры и спорт
  Athletics: 'Лёгкая атлетика',
  Badminton: 'Бадминтон',
  Baseball: 'Бейсбол',
  Basketball: 'Баскетбол',
  'Board Game': 'Настольная игра',
  Boxing: 'Бокс',
  Cycling: 'Велоспорт',
  'E-Sports': 'Киберспорт',
  Fencing: 'Фехтование',
  Fishing: 'Рыбалка',
  Football: 'Футбол',
  Go: 'Го',
  Golf: 'Гольф',
  'Ice Skating': 'Коньки',
  Judo: 'Дзюдо',
  Mahjong: 'Мадзян',
  Poker: 'Покер',
  Rugby: 'Регби',
  Shogi: 'Сёги',
  Skateboarding: 'Скейтборд',
  Sumo: 'Сумо',
  Surfing: 'Сёрфинг',
  Swimming: 'Плавание',
  'Table Tennis': 'Настольный теннис',
  Tennis: 'Теннис',
  'Video Games': 'Видеоигры',
  Volleyball: 'Волейбол',
  Wrestling: 'Борьба',

  // Прочее
  Adoption: 'Приёмная семья',
  Animals: 'Животные',
  Astronomy: 'Астрономия',
  Biographical: 'Биография',
  'Body Horror': 'Телесный ужас',
  Cannibalism: 'Людоедство',
  Chibi: 'Тиби',
  Cosplay: 'Косплей',
  Crime: 'Преступления',
  Crossover: 'Кроссовер',
  'Death Game': 'Игра на смерть',
  Drugs: 'Наркотики',
  Economics: 'Экономика',
  Educational: 'Познавательное',
  Environmental: 'Природа и экология',
  Filmmaking: 'Кинодело',
  'Found Family': 'Обретённая семья',
  Gambling: 'Азартные игры',
  'Gender Bending': 'Смена пола',
  Gore: 'Жестокость',
  'Language Barrier': 'Языковой барьер',
  'LGBTQ+ Themes': 'ЛГБТ-темы',
  'Lost Civilization': 'Забытая цивилизация',
  Marriage: 'Брак',
  Medicine: 'Медицина',
  'Memory Manipulation': 'Игры с памятью',
  Meta: 'О самом себе',
  Mountaineering: 'Альпинизм',
  Noir: 'Нуар',
  'Otaku Culture': 'Культура отаку',
  Pandemic: 'Пандемия',
  Philosophy: 'Философия',
  Politics: 'Политика',
  Reincarnation: 'Перерождение',
  Religion: 'Религия',
  Slavery: 'Рабство',
  'Software Development': 'Разработка программ',
  Survival: 'Выживание',
  Terrorism: 'Терроризм',
  Torture: 'Пытки',
  Travel: 'Путешествия',
  War: 'Война',

  // Организации и транспорт
  Aviation: 'Авиация',
  Cars: 'Автомобили',
  'Criminal Organization': 'Преступная организация',
  Cult: 'Культ',
  Firefighters: 'Пожарные',
  Gangs: 'Банды',
  Mafia: 'Мафия',
  Motorcycles: 'Мотоциклы',
  Police: 'Полиция',
  Ships: 'Корабли',
  Tanks: 'Танки',
  Trains: 'Поезда',
  Triads: 'Триады',
  Yakuza: 'Якудза',

  // Романтика
  'Age Gap': 'Разница в возрасте',
  "Boys' Love": 'Сёнэн-ай',
  Cohabitation: 'Жизнь под одной крышей',
  'Female Harem': 'Женский гарем',
  'Love Triangle': 'Любовный треугольник',
  'Male Harem': 'Мужской гарем',
  Matchmaking: 'Сватовство',
  'Mixed Gender Harem': 'Смешанный гарем',
  Polyamorous: 'Многолюбие',
  "Teens' Love": 'Подростковая любовь',
  'Unrequited Love': 'Безответная любовь',
  Yuri: 'Юри',

  // Фантастика и меха
  Cyberpunk: 'Киберпанк',
  Mecha: 'Меха',
  'Real Robot': 'Реалистичные роботы',
  'Space Opera': 'Космоопера',
  'Super Robot': 'Суперроботы',
  Terraforming: 'Освоение планет',
  'Time Loop': 'Петля времени',
  'Time Manipulation': 'Управление временем',
  Tokusatsu: 'Токусацу',

  // Повседневность
  Agriculture: 'Сельское хозяйство',
  'Cute Boys Doing Cute Things': 'Милые мальчики',
  'Cute Girls Doing Cute Things': 'Милые девочки',
  'Family Life': 'Семейная жизнь',
  Iyashikei: 'Исцеляющее',
  Parenthood: 'Родительство',

  // Взрослое: в меню показывается только при разрешённом взрослом
  Ecchi: 'Этти',
  Nudity: 'Нагота',
}

/** Слово из словаря или сам ключ: чужое имя лучше пустоты. */
function word(dict: Readonly<Record<string, string>>, key: string): string {
  const clean = key.trim()
  if (clean === '') return ''
  return dict[clean] ?? clean
}

/** Русское слово тэга каталога. */
export function tagWord(name: string): string {
  return word(TAG_WORDS, name)
}

/**
 * Русское имя раздела. Если вся дорожка незнакома, берётся последнее
 * звено: у нового «Theme-Sci Fi-Что-то» читаемое именно окончание,
 * а не вся английская дорожка с дефисами.
 */
export function tagGroupWord(category: string): string {
  const clean = category.trim()
  if (clean === '') return ''

  const known = GROUP_WORDS[clean]
  if (known !== undefined) return known

  const parts = clean.split('-')
  return parts[parts.length - 1]?.trim() || clean
}
