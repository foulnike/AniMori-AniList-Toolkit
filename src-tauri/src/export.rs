// Пункт 3.3: выгрузка списка файлом, который человек найдёт руками.
//
// Почему не files.rs. Там имя из списка трёх и приватный каталог приложения:
// команда сознательно не умеет писать куда попало. Склад снимка и выгрузка
// для человека — разные права, и сводить их в одну команду нельзя.
//
// Диалог выбора папки живёт здесь, в Rust, а не в разметке. Так уже решено
// в Cargo.toml про dialog и updater: разрешение окну выдать легко, отобрать
// обратно нельзя. Разметка получает ровно два умения — спросить папку
// у человека и положить текст в уже выбранную папку.
//
// Путь приходит из разметки: папка хранится в настройках (ключ set_export_dir),
// и это осознанный размен. Держать её на стороне Rust значило бы завести
// второй склад настроек ради одной строки. Отсюда строгие проверки ниже:
// имя — только имя, папка — только существующий полный путь.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// Потолок записи в байтах. Тот же, что у files.rs: выгрузка списка на десять
/// тысяч записей весит около мегабайта, восемь закрывают живые случаи с запасом.
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Разрешённое окончание имени. Выгрузка у нас одна — список в XML, и проверка
/// расширения не даёт превратить команду в способ положить рядом что угодно.
const ALLOWED_SUFFIX: &str = ".xml";

/// Проверяет, что пришло именно имя файла, а не путь.
///
/// Path::file_name отсекает всё, что похоже на путь, поэтому сравнение
/// с исходной строкой ловит разом и разделители, и «..», и имя диска.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 200 {
        return Err(format!("Имя файла не годится: {name}"));
    }

    if !name.to_ascii_lowercase().ends_with(ALLOWED_SUFFIX) {
        return Err(format!("Выгрузка бывает только {ALLOWED_SUFFIX}: {name}"));
    }

    if Path::new(name).file_name().and_then(|part| part.to_str()) != Some(name) {
        return Err(format!("Имя файла не разрешено: {name}"));
    }

    Ok(())
}

/// Проверяет папку. Только существующий полный путь, и никакого создания:
/// files.rs свой служебный каталог создаёт сам, а здесь папку выбирал человек.
/// Нет её — значит настройка устарела, и плодить каталоги молча нельзя.
fn check_dir(dir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(dir);

    if !path.is_absolute() {
        return Err(format!("Путь папки не полный: {dir}"));
    }

    if !path.is_dir() {
        return Err(format!("Папка не найдена: {dir}"));
    }

    Ok(path)
}

/// Спрашивает папку родным окном и отдаёт её полный путь. None — человек
/// закрыл окно: отмена не ошибка и красной надписи в настройках не заслуживает.
///
/// Диалог отвечает обратным вызовом, а не значением, поэтому ответ ждём
/// через обычный канал на отдельном потоке: blocking_pick_folder звать нельзя,
/// он запрещён на главном потоке, где живёт окно.
///
/// Родительское окно указано намеренно: без него окно выбора на Windows умеет
/// всплыть ЗА приложением, и человек решит, что кнопка не работает.
#[tauri::command]
pub async fn animori_export_pick_dir(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("Куда сохранять выгрузки AniMori")
        .pick_folder(move |picked| {
            // Отправка не дойдёт, если ждущая сторона уже ушла: это не беда.
            let _ = tx.send(picked);
        });

    // Ожидание уводится с потока среды: обратный вызов придёт неизвестно когда,
    // а человек вправе смотреть на окно выбора сколько ему угодно.
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|e| format!("Выбор папки не завершился: {e}"))?;

    let Some(found) = picked else {
        return Ok(None);
    };

    let path = found
        .into_path()
        .map_err(|e| format!("Папку не разобрать: {e}"))?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Пишет выгрузку в выбранную папку и возвращает полный путь: настройки
/// показывают его человеку, чтобы файл не приходилось искать по диску.
///
/// Сначала во временный соседний файл, потом переименованием — тем же приёмом,
/// что и снимок: гибель процесса на середине не оставит обрезанный список.
#[tauri::command]
pub async fn animori_export_write(
    dir: String,
    name: String,
    text: String,
) -> Result<String, String> {
    if text.len() > MAX_BYTES {
        return Err(format!("Выгрузка слишком большая: {} байт", text.len()));
    }

    check_name(&name)?;

    tauri::async_runtime::spawn_blocking(move || {
        let path = check_dir(&dir)?.join(&name);
        let temp = path.with_extension("xml.tmp");

        fs::write(&temp, text.as_bytes()).map_err(|e| format!("Не записать файл: {e}"))?;
        fs::rename(&temp, &path).map_err(|e| format!("Не заменить файл: {e}"))?;

        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Запись выгрузки не завершилась: {e}"))?
}
