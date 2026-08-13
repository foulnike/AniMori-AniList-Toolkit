// Запасной вид: настоящий anilist.co в отдельном окне с внедрённым бандлом
// скрипта. До пункта 3.1 это было ГЛАВНОЕ окно приложения, теперь — второе
// и по команде. Код переехал целим именно ради 3.7: выключенный и забытый
// он к тому времени успел бы сгнить.
//
// Метка окна другая, и это главное в переезде: разрешения выдаются окну
// по метке, а здешнее окно грузит чужой сайт и потому доверия заслуживает
// меньше, чем своё. См. capabilities/site.json рядом с capabilities/default.json.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// На эту метку ссылаются capabilities/site.json и сторож страницы
/// в proxy_guard.rs. Три места расходиться не должны.
pub const WINDOW_LABEL: &str = "site";

// Не корень домена: на anilist.co/ лендинг для гостей, авторизованного уносит на /home.
const ANILIST_URL: &str = "https://anilist.co/home";

// Имена файлов зафиксированы в vite.config.ts без хешей ради этих двух макросов.
// include_str! читает файлы при компиляции, поэтому `npm run build:tauri` обязан
// отработать до cargo — он стоит в beforeBuildCommand вторым шагом именно поэтому.
// cargo check по пустому dist падает ожидаемо.
const ANIMORI_JS: &str = include_str!("../../dist/animori.tauri.js");
const ANIMORI_CSS: &str = include_str!("../../dist/animori.tauri.css");

// В режиме tauri плагин monkey отключён, вместе с ним пропал и инжект стилей:
// CSS вставляет бэкенд первым скриптом инициализации, без ещё одной зависимости.
// serde_json::to_string даёт корректный JS-литерал: в SCSS есть кавычки, слеши и переводы
// строк; ручное экранирование — готовая дыра. Скрипт идёт до создания DOM, поэтому
// есть запасной путь через DOMContentLoaded.
//
// Обратные слеши в конце строк — продолжение литерала Rust: они съедают перевод
// строки и отступ. Удвоенный слеш здесь — SyntaxError вместо вставки стилей.
fn css_injection_script() -> String {
    let css = serde_json::to_string(ANIMORI_CSS).expect("CSS bundle is not serializable");

    format!(
        "(function(){{var css={css};var add=function(){{\
         if(document.getElementById('animori-style'))return;\
         var s=document.createElement('style');s.id='animori-style';s.textContent=css;\
         (document.head||document.documentElement).appendChild(s);}};\
         if(document.head){{add();}}else{{document.addEventListener('DOMContentLoaded',add);}}}})();"
    )
}

/// Разведчик адресов кадра плеера: реклама живёт в чужом iframe (Kodik),
/// куда код со стороны anilist.co доступа не имеет. Список собран и переехал
/// в adblock.rs, но разведчик оставлен: домены меняются пачками, охоту придётся
/// повторять тем же Ctrl+Shift+S. Спящий он не стоит ничего.
///
/// Скрипт идёт во ВСЕ фреймы: обычный initialization_script попадает только в главный,
/// а весь интерес во вложенных. Бандл туда не идёт: это целый Vue в каждом iframe.
///
/// Правка после первой охоты: главный кадр дал триста источников рекламных бирж
/// и выбрал потолок до кадра плеера. Поэтому теперь в главном кадре он не работает
/// вовсе, а во вложенных молчит до команды __animoriNetProbeArm.
///
/// Собирается только сводка по источникам: полный список URL затопил бы журнал
/// сегментами видео. Канал наверх — postMessage, единственный легальный между доменами.
const NET_PROBE_SCRIPT: &str = r#"(function () {
  try {
    // Главный кадр слушает сводки, но сам ничего не собирает.
    if (window.top === window) return;
    if (window.__animoriNetProbe) return;
    window.__animoriNetProbe = true;

    var armed = false;
    var started = false;
    var timer = null;
    var seen = {};
    var dirty = false;

    function note(raw, kind) {
      if (!armed) return;
      try {
        var u = new URL(String(raw), location.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        var key = kind + ' ' + u.origin;
        var rec = seen[key];
        if (!rec) {
          rec = seen[key] = { origin: u.origin, kind: kind, count: 0, sample: u.href };
          dirty = true;
        }
        rec.count++;
      } catch (e) {}
    }

    // Resource Timing видит все ресурсы кадра и надёжнее подмены fetch/XHR: подмена
    // ломается, если чужой код сохранил оригинал раньше нас. buffered: true отдаёт
    // и то, что загрузилось до подписки.
    function start() {
      if (started) return;
      started = true;
      try {
        var po = new PerformanceObserver(function (list) {
          var items = list.getEntries();
          for (var i = 0; i < items.length; i++) note(items[i].name, 'res');
        });
        po.observe({ type: 'resource', buffered: true });
      } catch (e) {}

      // Попытки открыть окно — отдельный вид, чтобы не тонули среди запросов.
      try {
        var openOriginal = window.open;
        window.open = function (target) {
          note(target || '', 'open');
          return openOriginal.apply(window, arguments);
        };
      } catch (e) {}

      if (!timer) timer = setInterval(send, 2000);
    }

    function send() {
      if (!armed || !dirty) return;
      dirty = false;
      var list = [];
      for (var key in seen) {
        if (Object.prototype.hasOwnProperty.call(seen, key)) list.push(seen[key]);
      }
      try {
        window.top.postMessage(
          { __animoriNetProbe: 1, frame: location.href, items: list },
          '*'
        );
      } catch (e) {}
    }

    // Команда повторяется каждые две секунды: кадр рекламы рождается позже
    // начала охоты и одиночную команду не застал бы.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.__animoriNetProbeArm === 1) {
        if (!armed) {
          armed = true;
          seen = {};
          dirty = false;
          start();
        }
      } else if (d.__animoriNetProbeArm === 0) {
        armed = false;
      }
    });
  } catch (e) {}
})();
"#;

