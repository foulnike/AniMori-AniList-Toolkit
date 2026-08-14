// Пункт 4.3, правка по итогам первого живого запуска.
//
// Собственные команды приложения требуют разрешения в ACL Tauri. Без объявления
// здесь такого разрешения вообще не существует, и вызов из JS падает с сообщением
// "<имя> not allowed. Plugin not found" — именно так молчала кнопка перезагрузки.
// Для окна на внешнем URL (WebviewUrl::External + remote.urls) это тем важнее:
// вызвать можно ровно то, что перечислено в разрешениях.
//
// AppManifest::commands порождает разрешения с именами в kebab-case:
//   animori_reload            -> allow-animori-reload
//   animori_toggle_fullscreen -> allow-animori-toggle-fullscreen
//   animori_open_external     -> allow-animori-open-external
//   animori_open_site         -> allow-animori-open-site
//   animori_auth_start        -> allow-animori-auth-start
//   animori_auth_submit       -> allow-animori-auth-submit
//   animori_auth_status       -> allow-animori-auth-status
//   animori_auth_logout       -> allow-animori-auth-logout
//   animori_proxy_status      -> allow-animori-proxy-status
//   animori_proxy_probe       -> allow-animori-proxy-probe
//   animori_page_ready        -> allow-animori-page-ready
//
// Разрешения разнесены по трём файлам, потому что окон три и доверие к ним разное:
//   capabilities/default.json — своё окно «main» на своей сборке;
//   capabilities/site.json    — окно «site» с настоящим anilist.co;
//   capabilities/auth.json    — окно «auth» со страницей входа AniList.
//
// Правило на будущее: новая команда — три места.
//   1) invoke_handler в src/lib.rs
//   2) COMMANDS ниже
//   3) permissions в capability того окна, которому команда нужна
// Пропуск любого из трёх даёт тот же отказ на стороне JS.

const COMMANDS: &[&str] = &[
    "animori_reload",
    // Полноэкранный режим окна. Параметров нет: только переключение туда-обратно,
    // чтобы чужой скрипт не мог запереть окно в полном экране повторными вызовами.
    "animori_toggle_fullscreen",
    "animori_open_external",
    // Пункт 3.1: открытие запасного вида с настоящим сайтом. Параметров нет и не будет:
    // адрес зашит в hybrid.rs, иначе команда стала бы способом открыть любой сайт
    // в окне с правами нашего приложения. Выдана только своему окну.
    "animori_open_site",
    // Пункт 2.2: вход в AniList. start и status нужны только своему окну,
    // submit — ещё и окну входа (страховочный скрипт со страницы возврата).
    // Окну запасного вида не выдана ни одна из них: там живёт чужой сай