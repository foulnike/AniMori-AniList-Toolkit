import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import monkey from 'vite-plugin-monkey'

// Ветка script: здесь собирается ровно один продукт — юзерскрипт для anilist.co.
//
// Режима tauri в этом файле больше нет. Прежний десктоп вставлял тот же код скрипта
// в чужую страницу внутри своего окна (dist/animori.tauri.js уезжал в Rust через
// include_str!), и от этой реализации мы отказались целиком. Новый клиент рисует свои
// экраны, живёт в ветке app-3.0-dev и собирается своим конфигом.
//
// Почему сборки разошлись, а не остался один конфиг с тремя режимами: общая сборка
// связывала продукты там, где связи нет. Правка в скрипте поднимала номер приложению,
// а сборка скрипта в CI тянула за собой Rust-часть и проверку типов чужих экранов.
//
// Единый источник номера версии — package.json.
//
// Раньше номер был прописан здесь строкой, и при выпуске его приходилось поднимать
// в двух местах. Пропуск одного из них стоит дорого: GreasyFork смотрит только на
// шапку скрипта — со старым номером он решит, что обновлять нечего, и люди останутся
// на прежней сборке молча.
//
// Чтение файла, а не import его JSON: импорт потребовал бы resolveJsonModule
// и тянул бы package.json в область проверки типов всего проекта.
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string }

// Метаданные ниже перенесены 1:1 из шапки монолита animori.user.js (строки 1-25),
// кроме version — он теперь приезжает из package.json.
// Не добавляй @match/@grant/@connect "на всякий случай": лишние права ломают ревю GreasyFork.
//
// Функции с mode здесь тоже больше нет: режим остался один, и ветвление по нему
// только запутывало бы чтение.
export default defineConfig({
  resolve: {
    alias: {
      // Пункт 3.4: реализация Bridge подставляется псевдопутём.
      //
      // Цель теперь одна: TauriBridge уехал вместе с десктопом. Сам псевдопуть оставлен
      // намеренно — снять его значило бы править импорты в src/bridge/index.ts и точке
      // входа без пользы для читателя, а IBridge остаётся единственным местом, где
      // описано, что скрипт вправе просить у среды.
      //
      // Ключ обязан идти до '@': совпадение строковых алиасов идёт по порядку.
      // Пересечения всё равно нет: '@' срабатывает лишь на точном '@' или префиксе '@/'.
      '@bridge-impl': fileURLToPath(new URL('./src/bridge/MonkeyBridge.ts', import.meta.url)),
      // Пункт 2.10, правка 2 августа: блокировщика рекламы в браузере нет и не будет.
      // Его работу делает расширение пользователя, и делает её лучше: расширение видит
      // и кадр плеера, куда наш код заглянуть не вправе.
      //
      // Заглушки, а не убранные вызовы в точке входа: ни main.ts, ни панель настроек
      // не должны знать о среде. Сигнатуры impl.noop.ts повторяют прежний контракт,
      // поэтому расхождение станет ошибкой проверки типов, а не тихой поломкой.
      //
      // Ключ так же обязан идти до '@'.
      '@adblock-impl': fileURLToPath(
        new URL('./src/features/adblock/impl.noop.ts', import.meta.url),
      ),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    // Значение стало постоянным, и это не мусор: код местами спрашивает среду, а
    // постоянная строка позволяет Rollup выбросить недостижимые ветви целиком.
    __ANIMORI_PLATFORM__: JSON.stringify('userscript'),
    // Пункт 5.3.5: номер версии нужен рантайму. Берётся из того же package.json,
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
    monkey({
      entry: 'src/main.ts',
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
  ],
  build: {
    outDir: 'dist',
    // Чистка dist снова безусловна: второй сборки рядом больше не идёт, и держать
    // в папке файлы прошлого продукта незачем.
    emptyOutDir: true,
    minify: false,
    target: 'esnext',
  },
})
