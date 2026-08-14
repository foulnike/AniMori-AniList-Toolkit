// Пункт 2.2: вход в аккаунт AniList.
//
// Своей формы входа у нас нет и не будет: логин с паролем человек вводит
// только на самом AniList. Наше дело — увести туда и поймать пропуск на
// обратном пути.
//
// Пропуск приезжает во фрагменте адреса (после #), а фрагмент на сервер не
// уезжает никогда: прочитать его может лишь страница в браузере. Поэтому в
// цепочке стоит страничка-стрелочник на GitHub Pages: она читает фрагмент и
// пересылает пропуск обычным адресом. Её адрес записан у клиента AniList как
// единственный адрес возврата: он постоянный, а адрес компьютера или
// телевизора меняется от сети к сети.
//
// Принимает пропуск крошечный сервер внутри приложения. Слушает он не только
// себя, но и домашнюю сеть: тогда тот же вход годится для телевизора, где
// пароль набирают телефоном по QR-коду.
//
// Пропуск никогда не уезжает в разметку: своему окну отдаётся только факт
// входа и срок. Запросы к API пойдут из Rust (пункт 2.3), а чего нет в
// странице, того нельзя и утащить.

use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

/// Порт приёмника. Постоянный, а не свободный из системы: этот же номер
/// проверяет страничка-стрелочник. Случайный порт пришлось бы согласовывать
/// при каждом входе.
pub const PORT: u16 = 48513;

/// Страничка-стрелочник. Ровно этот адрес должен стоять у клиента AniMori
/// в консоли разработчика AniList, иначе вход отдаст пустую страницу.
const RELAY_URL: &str = "https://foulnike.github.io/AniMori-AniList-Toolkit/";

const AUTHORIZE_BASE: &str = "https://anilist.co/api/v2/oauth/authorize";

/// Пункт 2.1: клиент AniMori. Секрета здесь нет и быть не может: неявный
/// поток его не требует, а в раздаваемом приложении секрет всё равно достанут.
const CLIENT_ID: &str = "48513";

/// Сколько приёмник ждёт пропуск. Пять минут человеку хватает, а открытый
/// порт без нужды висеть не должен.
const WAIT_SECS: u64 = 300;

/// Шаг ожидания входящих. Приёмник неблокирующий: с обычным accept поток
/// висел бы до первого соединения и никогда не заметил, что срок вышел.
const POLL_STEP_MS: u64 = 200;

/// Сроки на чтение и ответ одному соединению. Без них молчащий клиент
/// занял бы приёмник до самого конца ожидания.
const IO_TIMEOUT_MS: u64 = 3000;

/// Тот же файл, что у прокси и остальных настроек: второе хранилище
/// разошлось бы с первым при любой чистке настроек руками.
const STORE_FILE: &str = "animori-settings.json";
const KEY_TOKEN: &str = "auth_token";
const KEY_EXPIRES_AT: &str = "auth_expires_at";

/// Событие для своего окна: пропуск приходит из браузера, то есть со стороны,
/// и без события настройки узнали бы о входе только опросом в цикле.
const EVENT_CHANGED: &str = "animori://auth-changed";

/// Запас на жизнь пропуска: срок, истекающий в ближайшую минуту, считаем
/// истёкшим — иначе запрос ушёл бы с умирающим пропуском и вернулся отказом.
const EXPIRY_MARGIN_SECS: u64 = 60;

/// Границы здравого смысла для ручной вставки: пропуск AniList — длинная
/// строка из трёх частей через точку. Проверка от опечаток, не от взлома.
const TOKEN_MIN_LEN: usize = 24;
const TOKEN_MAX_LEN: usize = 8192;

/// Приёмник поднят? Он один на приложение: второй попытался бы занять тот
/// же порт и упал бы с отказом ровно там, где человек нажал кнопку.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Всё, что разметка знает о входе. Самого пропуска здесь нет сознательно.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub authorized: bool,
    /// Секунды эпохи Unix. None — срок неизвестен (ручная вставка).
    pub expires_at: Option<u64>,
}

