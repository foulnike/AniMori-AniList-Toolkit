// Пункт 2.2: вход в AniList неявным потоком.
//
// Вход живёт в ОТДЕЛЬНОМ окне с отдельной меткой, а не в окне запасного
// вида и не в своём: через это окно проезжает адрес с токеном,
// и единственное его право — отдать токен назад (capabilities/auth.json).
//
// Токен НИКОГДА не уезжает в разметку: своему окну отдаётся только
// факт входа и срок. Запросы к API пойдут из Rust (пункт 2.3), поэтому
// в JS токен не нужен вовсе, а чего нет в странице, то нельзя и утащить.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

/// На эту метку ссылается capabilities/auth.json. Два места расходиться не должны.
pub const WINDOW_LABEL: &str = "auth";

/// Пункт 2.1: клиент «AniMori» в консоли разработчика AniList.
/// Секрета здесь нет и быть не может: неявный поток его не требует,
/// а в раздаваемом приложении любой секрет всё равно достанут.
const AUTHORIZE_URL: &str =
    "https://anilist.co/api/v2/oauth/authorize?client_id=48513&response_type=token";

/// Тот же файл, что у прокси и остальных настроек: второе хранилище
/// разошлось бы с первым при любой чистке настроек руками.
const STORE_FILE: &str = "animori-settings.json";
const KEY_TOKEN: &str = "auth_token";
const KEY_EXPIRES_AT: &str = "auth_expires_at";

/// Событие для своего окна: окно входа закрывается само, и без события
/// настройки узнали бы о входе только опросом в цикле.
const EVENT_CHANGED: &str = "animori://auth-changed";

/// Запас на жизнь токена: срок, истекающий в ближайшую минуту, считаем
/// истёкшим: иначе запрос ушёл бы с умирающим токеном и вернулся отказом.
const EXPIRY_MARGIN_SECS: u64 = 60;

/// Границы здравого смысла для ручной вставки: токен AniList — длинная
/// строка из трёх частей через точку. Проверка от опечаток, не от взлома.
const TOKEN_MIN_LEN: usize = 24;
const TOKEN_MAX_LEN: usize = 8192;

/// Всё, что разметка знает о входе. Самого токена здесь нет сознательно.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub authorized: bool,
    /// Секунды эпохи Unix. None — срок неизвестен (ручная вставка).
    pub expires_at: Option<u64>,
}

/// Страховка на случай, когда движок меняет только хэш адреса
/// и о навигации не сообщает: токен приходит именно во фрагменте,
/// а фрагмент — единственная часть адреса, которая на сервер не едет.
///
/// __TAURI_INTERNALS__ вместо @tauri-apps/api: скрипт инициализации — обычный
/// скрипт без сборки и импортов, тащить сюда бандл ради одного вызова незачем.
const CATCH_SCRIPT: &str = r#"(function () {
  function grab() {
    try {
      var hash = String(location.hash || '');
      if (hash.indexOf('access_token=') === -1) return false;

      var params = new URLSearchParams(hash.replace(/^#/, ''));
      var token = params.get('access_token');
      if (!token) return false;

      var api = window.__TAURI_INTERNALS__;
      if (!api || typeof api.invoke !== 'function') return false;

      var expires = Number(params.get('expires_in') || '0');
      api.invoke('animori_auth_submit', {
        token: token,
        expiresIn: expires > 0 ? expires : null,
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  if (grab()) return;
  window.addEventListener('hashchange', grab);
  document.addEventListener('DOMContentLoaded', grab);
})();
"#;

/// Секунды эпохи Unix. Шаг назад за 1970 год невозможен в работе,
/// поэтому при сбитых часах честнее считать срок неизвестным.
fn now_secs() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Проверка формы токена. Нужна из-за ручной вставки: человек легко
/// пришлёт адрес целиком или половину строки, и внятный отказ тут полезнее
/// молчаливого «вошло, но не работает» на каждом запросе.
fn check_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();

    if token.is_empty() {
        return Err("Токен пустой".to_string());
    }

    if token.len() < TOKEN_MIN_LEN || token.len() > TOKEN_MAX_LEN {
        return Err("Длина токена не похожа на токен AniList".to_string());
    }

    // Допустимые символы веб-токена. Пробел или слеш значат, что приехал
    // адрес или часть страницы, а не токен.
    let shaped = token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');

    if !shaped {
        return Err("В токене есть посторонние символы".to_string());
    }

    Ok(token.to_string())
}

/// Снимок состояния из файла настроек. Истёкший токен считается
/// отсутствием входа: с ним всё равно ничего не сделать.
fn read_status(app: &AppHandle) -> Result<AuthStatus, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    let has_token = store
        .get(KEY_TOKEN)
        .and_then(|v| v.as_str().map(|s| !s.trim().is_empty()))
        .unwrap_or(false);

    if !has_token {
        return Ok(AuthStatus {
            authorized: false,
            expires_at: None,
        });
    }

    let expires_at = store.get(KEY_EXPIRES_AT).and_then(|v| v.as_u64());

    let alive = match (expires_at, now_secs()) {
        (Some(deadline), Some(now)) => deadline > now + EXPIRY_MARGIN_SECS,
        // Срок неизвестен — верим токену: так бывает после ручной вставки.
        _ => true,
    };

    Ok(AuthStatus {
        authorized: alive,
        expires_at,
    })
}

/// Запись токена и срока. save() явный: плагин не пишет файл сам,
/// и без этого вызова вход жил бы только до закрытия приложения (дефект 4.5).
fn write_token(app: &AppHandle, token: &str, expires_in: Option<u64>) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    store.set(KEY_TOKEN, token.to_string());

    match (expires_in, now_secs()) {
        (Some(secs), Some(now)) if secs > 0 => store.set(KEY_EXPIRES_AT, now + secs),
        // Старый срок убирается обязательно: иначе новый токен считался бы
        // истёкшим по чужой отметке.
        _ => {
            store.delete(KEY_EXPIRES_AT);
        }
    }

    store.save().map_err(|e| e.to_string())
}

/// Общий хвост для обоих путей перехвата: запись, закрытие окна входа
/// и сообщение своему окну.
fn accept_token(app: &AppHandle, token: &str, expires_in: Option<u64>) -> Result<AuthStatus, String> {
    let token = check_token(token)?;
    write_token(app, &token, expires_in)?;

    // Окно входа больше не нужно. Искаем по метке, а не берём окно вызова:
    // ручная вставка приходит из своего окна, и его закрывать нельзя.
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if let Err(e) = window.close() {
            log::warn!("Окно входа не закрылось: {e}");
        }
    }

    let status = read_status(app)?;

    // Ошибка только в журнал: токен уже записан, и отвечать отказом было бы ложью.
    if let Err(e) = app.emit(EVENT_CHANGED, status.clone()) {
        log::warn!("Событие о входе не разошлось: {e}");
    }

    log::info!("Вход в AniList выполнен");
    Ok(status)
}