/// Домен, который живёт внутри окна. Сравнение по хосту целиком или по суффиксу
/// с точкой, а не через contains: иначе подошло бы anilist.co.evil.example.
fn is_internal_host(host: &str) -> bool {
    host == "anilist.co" || host.ends_with(".anilist.co")
}

/// Открывает запасное окно с настоящим сайтом или возвращает фокус уже открытому.
///
/// Второго такого окна быть не должно: в нём живёт сеанс сайта и свой бандл
/// скрипта со своим состоянием, а два таких окна дали бы два блокировщика
/// и два сторожа на одни и те же настройки.
pub fn open(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }

    // Сторож заводится ДО окна: он регистрирует состояние, без которого команда
    // animori_page_ready со стороны страницы ответить не сможет. Разница в отсчёте
    // предельного срока — единицы миллисекунд, а паника из-за незарегистрированного
    // состояния стоила бы всего окна.
    crate::proxy_guard::spawn(app);

    // Копия дескриптора для замыкания on_navigation.
    let handle = app.clone();

    // Порядок скриптов важен: стили раньше бандла, иначе первые Vue-приложения
    // мелькнут без оформления. inner_size и center — геометрия только первого запуска:
    // сохранённое состояние перекроет их, а min_inner_size страхует от непригодного размера.
    //
    // Адрес — константа, поэтому expect: его разбор не может провалиться в работе,
    // только при правке строки выше — и тогда падение на первом же запуске полезнее молчания.
    let window = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::External(ANILIST_URL.parse().expect("адрес AniList разбирается")),
    )
    .title("AniMori: AniList")
    .inner_size(1280.0, 800.0)
    .min_inner_size(1024.0, 600.0)
    .resizable(true)
    .center()
    .initialization_script(css_injection_script())
    .initialization_script(ANIMORI_JS)
    // Разведчик ставится ПОСЛЕ бандла: в главном фрейме скрипты идут по порядку
    // регистрации, и приёмник сводки должен быть готов раньше первого сообщения.
    .initialization_script_for_all_frames(NET_PROBE_SCRIPT)
    // Страховка на стороне оболочки. Перехватчик кликов в features/ui/links.ts
    // не ловит навигацию без клика: редирект с сервера, location.assign, баннер
    // в iframe плеера. Окно без тулбара стало бы ловушкой на чужом сайте.
    //
    // Схемы кроме http/https пропускаем: на первом шаге бывают about:blank и data:,
    // и отказ от них сломал бы загрузку самого окна.
    .on_navigation(move |url| {
        let scheme = url.scheme();
        if scheme != "http" && scheme != "https" {
            return true;
        }

        match url.host_str() {
            Some(host) if is_internal_host(host) => true,
            Some(_) => {
                // Ошибку только пишем в журнал: отказ браузера не повод впускать
                // внешний сайт в окно приложения.
                if let Err(e) = handle.opener().open_url(url.as_str(), None::<&str>) {
                    log::warn!("Не удалось открыть внешний адрес {url}: {e}");
                }
                false
            }
            None => true,
        }
    })
    .build()
    .map_err(|e| e.to_string())?;

    // Авторизация у прокси — раньше блокировщика: запрос учётных данных приходит
    // на первом же соединении, а подписка действует только вперёд.
    #[cfg(windows)]
    crate::proxy_auth::install(app, &window);

    // Блокировщик — сразу после создания окна: подписка действует только на те
    // запросы, что уйдут после неё.
    #[cfg(windows)]
    crate::adblock::install(&window);

    // На не-Windows окно больше нигде не нужно — глушим предупреждение.
    #[cfg(not(windows))]
    let _ = &window;

    log::info!("Открыто запасное окно с настоящим сайтом");
    Ok(())
}
