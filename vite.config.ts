import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import monkey from 'vite-plugin-monkey'

// Единый источник номера версии — package.json.
//
// Раньше номер был прописан здесь строкой, и при выпуске его приходилось
// поднимать в двух местах. Пропуск одного из них стоит дорого: Tauri берёт
// версию из package.json и приложение обновится, а GreasyFork смотрит только на
// шапку скрипта — со старым номером он решит, что обновлять нечего, и люди
// останутся на прежней сборке молча.
//
// Чтение файла, а не import его JSON: импорт потребовал бы resolveJsonModule
// и тянул бы package.json в область проверки типов всего проекта.
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string }

// Метаданные ниже перенесены 1:1 из шапки монолита animori.user.js (строки 1-25),
// кроме version — он теперь приезжает из package.json.
// Не добавляй @match/@grant/@connect "на всякий случай": лишние права ломают ревю GreasyFork.
export default defineConfig(({ mode }) => {
  // Пункт 4.6: два таргета из одного входа src/userscript/main.ts.
  //
  // Режим userscript: vite-plugin-monkey добавляет шапку и сам инжектирует CSS.
  // Режим tauri: плагин monkey отключён целиком — шапка юзерскрипта и его
  // обёртки в initialization_script недопустимы. На выходе два файла:
  // dist/animori.tauri.js (IIFE) и dist/animori.tauri.css. Rust-бэкенд включает оба
  // через include_str! (пункт 4.3), поэтому имена файлов зафиксированы жёстко,
  // без хешей в имени.
  const isTauri = mode === 'tauri'

  // Пункт 1.5: третий режим — своё приложение.
  //
  // Отличие от двух прежних принципиальное: там мы входили в чужую страницу
  // одним файлом скрипта, здесь собирается обычное веб-приложение со своим
  // index.html. Поэтому у режима свой корень (src/app) и свой выход (dist/app).
  //
  // Разметка лежит в src/app, а не в корне репозитория, специально: корневой
  // index.html Vite подхватывает сам в любом режиме, и он бы влез в сборки скрипта.
  const isApp = mode === 'app'

  // Мост и блокировщик выбираются по среде, а не по продукту: и десктопный
  // скрипт, и своё приложение живут внутри окна Tauri, где есть наш канал и права.
  const isDesktop = isTauri || isApp

  return {
    // В режиме app корень сборки — src/app: там лежит его index.html.
    ...(isApp ? { root: fileURLToPath(new URL('./src/app', import.meta.url)) } : {}),
    resolve: {
      alias: {
        // Пункт 3.4: выбор реализации Bridge на этапе сборки.
        //
        // Подмена пути надёжнее ветвления по __ANIMORI_PLATFORM__ внутри кода:
        // TauriBridge создаёт LazyStore на верхнем уровне модуля, и такой побочный
        // эффект Rollup вправе сохранить даже после удаления недостижимой ветви — вместе
        // с ним в бандл юзерскрипта уехали бы пакеты @tauri-apps/*.
        //
        // Ключ обязан идти до '@': совпадение строковых алиасов идёт по порядку.
        // Пересечения всё равно нет: '@' срабатывает лишь на точном '@' или префиксе '@/'.
        '@bridge-impl': fileURLToPath(
          new URL(
            isDesktop
              ? './src/shared/bridge/TauriBridge.ts'
              : './src/shared/bridge/MonkeyBridge.ts',
            import.meta.url,
          ),
        ),
        // Пункт 2.10, правка 2 августа: блокировщик рекламы есть только в десктопной
        // сборке. В браузере его работу делает расширение пользователя, и оно делает её
        // лучше: расширение видит и кадр плеера, куда наш код заглянуть не вправе.
        //
        // Выбор целью алиаса, а не проверкой платформы: initAdblock() тянет наблюдатель
        // мутаций, строку стилей и net-block.ts, и полагаться на вычистку недостижимой
        // ветви нельзя ровно по той же причине, что и с мостом выше.
        //
        // Ключ так же обязан идти до '@'.
        '@adblock-impl': fileURLToPath(
          new URL(
            isDesktop
              ? './src/shared/adblock/impl.desktop.ts'
              : './src/shared/adblock/impl.noop.ts',
            import.meta.url,
          ),
        ),
        // Пункт 1.3: дерево разделено на ядро (shared), надстройку над сайтом
        // (userscript) и своё приложение (app). Имена модулей при переезде не менялись,
        // сменилось только их место, поэтому старые имена сведены на новые каталоги
        // здесь. Иначе правка коснулась бы импортов во всех 63 файлах без пользы для
        // читателя, а история переезда утонула бы в шуме.
        //
        // Порядок ключей обязателен: побеждает первое совпадение, поэтому точные пути
        // идут раньше общих, а '@' остаётся последним.
        //
        // Те же соответствия живут в tsconfig.json (всё дерево) и в tsconfig.shared.json
        // (только ядро, пункт 1.5). Новый алиас ядра надо прописать во всех трёх файлах:
        // расхождение даёт самый неприятный сорт отказа — сборка идёт, а проверка
        // типов падает, или наоборот.
        //
        // Жизненный цикл — единственный, кто сменил слой: он знает про роуты и корни
        // чужого SPA, поэтому уехал к скрипту, а не остался в ядре.
        '@/core/lifecycle': fileURLToPath(
          new URL('./src/userscript/lifecycle.ts', import.meta.url),
        ),
        // Блокировщик работает через мост и сетевые правила, поэтому он в ядре,
        // хотя исторически лежал среди features.
        '@/features/adblock': fileURLToPath(new URL('./src/shared/adblock', import.meta.url)),
        '@/api': fileURLToPath(new URL('./src/shared/api', import.meta.url)),
        '@/bridge': fileURLToPath(new URL('./src/shared/bridge', import.meta.url)),
        '@/core': fileURLToPath(new URL('./src/shared/core', import.meta.url)),
        '@/utils': fileURLToPath(new URL('./src/shared/utils', import.meta.url)),
        '@/features': fileURLToPath(new URL('./src/userscript/features', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      // Этап 3-4: выбор реализации Bridge на этапе сборки.
      // Пункт 1.5: третье значение 'app' — своё приложение. Оно тоже живёт в окне
      // Tauri, но отличается от скрипта внутри окна: чужой разметки вокруг нет.
      __ANIMORI_PLATFORM__: JSON.stringify(isApp ? 'app' : isTauri ? 'tauri' : 'userscript'),
      // Пункт 5.3.5: номер версии нужен рантайму для заголовка User-Agent
      // нашего канала (src/shared/bridge/TauriBridge.ts). Берётся из того же package.json,
      // что и версия в шапке юзерскрипта: второй источник номера заводить нельзя,
      // см. комментарий в шапке файла.
      __ANIMORI_VERSION__: JSON.stringify(version),
      // Этап 2: флаги сборки Vue. Без них рантаим сыплет предупреждения в консоль.
      // Options API нигде не используется — только Composition API, поэтому false.
      __VUE_OPTIONS_API__: 'false',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    css: {
      preprocessorOptions: {
        scss: { api: 'modern-compiler' },
      },
    },
    plugins: [
      // vue() строго до monkey(): к monkey код должен прийти уже без SFC.
      vue(),
      ...(isDesktop
        ? []
        : [
            monkey({
              entry: 'src/userscript/main.ts',
              userscript: {
                // Пункт 4 naming guidelines AniList: чужой проект с их именем в названии
                // обязан нести пометку «UNOFFICIAL» либо оборот «for AniList».
                name: 'AniMori — Toolkit for AniList',
                namespace: 'http://tampermonkey.net/',
                version,
                description:
                  'Русский перевод, поиск, плеер, рейтинги Shiki и MAL, дерево хронологии, опенинги/эндинги, музыка, внешние ссылки, экспорт и сравнение списков Shikimori/AniList.',
                author: 'foulnike',
                license: 'MIT',
                // Только anilist.co. Прежний '*://shikimori.io/*' стал мёртвым после пункта 3.7:
                // точка входа выходит на шаге `if (IS_SHIKI) return`, то есть на Shikimori скрипт
                // грузился, чтобы сразу ничего не сделать. Перенос списков этого не требует:
                // после 3.6 списки Shikimori читаются через мост с любого домена, а разрешает
                // такой запрос @connect, а не @match — он ниже и остаётся на месте.
                match: ['https://anilist.co/*'],
                grant: [
                  'GM_xmlhttpRequest',
                  'GM_setValue',
                  'GM_getValue',
                  'GM_addStyle',
                  'GM_setClipboard',
                ],
                connect: [
                  'raw.githubusercontent.com',
                  'shikimori.io',
                  'shikimori.rip',
                  'smotret-anime.online',
                  'anime365.ru',
                  'graphql.anilist.co',
                  'kodik-api.com',
                  'api.animethemes.moe',
                ],
                // Адреса выдаёт Greasy Fork и менять их вручную нельзя: по ним идёт
                // автообновление уже установленных копий. При переименовании страницы
                // ссылки сверяются с тем, что показывает сама площадка.
                downloadURL:
                  'https://update.greasyfork.org/scripts/572948/AniMori%3A%20AniList%20Toolkit.user.js',
                updateURL:
                  'https://update.greasyfork.org/scripts/572948/AniMori%3A%20AniList%20Toolkit.meta.js',
              },
              build: {
                fileName: 'animori.user.js',
                metaFileName: 'animori.meta.js',
              },
            }),
          ]),
    ],
    build: {
      // У приложения своя папка выдачи: там лежит index.html с хешированными
      // файлами, и мешать их с двумя жёстко названными файлами скрипта незачем.
      // Путь абсолютный: в режиме app корень сборки — src/app, и относительный
      // 'dist' уехал бы внутрь исходников.
      outDir: isApp ? fileURLToPath(new URL('./dist/app', import.meta.url)) : 'dist',
      // Сборка tauri не чистит dist: в CI она идёт второй и рядом лежит уже собранный
      // animori.user.js для GreasyFork. Сборка app чистит только свою подпапку.
      emptyOutDir: !isTauri,
      minify: false,
      target: 'esnext',
      ...(isTauri
        ? {
            // Не lib-режим: нужен ровно один самодостаточный IIFE без экспортов,
            // который можно отдать WebView строкой.
            rollupOptions: {
              input: fileURLToPath(new URL('./src/userscript/main.ts', import.meta.url)),
              output: {
                format: 'iife' as const,
                inlineDynamicImports: true,
                entryFileNames: 'animori.tauri.js',
                assetFileNames: 'animori.tauri.[ext]',
              },
            },
            cssCodeSplit: false,
          }
        : {}),
    },
  }
})
