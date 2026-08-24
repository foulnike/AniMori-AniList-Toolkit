import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Номер версии — из package.json, и это единственный его источник в ветке.
//
// Прежде здесь был versions.json с двумя номерами и сторож, проверявший, что
// номер приложения совпадает с package.json: именно оттуда его берёт Tauri, а по
// нему обновляются установленные копии. Продукт здесь теперь один, расходиться
// двум файлам негде — сторож ушёл вместе с причиной своего существования.
// Номер юзерскрипта живёт в ветке script и сюда больше не заглядывает.
//
// Чтение файла, а не import его JSON: импорт потребовал бы resolveJsonModule
// и тянул бы эти файлы в область проверки типов всего проекта.
const readJson = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf-8'))

const { version } = readJson('./package.json') as { version: string }

// Сборка одна: своё веб-приложение со своим index.html внутри окна Tauri.
//
// Прежде здесь было три режима (userscript, tauri, app) и ветвление по mode
// в десятке мест. Два первых собирали юзерскрипт: один для браузера, второй —
// одним IIFE для внедрения в окно с настоящим anilist.co. От гибрида мы отказались,
// скрипт уехал в ветку script — вместе с ними ушли плагин monkey, шапка
// юзерскрипта, жёсткие имена animori.tauri.js/css и вся обвязка IIFE.
//
// defineConfig принимает объект, а не функцию: mode больше не читается, и --mode
// в командах npm не нужен.
export default defineConfig({
  // Корень сборки — src/app: там лежит свой index.html. Разметка держится вне
  // корня репозитория сознательно: корневой index.html Vite подхватывает сам.
  root: fileURLToPath(new URL('./src/app', import.meta.url)),
  resolve: {
    alias: {
      // Пункт 3.4: реализация моста подставляется сборкой. Цель теперь одна —
      // окно Tauri, — но шов оставлен: он ничего не стоит, а вырезание потребовало бы
      // правки импортов при первой же нужде в другой платформе (Android из планов).
      //
      // Ключ обязан идти до '@': совпадение строковых алиасов идёт по порядку.
      '@bridge-impl': fileURLToPath(new URL('./src/shared/bridge/TauriBridge.ts', import.meta.url)),
      // Пункт 1.3: имена модулей при переезде в shared не менялись, сменилось только
      // их место — старые имена сведены на новые каталоги здесь.
      //
      // Порядок ключей обязателен: побеждает первое совпадение, поэтому точные пути
      // идут раньше общих, а '@' остаётся последним. Те же соответствия живут
      // в tsconfig.json и tsconfig.shared.json: расхождение даёт самый неприятный сорт
      // отказа — сборка идёт, а проверка типов падает, или наоборот.
      //
      // Из списка ушли четыре алиаса в src/userscript и src/shared/adblock:
      // жизненный цикл чужого SPA, словарь подмены слов в чужом DOM, его загрузчик
      // и блокировщик рекламы. Своему приложению всё это не нужно: чужой разметки
      // вокруг нет, оно рисует по-русски сразу и рекламы в своих экранах не показывает.
      '@/api': fileURLToPath(new URL('./src/shared/api', import.meta.url)),
      '@/bridge': fileURLToPath(new URL('./src/shared/bridge', import.meta.url)),
      '@/core': fileURLToPath(new URL('./src/shared/core', import.meta.url)),
      '@/utils': fileURLToPath(new URL('./src/shared/utils', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    // Платформа одна. Значение оставлено, а не вырезано: по нему ветвится общий
    // код ядра, а впереди Android — там появится второе значение.
    __ANIMORI_PLATFORM__: JSON.stringify('app'),
    // Пункт 5.3.5: номер версии нужен рантайму для заголовка User-Agent
    // нашего канала (src/shared/bridge/TauriBridge.ts) и для экранов приложения.
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
  plugins: [vue()],
  build: {
    // Путь абсолютный: корень сборки — src/app, и относительный 'dist' уехал бы
    // внутрь исходников. Именно на dist/app смотрит frontendDist в tauri.conf.json.
    outDir: fileURLToPath(new URL('./dist/app', import.meta.url)),
    // Теперь можно без оглядки: в dist пишет один продукт. Прежде здесь стояло
    // emptyOutDir: !isTauri — тауринная сборка не имела права снести уже собранный
    // рядом animori.user.js, и порядок шагов в CI был обязателен.
    emptyOutDir: true,
    minify: false,
    target: 'esnext',
  },
})
