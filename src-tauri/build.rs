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
//   animori_anilist_query     -> allow-animori-anilist-query
//   animori_file_read         -> allow-animori-file-read
//   animori_file_write        -> allow-animori-file-write
//   animori_proxy_status      -> allow-animori-proxy-status
//   animori_proxy_probe       -> allow-animori-proxy-probe
//   animori_page_ready        -> allow-animori-page-ready
//
// Разрешения разнесены по трём файлам, потому что окон три и доверие к ним разное:
//   capabilities/default.json — своё окно «main» на своей сборке;
//   capabilities/site.json    — окно «site» с настоящим anilist.co;
//   capabilities/auth.json    — окно «auth» со страницей входа (пункт 2.2).
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
    // Пункт 2.2: вход в AniList. start, status и logout выданы только своему окну,
    // submit — ещё и окну входа: страховочный скрипт отдаёт токен именно ей.
    // Окну запасного вида не выдана ни одна: там живёт чужой сайт, и право
    // подсунуть свой токен или выкинуть нас из аккаунта ему ни к чему.
    "animori_auth_start",
    "animori_auth_submit",
    "animori_auth_status",
    "animori_auth_logout",
    // Пункт 2.3: запрос к AniList из процесса оболочки. Адрес зашит, параметры —
    // только тело запроса и признак авторизации: пропуск в разметку не отдаётся.
    // Выдана только своему окну: из окна с чужим сайтом она была бы способом
    // говорить с API от нашего имени и править список чужими руками.
    "animori_anilist_query",
    // Пункт 2.5.2: дубль снимка в файл приватного каталога. Имя файла проверяется
    // по списку в files.rs, каталог выбирает сама оболочка. Выданы только своему окну:
    // чужому сайту нечего читать и переписывать в нашем снимке.
    "animori_file_read",
    "animori_file_write",
    // Пункт 5.3.6: диагностика прокси для карточки настроек. Обе только читают:
    // status отдаёт снимок состояния, probe открывает TCP-соединение на адрес из
    // файла настроек. Ни та, ни другая не принимают адрес параметром — иначе скрипт
    // чужого сайта получил бы сканер портов местной сети чужими руками.
    "animori_proxy_status",
    "animori_proxy_probe",
    // Пункт 5.3.7: отметка «страница ожила» для сторожа прокси. Ничего не читает,
    // ничего не возвращает и параметров не принимает — только поднимает флаг, по
    // которому сторож понимает, что вмешиваться не нужно.
    "animori_page_ready",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build")
}