/// Ответ на нажатие «Войти»: чем открылся браузер и что показать на экране
/// для входа с телефона.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    /// Адрес для этого же компьютера. Им открывается браузер.
    pub local_url: String,
    /// Адрес в домашней сети. None — сети нет, вход с телефона невозможен.
    pub lan_url: Option<String>,
    /// Картинка QR для домашнего адреса. Рисуется в Rust: тащить в разметку
    /// целую библиотеку ради одной картинки незачем.
    pub qr_svg: Option<String>,
    /// Сколько секунд приёмник ждёт. Экран показывает это человеку.
    pub wait_secs: u64,
}

/// Секунды эпохи Unix. Шаг назад за 1970 год в работе невозможен, поэтому при
/// сбитых часах честнее считать срок неизвестным.
fn now_secs() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Проверка формы пропуска. Нужна из-за ручной вставки: человек легко
/// пришлёт адрес целиком или половину строки, и внятный отказ тут полезнее
/// молчаливого «вошло, но не работает» на каждом запросе.
fn check_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();

    if token.is_empty() {
        return Err("Пропуск пустой".to_string());
    }

    if token.len() < TOKEN_MIN_LEN || token.len() > TOKEN_MAX_LEN {
        return Err("Длина не похожа на пропуск AniList".to_string());
    }

    // Допустимые символы веб-токена. Пробел или слеш значат, что приехал
    // адрес или часть страницы, а не пропуск.
    let shaped = token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');

    if !shaped {
        return Err("В пропуске есть посторонние символы".to_string());
    }

    Ok(token.to_string())
}

/// Снимок состояния из файла настроек. Истёкший пропуск считается
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
        // Срок неизвестен — верим пропуску: так бывает после ручной вставки.
        _ => true,
    };

    Ok(AuthStatus {
        authorized: alive,
        expires_at,
    })
}

/// Запись пропуска и срока. save() явный: плагин не пишет файл сам,
/// и без этого вызова вход жил бы только до закрытия приложения (дефект 4.5).
fn write_token(app: &AppHandle, token: &str, expires_in: Option<u64>) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    store.set(KEY_TOKEN, token.to_string());

    match (expires_in, now_secs()) {
        (Some(secs), Some(now)) if secs > 0 => store.set(KEY_EXPIRES_AT, now + secs),
        // Старый срок убирается обязательно: иначе новый пропуск считался бы
        // истёкшим по чужой отметке.
        _ => {
            store.delete(KEY_EXPIRES_AT);
        }
    }

    store.save().map_err(|e| e.to_string())
}

/// Общий хвост для всех путей: запись и сообщение своему окну.
fn accept_token(
    app: &AppHandle,
    token: &str,
    expires_in: Option<u64>,
) -> Result<AuthStatus, String> {
    let token = check_token(token)?;
    write_token(app, &token, expires_in)?;

    let status = read_status(app)?;

    // Ошибка только в журнал: пропуск уже записан, и отвечать отказом было бы ложью.
    if let Err(e) = app.emit(EVENT_CHANGED, status.clone()) {
        log::warn!("Событие о входе не разошлось: {e}");
    }

    log::info!("Вход в AniList выполнен");
    Ok(status)
}

/// Кодирование значения для адреса. Своё, а не библиотечное: нужны ровно два
/// значения в одной строке, и целая зависимость ради этого не оправдана.
fn encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + raw.len() / 2);

    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => {
                out.push('%');
                out.push_str(&hex(other >> 4));
                out.push_str(&hex(other & 0x0F));
            }
        }
    }

    out
}

/// Одна шестнадцатиричная цифра верхним регистром.
fn hex(nibble: u8) -> String {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    (DIGITS[nibble as usize] as char).to_string()
}

/// Обратное превращение значения из адреса.
fn decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let pair = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                match pair.and_then(|p| u8::from_str_radix(p, 16).ok()) {
                    Some(value) => {
                        out.push(value);
                        index += 3;
                    }
                    None => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&out).to_string()
}

/// Значение параметра из строки запроса.
fn param(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| *name == key)
        .map(|(_, value)| decode(value))
}

/// Адрес входа. state — куда стрелочнику вернуть пропуск: этот адрес зависит
/// от того, кто спрашивает (свой компьютер или телефон в домашней сети).
fn authorize_url(origin: &str) -> String {
    [
        AUTHORIZE_BASE,
        "?client_id=",
        CLIENT_ID,
        "&response_type=token&redirect_uri=",
        &encode(RELAY_URL),
        "&state=",
        &encode(origin),
    ]
    .concat()
}

