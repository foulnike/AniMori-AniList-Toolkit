// Пункт 4.3, правка по итогам первого живого запуска.
//
// Собственные команды приложения требуют разрешения в ACL Tauri. Без объявления
// здесь такого разрешения вообще не существует, и вызов из JS падает с сообщением
// "<имя> not allowed. Plugin not found" — именно так молчала кнопка перезагрузки.
//
// AppManifest::commands порождает разрешения с именами в kebab-case:
//   animori_reload            -> allow-animori-reload
//   animori_toggle_fullscreen -> allow-animori-toggle-fullscreen
//   animori_open_external     -> allow-animori-open-external
//   animori_auth_start        -> allow-animori-auth-start
//   animori_auth_submit       -> allow-animori-auth-submit
//   animori_auth_status       -> allow-animori-auth-status
//   animori_auth_logout       -> allow-animori-auth-logout
//   animori_anilist_query     -> allow-animori-anilist-query
//   animori_file_read         -> allow-animori-file-read
//   animori_file_write        -> allow-animori-file-write
//   animori_proxy_status      -> allow-animori-proxy-status
//   animori_proxy_probe       -> allow-animori-proxy-probe
//
// Файл разрешений теперь один, потому что окно с правами осталось одно:
//   capabilities/default.json — своё окно «main» на своей сборке.
//
// Окно входа (метка «login», пункт 2.2) прав не имеет вовсе, и файла capabilities
// у него нет сознательно: там чужая форма с паролем, а пропуск возвращается
// мимо разметки — в приёмник на 127.0.0.1. Для окна на внешнем адресе это тем
// важнее: вызвать можно ровно то, что перечислено в разрешениях.
//
// Окно «site» с настоящим anilist.co, его capabilities/site.json и две команды под него
// (animori_open_site и animori_page_ready) ушли вместе со старой реализацией десктопа.
//
// Правило на будущее: новая команда — три места.
//   1) invoke_handler в src/lib.rs
//   2) COMMANDS ниже
//   3) permissions в capability того окна, которому команда нужна
// Пропуск любого из трёх даёт тот же отказ на стороне JS.

const COMMANDS: &[&str] = &[
    "animori_reload",
    // Полноэкранный режим окна. Параметров нет: только переключение туда-обратно,
    // чтобы код в окне не мог запереть его в полном экране повторными вызовами.
    "animori_toggle_fullscreen",
    "animori_open_external",
    // Пункт 2.2: вход в AniList. Все четыре выданы только своему окну: окно входа
    // ничего не вызывает, оно лишь показывает чужую форму, а пропуск приезжает
    // в приёмник обычным запросом.
    "animori_auth_start",
    "animori_auth_submit",
    "animori_auth_status",
    "animori_auth_logout",
    // Пункт 2.3: запрос к AniList из процесса оболочки. Адрес зашит, параметры —
    // только тело запроса и признак авторизации: пропуск в разметку не отдаётся.
    "animori_anilist_query",
    // Пункт 2.5.2: дубль снимка в файл приватного каталога. Имя файла проверяется
    // по списку в files.rs, каталог выбирает сама оболочка.
    "animori_file_read",
    "animori_file_write",
    // Пункт 5.3.6: диагностика прокси для карточки настроек. Обе только читают:
    // status отдаёт снимок состояния, probe открывает TCP-соединение на адрес из
    // файла настроек. Ни та, ни другая не принимают адрес параметром — иначе код
    // в окне получил бы сканер портов местной сети чужими руками.
    "animori_proxy_status",
    "animori_proxy_probe",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build")
}
