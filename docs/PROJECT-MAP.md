# Карта проекта AniMori

Ветка `app-3.0-dev`. Здесь структура и связи кода, а не история
разработки: решения и их причины — в `docs/DECISIONS.md`, ход работ —
в `docs/<версия>/PLAN.md`, подробности — в телах коммитов.

Карта разбита на три части:

1. этот файл — обзор, дерево репозитория, жизненный цикл;
2. `PROJECT-MAP-MODULES.md` — прикладные модули и слой API;
3. `PROJECT-MAP-SHELL.md` — оболочка Tauri, сборка, данные, инварианты.

Размеры файлов в карте не указываются: они меняются каждую неделю и всегда
оказываются ложью.

---

> **Перед любой правкой:** `docs/CODE-STYLE.md` — комментарии в проекте ОЧЕНЬ
> лаконичны. Перед любой записью в `docs/`: `docs/DOC-RULES.md`.

---

## 1. Что это такое

AniMori — надстройка над anilist.co для русскоязычного зрителя: перевод
интерфейса и карточек, русский поиск, встроенный плеер, виджеты медиа-страницы,
перенос списков с Shikimori и их сравнение.

В ветке 3.0 к этому добавляется второй продукт: собственный клиент AniList
на своих экранах. Скрипт и приложение стоят на общем ядре.

Одна кодовая база собирается в два продукта.

|                   | Юзерскрипт                          | Десктоп                            |
| ----------------- | ----------------------------------- | ---------------------------------- |
| Сборка            | `npm run build` (режим userscript)  | `npm run build:tauri` плюс cargo   |
| Оболочка          | Tampermonkey в браузере             | Tauri 2 и WebView2, только Windows |
| Артефакт          | `dist/animori.user.js`              | `AniMori_<версия>_x64-setup.exe`   |
| Мост              | `MonkeyBridge` на GM_\*             | `TauriBridge` на плагинах Tauri    |
| Адблок            | заглушка `impl.noop`                | CSS плюс сетевой фильтр WebView2   |
| Сеть через прокси | нет, только диагностика доступности | два канала: WebView2 и клиент Rust |

Различия решаются на сборке через `resolve.alias`, а не ветвлением в рантайме:
иначе в браузерный бандл уехали бы пакеты `@tauri-apps/*`, неработоспособные
вне окна приложения.

Ветки: `main` — релиз; `app-3.0-dev` — рабочая; `script&windows-dev` — линия 2.x,
только исправления; `linux-dev` и `android-dev` — заготовки портов, клоны `main`,
работа не начата.

---

## 2. Дерево репозитория

### Корень

```
.github/workflows/release.yml   сборка и публикация по тегу
.github/ISSUE_TEMPLATE/         четыре формы обращений и config.yml
dictionary.json                 словарь интерфейса, тянется с raw.githubusercontent
docs/                           карты, стиль, правила документации, реестр решений
docs/<версия>/                  PLAN.md, CONTEXT.md и свой DECISIONS.md
src/                            общий фронтенд: ядро, скрипт, приложение
src-tauri/                      оболочка на Rust
vite.config.ts                  два режима сборки, алиасы, шапка юзерскрипта
tsconfig.json                   strict, алиасы для тайпчека
package.json                    единственный источник номера версии
CHANGELOG.md, README.md, LICENSE
```

Формы обращений: `bug.yml`, `translation.yml`, `feature.yml`, `dictionary-bulk.yml`.
GitHub берёт их только из ветки по умолчанию, так что в рабочей ветке их
проверить нельзя. `config.yml` выключает пустые обращения и ссылается на
якорь раздела установки в README.

Документы в корне `docs/`: `DOC-RULES.md` (как вести записи), `DECISIONS.md`
(реестр решений строками с хешами), `CODE-STYLE.md`, три части карты.

### src/

Три слоя. `shared/` не знает ничьей разметки, `userscript/` — надстройка над
чужим сайтом, `app/` — свои экраны.

```
vite-env.d.ts  типы глобалов сборки, в том числе __ANIMORI_VERSION__

shared/     общее ядро обоих продуктов
  api/        внешние сервисы
    anilist.ts, shikimori.ts, shikimori-people.ts, shikimori-user.ts,
    anime365.ts, animethemes.ts, dictionary.ts, titles.ts, rate-limit.ts
  bridge/     абстракция платформы
    IBridge.ts              контракт: storage, http, clipboard, shell, proxyDiagnostics
    TauriBridge.ts, MonkeyBridge.ts, TauriProxyDiagnostics.ts
    index.ts                единственная точка импорта: '@/bridge'
  core/       ядро данных и настроек
    db.ts           IndexedDB, кэши, сборщик мусора
    settings.ts     все настройки и чтение их через мост
    net-health.ts   учёт доступности источников
    proxy.ts        разбор и сборка настроек прокси
    dictionary.ts   сборка итогового словаря
    constants.ts    домены, TTL, регулярки перевода
    types.ts, custom-links.ts, accent.ts
  adblock/    impl.desktop.ts, impl.noop.ts, index.ts, net-block.ts, net-probe.ts
  utils/      logger.ts, vue-mounter.ts, dom.ts, name-match.ts

userscript/ надстройка над сайтом
  main.ts        точка входа: порядок старта и привязка к SPA
  lifecycle.ts   реестр задач на смену роута и разбор
  style.scss     все стили надстройки одним файлом
  features/
    exporter/   index.ts, sync-api.ts, sync-state.ts, SyncModal.vue
    media/      index.ts, player.ts, franchise.ts, themes.ts, ratings.ts,
                extlinks.ts, types.ts
    scanner/    index.ts, compare.ts, scanner-state.ts, ScannerModal.vue,
                ScannerDiffCategory.vue
    search/     index.ts, dict-capture.ts
    translator/ index.ts, rules.ts, dom.ts
    ui/         SettingsModal.vue и вкладки (SettingsDevTab, SettingsDictTab,
                SettingsLinksTab, SettingsSupportTab, SettingsProxyCard),
                settings-state.ts, LoggerModal.vue, logger-state.ts,
                ActionPanel.vue, action-panel-state.ts, actions.ts,
                player-hero.scss, NavPanel.vue, nav.ts, nav-state.ts, reload.ts,
                links.ts, net-check.ts, NetToast.vue, net-toast.ts, settings.ts,
                logger-ui.ts

app/        свои экраны приложения, пока пусто
```