/// Наш адрес в домашней сети. Спрашивается у самой системы: перебирать
/// сетевые устройства руками пришлось бы по-разному на каждой платформе.
///
/// Ни одного байта не отправляется: connect у UDP только выбирает исходящий
/// путь, зато после него можно спросить, каким адресом мы в этом пути видны.
fn lan_ip() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 53)).ok()?;

    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

/// Адрес входа приёмника для заданного узла. Склейка через concat, а не
/// шаблон: в шаблоне легко опечататься скобкой и увезти её в адрес.
fn login_url(host: &str) -> String {
    ["http://", host, ":", &PORT.to_string(), "/login"].concat()
}

/// Картинка QR. Уровень M — середина между размером и терпимостью к засветке
/// на экране телевизора.
fn qr_code_svg(data: &str) -> Option<String> {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};

    let code = QrCode::with_error_correction_level(data, EcLevel::M).ok()?;

    Some(
        code.render::<svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(svg::Color("#0b1622"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

/// Домашний ли адрес. Пропуск возвращается только в свой компьютер или в
/// домашнюю сеть: чужой адрес здесь означал бы утечку пропуска наружу.
fn is_home_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }

    match host.parse::<Ipv4Addr>() {
        Ok(ip) => ip.is_loopback() || ip.is_private(),
        Err(_) => false,
    }
}

/// Каким адресом до нас дошли. Берётся из заголовка Host, потому что для
/// своего компьютера и для телефона это разные адреса, а стрелочнику нужно
/// вернуть пропуск именно туда, откуда пришли.
fn origin_from_host(host: &str) -> String {
    let cleaned = host.trim();
    let fallback = ["http://127.0.0.1:", &PORT.to_string()].concat();

    let Some((name, port)) = cleaned.rsplit_once(':') else {
        return fallback;
    };

    if port != PORT.to_string() || !is_home_host(name) {
        return fallback;
    }

    ["http://", cleaned].concat()
}

/// Ответ одной строкой. Свой мини-сервер вместо готового: нам нужны два
/// адреса и три ответа, а любая библиотека сервера тянет с собой целый мир.
fn reply(mut stream: TcpStream, code: u16, kind: &str, body: &str) {
    let reason = match code {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };

    let head = [
        "HTTP/1.1 ",
        &code.to_string(),
        " ",
        reason,
        "\r\nContent-Type: ",
        kind,
        "\r\nContent-Length: ",
        &body.as_bytes().len().to_string(),
        "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
    ]
    .concat();

    let sent = stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body.as_bytes()))
        .and_then(|_| stream.flush());

    if let Err(e) = sent {
        log::warn!("Ответ приёмника не ушёл: {e}");
    }
}

/// Отправка человека на страницу входа AniList.
fn redirect(mut stream: TcpStream, url: &str) {
    let head = [
        "HTTP/1.1 302 Found\r\nLocation: ",
        url,
        "\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
    ]
    .concat();

    if let Err(e) = stream.write_all(head.as_bytes()).and_then(|_| stream.flush()) {
        log::warn!("Отправка на вход не ушла: {e}");
    }
}

/// Страница-итог для браузера или телефона. Сверстана тёмной под нашу
/// палитру, чтобы возврат не выглядел чужим.
fn page(stream: TcpStream, title: &str, text: &str) {
    let body = [
        "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
        "<title>AniMori</title><style>:root{color-scheme:dark}",
        "body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;",
        "background:#0b1622;color:#e7edf7;font:16px/1.5 system-ui,sans-serif;text-align:center}",
        "h1{margin:0 0 8px;font-size:22px;color:#4c9ffe}</style></head><body><main><h1>",
        title,
        "</h1><p>",
        text,
        "</p></main></body></html>",
    ]
    .concat();

    reply(stream, 200, "text/html; charset=utf-8", &body);
}

