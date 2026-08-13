// Аварийный выход, когда прокси принят, но страница не грузится. TCP-щуп в proxy.rs
// не отличает прокси, который принимает соединение, но наружу не выпускает, а панель
// настроек живёт внутри незагрузившейся страницы — выключить прокси нечем.
//
// Пункт 3.1: сторож стережёт окно запасного вида (hybrid.rs), а не своё окно:
// своя сборка откроется и без сети, и панель настроек в ней останется доступной.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_store::StoreExt;

use crate::proxy::{self, ProxyOutcome};

/// Повторяют proxy.rs, а тот — src/core/proxy.ts: разойтись эти три места не должны.
const STORE_FILE: &str = "animori-settings.json";
const KEY_ENABLED: &str = "set_proxy_on";

/// Меньше — ложные срабатывания на живом, но медленном канале.
const PAGE_READY_TIMEOUT_MS: u64 = 12_000;

/// Прокси с логином спрашивает учётные данные за секунды, а не за десятки секунд.
const AUTH_SILENCE_MS: u64 = 3_000;

/// Шаг опроса: при известной причине ждать полный срок незачем.
const POLL_STEP_MS: u64 = 250;

/// Тихий перезаход разрешён ровно один: иначе мёртвый прокси даст карусель.
static RELOADED: AtomicBool = AtomicBool::new(false);

/// Отметка «страница ожила» отдельно от ProxyState: команда ниже зовётся всегда,
/// даже когда прокси выключен и сторож не заводится.
pub struct PageReady(AtomicBool);

/// НЕДОВЕРЕННЫЙ ВЫЗОВ из контекста anilist.co: худшее последствие
/// злоупотребления — сторож промолчит.
#[tauri::command]
pub fn animori_page_ready(state: State<'_, PageReady>) {
    state.0.store(true, Ordering::Relaxed);

    // Лимит попыток — на подбор пароля, а не на длину сеанса.
    #[cfg(windows)]
    crate::proxy_auth::note_page_ready();
}