Жизненный цикл живёт у скрипта, а не в ядре: он знает роуты и корни чужого SPA.

### Алиасы совместимости

Старые имена модулей ведут на новые каталоги, поэтому переезд не потребовал
править каждый импорт. Между слоями ходят только через алиасы; относительные
пути допустимы лишь внутри своего каталога.

| Имя в коде           | Куда ведёт                    |
| -------------------- | ----------------------------- |
| `@/api/*`            | `src/shared/api/*`            |
| `@/bridge`           | `src/shared/bridge/index.ts`  |
| `@/core/*`           | `src/shared/core/*`           |
| `@/utils/*`          | `src/shared/utils/*`          |
| `@/features/adblock` | `src/shared/adblock`          |
| `@/core/lifecycle`   | `src/userscript/lifecycle.ts` |
| `@/features/*`       | `src/userscript/features/*`   |
| `@/*`                | `src/*`                       |

Список держится синхронно в двух местах: `resolve.alias` в `vite.config.ts`
и `paths` в `tsconfig.json`. Правка одного без другого даёт зелёную сборку
при красном тайпчеке или наоборот. Точные имена стоят раньше общих: порядок
ключей решает, какой алиас сработает.

### src-tauri/

```
src/lib.rs          создание окна, инъекция бандла, команды, плагины
src/adblock.rs      сетевой блокировщик на событиях WebView2, только Windows
src/proxy.rs        решение о прокси, щуп, состояние для интерфейса
src/proxy_guard.rs  сторож готовности страницы и аварийный выход
src/proxy_auth.rs   ответ на запрос логина прокси, только Windows
src/updater.rs      проверка и установка обновлений
src/main.rs         вызов run()
build.rs            AppManifest::commands
capabilities/       ACL окна, открытого на внешнем адресе
icons/              иконки приложения
tauri.conf.json     идентификатор, бандл, автообновление
Cargo.toml
```

---

## 3. Жизненный цикл

### 3.1 Как код попадает на страницу

В браузере — Tampermonkey по `@match https://anilist.co/*`; стили вставляет плагин
monkey. В десктопе — `initialization_script` из `lib.rs`: сначала скрипт со стилями,
затем сам бандл. Оба выполняются до создания DOM, поэтому в точке входа
есть гейт `whenDomReady()`: ожидание `document.body` через событие и опрос
одновременно (между проверкой и подпиской есть зазор).

### 3.2 Порядок старта (`src/userscript/main.ts`, `bootstrap()`)

Каждый шаг обёрнут в `step()`: падение одного не обрывает остальные и оставляет
запись в журнале.

1. параллельно: готовность DOM и `loadSettings()`;
2. перехватчики ошибок, перехват ссылок, токен AniList;
3. выход, если домен не anilist.co (проверка `IS_SHIKI` нужна для старых
   установок юзерскрипта, где в шапке ещё стоит shikimori);
4. свои ссылки и личный словарь;
5. адблок, затем сетевая разведка (в браузере оба — заглушки);
6. акцентный цвет;
7. панели: настройки, журнал, сканер, перенос, панель действий, блок навигации;
8. IndexedDB;
9. словарь интерфейса, переводчик, поиск;
10. регистрация медиа-виджетов и `initMedia()`;
11. `wireLifecycle()` — привязка к SPA-навигации;
12. через 15 секунд — сборщик мусора кэша.

Жёсткие зависимости порядка:

- всё, что читает `settings`, идёт строго после `loadSettings()`: до этого в объекте
  лежат дефолты;
- медиа-виджеты живут на наблюдателе мутаций переводчика, поэтому идут после
  `initTranslator()`; сам переводчик запускается всегда, даже при выключенном
  переводе;
- адблок — до первой отрисовки страницы, иначе баннер успевает мигнуть.

### 3.3 SPA-навигация (`src/userscript/lifecycle.ts`)

AniList — SPA на React, документ при переходе не перезагружается. Три источника
событий: обёртки над `pushState` и `replaceState`, `popstate`, и пулинг адреса
каждые 800 мс как страховка. Пачка событий схлопывается общим таймером на 50 мс.

Задачи роута регистрируются в `main.ts` и выполняются в порядке регистрации:
снятие постраничных Vue-приложений, уборка фантомных корней, медиа-страница,
сброс счётчиков переводчика. Порядок важен: сначала снимается то, что
привязано к ушедшей странице, и только потом собирается новая.

Задачи обязаны быть идемпотентными: повторный прогон по тому же адресу — это
штатный способ дожать то, что не вышло с первого раза.

Задачи разбора (`shutdownLifecycle`) в браузере не вызываются никогда: вкладку
закрывают вместе с документом. Они для десктопа, где WebView живёт дольше
документа.

### 3.4 Монтирование Vue

`shared/utils/vue-mounter.ts` держит реестр всех приложений. Признак `pageScoped`
разделяет два рода: постраничные снимаются на каждой смене роута,
а панель действий и модалки живут в `body` всю сессию. Отдельно есть уборка
фантомов: узлы `am-vue-root` без живого приложения за ними остаются, когда
React переносит кусок разметки вместе с нашим корнем.
