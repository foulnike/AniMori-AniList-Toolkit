<div align="center">
  
# AniMori — Toolkit for AniList

**Русификатор и набор инструментов для [AniList](https://anilist.co) — перевод интерфейса, плеер, рейтинги, дерево франшиз, экспорт и сравнение списков с Shikimori.**

[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-%D1%83%D1%81%D1%82%D0%B0%D0%BD%D0%BE%D0%B2%D0%B8%D1%82%D1%8C-02A9FF?style=flat-square&logo=javascript&logoColor=white&labelColor=0B1622)](https://greasyfork.org/ru/scripts/572948-animori-anilist-toolkit)
[![Релиз](https://img.shields.io/github/v/release/foulnike/AniMori-AniList-Toolkit?style=flat-square&logo=github&logoColor=white&label=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7&labelColor=0B1622&color=02A9FF)](https://github.com/foulnike/AniMori-AniList-Toolkit/releases/latest)
[![Лицензия](https://img.shields.io/badge/%D0%BB%D0%B8%D1%86%D0%B5%D0%BD%D0%B7%D0%B8%D1%8F-MIT-02A9FF?style=flat-square&labelColor=0B1622)](LICENSE)

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Vue 3](https://img.shields.io/badge/Vue%203-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![Sass](https://img.shields.io/badge/Sass-CC6699?style=flat-square&logo=sass&logoColor=white)
![Tampermonkey](https://img.shields.io/badge/Tampermonkey-00485B?style=flat-square&logo=tampermonkey&logoColor=white)

[Возможности](#возможности) · [Установка](#установка) · [Авторизация](#авторизация-для-экспорта-и-редактирования-списков) · [Сборка](#сборка-из-исходников)

</div>

---

**AniMori** превращает AniList в удобный для русскоязычного зрителя сервис: переводит интерфейс, подтягивает русские названия и описания с Shikimori и anime365, встраивает плеер, показывает рейтинги MAL и Shikimori, строит дерево хронологии франшизы, переносит списки из Shikimori в AniList и сравнивает списки двух площадок.

Это **пользовательский скрипт** — он работает в вашем браузере поверх сайта anilist.co и ничего кроме менеджера скриптов не требует.

AniMori — неофициальный проект и не связан с командой AniList.

> [!NOTE]
> **Где что лежит.** У проекта два продукта, и живут они в разных ветках:<br>
> — ветка **`script`** (эта) — юзерскрипт, теги вида `script-2.1.0`;<br>
> — ветка **`app-3.0-dev`** — настольное приложение со своим интерфейсом, теги вида `app-3.0.0`;<br>
> — ветка **`main`** — история монолита 2.x, когда скрипт и десктоп собирались из одной кодовой базы. Из неё же раздаётся словарь перевода.

## Как выглядит

<div align="center">

<img src="https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/assets/screenshots/home.webp" width="900" alt="Каталог AniList с переведённым интерфейсом и русскими названиями">

</div>

<details>
<summary><b>Страница аниме</b> — русское описание с указанием источника, рейтинги, музыкальные темы, дерево франшизы, внешние ссылки</summary>
<br>
<div align="center">
<img src="https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/assets/screenshots/media.webp" width="900" alt="Страница аниме с блоками AniMori">
</div>
</details>

<details>
<summary><b>Плеер</b> — выбор озвучки с избранным и переключение серий без перезагрузки страницы</summary>
<br>
<div align="center">
<img src="https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/assets/screenshots/player.webp" width="900" alt="Встроенный плеер с панелями озвучек и эпизодов">
</div>
</details>

## Возможности

- **Перевод интерфейса** — строки сайта переводятся по словарю `dictionary.json`.
- **Русские тайтлы и описания** — названия и синопсисы подтягиваются с Shikimori или anime365 с указанием источника и ссылкой на него; основной источник и фоллбэк выбираются в настройках.
- **Перевод персонажей и персонала** — имена с Shikimori, с сопоставлением записей с AniList.
- **Аниме-плеер** — встроенный плеер с выбором озвучки и серий (Kodik).
- **Рейтинги MAL и Shikimori** — оценки MyAnimeList и Shikimori рядом с оценкой AniList.
- **Дерево франшизы** — хронология связанных тайтлов (включая записи, которых нет на AniList, — со стороны Shikimori).
- **Музыкальные темы** — опенинги и эндинги с поиском в VK Музыке, YouTube Music, Spotify и SoundCloud.
- **Русский поиск** — поиск по русским названиям для аниме, манги, **персонажей и персонала**.
- **Внешние ссылки** — быстрый переход на RuTracker, YummyAnime, AnimeGO, MangaLib (домены настраиваются) плюс **свои ссылки** с URL-шаблонами и плейсхолдерами `{ru}` / `{romaji}` / `{query}`.
- **Сравнение списков Shikimori ⇄ AniList** — сканер расхождений: сводная статистика, поимённые различия по статусу, оценке, прогрессу, пересмотрам и заметкам, сравнение избранного (аниме, манга, персонажи, персонал), детект связанных сезонов и игнор-лист.
- **Импорт списка Shikimori → AniList** — перенос аниме, манги, избранного и точных дат просмотров в AniList (требуется токен AniList).
- **Локальный словарь** — свои переводы поверх общей базы: добавляются вручную или выделением текста на странице, применяются сразу без перезагрузки; редактор с поиском, импортом/экспортом и отправкой предложений в общую базу.
- **Цветовые темы тулкита** — выбор акцентного цвета AniMori.
- **Локальный кэш (IndexedDB)** — данные Shikimori/MAL кэшируются на 90 дней, чтобы не дёргать API повторно.
- **Гибкие настройки** — модули включаются/отключаются во вкладочной панели «⚙» в левом нижнем углу.
- **Логгер** — встроенный инструмент отладки (по желанию).

Блокировщика рекламы здесь нет намеренно: в браузере с этим лучше справится любое профильное расширение — оно видит и кадр плеера, куда скрипту заглянуть не дано.

## Установка

1. Установите менеджер пользовательских скриптов — [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox и др.).
2. Установите скрипт со страницы **[Greasy Fork](https://greasyfork.org/ru/scripts/572948-animori-anilist-toolkit)** — это рекомендуемый способ, он обеспечивает автообновления.
3. Откройте [AniList](https://anilist.co) — внизу слева появится кнопка **⚙**.

Файл `animori.user.js` из раздела [Releases](https://github.com/foulnike/AniMori-AniList-Toolkit/releases) — для тех, кто ставит скрипт вручную. Автообновление в любом случае идёт через Greasy Fork.

## Авторизация (для экспорта и редактирования списков)

Перевод, плеер и рейтинги работают без входа. Для экспорта списка из Shikimori и изменения своего списка на AniList нужен токен:

1. Откройте панель **⚙** → раздел «Авторизация AniList».
2. Создайте API-клиент на [anilist.co/settings/developer](https://anilist.co/settings/developer) (в поле redirect укажите `https://anilist.co/api/v2/oauth/pin`).
3. Вставьте Client ID, сгенерируйте ссылку, получите токен и вставьте его в поле.

Токен хранится в хранилище Tampermonkey и наружу не утекает.

## Источники данных

| Источник | Назначение |
| :--- | :--- |
| `raw.githubusercontent.com` | словарь перевода интерфейса (этот репозиторий) |
| `graphql.anilist.co` | данные и списки AniList |
| `shikimori.io`, `shikimori.rip` | русские названия, описания, персонажи, франшизы (`.rip` — запасное зеркало на случай недоступности основного домена) |
| `smotret-anime.online`, `anime365.ru` | тайтлы и описания (альтернативный источник/фоллбэк anime365) |
| `api.animethemes.moe` | музыка |
| `kodik-api.com` | видеоплеер |

Запросы идут прямо из браузера через `GM_xmlhttpRequest`. Ваши данные на сторонние серверы не отправляются: токен и настройки остаются на вашей машине, кэш — в локальной IndexedDB.

## Словарь перевода

`dictionary.json` — набор пар `оригинал → перевод` для строк интерфейса AniList:

```json
{
  "Home": "Главная",
  "Browse": "Просмотр",
  "Settings": "Настройки"
}
```

Словарь подгружается напрямую из ветки `main`, поэтому правки применяются у всех пользователей без обновления скрипта. Нашли непереведённую или неточно переведённую строку — присылайте Pull Request или открывайте Issue.

## Сборка из исходников

Нужен только Node.js.

```bash
npm install
npm run build       # → dist/animori.user.js и dist/animori.meta.js
npm run dev         # сборка с пересборкой на лету
npm run typecheck   # проверка типов
```

Выпуск делает тег вида `script-2.1.0`: прогон сверяет номер в теге с `package.json`, собирает скрипт и создаёт релиз с описанием из верхнего раздела `CHANGELOG.md`. На Greasy Fork новая версия выкладывается отдельно — именно оттуда приходят обновления к людям.

Исходный код: `src/` — логика и интерфейс на TypeScript и Vue 3, входная точка — `src/main.ts`.

## Лицензия

[MIT](LICENSE) © foulnike

Лицензия покрывает код проекта и переводы, сделанные участниками. Данные сторонних сервисов ею не покрываются: оригинальные строки интерфейса в ключах `dictionary.json` принадлежат AniList, русские названия, описания и имена — Shikimori и anime365, музыкальные метаданные — AnimeThemes. Всё это показывается со ссылкой на источник и не хранится в репозитории.

Сторонние сервисы (AniList, Shikimori, MyAnimeList, anime365, AnimeThemes, Kodik) принадлежат их владельцам и используются через их публичные API. Видео отдаёт сторонний плеер: проект не хранит и не раздаёт видео и не отвечает за содержимое источников.