/// Одно соединение. true — пропуск получен, приёмник больше не нужен.
fn serve(app: &AppHandle, stream: TcpStream) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(IO_TIMEOUT_MS)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(IO_TIMEOUT_MS)));

    let copy = match stream.try_clone() {
        Ok(copy) => copy,
        Err(e) => {
            log::warn!("Соединение не прочитать: {e}");
            return false;
        }
    };

    let mut reader = BufReader::new(copy);

    let mut request = String::new();
    if let Err(e) = reader.read_line(&mut request) {
        log::warn!("Запрос к приёмнику не прочитан: {e}");
        return false;
    }

    // Заголовки до пустой строки. Нужен ровно один — Host.
    let mut host = String::new();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }

        if line.trim().is_empty() {
            break;
        }

        if line.to_ascii_lowercase().starts_with("host:") {
            host = line[5..].trim().to_string();
        }
    }

    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");

    if method != "GET" {
        reply(stream, 405, "text/plain; charset=utf-8", "Только GET");
        return false;
    }

    let (path, query) = target.split_once('?').unwrap_or((target, ""));

    match path {
        "/" | "/login" => {
            redirect(stream, &authorize_url(&origin_from_host(&host)));
            false
        }
        "/token" => {
            let token = param(query, "access_token");
            let expires_in = param(query, "expires_in").and_then(|v| v.parse::<u64>().ok());

            match token {
                Some(token) => match accept_token(app, &token, expires_in) {
                    Ok(_) => {
                        page(
                            stream,
                            "Готово",
                            "Вход выполнен. Эту страницу можно закрыть и вернуться в AniMori.",
                        );
                        true
                    }
                    Err(e) => {
                        log::warn!("Пропуск из адреса возврата не принят: {e}");
                        page(stream, "Не вышло", "Пропуск не принят. Попробуй ещё раз.");
                        false
                    }
                },
                None => {
                    page(stream, "Не вышло", "В адресе возврата нет пропуска.");
                    false
                }
            }
        }
        _ => {
            reply(stream, 404, "text/plain; charset=utf-8", "Нет такой страницы");
            false
        }
    }
}

/// Поднимает приёмник, если его ещё нет.
fn start_receiver(app: &AppHandle) -> Result<(), String> {
    if RUNNING.load(Ordering::SeqCst) {
        return Ok(());
    }

    // Слушаем все свои адреса, а не только 127.0.0.1: иначе телефон из
    // домашней сети до приёмника не дотянется и вход по QR стал бы невозможен.
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, PORT))
        .map_err(|e| ["Приёмник не занял свой порт: ", &e.to_string()].concat())?;

    listener
        .set_nonblocking(true)
        .map_err(|e| ["Приёмник не перевести в ожидание: ", &e.to_string()].concat())?;

    RUNNING.store(true, Ordering::SeqCst);

    let handle = app.clone();

    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(WAIT_SECS);

        loop {
            if Instant::now() >= deadline {
                log::info!("Приёмник входа закрыт: время ожидания вышло");
                break;
            }

            match listener.accept() {
                Ok((stream, _)) => {
                    if serve(&handle, stream) {
                        log::info!("Приёмник входа закрыт: пропуск получен");
                        break;
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(POLL_STEP_MS));
                }
                Err(e) => {
                    log::warn!("Приёмник входа сломался: {e}");
                    break;
                }
            }
        }

        RUNNING.store(false, Ordering::SeqCst);
    });

    log::info!("Приёмник входа слушает свой порт");
    Ok(())
}

/// Пункт 2.2: начать вход. Поднимает приёмник, открывает браузер и отдаёт
/// экрану QR для входа с телефона.
#[tauri::command]
pub fn animori_auth_start(app: AppHandle) -> Result<LoginStart, String> {
    start_receiver(&app)?;

    let local_url = login_url("127.0.0.1");
    let lan_url = lan_ip().map(|ip| login_url(&ip.to_string()));
    let qr_svg = lan_url.as_deref().and_then(qr_code_svg);

    // Отказ браузера — не отказ входа: приёмник уже слушает, и остаётся QR
    // с адресом, который человек может открыть руками.
    if let Err(e) = app.opener().open_url(local_url.clone(), None::<&str>) {
        log::warn!("Браузер не открылся: {e}");
    }

    Ok(LoginStart {
        local_url,
        lan_url,
        qr_svg,
        wait_secs: WAIT_SECS,
    })
}

/// Ручная вставка пропуска. Запасной путь на случай, когда возврат не дошёл:
/// стрелочник тогда показывает пропуск на экране.
#[tauri::command]
pub fn animori_auth_submit(
    app: AppHandle,
    token: String,
    expires_in: Option<u64>,
) -> Result<AuthStatus, String> {
    accept_token(&app, &token, expires_in)
}

/// Состояние входа без самого пропуска.
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