/// Открывает окно входа или возвращает фокус уже открытому.
fn open_login(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }

    let handle = app.clone();

    let window = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::External(AUTHORIZE_URL.parse().expect("адрес входа разбирается")),
    )
    .title("AniMori: вход в AniList")
    .inner_size(520.0, 760.0)
    .min_inner_size(420.0, 560.0)
    .resizable(true)
    .center()
    .initialization_script(CATCH_SCRIPT)
    // Основной путь перехвата: адрес возврата ловится ДО загрузки, и сама
    // страница с токеном в окне так и не появляется.
    //
    // Чужие домены просто отбрасываются: вход в AniList — это логин и пароль
    // на самом AniList, переходам куда-либо ещё в этом окне делать нечего.
    .on_navigation(move |url| {
        if let Some(fragment) = url.fragment() {
            if fragment.contains("access_token=") {
                let token = fragment
                    .split('&')
                    .filter_map(|pair| pair.split_once('='))
                    .find(|(key, _)| *key == "access_token")
                    .map(|(_, value)| value.to_string());

                let expires_in = fragment
                    .split('&')
                    .filter_map(|pair| pair.split_once('='))
                    .find(|(key, _)| *key == "expires_in")
                    .and_then(|(_, value)| value.parse::<u64>().ok());

                if let Some(token) = token {
                    if let Err(e) = accept_token(&handle, &token, expires_in) {
                        log::warn!("Токен из адреса возврата не принят: {e}");
                    }
                    return false;
                }
            }
        }

        let scheme = url.scheme();
        if scheme != "http" && scheme != "https" {
            return true;
        }

        match url.host_str() {
            Some(host) if host == "anilist.co" || host.ends_with(".anilist.co") => true,
            Some(host) => {
                log::warn!("Переход из окна входа отклонён: {host}");
                false
            }
            None => true,
        }
    })
    .build()
    .map_err(|e| e.to_string())?;

    let _ = &window;

    log::info!("Открыто окно входа в AniList");
    Ok(())
}

/// Пункт 2.2: открыть окно входа. Выдана только своему окну.
#[tauri::command]
pub fn animori_auth_start(app: AppHandle) -> Result<(), String> {
    open_login(&app)
}

/// Принять токен. Зовётся из окна входа (страховочный скрипт)
/// и из своего окна (ручная вставка). Больше никому она не выдана:
/// окно запасного вида с чужим сайтом могло бы подсунуть свой токен.
#[tauri::command]
pub fn animori_auth_submit(
    app: AppHandle,
    token: String,
    expires_in: Option<u64>,
) -> Result<AuthStatus, String> {
    accept_token(&app, &token, expires_in)
}

/// Состояние входа без самого токена.
#[tauri::command]
pub fn animori_auth_status(app: AppHandle) -> Result<AuthStatus, String> {
    read_status(&app)
}

/// Выход: чистит только свои два ключа. Остальные настройки человек
/// вводил сам, и терять их при выходе из аккаунта незачем.
#[tauri::command]
pub fn animori_auth_logout(app: AppHandle) -> Result<AuthStatus, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.delete(KEY_TOKEN);
    store.delete(KEY_EXPIRES_AT);
    store.save().map_err(|e| e.to_string())?;

    let status = read_status(&app)?;

    if let Err(e) = app.emit(EVENT_CHANGED, status.clone()) {
        log::warn!("Событие о выходе не разошлось: {e}");
    }

    log::info!("Выход из аккаунта AniList");
    Ok(status)
}