/// За пределами Windows события авторизации нет вовсе.
fn auth_asked() -> bool {
    #[cfg(windows)]
    {
        crate::proxy_auth::was_asked()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Прокси отверг подставленную пару логина и пароля.
fn auth_rejected() -> bool {
    #[cfg(windows)]
    {
        crate::proxy_auth::was_rejected()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Чем кончилось ожидание отрезка времени.
enum Verdict {
    Ready,
    Rejected,
    Silent,
}

/// Выходит раньше срока, как только исход ясен.
fn wait(app: &AppHandle, total_ms: u64) -> Verdict {
    let mut left = total_ms;

    while left > 0 {
        let step = left.min(POLL_STEP_MS);
        std::thread::sleep(Duration::from_millis(step));
        left -= step;

        if app.state::<PageReady>().0.load(Ordering::Relaxed) {
            return Verdict::Ready;
        }

        if auth_rejected() {
            return Verdict::Rejected;
        }
    }

    Verdict::Silent
}

/// Отсчёт от создания окна, а не от конца навигации: при мёртвом прокси
/// она не завершится никогда.
///
/// Зовётся из hybrid.rs перед созданием окна и МОЖЕТ ПОВТОРЯТЬСЯ: запасной вид
/// разрешено закрыть и открыть снова.
pub fn spawn(app: &AppHandle) {
    // manage регистрирует состояние только один раз и второй вызов МОЛЧА ничего
    // не делает, поэтому флаги сбрасываются руками. Иначе сторож второго открытия
    // увидел бы «страница ожила» с прошлого раза и промолчал бы о мёртвом прокси.
    match app.try_state::<PageReady>() {
        Some(state) => state.0.store(false, Ordering::Relaxed),
        None => {
            app.manage(PageReady(AtomicBool::new(false)));
        }
    }

    // Карусели не будет: перезаход не пересоздаёт окно и сторожа заново не зовёт,
    // а новое открытие окна — новая попытка, и тихий перезаход ей тоже положен.
    RELOADED.store(false, Ordering::Relaxed);

    // При Off, Invalid и Unreachable окно идёт напрямую: диагноз был бы ложным.
    let Some((outcome, server)) = proxy::current_status(app) else {
        log::warn!("Сторож страницы не заведён: состояние прокси недоступно");
        return;
    };

    if outcome != ProxyOutcome::Applied {
        return;
    }

    // Логин задан: значит отсутствие запроса авторизации — сам по себе симптом.
    let has_login = proxy::window_auth(app).is_some();

    let app = app.clone();

    // Поток, а не задача рантайма: blocking_show на главном потоке повесил бы окно.
    std::thread::spawn(move || {
        let mut verdict = wait(&app, AUTH_SILENCE_MS);

        // Обработчик подписывается после создания окна: первый запрос мог проскочить мимо.
        if matches!(verdict, Verdict::Silent)
            && has_login
            && !auth_asked()
            && !RELOADED.swap(true, Ordering::Relaxed)
        {
            // Метка берётся из hybrid.rs: стережётся окно с чужим сайтом, а опечатка
            // в строке-литерале дала бы молчаливый пропуск вместо ошибки сборки.
            match app.get_webview_window(crate::hybrid::WINDOW_LABEL) {
                Some(window) => {
                    log::info!("Прокси не спросил учётные данные за 3 с — один тихий перезаход");
                    if let Err(e) = window.reload() {
                        log::warn!("Перезаход не удался: {e}");
                    }
                }
                None => log::warn!("Окно с сайтом не найдено, перезаход пропущен"),
            }
        }

        if matches!(verdict, Verdict::Silent) {
            verdict = wait(&app, PAGE_READY_TIMEOUT_MS - AUTH_SILENCE_MS);
        }

        if matches!(verdict, Verdict::Ready) {
            return;
        }

        let rejected = matches!(verdict, Verdict::Rejected) || auth_rejected();
        let seconds = PAGE_READY_TIMEOUT_MS / 1000;

        if rejected {
            log::warn!("Прокси {server} не принял учётные данные");
        } else {
            log::warn!("Страница не подала признаков жизни за {seconds} с при прокси {server}");
        }

        // При отказе по паролю выключать рабочий прокси — лечение хуже болезни.
        let message = if rejected {
            format!(
                "Прокси {server} не принял логин и пароль, поэтому AniList не загрузился.\n\n\
                 Проверьте их в файле %APPDATA%\\com.foulnike.animori\\animori-settings.json: \
                 ключи \"set_proxy_login\" и \"set_proxy_pass\". Панель настроек живёт внутри \
                 страницы, которая сейчас пуста.\n\n\
                 Выключить прокси и перезапустить приложение?"
            )
        } else if auth_asked() {
            format!(
                "AniList не загрузился за {seconds} секунд.\n\n\
                 Прокси {server} принял учётные данные, но трафик через него всё равно \
                 не проходит.\n\n\
                 Выключить прокси и перезапустить приложение?"
            )
        } else {
            format!(
                "AniList не загрузился за {seconds} секунд.\n\n\
                 Похоже, дело в прокси {server}: он принимает соединение, но трафик \
                 через него не проходит.\n\n\
                 Выключить прокси и перезапустить приложение?"
            )
        };

        let approved = app
            .dialog()
            .message(message)
            .title("AniMori: страница не загрузилась")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Выключить и перезапустить".to_string(),
                "Оставить как есть".to_string(),
            ))
            .blocking_show();

        if !approved {
            log::info!("Аварийное выключение прокси отклонено пользователем");
            return;
        }

        if let Err(err) = disable_proxy(&app) {
            log::error!("Не удалось выключить прокси: {err}");

            // Перезапуск был бы вредом: настройка та же, а сессия потеряна.
            app.dialog()
                .message(format!(
                    "Не удалось сохранить настройки: {err}\n\n\
                     Выключите прокси вручную: в файле \
                     %APPDATA%\\com.foulnike.animori\\animori-settings.json \
                     задайте \"set_proxy_on\": false."
                ))
                .title("AniMori: настройки не сохранены")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            return;
        }

        log::info!("Прокси выключен по аварийному сценарию, перезапуск");
        app.restart();
    });
}

/// Пишется РОВНО ОДИН ключ: адрес и логин человек вводил сам.
fn disable_proxy(app: &AppHandle) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(KEY_ENABLED, false);
    store.save().map_err(|e| e.to_string())
}
