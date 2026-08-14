// Главное окно приложения грузит СВОЮ сборку (dist/app), а не чужой сайт.
// Настоящий anilist.co со внедрённым бандлом скрипта живёт в hybrid.rs
// и открывается вторым окном по команде (пункт 3.7).
//
// Метка «main» остаётся у своего окна: на неё ссылается capabilities/default.json.
// Окно создаётся здесь, а не в tauri.conf.json, чтобы оба окна строились одним
// способом и в одном месте была видна разница между ними.

use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// Сетевой блокировщик. Только Windows: он построен на событиях WebView2.
// Потребитель один — гибридное окно: реклама есть только на чужом сайте.
#[cfg(windows)]
mod adblock;

// Авторизация окна у прокси. Тоже только Windows: целиком событие WebView2.
#[cfg(windows)]
mod proxy_auth;

// Пункт 2.2: вход в аккаунт AniList отдельным окном.
mod auth;

// Запасной вид: настоящий сайт во втором окне.
mod hybrid;

mod updater;

// Прокси для трафика окна. Без cfg сознательно: чтение настроек одинаково везде,
// разница в применении спрятана внутри модуля — на Linux будет внятное
// предупреждение в журнале, а не пропавшая настройка.
mod proxy;
mod proxy_guard;

/// Что запоминается между запусками. Не StateFlags::all(): сохранённый VISIBLE даёт
/// запуск без единого окна, а из FULLSCREEN в окне без меню нечем выйти.
/// Флаги общие и на сохранение, и на восстановление: это один параметр плагина.
fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// Перезагружает окно, из которого пришёл вызов: страница сайта этого не может —
/// location.reload() на внешнем URL не даёт ничего, а в JS-API метода нет вовсе.
/// Окно приходит параметром, а не ищется по метке: теперь окон два, и перезагружать
/// надо то, откуда просили.
#[tauri::command]
fn animori_reload(window: WebviewWindow) -> Result<(), String> {
    window.reload().map_err(|e| e.to_string())
}

/// Переключает полноэкранный режим окна и возвращает новое состояние: без него
/// его пришлось бы спрашивать вторым вызовом после каждого нажатия.
///
/// Своя команда, а не core:window:allow-set-fullscreen: разрешение из core выдаётся окну
/// целиком, то есть любому скрипту на anilist.co; здесь право сведено к одному действию.
#[tauri::command]
fn animori_toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// Открывает адрес в браузере по умолчанию. В WebView2 target="_blank" и window.open()
/// превращаются в запрос нового окна, и без обработчика он отбрасывается МОЛЧА:
/// ни окна, ни ошибки, ни события на стороне JS.
///
/// Схема проверяется здесь, а не только в мосте: вызов приходит и из контекста
/// anilist.co, то есть от недоверенного кода. Без проверки чужой скрипт мог бы попросить
/// file:// или свою схему и запустить произвольное приложение.
#[tauri::command]
fn animori_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();

    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        return Err(format!("Схема адреса не разрешена: {trimmed}"));
    }

    // None во втором аргументе — «браузер по умолчанию».
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Пункт 3.1: открывает запасное окно с настоящим сайтом.
///
/// Параметров нет сознательно: адрес зашит в hybrid.rs. Иначе команда стала бы
/// способом открыть любой сайт в окне с правами нашего приложения.
#[tauri::command]
fn animori_open_site(app: AppHandle) -> Result<(), String> {
    hybrid::open(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        // Плагин открывает адреса в системных приложениях и нужен только со стороны Rust:
        // opener:allow-open-url в окне на anilist.co открыл бы что угодно любому скрипту.
        .plugin(tauri_plugin_opener::init())
        // Память геометрии окон. Регистрация именно в цепочке Builder, а не в setup():
        // плагины оттуда поднимаются ДО setup, а окно создаётся внутри него. Плагин
        // восстановит геометрию сам; поменяешь порядок — перестанет без единой ошибки.
        // Разрешений в capabilities ему не выдано: из JS команды не вызываются.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        // Автообновление; обоснования — в updater.rs. Разрешений тоже нет, и здесь это
        // критичнее всего: updater:default означал бы право чужого скрипта запустить
        // загрузку и установку исполняемого файла.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Список команд дублируется в build.rs и в файлах capabilities: разрешено
        // ровно то, что перечислено в capability нужного окна. Пропуск любого из трёх мест
        // даёт отказ вида "... not allowed. Plugin not found".
        //
        // Команды из модулей указываются с путём: generate_handler! обращается к функции
        // по имени, и без префикса сборка падает с E0425.
        .invoke_handler(tauri::generate_handler![
            proxy_guard::animori_page_ready,
            animori_reload,
            animori_toggle_fullscreen,
            animori_open_external,
            animori_open_site,
            auth::animori_auth_start,
            auth::animori_auth_submit,
            auth::animori_auth_status,
            auth::animori_auth_logout,
            proxy::animori_proxy_status,
            proxy::animori_proxy_probe
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Прокси — СТРОГО до создания первого окна: движок читает аргументы один раз,
            // на первом окне — и теперь первым идёт свое окно, а гибридное открывается
            // позже и пользуется тем же окружением. Здесь же заводится ProxyState,
            // без которого animori_proxy_status не ответит.
            proxy::apply_to_webview(app.handle());

            // Своё окно: WebviewUrl::default() — это index.html из frontendDist, то есть
            // наша сборка dist/app. Никаких скриптов инициализации здесь нет: разметка
            // своя, и стили со скриптом приходят из самого index.html.
            WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::default())
                .title("AniMori")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1024.0, 600.0)
                .resizable(true)
                .center()
                .build()?;

            // Проверка обновлений — последним шагом и только фоновой задачей: запрос
            // прямо здесь задержал бы окно на ответ GitHub, а при мёртвой сети — на весь таймаут.
            updater::spawn_check(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
