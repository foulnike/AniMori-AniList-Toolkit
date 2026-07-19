// ==UserScript==
// @name         AniMori: AniList Toolkit
// @namespace    http://tampermonkey.net/
// @version      1.8.1
// @description  Русский перевод, поиск, плеер, рейтинги Shiki и MAL, дерево хронологии, опенинги/эндинги, музыка (VK/YouTube/Spotify/SoundCloud), внешние ссылки, экспорт и сравнение списков Shikimori/AniList.
// @author       foulnike
// @match        https://anilist.co/*
// @match        *://shikimori.io/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @connect      raw.githubusercontent.com
// @connect      shikimori.io
// @connect      graphql.anilist.co
// @connect      kodik-api.com
// @connect      api.animethemes.moe
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/572948/AniMori%3A%20AniList%20Toolkit.user.js
// @updateURL https://update.greasyfork.org/scripts/572948/AniMori%3A%20AniList%20Toolkit.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 1. ГЛОБАЛЬНЫЕ КОНСТАНТЫ И КОНФИГУРАЦИЯ
    // ==========================================

    const IS_SHIKI = window.location.hostname.includes("shikimori");
    const IS_ANILIST = window.location.hostname.includes("anilist.co");

    // Словарь для перевода интерфейса
    const DICT_URL = 'https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/dictionary.json';

    // Shikimori
    const SHIKI_DOMAINS =['shikimori.io'];

    // Время жизни кэша 90 дней
    const CACHE_TIME = 90 * 24 * 60 * 60 * 1000;

    // Конфигурация локальной базы данных IndexedDB
    const DB_NAME = 'AniMoriSuperDB';
    const DB_VERSION = 5;

    // Глобальные стейты скрипта
    let dictionary = Object.create(null);
    let alRateLimitPause = 0;      // Пауза при 429 от AniList
    let shikiRateLimitPause = 0;   // Пауза при 429 от Shikimori
    let globalDbInstance = null;
    let globalPendingQueues = null; // Очереди перевода (для инспектора состояния)

    // Пользовательские настройки (сохраняются в хранилище скрипта)
    const settings = {
        translateInterface:  GM_getValue('set_interface', true),
        translateTitles:     GM_getValue('set_titles', true),
        translateCharacters: GM_getValue('set_chars', true),
        translateStaff:      GM_getValue('set_staff', true),
        enablePlayer:        GM_getValue('set_player', true),
        enableRatings:       GM_getValue('set_ratings', true),
        enableFranchise:     GM_getValue('set_franchise', true),
        enableThemes:        GM_getValue('set_themes', true),
        enableExtLinks:      GM_getValue('set_extlinks', true),
        enableLinkRutracker: GM_getValue('set_link_rutracker', true),
        enableLinkYummy:     GM_getValue('set_link_yummy', true),
        enableLinkAnimego:   GM_getValue('set_link_animego', true),
        enableLinkMangalib:  GM_getValue('set_link_mangalib', true),
        yummyDomain:         GM_getValue('set_yummy_domain', 'yummyanime.tv'),
        animegoDomain:       GM_getValue('set_animego_domain', 'animego.org'),
        mangalibDomain:      GM_getValue('set_mangalib_domain', 'mangalib.me'),
        enableLogger:        GM_getValue('set_logger', true)
    };

    // Списки локализации для парсера дат и времени
    const monthsFull = { Jan: 'января', Feb: 'февраля', Mar: 'марта', Apr: 'апреля', May: 'мая', Jun: 'июня', Jul: 'июля', Aug: 'августа', Sep: 'сентября', Oct: 'октября', Nov: 'ноября', Dec: 'декабря' };
    const days = { Mon: 'Пн', Tue: 'Вт', Wed: 'Ср', Thu: 'Чт', Fri: 'Пт', Sat: 'Сб', Sun: 'Вс' };
    const seasons = { Winter: 'Зима', Spring: 'Весна', Summer: 'Лето', Fall: 'Осень' };

    // Регулярные выражения для перевода (роли, даты, время)
    const rxRole = /^(.+?)\s*\((.+)\)$/;
    const rxRoleEps = /\beps?\b/gi;
    const rxRoleOP = /\bOP\b/gi;
    const rxRoleED = /\bED\b/gi;
    const rxRanking = /^#(\d+)\s+(highest\s+rated|most\s+popular)\s+(.+)$/i;
    const rxTimeComplex = /^(\d+\s+\w+)(?:,\s*|\s+)(\d+\s+\w+)$/i;
    const rxHeight = /^(?:Height:\s+)?([\d\s\.,\-–—]+)\s*cm(?:\s*\((.*?)\))?$/i;
    const rxLiked = /^(\d+)\s+out\s+of\s+(\d+)\s+(?:users?\s+)?liked\s+this\s+review$/i;
    const rxDateFull = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})$/i;
    const rxBday = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:,)?\s+(\d{1,4})$/i;
    const rxSeason = /^(Winter|Spring|Summer|Fall)\s+(\d{4})$/i;
    const rxAct = /^(Watched|Rewatched|Read|Reread)\s+(episode|chapter)\s+([\d\s\-–—]+)\s+of$/i;
    const rxLabel = /^(Format|Status|Country|Chapters|Score|Count|Hours Watched|Mean Score|Chapters Read|Episodes|Released|Started|Amount|Progress|Finish Date|Birthday|Height|Age|Gender|Blood Type|Blood type|Occupation|Affiliation|Grade):\s*(.*)$/i;
    const rxUnit = /^(\d+)\s+(day|hour|hr|minute|min|mins|sec|episode|chapter|volume|reply|user)s?$/i;
    const rxRecent = /^(\d+)\s+recently\s+(watched|read)$/i;
    const rxReviewBy = /^a\s+review\s+by\s+(.+)$/i;
    const rxDayDate = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})$/i;
    const rxAgo = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
    const rxAiringEp = /^Ep\s+(\d+)\s+airing\s+in\s+(\d+)\s+(second|minute|min|hour|day|week|month)s?$/i;
    const rxAiringOnly = /^Airing\s+in\s+(\d+)\s+(second|minute|min|hour|day|week|month)s?$/i;
    const rxListAdded = /^(.+?)\s+added\s+to\s+(completed|watching|planning|dropped|paused|reading)\s+list$/i;
    const rxListUpdated = /^(.+?)\s+list\s+entry\s+updated$/i;

    // Утилиты
    function escapeHTML(str) {
        if (!str) return "";
        return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
    }

    function getPlural(n, forms) {
        return (n % 10 === 1 && n % 100 !== 11 ? forms[0] : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? forms[1] : forms[2]));
    }

    // ==========================================
    //1.5. ЛОГГЕР СКРИПТА (Инструмент отладки)
    // ==========================================

    const LOG_LIMIT = 1000;
    let scriptLogs =[];
    let isLoggerOpen = false;
    let activeLogFilter = 'ALL';
    let activeSearchQuery = '';
    let unreadLogs = 0;

    // Восстановление логов из сессии
    if (settings.enableLogger) {
        try {
            const savedLogs = sessionStorage.getItem('animori_logs');
            if (savedLogs) scriptLogs = JSON.parse(savedLogs);
        } catch (e) {}
    }

    // Интерактивный просмотрщик JSON
    function createJSONView(obj, isRoot = true) {
        if (obj === null) return '<span style="color:#f38ba8">null</span>';
        if (typeof obj === 'undefined') return '<span style="color:#f38ba8">undefined</span>';
        if (typeof obj === 'boolean') return `<span style="color:#cba6f7">${obj}</span>`;
        if (typeof obj === 'number') return `<span style="color:#fab387">${obj}</span>`;
        if (typeof obj === 'string') return `<span style="color:#a6e3a1">"${escapeHTML(obj)}"</span>`;

        if (Array.isArray(obj)) {
            if (obj.length === 0) return '[]';
            let html = `<details ${isRoot ? 'open' : ''} style="margin-left:${isRoot?0:15}px;"><summary style="cursor:pointer;color:#89b4fa;user-select:none;outline:none;">Array(${obj.length})[</summary><div style="margin-left:15px; border-left:1px solid rgba(255,255,255,0.1); padding-left:10px;">`;
            for(let i=0; i<obj.length; i++) {
                html += `<div style="margin-bottom:2px;"><span style="color:#cdd6f4">${i}:</span> ${createJSONView(obj[i], false)}</div>`;
            }
            html += `</div><span style="color:#89b4fa;">]</span></details>`;
            return html;
        }

        if (typeof obj === 'object') {
            const keys = Object.keys(obj);
            if (keys.length === 0) return '{}';
            let html = `<details ${isRoot ? 'open' : ''} style="margin-left:${isRoot?0:15}px;"><summary style="cursor:pointer;color:#89b4fa;user-select:none;outline:none;">Object {</summary><div style="margin-left:15px; border-left:1px solid rgba(255,255,255,0.1); padding-left:10px;">`;
            for(let key of keys) {
                html += `<div style="margin-bottom:2px;"><span style="color:#cdd6f4">"${escapeHTML(key)}":</span> ${createJSONView(obj[key], false)}</div>`;
            }
            html += `</div><span style="color:#89b4fa;">}</span></details>`;
            return html;
        }
        return escapeHTML(String(obj));
    }

    // Главная функция логирования
    function Logger(type, message, details = null) {
        if (!settings.enableLogger) return;

        let parsedDetails = details;
        if (details instanceof Error) {
            parsedDetails = { name: details.name, message: details.message, stack: details.stack };
        }

        const d = new Date();
        const time = `${d.toLocaleTimeString('ru-RU', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
        const path = window.location.pathname; // URL Контекст
        const stackLines = new Error().stack.split('\n');
        const stack = stackLines.length > 2 ? stackLines.slice(2).join('\n') : '';

        const entry = { id: Date.now() + Math.random(), time, path, type, message, details: parsedDetails, stack };
        scriptLogs.push(entry);

        let typeCount = 0;
        for (let i = scriptLogs.length - 1; i >= 0; i--) {
            if (scriptLogs[i].type === type) {
                typeCount++;
                if (typeCount > LOG_LIMIT) {
                    scriptLogs.splice(i, 1);
                    break;
                }
            }
        }

        // Сохранение в сессию (Лимит 200 логов, чтобы не забить квоту)
        try { sessionStorage.setItem('animori_logs', JSON.stringify(scriptLogs.slice(-200))); } catch (e) {}

        if (isLoggerOpen) appendLogEntry(entry);
        if (type === 'ERROR') console.error(`[AniMori ERROR] ${message}`, details || '');
    }

    // Глобальный перехватчик критических ошибок скрипта
    if (settings.enableLogger) {
        window.addEventListener('error', (e) => {
            // Фильтруем ошибки, чтобы не логировать внутренние баги самого AniList
            if (e.filename && (e.filename.includes('userscript') || e.filename.includes('tampermonkey'))) {
                Logger('ERROR', `Uncaught Error: ${e.message}`, { file: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack });
            }
        });
        window.addEventListener('unhandledrejection', (e) => {
            if (e.reason && e.reason.stack && (e.reason.stack.includes('userscript') || e.reason.stack.includes('tampermonkey'))) {
                Logger('ERROR', `Unhandled Promise Rejection: ${e.reason}`, typeof e.reason === 'object' ? e.reason : { reason: e.reason });
            }
        });
    }

    // Рендер одиночной записи логгера
    function createSingleLogEl(entry) {
        const el = document.createElement('div');
        el.className = `am-log-entry type-${entry.type.toLowerCase()}`;

        let detailsHtml = '';
        if (entry.details) {
            detailsHtml = `<div class="am-log-details" style="display:none;">${createJSONView(entry.details)}</div>`;
        }

        const shortPath = entry.path === '/' ? '/' : (entry.path.split('/').slice(1, 3).join('/') || '/');

        el.innerHTML = `
            <div class="am-log-header">
                <span class="am-log-time">${entry.time}</span>
                <span class="am-log-badge">${entry.type}</span>
                <span class="am-log-path" title="${escapeHTML(entry.path)}">/${escapeHTML(shortPath)}</span>
                <span class="am-log-msg">${escapeHTML(entry.message)}</span>
                <div style="margin-left:auto; display:flex; gap:8px; align-items:center;">
                    ${entry.stack ? '<span class="am-log-btn-stack" title="Показать Stack Trace">[Stack]</span>' : ''}
                    ${entry.details ? '<span class="am-log-expand">▼</span>' : ''}
                </div>
            </div>
            ${entry.stack ? `<div class="am-log-stack-details" style="display:none; padding:8px 12px; background:rgba(252,129,129,0.1); border-top:1px solid rgba(255,255,255,0.05);"><pre style="margin:0; font-size:10.5px; color:#f38ba8; white-space:pre-wrap; font-family:inherit;">${escapeHTML(entry.stack)}</pre></div>` : ''}
            ${detailsHtml}
        `;

        if (entry.details) {
            const header = el.querySelector('.am-log-header');
            header.style.cursor = 'pointer';
            header.onclick = (e) => {
                if (e.target.classList.contains('am-log-btn-stack')) return;
                e.stopPropagation();
                const det = el.querySelector('.am-log-details');
                const isHidden = det.style.display === 'none';
                det.style.display = isHidden ? 'block' : 'none';
                el.querySelector('.am-log-expand').style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
            };
        }

        if (entry.stack) {
            const stackBtn = el.querySelector('.am-log-btn-stack');
            stackBtn.onclick = (e) => {
                e.stopPropagation();
                const stackEl = el.querySelector('.am-log-stack-details');
                stackEl.style.display = stackEl.style.display === 'none' ? 'block' : 'none';
            };
        }

        return el;
    }

    function updateScrollBtn() {
        const btn = document.getElementById('am-log-scroll-down');
        if (!btn) return;
        if (unreadLogs > 0) {
            btn.style.display = 'block';
            btn.textContent = `⬇ Новые логи (${unreadLogs})`;
        } else {
            btn.style.display = 'none';
        }
    }

    function appendLogEntry(entry) {
        const container = document.getElementById('am-log-container');
        if (!container) return;
        if (activeLogFilter !== 'ALL' && activeLogFilter !== entry.type) return;

        // Фильтрация поиска
        if (activeSearchQuery) {
            const q = activeSearchQuery.toLowerCase();
            const msg = entry.message.toLowerCase();
            const path = entry.path.toLowerCase();
            let detailsStr = '';
            try { detailsStr = JSON.stringify(entry.details || {}).toLowerCase(); } catch(e){}
            if (!msg.includes(q) && !detailsStr.includes(q) && !path.includes(q)) return;
        }

        const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 30;
        // Отключаем группировку, если активен поиск
        const canGroup = activeLogFilter === 'ALL' && !activeSearchQuery &&['API', 'DB', 'QUEUE'].includes(entry.type);
        const lastChild = container.lastElementChild;

        if (canGroup && lastChild) {
            if (lastChild.classList.contains('am-log-group') && lastChild.dataset.groupType === entry.type) {
                lastChild.querySelector('.am-log-group-items').appendChild(createSingleLogEl(entry));
                let count = parseInt(lastChild.dataset.groupCount) + 1;
                lastChild.dataset.groupCount = count;
                lastChild.querySelector('.am-log-group-count').textContent = `Сгруппировано (${count})`;
            } else if (lastChild.classList.contains('am-log-entry') && lastChild.classList.contains(`type-${entry.type.toLowerCase()}`)) {
                const prevNode = lastChild;
                container.removeChild(prevNode);
                const groupEl = document.createElement('div');
                groupEl.className = `am-log-group type-${entry.type.toLowerCase()}`;
                groupEl.dataset.groupType = entry.type;
                groupEl.dataset.groupCount = "2";
                groupEl.innerHTML = `
                    <div class="am-log-header am-log-group-header">
                        <span class="am-log-time">${entry.time}</span>
                        <span class="am-log-badge">${entry.type}</span>
                        <span class="am-log-msg am-log-group-count" style="font-style: italic; color: #8b949e;">Сгруппировано (2)</span>
                        <span class="am-log-expand">▼</span>
                    </div>
                    <div class="am-log-group-items" style="display:none;"></div>
                `;
                const itemsContainer = groupEl.querySelector('.am-log-group-items');
                itemsContainer.appendChild(prevNode);
                itemsContainer.appendChild(createSingleLogEl(entry));

                const header = groupEl.querySelector('.am-log-group-header');
                header.style.cursor = 'pointer';
                header.onclick = () => {
                    const isHidden = itemsContainer.style.display === 'none';
                    itemsContainer.style.display = isHidden ? 'block' : 'none';
                    groupEl.querySelector('.am-log-expand').style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
                };
                container.appendChild(groupEl);
            } else { container.appendChild(createSingleLogEl(entry)); }
        } else { container.appendChild(createSingleLogEl(entry)); }

        if (isAtBottom) {
            container.scrollTop = container.scrollHeight;
            unreadLogs = 0;
        } else {
            unreadLogs++;
        }
        updateScrollBtn();
    }

    function renderAllLogs() {
        const container = document.getElementById('am-log-container');
        if (!container) return;
        container.innerHTML = '';
        scriptLogs.forEach(appendLogEntry);
        container.scrollTop = container.scrollHeight;
        unreadLogs = 0;
        updateScrollBtn();
    }

    // UI Логгера
    function openLoggerModal() {
        if (document.getElementById('am-logger-overlay')) return;
        isLoggerOpen = true;
        unreadLogs = 0;

        const overlay = document.createElement('div');
        overlay.id = 'am-logger-overlay';
        overlay.innerHTML = `
            <div class="am-logger-modal" style="position:relative;">
                <div class="am-logger-header">
                    <h2>AniMori Logger <span style="font-size:12px;opacity:0.6;font-weight:normal;">(Session Memory)</span></h2>
                    <input type="text" id="am-log-search" placeholder="Поиск по логам..." style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;width:200px;transition:0.2s;">
                    <div class="am-logger-filters">
                        <button class="am-log-filter ${activeLogFilter === 'ALL' ? 'active' : ''}" data-filter="ALL">ALL</button>
                        <button class="am-log-filter ${activeLogFilter === 'INFO' ? 'active' : ''}" data-filter="INFO">INFO</button>
                        <button class="am-log-filter ${activeLogFilter === 'API' ? 'active' : ''}" data-filter="API">API</button>
                        <button class="am-log-filter ${activeLogFilter === 'DB' ? 'active' : ''}" data-filter="DB">DB</button>
                        <button class="am-log-filter ${activeLogFilter === 'QUEUE' ? 'active' : ''}" data-filter="QUEUE">QUEUE</button>
                        <button class="am-log-filter ${activeLogFilter === 'ERROR' ? 'active' : ''}" data-filter="ERROR">ERROR</button>
                    </div>
                    <div class="am-logger-actions">
                        <button id="am-log-state">Состояние</button>
                        <button id="am-log-download">Скачать</button>
                        <button id="am-log-copy">Копировать</button>
                        <button id="am-log-clear">Очистить</button>
                        <button id="am-log-close">✖</button>
                    </div>
                </div>
                <div id="am-log-container"></div>
                <button id="am-log-scroll-down" style="display:none; position:absolute; bottom:25px; right:30px; background:#3dbbee; color:#fff; border:none; border-radius:20px; padding:8px 16px; cursor:pointer; box-shadow:0 4px 15px rgba(0,0,0,0.5); font-weight:bold; z-index:10; transition:0.2s;"></button>
            </div>
        `;
        document.body.appendChild(overlay);

        const container = document.getElementById('am-log-container');
        container.onscroll = () => {
            if (container.scrollHeight - container.scrollTop <= container.clientHeight + 30) {
                unreadLogs = 0; updateScrollBtn();
            }
        };

        const searchInput = document.getElementById('am-log-search');
        searchInput.value = activeSearchQuery;
        searchInput.oninput = (e) => {
            activeSearchQuery = e.target.value.trim();
            renderAllLogs();
        };

        document.getElementById('am-log-scroll-down').onclick = () => {
            container.scrollTop = container.scrollHeight;
            unreadLogs = 0; updateScrollBtn();
        };

        document.getElementById('am-log-close').onclick = () => { overlay.remove(); isLoggerOpen = false; };
        document.getElementById('am-log-clear').onclick = () => { scriptLogs=[]; sessionStorage.removeItem('animori_logs'); renderAllLogs(); Logger('INFO', 'Логгер очищен вручную'); };

        document.getElementById('am-log-copy').onclick = () => {
            const text = scriptLogs.map(l => `[${l.time}][${l.type}][PATH: ${l.path}] ${l.message} \n${l.details ? JSON.stringify(l.details, null, 2) : ''}`).join('\n\n');
            navigator.clipboard.writeText(text);
            const btn = document.getElementById('am-log-copy');
            btn.textContent = '✔ Скопировано';
            setTimeout(() => btn.textContent = 'Копировать', 2000);
        };

        document.getElementById('am-log-download').onclick = () => {
            const text = scriptLogs.map(l =>
                `[${l.time}] [${l.type}][PATH: ${l.path}]\nMSG: ${l.message}\nDETAILS: ${l.details ? JSON.stringify(l.details, null, 2) : 'null'}\nSTACK:\n${l.stack}\n---------------------------------------------------`
            ).join('\n\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `animori_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        };

        // Инспектор состояния (State Inspector) - выводит текущий слепок работы скрипта
        document.getElementById('am-log-state').onclick = async () => {
            document.getElementById('am-log-state').textContent = 'Загрузка...';

            const dbStats = await getDbStats();

            const state = {
                url: window.location.href,
                settings: settings,
                currentMediaId: typeof currentMediaId !== 'undefined' ? currentMediaId : null,
                queueSizes: {
                    MED2: globalPendingQueues?.MED2?.size || 0,
                    CHR2: globalPendingQueues?.CHR2?.size || 0,
                    STF3: globalPendingQueues?.STF3?.size || 0
                },
                databaseCache: dbStats,
                rateLimits: {
                    alRateLimitPause: alRateLimitPause > Date.now() ? new Date(alRateLimitPause).toLocaleTimeString() : 'OK',
                    shikiRateLimitPause: shikiRateLimitPause > Date.now() ? new Date(shikiRateLimitPause).toLocaleTimeString() : 'OK'
                }
            };

            Logger('INFO', 'DUMP: Текущее состояние скрипта', state);
            renderAllLogs();
            if(container) container.scrollTop = container.scrollHeight;
            document.getElementById('am-log-state').textContent = 'Состояние';
        };

        overlay.querySelectorAll('.am-log-filter').forEach(btn => {
            btn.onclick = (e) => {
                overlay.querySelectorAll('.am-log-filter').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                activeLogFilter = e.target.dataset.filter;
                renderAllLogs();
            };
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); isLoggerOpen = false; }
        });

        renderAllLogs();
    }

    // ==========================================
    // 1.5 СКАНЕР ДЕЛЬТЫ: сравнение списков Shikimori <-> AniList (read-only)
    // Ключ сопоставления — MAL id (у Shikimori id == MAL id, у AniList media есть idMal).
    // Ничего не пишет: только читает оба списка, считает статистику и расхождения.
    // ==========================================

    const CMP_STATUS_ORDER = ['watching', 'rewatching', 'planned', 'completed', 'on_hold', 'dropped'];
    const CMP_STATUS_LABEL = {
        watching: 'Смотрю/Читаю', rewatching: 'Пересматриваю', planned: 'Запланировано',
        completed: 'Просмотрено', on_hold: 'Отложено', dropped: 'Брошено', null: '—'
    };
    const AL_STATUS_MAP = { CURRENT: 'watching', REPEATING: 'rewatching', PLANNING: 'planned', COMPLETED: 'completed', PAUSED: 'on_hold', DROPPED: 'dropped' };
    // Типы связей AniList, указывающие на «тот же тайтл рядом» (деление на сезоны/куски,
    // сиквелы/приквелы). Используются для группировки «связанных» записей (B).
    const CMP_SPLIT_RELATIONS = ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'ALTERNATIVE', 'SPIN_OFF'];
    let cmpLast = null; // снимок последнего скана — чтобы перерисовывать без повторной загрузки

    // Игнор-лист (C): MAL id, помеченные пользователем как «не показывать» (ложные расхождения).
    function cmpGetIgnore() { try { return new Set(JSON.parse(GM_getValue('CMP_IGNORE', '[]'))); } catch (e) { return new Set(); } }
    function cmpSaveIgnore(set) { GM_setValue('CMP_IGNORE', JSON.stringify([...set])); }
    function cmpAddIgnore(id) { const s = cmpGetIgnore(); s.add(Number(id)); cmpSaveIgnore(s); }
    function cmpRemoveIgnore(id) { const s = cmpGetIgnore(); s.delete(Number(id)); cmpSaveIgnore(s); }

    function cmpEsc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function cmpStatusLabel(s) { return CMP_STATUS_LABEL[s] || '—'; }
    function cmpFmtScore(v) { return v > 0 ? (Math.round(v * 10) / 10).toString() : '—'; }
    function cmpFmtProg(e, type) { return type === 'manga' ? `${e.progress} гл. / ${e.volumes} т.` : `${e.progress} эп.`; }

    // AniList: список пользователя (аниме/манга), ключ = idMal. Оценка запрошена как
    // POINT_100 -> нормализуем в 0..10 делением на 10 (не зависим от шкалы пользователя).
    async function cmpFetchAniListList(userName, type) {
        const q = `query($n:String,$t:MediaType){MediaListCollection(userName:$n,type:$t){lists{entries{status score(format:POINT_100) progress progressVolumes repeat notes media{idMal title{romaji english} relations{edges{relationType node{idMal}}}}}}}}`;
        const res = await anilistQuery(q, { n: userName, t: type }, true);
        const lists = res && res.data && res.data.MediaListCollection && res.data.MediaListCollection.lists || [];
        const map = new Map();
        for (const l of lists) for (const e of (l.entries || [])) {
            const mal = e.media && e.media.idMal;
            if (!mal) continue;
            map.set(mal, {
                malId: mal,
                title: (e.media.title && (e.media.title.romaji || e.media.title.english)) || ('MAL#' + mal),
                status: AL_STATUS_MAP[e.status] || null,
                score10: e.score ? e.score / 10 : 0,
                progress: e.progress || 0,
                volumes: e.progressVolumes || 0,
                rewatches: e.repeat || 0,
                notes: (e.notes || '').trim(),
                relations: ((e.media.relations && e.media.relations.edges) || [])
                    .filter(ed => CMP_SPLIT_RELATIONS.includes(ed.relationType))
                    .map(ed => ed.node && ed.node.idMal).filter(Boolean),
            });
        }
        return map;
    }

    // AniList: избранное (аниме/манга) с пагинацией. Множество idMal -> название.
    async function cmpFetchAniListFavs(userName, kind) {
        const map = new Map(); let page = 1;
        while (true) {
            const q = `query($n:String,$p:Int){User(name:$n){favourites{${kind}(page:$p){pageInfo{hasNextPage} nodes{idMal title{romaji english}}}}}}`;
            const res = await anilistQuery(q, { n: userName, p: page }, true);
            const fav = res && res.data && res.data.User && res.data.User.favourites && res.data.User.favourites[kind];
            if (!fav) break;
            for (const n of (fav.nodes || [])) { if (n.idMal) map.set(n.idMal, (n.title && (n.title.romaji || n.title.english)) || ('MAL#' + n.idMal)); }
            if (!fav.pageInfo || !fav.pageInfo.hasNextPage) break;
            page++; await new Promise(r => setTimeout(r, 700));
        }
        return map;
    }

    // Shikimori: список через v1 *_rates (сразу с названиями), ключ = target id (== MAL id).
    async function cmpFetchShikiList(userId, type) {
        const map = new Map(); let page = 1;
        while (true) {
            const r = await fetchShiki(`/api/users/${userId}/${type}_rates?limit=5000&page=${page}`);
            const data = r && r.data;
            if (!Array.isArray(data) || data.length === 0) break;
            for (const it of data) {
                const media = it[type];
                if (!media || !media.id) continue;
                const mal = media.id;
                map.set(mal, {
                    malId: mal,
                    title: media.russian || media.name || ('MAL#' + mal),
                    status: it.status || null,
                    score10: it.score || 0,
                    progress: type === 'anime' ? (it.episodes || 0) : (it.chapters || 0),
                    volumes: type === 'manga' ? (it.volumes || 0) : 0,
                    rewatches: it.rewatches || 0,
                    notes: (it.text || '').trim(),
                });
            }
            if (data.length < 5000) break;
            page++; await new Promise(r => setTimeout(r, 700));
        }
        return map;
    }

    async function cmpFetchShikiFavs(userId) {
        const r = await fetchShiki(`/api/users/${userId}/favourites`);
        const d = (r && r.data) || {};
        const toMap = arr => { const m = new Map(); (arr || []).forEach(x => { if (x && x.id) m.set(x.id, x.russian || x.name || ('MAL#' + x.id)); }); return m; };
        // Персонажи/стафф: id нельзя мостить (у AniList свои), сравниваем по имени -> отдаём
        // ромадзи (name) для матча и русское (russian) для показа.
        const toNames = arr => (arr || []).map(x => ({ name: x.russian || x.name || '', romaji: x.name || '' })).filter(x => x.name || x.romaji);
        // AniList «staff» — единый список; у Shikimori стафф разнесён по people/seyu/
        // mangakas/producers. Объединяем для сопоставимости.
        const staffAll = [...(d.people || []), ...(d.seyu || []), ...(d.mangakas || []), ...(d.producers || [])];
        return { anime: toMap(d.animes), manga: toMap(d.mangas), characters: toNames(d.characters), people: toNames(staffAll) };
    }

    // AniList: избранные персонажи/стафф (kind: 'characters'|'staff'). id не мостится с Shiki,
    // поэтому берём только имена (full — ромадзи, native — оригинал).
    async function cmpFetchAniListFavPeople(userName, kind) {
        const arr = []; let page = 1;
        while (true) {
            const q = `query($n:String,$p:Int){User(name:$n){favourites{${kind}(page:$p){pageInfo{hasNextPage} nodes{name{full native}}}}}}`;
            const res = await anilistQuery(q, { n: userName, p: page }, true);
            const fav = res && res.data && res.data.User && res.data.User.favourites && res.data.User.favourites[kind];
            if (!fav) break;
            for (const n of (fav.nodes || [])) arr.push({ name: (n.name && n.name.full) || '', native: (n.name && n.name.native) || '' });
            if (!fav.pageInfo || !fav.pageInfo.hasNextPage) break;
            page++; await new Promise(r => setTimeout(r, 700));
        }
        return arr;
    }

    // Нормализация имени для приблизительного матча: нижний регистр, ё->е, разбивка по
    // не-буквам, сортировка токенов (гасит разный порядок «Имя Фамилия»).
    function cmpNormName(s) { return (s || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i).filter(Boolean).sort().join(' '); }

    // Сравнение избранных персонажей/стаффа по имени (приблизительно, без id-моста).
    function cmpNameDiff(shikiArr, alArr) {
        const alKeys = new Set(alArr.map(x => cmpNormName(x.name)).filter(Boolean));
        const shKeys = new Set(shikiArr.map(x => cmpNormName(x.romaji || x.name)).filter(Boolean));
        const onlyShiki = shikiArr.filter(x => { const k = cmpNormName(x.romaji || x.name); return k && !alKeys.has(k); }).map(x => ({ title: x.name }));
        const onlyAl = alArr.filter(x => { const k = cmpNormName(x.name); return k && !shKeys.has(k); }).map(x => ({ title: x.name || x.native }));
        return { onlyShiki, onlyAl, shikiCount: shikiArr.length, alCount: alArr.length };
    }

    // D: глубокая проверка каталогов (батчами). Возвращает множества MAL id, которые
    // РЕАЛЬНО существуют в каталоге другой площадки (не в списке — а вообще в базе).
    async function cmpDeepCheck(onlyShiki, onlyAl, setStatus) {
        const alHas = new Set(), shikiHas = new Set();
        if (setStatus) setStatus('Глубокая проверка: каталог AniList...');
        for (const [type, ids] of [['ANIME', onlyShiki.anime], ['MANGA', onlyShiki.manga]]) {
            for (let i = 0; i < ids.length; i += 50) {
                const chunk = ids.slice(i, i + 50);
                const res = await anilistQuery(`query($m:[Int],$t:MediaType){Page(page:1,perPage:50){media(idMal_in:$m,type:$t){idMal}}}`, { m: chunk, t: type });
                const media = (res && res.data && res.data.Page && res.data.Page.media) || [];
                media.forEach(m => { if (m.idMal) alHas.add(m.idMal); });
                await new Promise(r => setTimeout(r, 700));
            }
        }
        if (setStatus) setStatus('Глубокая проверка: каталог Shikimori...');
        for (const [ep, ids] of [['animes', onlyAl.anime], ['mangas', onlyAl.manga]]) {
            for (let i = 0; i < ids.length; i += 50) {
                const chunk = ids.slice(i, i + 50);
                const r = await fetchShiki(`/api/${ep}?ids=${chunk.join(',')}&limit=50`);
                const data = (r && r.data) || [];
                if (Array.isArray(data)) data.forEach(m => { if (m && m.id) shikiHas.add(m.id); });
                await new Promise(r => setTimeout(r, 700));
            }
        }
        return { alHas, shikiHas };
    }

    function cmpStats(map) {
        const st = {}; CMP_STATUS_ORDER.forEach(s => st[s] = 0);
        let scored = 0, sum = 0;
        for (const e of map.values()) {
            if (e.status && st[e.status] !== undefined) st[e.status]++;
            if (e.score10 > 0) { scored++; sum += e.score10; }
        }
        return { total: map.size, byStatus: st, mean: scored ? sum / scored : 0 };
    }

    // Расхождения по одному типу (anime|manga). Возвращает ведёрки со списками.
    function cmpDiff(shiki, al, type) {
        // Множество idMal, на которые ссылаются связи записей AniList (для детекта «связанных»).
        const alRelated = new Set();
        for (const a of al.values()) for (const rid of (a.relations || [])) alRelated.add(rid);

        const ids = new Set([...shiki.keys(), ...al.keys()]);
        const out = { onlyShiki: [], onlyShikiRel: [], onlyAl: [], onlyAlRel: [], status: [], score: [], progress: [], rewatch: [], notes: [] };
        for (const id of ids) {
            const s = shiki.get(id), a = al.get(id);
            if (s && !a) {
                // B: если на этот тайтл ссылается какая-то запись AniList (сиквел/часть) — «связанный».
                (alRelated.has(id) ? out.onlyShikiRel : out.onlyShiki).push({ id, title: s.title, info: cmpStatusLabel(s.status) });
                continue;
            }
            if (a && !s) {
                // B: если запись AniList связана с чем-то, что ЕСТЬ на Shiki — «связанный».
                const rel = (a.relations || []).some(rid => shiki.has(rid));
                (rel ? out.onlyAlRel : out.onlyAl).push({ id, title: a.title, info: cmpStatusLabel(a.status) });
                continue;
            }
            const title = a.title || s.title;
            if (s.status !== a.status) out.status.push({ id, title, shiki: cmpStatusLabel(s.status), al: cmpStatusLabel(a.status) });
            if (Math.round(s.score10) !== Math.round(a.score10)) out.score.push({ id, title, shiki: cmpFmtScore(s.score10), al: cmpFmtScore(a.score10) });
            let pDiff = s.progress !== a.progress || (type === 'manga' && s.volumes !== a.volumes);
            if (pDiff) out.progress.push({ id, title, shiki: cmpFmtProg(s, type), al: cmpFmtProg(a, type) });
            if (s.rewatches !== a.rewatches) out.rewatch.push({ id, title, shiki: s.rewatches, al: a.rewatches });
            if (s.notes !== a.notes && (s.notes || a.notes)) out.notes.push({ id, title, shiki: s.notes ? 'есть' : '—', al: a.notes ? 'есть' : '—' });
        }
        return out;
    }

    function cmpFavDiff(shikiFav, alFav) {
        const ids = new Set([...shikiFav.keys(), ...alFav.keys()]);
        const onlyShiki = [], onlyAl = [];
        for (const id of ids) {
            if (shikiFav.has(id) && !alFav.has(id)) onlyShiki.push({ id, title: shikiFav.get(id) });
            else if (alFav.has(id) && !shikiFav.has(id)) onlyAl.push({ id, title: alFav.get(id) });
        }
        return { onlyShiki, onlyAl, shikiCount: shikiFav.size, alCount: alFav.size };
    }

    // Резолв Shikimori user id по логину (ник) или числовому id.
    async function cmpResolveShikiUser(login) {
        const isNum = /^\d+$/.test(login);
        const path = isNum ? `/api/users/${login}` : `/api/users/${encodeURIComponent(login)}?is_nickname=1`;
        const r = await fetchShiki(path);
        if (r && r.data && r.data.id) return r.data.id;
        throw new Error('Пользователь Shikimori не найден: ' + login);
    }

    // --- Рендер ---
    function cmpRenderSummary(label, sh, al) {
        const rows = CMP_STATUS_ORDER.map(s =>
            `<tr><td>${CMP_STATUS_LABEL[s]}</td><td>${sh.byStatus[s]}</td><td>${al.byStatus[s]}</td><td style="color:rgb(var(--color-text-light));">${al.byStatus[s] - sh.byStatus[s] > 0 ? '+' : ''}${al.byStatus[s] - sh.byStatus[s] || ''}</td></tr>`
        ).join('');
        return `<table class="amk-table" style="margin-bottom:12px;">
            <thead><tr><th>${cmpEsc(label)}</th><th style="width:70px;color:rgb(var(--color-pink));">Shiki</th><th style="width:70px;color:rgb(var(--color-blue));">AniList</th><th style="width:50px;">Δ</th></tr></thead>
            <tbody>${rows}
            <tr style="font-weight:700;"><td>Всего</td><td>${sh.total}</td><td>${al.total}</td><td>${al.total - sh.total || ''}</td></tr>
            <tr><td>Средняя оценка</td><td>${sh.mean ? sh.mean.toFixed(2) : '—'}</td><td>${al.mean ? al.mean.toFixed(2) : '—'}</td><td></td></tr>
            </tbody></table>`;
    }

    function cmpRenderDiff(diff, ignore, catalog) {
        const notIgn = arr => arr.filter(x => !ignore.has(Number(x.id)));
        const ignBtn = id => `<span class="amk-x cmp-ignore" data-id="${id}" title="Скрыть (в игнор)">✕</span>`;
        const row = (x, right) => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(x.title)}</span><span class="amk-meta">${right || ''}</span>${ignBtn(x.id)}</div>`;
        const sec = (label, arr, fmt) => {
            const a = notIgn(arr);
            if (!a.length) return '';
            const items = a.slice(0, 500).map(fmt).join('');
            const more = a.length > 500 ? `<div style="opacity:.6;padding:6px;">…ещё ${a.length - 500}</div>` : '';
            return `<details class="amk-collapse"><summary>${cmpEsc(label)} <span class="amk-count">(${a.length})</span></summary><div class="amk-collapse-body">${items}${more}</div></details>`;
        };
        let h = '';
        // A: нейтральные «в списке только на одной площадке» — это НЕ ошибка синка.
        // D: если была глубокая проверка — делим на «есть/нет в каталоге другой площадки».
        if (catalog) {
            h += sec('Только на Shikimori — ЕСТЬ в каталоге AniList (можно добавить)', diff.onlyShiki.filter(x => catalog.alHas.has(Number(x.id))), x => row(x, cmpEsc(x.info)));
            h += sec('Только на Shikimori — НЕТ в каталоге AniList', diff.onlyShiki.filter(x => !catalog.alHas.has(Number(x.id))), x => row(x, cmpEsc(x.info)));
            h += sec('Только на AniList — ЕСТЬ в каталоге Shikimori (можно добавить)', diff.onlyAl.filter(x => catalog.shikiHas.has(Number(x.id))), x => row(x, cmpEsc(x.info)));
            h += sec('Только на AniList — НЕТ в каталоге Shikimori', diff.onlyAl.filter(x => !catalog.shikiHas.has(Number(x.id))), x => row(x, cmpEsc(x.info)));
        } else {
            h += sec('В списке только на Shikimori', diff.onlyShiki, x => row(x, cmpEsc(x.info)));
            h += sec('В списке только на AniList', diff.onlyAl, x => row(x, cmpEsc(x.info)));
        }
        // B: связанные записи (деление на сезоны / сиквелы) — отдельным свёрнутым блоком.
        const rel = [...diff.onlyShikiRel, ...diff.onlyAlRel];
        h += sec('Связано с уже отслеживаемым (деление на сезоны / сиквелы)', rel, x => row(x, cmpEsc(x.info)));
        // Реальные разногласия по СОВПАВШИМ (один MAL id) тайтлам.
        h += sec('Разный статус', diff.status, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        h += sec('Разная оценка', diff.score, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        h += sec('Разный прогресс', diff.progress, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        h += sec('Разные пересмотры', diff.rewatch, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        h += sec('Разные заметки', diff.notes, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        const total = ['onlyShiki', 'onlyAl', 'onlyShikiRel', 'onlyAlRel', 'status', 'score', 'progress', 'rewatch', 'notes'].reduce((n, k) => n + notIgn(diff[k]).length, 0);
        if (!total) h += `<div style="opacity:.6;padding:8px;">Расхождений нет.</div>`;
        return h;
    }

    function cmpRenderFavs(favA, favM, ignore) {
        const notIgn = arr => arr.filter(x => !ignore.has(Number(x.id)));
        const ignBtn = id => `<span class="amk-x cmp-ignore" data-id="${id}" title="Скрыть (в игнор)">✕</span>`;
        const sec = (label, arr) => {
            const a = notIgn(arr);
            if (!a.length) return '';
            const items = a.slice(0, 500).map(x => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(x.title)}</span>${ignBtn(x.id)}</div>`).join('');
            return `<details class="amk-collapse"><summary>${cmpEsc(label)} <span class="amk-count">(${a.length})</span></summary><div class="amk-collapse-body">${items}</div></details>`;
        };
        let h = `<div style="font-size:13px;margin-bottom:6px;">Избранное — Аниме: <b style="color:rgb(var(--color-pink));">${favA.shikiCount}</b> Shiki / <b style="color:rgb(var(--color-blue));">${favA.alCount}</b> AniList · Манга: <b style="color:rgb(var(--color-pink));">${favM.shikiCount}</b> / <b style="color:rgb(var(--color-blue));">${favM.alCount}</b></div>`;
        h += sec('Избранное аниме: только в Shikimori', favA.onlyShiki);
        h += sec('Избранное аниме: только в AniList', favA.onlyAl);
        h += sec('Избранное манга: только в Shikimori', favM.onlyShiki);
        h += sec('Избранное манга: только в AniList', favM.onlyAl);
        if (!notIgn(favA.onlyShiki).length && !notIgn(favA.onlyAl).length && !notIgn(favM.onlyShiki).length && !notIgn(favM.onlyAl).length) h += `<div style="opacity:.6;padding:8px;">Избранное совпадает.</div>`;
        return h;
    }

    // Избранные персонажи/стафф — сравнение по имени (без id, приблизительно; без игнора).
    function cmpRenderNameFavs(label, diff) {
        const sec = (l, arr) => {
            if (!arr.length) return '';
            const items = arr.slice(0, 500).map(x => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(x.title)}</span></div>`).join('');
            const more = arr.length > 500 ? `<div style="opacity:.6;padding:6px;">…ещё ${arr.length - 500}</div>` : '';
            return `<details class="amk-collapse"><summary>${cmpEsc(l)} <span class="amk-count">(${arr.length})</span></summary><div class="amk-collapse-body">${items}${more}</div></details>`;
        };
        let h = `<div style="font-size:13px;margin:8px 0 4px;"><b>${cmpEsc(label)}</b> — <b style="color:rgb(var(--color-pink));">${diff.shikiCount}</b> Shiki / <b style="color:rgb(var(--color-blue));">${diff.alCount}</b> AniList <span style="opacity:.5;">(матч по имени, приблизительно)</span></div>`;
        h += sec(label + ': только в Shikimori', diff.onlyShiki);
        h += sec(label + ': только в AniList', diff.onlyAl);
        return h;
    }

    // Пересчитывает дифф из снимка cmpLast и рендерит (с учётом игнор-листа). Вызывается
    // и после скана, и после изменения игнора — без повторной загрузки данных.
    function cmpRender(resultEl) {
        if (!cmpLast) return;
        const ignore = cmpGetIgnore();
        const { shA, alA, shM, alM, shFav, alFavA, alFavM, alFavChar, alFavStaff, catalog } = cmpLast;
        const stA = { sh: cmpStats(shA), al: cmpStats(alA) };
        const stM = { sh: cmpStats(shM), al: cmpStats(alM) };
        const dA = cmpDiff(shA, alA, 'anime');
        const dM = cmpDiff(shM, alM, 'manga');
        const favA = cmpFavDiff(shFav.anime, alFavA);
        const favM = cmpFavDiff(shFav.manga, alFavM);
        const favChar = cmpNameDiff(shFav.characters || [], alFavChar || []);
        const favStaff = cmpNameDiff(shFav.people || [], alFavStaff || []);

        const titleOf = id => {
            id = Number(id);
            for (const m of [shA, alA, shM, alM]) { const e = m.get(id); if (e) return e.title; }
            for (const fm of [shFav.anime, alFavA, shFav.manga, alFavM]) { if (fm.has(id)) return fm.get(id); }
            return 'MAL#' + id;
        };
        const ignArr = [...ignore];
        const ignHtml = ignArr.length
            ? `<details class="amk-collapse"><summary>Игнорируемые <span class="amk-count">(${ignArr.length})</span></summary><div class="amk-collapse-body">${ignArr.map(id => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(titleOf(id))}</span><span class="cmp-unignore amk-x" data-id="${id}" title="Вернуть" style="color:rgb(var(--color-blue));opacity:.85;">↩</span></div>`).join('')}</div></details>`
            : '';

        resultEl.innerHTML =
            `<div style="display:flex;gap:20px;flex-wrap:wrap;">
                <div style="flex:1;min-width:280px;">${cmpRenderSummary('Аниме', stA.sh, stA.al)}</div>
                <div style="flex:1;min-width:280px;">${cmpRenderSummary('Манга', stM.sh, stM.al)}</div>
             </div>
             <div style="margin-top:6px;">${cmpRenderFavs(favA, favM, ignore)}</div>
             ${cmpRenderNameFavs('Избранные персонажи', favChar)}
             ${cmpRenderNameFavs('Избранный стафф', favStaff)}
             <h3 style="margin:16px 0 4px;color:rgb(var(--color-text));">Аниме</h3>${cmpRenderDiff(dA, ignore, catalog)}
             <h3 style="margin:16px 0 4px;color:rgb(var(--color-text));">Манга</h3>${cmpRenderDiff(dM, ignore, catalog)}
             ${ignHtml}
             <div style="opacity:.5;font-size:11px;margin-top:14px;line-height:1.5;">«В списке только на одной площадке» — не ошибка синка, а различие каталогов/списков. «Связано с уже отслеживаемым» — вероятно деление на сезоны или сиквелы (по связям AniList). Крестик ✕ — скрыть строку (игнор, запоминается). Даты не сравниваются. Оценки нормализованы к 10-балльной. Сопоставление по MAL id.</div>`;

        resultEl.querySelectorAll('.cmp-ignore').forEach(el => el.onclick = () => { cmpAddIgnore(el.dataset.id); cmpRender(resultEl); });
        resultEl.querySelectorAll('.cmp-unignore').forEach(el => el.onclick = () => { cmpRemoveIgnore(el.dataset.id); cmpRender(resultEl); });
    }

    async function cmpRunScan(shikiLogin, alName, statusEl, resultEl, deepCheck) {
        const setStatus = t => { if (statusEl) statusEl.textContent = t; };
        try {
            GM_setValue('SHIKI_LOGIN', shikiLogin);
            // AniList-имя: если не задано — берём из Viewer (нужен токен).
            if (!alName) {
                setStatus('Определяю пользователя AniList...');
                const v = await anilistQuery('query{Viewer{name}}', {}, true);
                alName = v && v.data && v.data.Viewer && v.data.Viewer.name;
                if (!alName) throw new Error('Не удалось определить AniList-пользователя. Укажите имя вручную или задайте токен в настройках.');
            }
            setStatus('Ищу пользователя Shikimori...');
            const shikiId = await cmpResolveShikiUser(shikiLogin);

            setStatus('Загружаю списки (аниме)...');
            const [shA, alA] = [await cmpFetchShikiList(shikiId, 'anime'), await cmpFetchAniListList(alName, 'ANIME')];
            setStatus('Загружаю списки (манга)...');
            const [shM, alM] = [await cmpFetchShikiList(shikiId, 'manga'), await cmpFetchAniListList(alName, 'MANGA')];
            setStatus('Загружаю избранное...');
            const shFav = await cmpFetchShikiFavs(shikiId);
            const alFavA = await cmpFetchAniListFavs(alName, 'anime');
            const alFavM = await cmpFetchAniListFavs(alName, 'manga');
            const alFavChar = await cmpFetchAniListFavPeople(alName, 'characters');
            const alFavStaff = await cmpFetchAniListFavPeople(alName, 'staff');

            // D: глубокая проверка каталогов (опционально, батчами).
            let catalog = null;
            if (deepCheck) {
                const dA0 = cmpDiff(shA, alA, 'anime');
                const dM0 = cmpDiff(shM, alM, 'manga');
                catalog = await cmpDeepCheck(
                    { anime: dA0.onlyShiki.map(x => x.id), manga: dM0.onlyShiki.map(x => x.id) },
                    { anime: dA0.onlyAl.map(x => x.id), manga: dM0.onlyAl.map(x => x.id) },
                    setStatus
                );
            }

            setStatus('Сравниваю...');
            cmpLast = { shA, alA, shM, alM, shFav, alFavA, alFavM, alFavChar, alFavStaff, catalog };
            cmpRender(resultEl);
            setStatus(`Готово: Shiki ${shA.size + shM.size} / AniList ${alA.size + alM.size} тайтлов.`);
        } catch (e) {
            Logger('ERROR', 'Сканер сравнения: ошибка', e);
            setStatus('Ошибка: ' + (e && e.message ? e.message : e));
        }
    }

    async function openCompareModal() {
        if (document.getElementById('am-cmp-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'am-cmp-overlay';
        overlay.className = 'amk-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="amk-modal amk-wide">
                <div class="amk-head">
                    <h2 class="amk-title"><span class="amk-dot"></span><span style="color:rgb(var(--color-pink));">Shikimori</span>&nbsp;⇄&nbsp;<span style="color:rgb(var(--color-blue));">AniList</span> <span class="amk-sub">сравнение списков</span></h2>
                    <button class="amk-close" id="am-cmp-close" title="Закрыть">✕</button>
                </div>
                <div class="amk-head" style="border-bottom:1px solid rgba(var(--color-text-light),0.06);">
                    <input class="amk-input" id="am-cmp-shiki" placeholder="Логин Shikimori" style="flex:1;min-width:150px;width:auto;">
                    <input class="amk-input" id="am-cmp-al" placeholder="Имя AniList (авто по токену)" style="flex:1;min-width:150px;width:auto;">
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;white-space:nowrap;" title="Проверяет по каталогам обеих площадок наличие недостающих тайтлов. Медленнее (доп. запросы)."><input type="checkbox" id="am-cmp-deep"> Глубокая проверка</label>
                    <button class="amk-btn amk-btn-primary" id="am-cmp-run">Сканировать</button>
                </div>
                <div id="am-cmp-status" style="padding:8px 18px;font-size:12px;color:rgb(var(--color-text-light));min-height:18px;flex-shrink:0;"></div>
                <div class="amk-body" id="am-cmp-result" style="padding-top:6px;"></div>
            </div>`;
        document.body.appendChild(overlay);

        const closeEl = () => overlay.remove();
        document.getElementById('am-cmp-close').onclick = closeEl;
        overlay.addEventListener('click', e => { if (e.target === overlay) closeEl(); });

        const shikiInput = document.getElementById('am-cmp-shiki');
        const alInput = document.getElementById('am-cmp-al');
        shikiInput.value = GM_getValue('SHIKI_LOGIN', '');
        // Префилл имени AniList из Viewer (если есть токен) — без блокировки открытия.
        anilistQuery('query{Viewer{name}}', {}, true).then(v => {
            const n = v && v.data && v.data.Viewer && v.data.Viewer.name;
            if (n && !alInput.value) alInput.placeholder = n + ' (по токену)';
        }).catch(() => {});

        const statusEl = document.getElementById('am-cmp-status');
        const resultEl = document.getElementById('am-cmp-result');
        const run = () => {
            const login = shikiInput.value.trim();
            if (!login) { statusEl.textContent = 'Укажите логин Shikimori.'; return; }
            const deep = document.getElementById('am-cmp-deep').checked;
            document.getElementById('am-cmp-run').disabled = true;
            cmpRunScan(login, alInput.value.trim(), statusEl, resultEl, deep).finally(() => {
                const b = document.getElementById('am-cmp-run'); if (b) b.disabled = false;
            });
        };
        document.getElementById('am-cmp-run').onclick = run;
        shikiInput.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
        alInput.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    }

    // ==========================================
    // 2. БАЗА ДАННЫХ INDEXEDDB (Кэширование)
    // ==========================================

    async function openDB() {
        if (globalDbInstance) return globalDbInstance;
        return new Promise((resolve) => {
            Logger('DB', 'Открытие подключения к IndexedDB...');
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                Logger('DB', `Обновление версии БД до ${DB_VERSION}`);
                const db = e.target.result;
                if (!db.objectStoreNames.contains('shikiCache')) db.createObjectStore('shikiCache', { keyPath: 'key' });
                if (!db.objectStoreNames.contains('malCache')) db.createObjectStore('malCache', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('franchiseCache')) db.createObjectStore('franchiseCache', { keyPath: 'id' });
            };

            req.onsuccess = () => {
                globalDbInstance = req.result;
                resolve(globalDbInstance);
            };

            req.onerror = (err) => {
                Logger('ERROR', 'Ошибка открытия IndexedDB', err);
                resolve(null);
            };
        });
    }

    async function dbGet(store, key) {
        try {
            const db = await openDB();
            if (!db) return null;
            return new Promise(resolve => {
                const req = db.transaction(store, 'readonly').objectStore(store).get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => { Logger('ERROR', `Ошибка чтения DB (${store})`, key); resolve(null); };
            });
        } catch (e) {
            Logger('ERROR', `Сбой dbGet (${store})`, e);
            return null;
        }
    }

    async function dbSet(store, data) {
        try {
            const db = await openDB();
            if (!db) return;
            return new Promise(resolve => {
                const tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).put(data);
                tx.oncomplete = () => { Logger('DB', `Запись в кэш ${store} успешна`); resolve(); };
                tx.onerror = (e) => { Logger('ERROR', `Ошибка записи DB (${store})`, e); resolve(); };
            });
        } catch (e) {
            Logger('ERROR', `Сбой dbSet (${store})`, e);
        }
    }

    async function clearCache() {
        Logger('INFO', 'Запущен ручной сброс кэша IndexedDB');
        const db = await openDB();
        if (!db) return;

        const tx = db.transaction(['shikiCache', 'malCache', 'franchiseCache'], 'readwrite');
        tx.objectStore('shikiCache').clear();
        tx.objectStore('malCache').clear();
        tx.objectStore('franchiseCache').clear();

        return new Promise(r => tx.oncomplete = r);
    }

    // Фоновый сборщик мусора (удаляет старые записи из БД)
    async function runGarbageCollector() {
        try {
            const db = await openDB();
            if (!db) return;
            const tx = db.transaction(['shikiCache'], 'readwrite');
            const store = tx.objectStore('shikiCache');
            const req = store.openCursor();
            let deletedCount = 0;

            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (Date.now() - cursor.value.ts > CACHE_TIME) {
                        cursor.delete();
                        deletedCount++;
                    }
                    cursor.continue();
                } else {
                    if (deletedCount > 0) Logger('DB', `Garbage Collector очистил ${deletedCount} устаревших записей из кэша`);
                }
            };
        } catch (e) {
            Logger('ERROR', 'Ошибка Garbage Collector', e);
        }
    }

    async function getDbStats() {
        try {
            const db = await openDB();
            if (!db) return { error: 'БД недоступна' };

            // 1. Получаем размер памяти ДО открытия транзакции IndexedDB
            let estimatedSize = 'Неизвестно';
            try {
                if (navigator.storage && navigator.storage.estimate) {
                    const est = await navigator.storage.estimate();
                    estimatedSize = (est.usage / 1024 / 1024).toFixed(2) + ' MB';
                }
            } catch(e) {}

            // 2. Открываем транзакцию
            return new Promise((resolve) => {
                const tx = db.transaction(['shikiCache', 'malCache'], 'readonly');
                const shikiStore = tx.objectStore('shikiCache');
                const malStore = tx.objectStore('malCache');

                const stats = { media: 0, characters: 0, staff: 0, themes: 0, malMappings: 0, totalShikiRecords: 0, estimatedSize };

                const malReq = malStore.count();
                malReq.onsuccess = () => { stats.malMappings = malReq.result; };

                const shikiReq = shikiStore.getAllKeys();
                shikiReq.onsuccess = () => {
                    const keys = shikiReq.result;
                    stats.totalShikiRecords = keys.length;
                    keys.forEach(key => {
                        if (typeof key === 'string') {
                            if (key.startsWith('MED2_') || key.startsWith('FULL_')) stats.media++;
                            else if (key.startsWith('CHR2_')) stats.characters++;
                            else if (key.startsWith('STF3_')) stats.staff++;
                            else if (key.startsWith('THEMES_')) stats.themes++;
                        }
                    });
                };

                tx.oncomplete = () => resolve(stats);
                tx.onerror = () => resolve({ error: 'Ошибка чтения метрик БД' });
            });
        } catch (e) {
            return { error: e.message };
        }
    }

    // ==========================================
    // 3. ОБЩИЕ ФУНКЦИИ API И АВТОРИЗАЦИИ
    // ==========================================

    function getAlToken() {
        let token = GM_getValue("AL_TOKEN");
        if (token) return token;

        // Пытаемся вытянуть токен из Vuex самого сайта (если юзер залогинен на AniList)
        if (IS_ANILIST) {
            try {
                const vuex = JSON.parse(localStorage.getItem('vuex'));
                if (vuex && vuex.auth && vuex.auth.token) return vuex.auth.token;
            } catch(e) { Logger('ERROR', 'Ошибка чтения Vuex хранилища AniList', e); }
        }
        return null;
    }

    async function anilistQuery(query, variables, useAuth = false) {
        if (Date.now() < alRateLimitPause) {
            await new Promise(r => setTimeout(r, alRateLimitPause - Date.now() + Math.floor(Math.random() * 500)));
        }

        const headers = { "Content-Type": "application/json", "Accept": "application/json" };
        if (useAuth) {
            const token = getAlToken();
            if (token) headers["Authorization"] = "Bearer " + token;
        }

        Logger('API', 'GraphQL запрос (AniList)', { query: query.substring(0, 100) + '...', variables, useAuth });

        const startTime = performance.now();

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: "https://graphql.anilist.co",
                headers,
                data: JSON.stringify({ query, variables }),
                onload: (res) => {
                    if (res.status === 200) {
                        const timeTaken = Math.round(performance.now() - startTime);
                        Logger('API', `[DONE] GraphQL запрос (AniList) выполнен за ${timeTaken}ms`);
                        resolve(JSON.parse(res.responseText));
                    } else if (res.status === 429) {
                        const match = res.responseHeaders?.match(/retry-after:\s*(\d+)/i);
                        const waitTime = match ? parseInt(match[1]) * 1000 : 5000;
                        alRateLimitPause = Date.now() + waitTime + 500;
                        Logger('ERROR', `AniList Rate Limit 429! Ожидание ${waitTime}ms`, res);
                        // Повторяем запрос после паузы
                        setTimeout(() => resolve(anilistQuery(query, variables, useAuth)), waitTime + 500 + Math.floor(Math.random() * 500));
                    } else {
                        Logger('ERROR', `AniList API Error HTTP ${res.status}`, res.responseText);
                        reject(`Error ${res.status}`);
                    }
                },
                onerror: (e) => {
                    Logger('ERROR', 'AniList Network Error', e);
                    reject(e);
                }
            });
        });
    }

    // Запрос к Shikimori с fallback перебором зеркал
    async function fetchShiki(path) {
        if (Date.now() < shikiRateLimitPause) {
            await new Promise(r => setTimeout(r, shikiRateLimitPause - Date.now() + Math.floor(Math.random() * 500)));
        }

        Logger('API', `Запрос к Shikimori API: ${path}`);
        for (const domain of SHIKI_DOMAINS) {
            try {
                const res = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: `https://${domain}${path}`,
                        timeout: 5000,
                        onload: (r) => {
                            if (r.status === 200) resolve({ data: JSON.parse(r.responseText), domain });
                            else if (r.status === 429) { shikiRateLimitPause = Date.now() + 5000; resolve({ status: 429 }); }
                            else if (r.status === 404) resolve({ data: null, domain });
                            else reject(r.status);
                        },
                        onerror: reject, ontimeout: reject
                    });
                });

                if (res && res.status === 429) {
                    Logger('ERROR', `Shikimori Rate Limit 429 (${domain})! Пауза.`);
                    await new Promise(r => setTimeout(r, 5000 + Math.floor(Math.random() * 1000)));
                    return fetchShiki(path); // Рекурсивный повтор
                }
                if (res) return res;
            } catch (e) {
                Logger('ERROR', `Ошибка запроса к зеркалу Shiki: ${domain}`, e);
            }
        }
        return { data: null, domain: null };
    }

    // Запрос музыкальных тем с AnimeThemes API
    async function fetchMalThemes(malId) {
        if (!malId) return null;
        const cacheKey = `THEMES_${malId}`;
        const cached = await dbGet('shikiCache', cacheKey);
        if (cached && (Date.now() - cached.ts < CACHE_TIME)) return cached.data;

        Logger('API', `Запрос AnimeThemes.moe для MAL ID: ${malId}`);
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://api.animethemes.moe/anime?filter[has]=resources&filter[site]=MyAnimeList&filter[external_id]=${malId}&include=animethemes.song`,
                onload: (res) => {
                    if (res.status === 200) {
                        try {
                            const data = JSON.parse(res.responseText);
                            const animeList = data.anime || [];

                            // Если аниме не найдено, отдаем пустые массивы
                            if (animeList.length === 0) {
                                const emptyData = { openings: [], endings: [] };
                                dbSet('shikiCache', { key: cacheKey, data: emptyData, ts: Date.now() });
                                return resolve(emptyData);
                            }

                            const themes = animeList[0].animethemes || [];
                            const formattedData = { openings: [], endings: [] };

                            themes.forEach(t => {
                                const title = t.song && t.song.title ? t.song.title : t.slug;
                                const seq = t.slug.replace(/[^0-9]/g, '') || '1';
                                const str = `${seq}: "${title}"`;

                                if (t.type === 'OP') formattedData.openings.push(str);
                                else if (t.type === 'ED') formattedData.endings.push(str);
                            });

                            dbSet('shikiCache', { key: cacheKey, data: formattedData, ts: Date.now() });
                            resolve(formattedData);
                        } catch (e) {
                            Logger('ERROR', 'Ошибка парсинга AnimeThemes', e);
                            resolve(null);
                        }
                    } else if (res.status === 429) {
                        Logger('ERROR', 'AnimeThemes Rate Limit 429! Повторная попытка...');
                        setTimeout(() => resolve(fetchMalThemes(malId)), 1500 + Math.floor(Math.random() * 500));
                    } else {
                        Logger('ERROR', `AnimeThemes Error HTTP ${res.status}`);
                        resolve(null);
                    }
                },
                onerror: (e) => {
                    Logger('ERROR', 'AnimeThemes Network Error', e);
                    resolve(null);
                }
            });
        });
    }

    // Продвинутый поиск персоны (Сейю/Персонал) на Shiki
    async function fetchShikiPersonREST(endpointStr, searchName, nativeName) {
        if (!searchName) return { status: 404, data: null };
        let cleanStr = searchName.replace(/_/g, ' ').replace(/-/g, ' ').trim();
        let nameParts = cleanStr.split(' ');
        let reversedName = nameParts.length > 1 ? [...nameParts].reverse().join(' ') : cleanStr;
        let finalStatus = 404;

        Logger('API', `Поиск персоны на Shiki: ${cleanStr}`);
        for (const domain of SHIKI_DOMAINS) {
            try {
                let fetchMatch = async (url) => {
                    let r = await new Promise(resolve => GM_xmlhttpRequest({ method: "GET", url, onload: resolve, onerror: () => resolve({status: 0}) }));
                    if (r.status === 429) throw { status: 429 };
                    if (r.status === 200) {
                        try {
                            let res = JSON.parse(r.responseText);
                            if (res && res.length > 0) {
                                let target = cleanStr.toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim();
                                let targetRev = reversedName.toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim();
                                let targetNat = (nativeName || '').replace(/\s+/g, '').trim();

                                for (let c of res) {
                                    let en = (c.name || '').toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim();
                                    let ru = (c.russian || '').toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim();
                                    let jpn = (c.japanese || '').replace(/\s+/g, '').trim();
                                    if (en === target || en === targetRev || ru === target || ru === targetRev) return c;
                                    if (targetNat && jpn && jpn.includes(targetNat)) return c;
                                }
                                for (let c of res) {
                                    let en = (c.name || '').toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim();
                                    if (en.includes(target) || (targetRev.length > 4 && en.includes(targetRev))) return c;
                                }
                                return res[0];
                            }
                        } catch(e) { Logger('ERROR', 'Ошибка парсинга персоны Shiki', e); }
                    }
                    return null;
                };

                let item = await fetchMatch(`https://${domain}/api/${endpointStr}/search?search=${encodeURIComponent(cleanStr)}`);
                if (!item && nameParts.length > 1) item = await fetchMatch(`https://${domain}/api/${endpointStr}/search?search=${encodeURIComponent(reversedName)}`);
                if (!item) item = await fetchMatch(`https://${domain}/api/${endpointStr}?search=${encodeURIComponent(cleanStr)}`);

                if (!item) {
                    const gqlQuery = `query($search: String) { ${endpointStr}(search: $search, limit: 1) { id russian } }`;
                    let r = await new Promise(resolve => GM_xmlhttpRequest({
                        method: "POST", url: `https://${domain}/api/graphql`,
                        headers: { "Content-Type": "application/json", "Accept": "application/json" },
                        data: JSON.stringify({ query: gqlQuery, variables: { search: cleanStr } }),
                        onload: resolve, onerror: () => resolve({status: 0})
                    }));
                    if (r.status === 429) return { status: 429 };
                    if (r.status === 200) {
                        try {
                            let res = JSON.parse(r.responseText);
                            if (res.data && res.data[endpointStr] && res.data[endpointStr].length > 0) item = res.data[endpointStr][0];
                        } catch(e) { Logger('ERROR', 'Ошибка парсинга GraphQL Shiki', e); }
                    }
                }

                if (item && item.id) {
                    let rDetails = await new Promise(resolve => GM_xmlhttpRequest({ method: "GET", url: `https://${domain}/api/${endpointStr}/${item.id}`, onload: resolve, onerror: () => resolve({status: 0}) }));
                    if (rDetails.status === 429) return { status: 429 };
                    if (rDetails.status === 200) {
                        let detailsRes = JSON.parse(rDetails.responseText);
                        return { status: 200, data: { id: detailsRes.id || item.id, russian: detailsRes.russian || item.russian, description: detailsRes.description, url: detailsRes.url, domain } };
                    } else {
                        return { status: 200, data: { id: item.id, russian: item.russian, description: null, domain } };
                    }
                }
            } catch (e) { if (e.status === 429) return { status: 429 }; }
        }
        Logger('API', `Персона не найдена: ${cleanStr}`);
        return { status: finalStatus, data: null };
    }

    async function resolveShikiPersonByMedia(personData, type) {
        let mediaNodes = (type === 'characters' ? personData.media : personData.staffMedia)?.nodes ||[];
        let malIds = mediaNodes.map(m => m.idMal).filter(id => id);
        if (malIds.length === 0) return null;

        let targetFull = (personData.name.full || '').toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim();
        let parts = (personData.name.full || '').split(' ');
        let targetReversed = parts.length > 1 ? [...parts].reverse().join(' ').toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim() : targetFull;

        for (let malId of malIds) {
            let rolesRes = await fetchShiki(`/api/animes/${malId}/roles`);
            if (rolesRes.data) {
                let items = rolesRes.data.map(r => type === 'characters' ? r.character : r.person).filter(x => x);
                for (let c of items) {
                    let en = (c.name || '').toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim();
                    let ru = (c.russian || '').toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim();
                    if (en === targetFull || en === targetReversed || ru === targetFull || ru === targetReversed) return c;
                }
                for (let c of items) {
                    let en = (c.name || '').toLowerCase().replace(/[^a-zа-я0-9\s]/gi, '').trim();
                    if (en.includes(targetFull) || en.includes(targetReversed)) return c;
                }
            }
        }
        return null;
    }

    // ==========================================
    // 4. ЭКСПОРТЕР СПИСКА (Shikimori -> AniList)
    // ==========================================
    function initExporter() {
        Logger('INFO', 'Инициализация модуля Экспортера');
        const mapStatusShikiToAL = { 'planned': 'PLANNING', 'watching': 'CURRENT', 'reading': 'CURRENT', 'completed': 'COMPLETED', 'on_hold': 'PAUSED', 'dropped': 'DROPPED', 'rewatching': 'REPEATING', 'rereading': 'REPEATING' };

        function convertScoreShikiToAL(score, format) {
            if (!score) return 0;
            switch (format) {
                case 'POINT_100': case 'POINT_10_DECIMAL': return score * 10;
                case 'POINT_10': return score;
                case 'POINT_5': return Math.round(score / 2);
                case 'POINT_3': return score >= 8 ? 3 : (score >= 5 ? 2 : 1);
                default: return score;
            }
        }

        function fuzzyEquals(fd1, fd2) {
            const empty1 = !fd1 || (!fd1.year && !fd1.month && !fd1.day);
            const empty2 = !fd2 || (!fd2.year && !fd2.month && !fd2.day);
            if (empty1 && empty2) return true;
            if (empty1 || empty2) return false;
            return fd1.year === fd2.year && fd1.month === fd2.month && fd1.day === fd2.day;
        }

        function makeFuzzyDate(d) {
            if (!d) return undefined;
            const date = new Date(d);
            if (isNaN(date.getTime())) return undefined;
            return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
        }

        async function fetchShikiUserId(username) {
            const res = await fetch(`${window.location.origin}/api/users/${username}`);
            if (!res.ok) throw new Error("Пользователь Shikimori не найден.");
            return (await res.json()).id;
        }

        async function fetchShikimoriListV2(userId, type) {
            let page = 1; let all =[]; let seen = new Set();
            const targetType = type === 'anime' ? 'Anime' : 'Manga';
            Logger('INFO', `Скачивание списка ${type} с Shikimori v2...`);

            while (true) {
                const url = `${window.location.origin}/api/v2/user_rates?user_id=${userId}&target_type=${targetType}&limit=1000&page=${page}`;
                const res = await fetch(url);
                if (!res.ok) {
                    if (res.status === 404) break;
                    if (res.status === 403) throw new Error("Профиль скрыт.");
                    break;
                }
                const data = await res.json();
                if (!data || data.length === 0) break;

                let added = 0;
                for (let item of data) {
                    if (!seen.has(item.id)) { seen.add(item.id); all.push(item); added++; }
                }
                if (added === 0) break;
                page++; await new Promise(r => setTimeout(r, 500));
            }
            return all;
        }

        // Парсинг истории активности юзера (даты начала и окончания просмотров)
        async function fetchShikiHistoryDates(userId, btn) {
            let page = 1; const datesMap = {};
            while (true) {
                if (btn) btn.textContent = `Анализ таймингов (стр. ${page})...`;
                try {
                    const res = await fetch(`${window.location.origin}/api/users/${userId}/history?limit=100&page=${page}`);
                    if (!res.ok) {
                        if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
                        break;
                    }
                    const data = await res.json();
                    if (!data || data.length === 0) break;

                    data.forEach(item => {
                        if (!item.target) return;
                        const id = item.target.id;
                        const dateObj = new Date(item.created_at);
                        const desc = (item.description || "").toLowerCase();

                        if (!datesMap[id]) datesMap[id] = { starts: [], ends:[] };
                        if (desc === 'просмотрено' || desc === 'прочитано' || desc === 'пересмотрено' || desc === 'перечитано') {
                            datesMap[id].ends.push(dateObj.getTime());
                        } else if (desc.includes('смотрю') || desc.includes('читаю') || desc.includes('просмотрен') || desc.includes('прочитан') || desc.includes('эпизод') || desc.includes('глав') || desc.includes('пересматр') || desc.includes('перечитыв')) {
                            datesMap[id].starts.push(dateObj.getTime());
                        }
                    });

                    if (data.length < 100) break;
                    page++; await new Promise(r => setTimeout(r, 350));
                } catch(e) { break; }
            }

            const finalMap = {};
            for (const id in datesMap) {
                const starts = datesMap[id].starts; const ends = datesMap[id].ends;
                let start = starts.length > 0 ? new Date(Math.min(...starts)) : null;
                let end = ends.length > 0 ? new Date(Math.max(...ends)) : null;
                finalMap[id] = { start, end };
            }
            return finalMap;
        }

        async function fetchShikimoriFavorites(usernameOrId) {
            const endpoints =[`/api/users/${usernameOrId}/favorites`, `/api/users/${usernameOrId}/favourites`];
            for (const ep of endpoints) {
                try { const res = await fetch(window.location.origin + ep); if (res.ok) return await res.json(); } catch(e) { }
            }
            return null;
        }

        // Пакетный маппинг ID (MAL -> AniList)
        async function getAnilistIds(malIds, type) {
            if (!malIds || malIds.length === 0) return {};
            const map = {};
            for (let i = 0; i < malIds.length; i += 50) {
                const chunk = malIds.slice(i, i + 50);
                const query = `query($m:[Int],$t:MediaType){Page(page:1,perPage:50){media(idMal_in:$m,type:$t){id idMal}}}`;
                const res = await anilistQuery(query, { m: chunk, t: type });
                if (res?.data?.Page?.media) res.data.Page.media.forEach(m => map[m.idMal] = m.id);
                await new Promise(r => setTimeout(r, 700));
            }
            return map;
        }

        // Загрузка существующего списка с AniList для сверки
        async function getExistingAnilistList(alUserId, type, btn) {
            const map = {};
            if (btn) btn.textContent = `Загрузка AL списка (${type})...`;
            const query = `query($u:Int!,$t:MediaType){MediaListCollection(userId:$u,type:$t){lists{entries{mediaId status score progress progressVolumes repeat notes startedAt { year month day } completedAt { year month day }}}}}`;
            const res = await anilistQuery(query, {u: alUserId, t: type});
            const lists = res?.data?.MediaListCollection?.lists ||[];
            lists.forEach(list => list.entries.forEach(m => map[m.mediaId] = m));
            await new Promise(r => setTimeout(r, 600));
            return map;
        }

        async function getExistingAnilistFavorites(alUserId, btn) {
            const existing = { anime: new Set(), manga: new Set(), characters: new Set(), staff: new Set() };
            const fetchFav = async (type, targetSet) => {
                let page = 1; let hasNextPage = true;
                if (btn) btn.textContent = `Загрузка Fav AL (${type})...`;
                while (hasNextPage) {
                    const query = `query($u:Int!,$p:Int!){User(id:$u){favourites{${type}(page:$p){pageInfo{hasNextPage}nodes{id}}}}}`;
                    const res = await anilistQuery(query, {u: alUserId, p: page});
                    const data = res?.data?.User?.favourites[type];
                    if (!data) break;
                    data.nodes.forEach(n => targetSet.add(n.id));
                    hasNextPage = data.pageInfo.hasNextPage;
                    page++; await new Promise(r => setTimeout(r, 600));
                }
            };
            await fetchFav('anime', existing.anime); await fetchFav('manga', existing.manga);
            await fetchFav('characters', existing.characters); await fetchFav('staff', existing.staff);
            return existing;
        }

        async function getAnilistIdByName(name, type) {
            const field = type === 'CHARACTER' ? 'characters' : 'staff';
            const query = `query($s:String){Page(page:1,perPage:1){${field}(search:$s){id}}}`;
            try {
                const res = await anilistQuery(query, { s: name });
                if (res?.data?.Page[field]?.length > 0) return res.data.Page[field][0].id;
            } catch(e) {}
            return null;
        }

        // Основная функция синхронизации списка
        async function syncShikiToAlList(shikiItems, type, alUser, historyDates, btn) {
            if (!shikiItems || shikiItems.length === 0) return;
            const alType = type === 'anime' ? 'ANIME' : 'MANGA';
            const valids = shikiItems.filter(i => i && i.target_id);
            if (valids.length === 0) return;

            if (btn) btn.textContent = `Сверка ID (${type})...`;
            const idMap = await getAnilistIds(valids.map(i => i.target_id), alType);
            const exList = await getExistingAnilistList(alUser.id, alType, btn);

            let count = 0;
            for (const item of valids) {
                count++;
                if (btn) btn.textContent = `Shiki ➜ AL (${type}): ${count}/${valids.length}`;

                const alId = idMap[item.target_id];
                if (!alId) { if (count % 50 === 0) await new Promise(r => setTimeout(r, 10)); continue; }

                const status = mapStatusShikiToAL[item.status] || 'PLANNING';
                const scoreRaw = convertScoreShikiToAL(item.score, alUser.mediaListOptions.scoreFormat);
                const progress = (type === 'anime' ? item.episodes : item.chapters) || 0;
                const progressVolumes = (type === 'manga' ? item.volumes : 0) || 0;
                const repeat = item.rewatches || 0;

                let notes = item.text && item.text.trim().length > 0 ? item.text.trim() : undefined;
                if (notes) {
                    // Парсинг BB-кодов заметок с Shiki в Markdown
                    notes = notes.replace(/\[b\](.*?)\[\/b\]/gi, '**$1**').replace(/\[i\](.*?)\[\/i\]/gi, '*$1*')
                                 .replace(/\[s\](.*?)\[\/s\]/gi, '~~$1~~').replace(/\[spoiler(?:=[^\]]+)?\]([\s\S]*?)\[\/spoiler\]/gi, '~!$1!~')
                                 .replace(/\[url=(.+?)\](.*?)\[\/url\]/gi, '[$2]($1)');
                }

                let startedAt = undefined; let completedAt = undefined;
                if (historyDates && historyDates[item.target_id]) {
                    if (historyDates[item.target_id].start) startedAt = makeFuzzyDate(historyDates[item.target_id].start);
                    if (historyDates[item.target_id].end) completedAt = makeFuzzyDate(historyDates[item.target_id].end);
                }
                if (!startedAt && item.status !== 'planned' && item.created_at) startedAt = makeFuzzyDate(item.created_at);
                if (!completedAt && item.status === 'completed' && item.updated_at) completedAt = makeFuzzyDate(item.updated_at);

                const ex = exList[alId];
                if (ex) {
                    let alRawScore = Math.round(ex.score || 0);
                    if (alUser.mediaListOptions.scoreFormat === 'POINT_10_DECIMAL') alRawScore = Math.round((ex.score || 0) * 10);
                    let isSame = ex.status === status && alRawScore === scoreRaw && (ex.progress || 0) === progress &&
                                 (ex.repeat || 0) === repeat && fuzzyEquals(ex.startedAt, startedAt) && fuzzyEquals(ex.completedAt, completedAt);
                    if (type === 'manga') isSame = isSame && (ex.progressVolumes || 0) === progressVolumes;
                    if (notes !== undefined) isSame = isSame && (ex.notes ? ex.notes.trim() : undefined) === notes;

                    // Если данные на AniList идентичны Shikimori, пропускаем запрос
                    if (isSame) { if (count % 50 === 0) await new Promise(r => setTimeout(r, 10)); continue; }
                }

                const variables = { mediaId: alId, status, scoreRaw, progress, repeat };
                if (type === 'manga' && progressVolumes > 0) variables.progressVolumes = progressVolumes;
                if (notes !== undefined) variables.notes = notes;
                if (startedAt) variables.startedAt = startedAt;
                if (completedAt) variables.completedAt = completedAt;

                const mutationVars = []; const mutationArgs =[];
                for (const key of Object.keys(variables)) {
                    const typeStr = key === 'status' ? 'MediaListStatus' : key === 'notes' ? 'String' : (key === 'startedAt' || key === 'completedAt') ? 'FuzzyDateInput' : 'Int';
                    mutationVars.push(`$${key}:${typeStr}`); mutationArgs.push(`${key}:$${key}`);
                }
                const mutation = `mutation(${mutationVars.join(',')}){SaveMediaListEntry(${mutationArgs.join(',')}){id}}`;

                try { await anilistQuery(mutation, variables, true); } catch(e) {}
                await new Promise(r => setTimeout(r, 700)); // Лимит AniList (90/мин)
            }
        }

        async function syncShikiToAlFavorites(shikiFavs, exAlFavs, btn) {
            if (!shikiFavs) return;
            const processFavorites = async (arr, alType, exSet, varName) => {
                if (!arr || arr.length === 0) return;
                let processedCount = 0;
                const field = alType === 'ANIME' ? 'anime' : alType === 'MANGA' ? 'manga' : alType === 'CHARACTER' ? 'characters' : 'staff';
                const mutation = `mutation($id:Int!){ToggleFavourite(${varName}:$id){${field}{pageInfo{total}}}}`;

                if (['ANIME', 'MANGA'].includes(alType)) {
                    if (btn) btn.textContent = `Сверка ID (Fav ${alType})...`;
                    const idMap = await getAnilistIds(arr.map(x => x.id), alType);
                    for (const item of arr) {
                        processedCount++;
                        if (btn) btn.textContent = `Shiki ➜ AL (Fav ${alType}): ${processedCount}/${arr.length}`;
                        const alId = idMap[item.id];
                        if (!alId || exSet.has(alId)) { if (processedCount % 50 === 0) await new Promise(r => setTimeout(r, 10)); continue; }
                        try { await anilistQuery(mutation, { id: alId }, true); } catch(e) {}
                        await new Promise(r => setTimeout(r, 700));
                    }
                } else {
                    for (const item of arr) {
                        processedCount++;
                        if (btn) btn.textContent = `Shiki ➜ AL (Fav ${alType}): ${processedCount}/${arr.length}`;
                        const alId = await getAnilistIdByName(item.name, alType);
                        if (!alId || exSet.has(alId)) { await new Promise(r => setTimeout(r, 600)); continue; }
                        try { await anilistQuery(mutation, { id: alId }, true); } catch(e) {}
                        await new Promise(r => setTimeout(r, 700));
                    }
                }
            };
            const shikiStaff =[...(shikiFavs.people || []), ...(shikiFavs.seyu || []), ...(shikiFavs.mangakas ||[])];
            const uniqStaff = Array.from(new Map(shikiStaff.map(i =>[i.id, i])).values());
            await processFavorites(shikiFavs.animes, 'ANIME', exAlFavs.anime, 'animeId');
            await processFavorites(shikiFavs.mangas, 'MANGA', exAlFavs.manga, 'mangaId');
            await processFavorites(shikiFavs.characters, 'CHARACTER', exAlFavs.characters, 'characterId');
            await processFavorites(uniqStaff, 'STAFF', exAlFavs.staff, 'staffId');
        }

        // На Shikimori переменных тем AniList (--color-*) нет — выводим их из реальных
        // цветов страницы (фон/текст), чтобы кит подстроился и под светлую, и под тёмную
        // тему Shiki. Акцент/статусы — фиксированные.
        function amkShikiTokens(el) {
            const triple = (c, fb) => { const m = (c || '').match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/); return m ? `${m[1]} ${m[2]} ${m[3]}` : fb; };
            let bg = getComputedStyle(document.body).backgroundColor;
            if (!bg || bg === 'transparent' || bg.replace(/\s/g, '').includes('rgba(0,0,0,0)')) bg = getComputedStyle(document.documentElement).backgroundColor;
            const bgT = triple(bg, '18 18 28');
            const txT = triple(getComputedStyle(document.body).color, '226 232 240');
            const vars = { '--color-foreground': bgT, '--color-background': bgT, '--color-background-100': bgT, '--color-background-200': bgT, '--color-background-300': bgT, '--color-text': txT, '--color-text-light': txT, '--color-blue': '61 187 238', '--color-pink': '243 139 168', '--color-red': '252 129 129', '--color-green': '166 227 161', '--color-orange': '246 193 119', '--color-purple': '183 148 244' };
            for (const k in vars) el.style.setProperty(k, vars[k]);
        }

        async function openExportModal(btn) {
            if (document.getElementById('shiki-export-overlay')) return;
            const urlPath = window.location.pathname.split('/');
            const dUser = (urlPath.length > 1 && !['animes', 'mangas', 'forum'].includes(urlPath[1])) ? urlPath[1] : "";
            const tok = GM_getValue("AL_TOKEN", "");

            const sw = (id, on = true) => `<label class="amk-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="amk-track"></span><span class="amk-thumb"></span></label>`;
            const overlayTemplate = `
                <div id="shiki-export-overlay" class="amk-overlay" style="display:flex;">
                    <div class="amk-modal" style="width:500px;">
                        <div class="amk-head">
                            <h2 class="amk-title"><span class="amk-dot"></span><span style="color:rgb(var(--color-pink));">Shikimori</span>&nbsp;➜&nbsp;<span style="color:rgb(var(--color-blue));">AniList</span> <span class="amk-sub">экспорт</span></h2>
                            <button class="amk-close" id="se-close" title="Закрыть">✕</button>
                        </div>
                        <div class="amk-body">
                            <div style="display:flex;gap:10px;">
                                <input class="amk-input" id="se-user" placeholder="Логин Shikimori" style="flex:1;width:auto;">
                                <input class="amk-input amk-mono" type="password" id="se-token" placeholder="Токен AniList" style="flex:1;width:auto;">
                            </div>
                            <div class="amk-card">
                                <div class="amk-card-title">Что переносить</div>
                                <div class="amk-row"><span class="amk-row-label"><b>Аниме</b></span>${sw('se-anime')}</div>
                                <div class="amk-row"><span class="amk-row-label"><b>Манга</b></span>${sw('se-manga')}</div>
                                <div class="amk-row"><span class="amk-row-label"><b>Избранное</b></span>${sw('se-favs')}</div>
                                <div class="amk-row"><span class="amk-row-label"><b>Точные даты просмотров</b><span class="amk-row-hint">из истории Shikimori (медленнее)</span></span>${sw('se-dates')}</div>
                            </div>
                            <div class="amk-card">
                                <div class="amk-card-title">Токен AniList</div>
                                <div class="amk-row-hint" style="padding:8px 2px 6px;">Создайте Client <a href="https://anilist.co/settings/developer" target="_blank" style="color:rgb(var(--color-blue));text-decoration:none;">здесь</a>, redirect URL: <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;">https://anilist.co/api/v2/oauth/pin</code></div>
                                <div style="display:flex;gap:8px;">
                                    <input class="amk-input amk-mono" id="se-gen-client" placeholder="Client ID" style="flex:1;width:auto;">
                                    <button class="amk-btn amk-btn-ghost" id="se-gen-btn">Создать URL</button>
                                </div>
                                <div id="se-gen-url" style="margin-top:10px;text-align:center;font-size:12px;"></div>
                            </div>
                        </div>
                        <div class="amk-foot">
                            <button class="amk-btn amk-btn-primary amk-btn-block" id="se-start">Запуск</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', overlayTemplate);
            document.getElementById('se-user').value = dUser;
            document.getElementById('se-token').value = tok;

            const overlay = document.getElementById('shiki-export-overlay');
            amkShikiTokens(overlay);
            document.getElementById('se-close').onclick = () => overlay.remove();
            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

            document.getElementById('se-gen-btn').onclick = () => {
                const cid = document.getElementById('se-gen-client').value.trim();
                if (!cid) return alert("Введите Client ID");
                const authLink = document.createElement('a');
                authLink.href = `https://anilist.co/api/v2/oauth/authorize?client_id=${cid}&response_type=token`;
                authLink.target = "_blank";
                authLink.style.cssText = "color:rgb(var(--color-blue));text-decoration:none;font-weight:700;display:inline-block;padding:6px 12px;border:1px solid rgb(var(--color-blue));border-radius:6px;";
                authLink.textContent = "👉 Клик для авторизации";
                document.getElementById('se-gen-url').innerHTML = '';
                document.getElementById('se-gen-url').appendChild(authLink);
            };

            document.getElementById('se-start').onclick = async () => {
                const user = document.getElementById('se-user').value.trim();
                const token = document.getElementById('se-token').value.trim();
                const exportAnime = document.getElementById('se-anime').checked;
                const exportManga = document.getElementById('se-manga').checked;
                const exportFavs = document.getElementById('se-favs').checked;
                const exportDates = document.getElementById('se-dates').checked;

                if (!user || !token) return alert("Заполните логин и токен!");
                if (!exportAnime && !exportManga && !exportFavs) return alert("Выберите опции для экспорта!");

                GM_setValue("AL_TOKEN", token);
                document.getElementById('se-token').value = "";
                document.getElementById('shiki-export-overlay').remove();
                btn.disabled = true;

                try {
                    btn.textContent = "Соединение с AniList...";
                    const res = await anilistQuery(`query{Viewer{id name mediaListOptions{scoreFormat}}}`, {}, true);
                    const alUser = res.data.Viewer;

                    btn.textContent = "Поиск профиля Shiki...";
                    const shikiId = await fetchShikiUserId(user);

                    if (!confirm(`Начать перенос Shikimori ➜ AniList для профиля '${alUser.name}'?\n\nВнимание: Экспорт может занять некоторое время.`)) return;

                    let historyDates = null;
                    if (exportDates && (exportAnime || exportManga)) historyDates = await fetchShikiHistoryDates(shikiId, btn);
                    if (exportAnime) {
                        const animeList = await fetchShikimoriListV2(shikiId, 'anime');
                        await syncShikiToAlList(animeList, 'anime', alUser, historyDates, btn);
                    }
                    if (exportManga) {
                        const mangaList = await fetchShikimoriListV2(shikiId, 'manga');
                        await syncShikiToAlList(mangaList, 'manga', alUser, historyDates, btn);
                    }
                    if (exportFavs) {
                        const exFavs = await getExistingAnilistFavorites(alUser.id, btn);
                        const shikiFavs = await fetchShikimoriFavorites(user);
                        await syncShikiToAlFavorites(shikiFavs, exFavs, btn);
                    }
                    alert("Экспорт успешно завершен!");
                } catch (e) {
                    alert("Ошибка: " + (e.message || e));
                } finally {
                    btn.disabled = false;
                    setTimeout(() => btn.textContent = "ЭКСПОРТ", 2000);
                }
            };
        }

        const btn = document.createElement('button');
        btn.textContent = 'Экспорт';
        btn.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:9999;padding:11px 20px;background:rgba(var(--color-foreground),0.8);backdrop-filter:blur(16px) saturate(170%);-webkit-backdrop-filter:blur(16px) saturate(170%);border:1px solid rgba(var(--color-text-light),0.2);color:rgb(var(--color-text));border-radius:12px;cursor:pointer;font-weight:600;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,0.18);transition:border-color .2s, color .2s;letter-spacing:0.3px;';
        amkShikiTokens(btn);
        btn.onmouseover = () => { btn.style.borderColor = 'rgb(var(--color-blue))'; btn.style.color = 'rgb(var(--color-blue))'; };
        btn.onmouseout = () => { btn.style.borderColor = 'rgba(var(--color-text-light),0.2)'; btn.style.color = 'rgb(var(--color-text))'; };
        btn.onclick = () => openExportModal(btn);
        document.body.appendChild(btn);
    }

    // ==========================================
    // 5. МОДУЛЬ ПЕРЕВОДА И ИНТЕРФЕЙСА (ANILIST)
    // ==========================================
    function initTranslator() {
        Logger('INFO', 'Запуск модуля Translator');

        const queue = new Map();
        const pending = { MED2: new Set(), CHR2: new Map(), STF3: new Map() };
        globalPendingQueues = pending; // Прокидываем наружу для Инспектора

        let isProcessing = false;
        let debounceTimer = null;
        let ensureWidgetsTimer = null;

        function cleanShikiBB(text, url) {
            if (!text) return "";
            let safeText = escapeHTML(text);
            const html = safeText.replace(/\[i\](.*?)\[\/i\]/gi, '<i>$1</i>').replace(/\[b\](.*?)\[\/b\]/gi, '<b>$1</b>').replace(/\[u\](.*?)\[\/u\]/gi, '<u>$1</u>').replace(/\[\w+=\d+\](.*?)\[\/\w+\]/gi, '$1').replace(/\[\w+(=.*?)?\]/gi, '').replace(/\[\/\w+\]/gi, '').replace(/\n/g, '<br>');
            const safeUrl = escapeHTML(url);
            return html + `<br><br><small style="opacity:0.75;font-size:0.85em;">Описание предоставлено <a href="${safeUrl}" target="_blank" style="color:#3dbbee; font-weight:bold;">Shikimori</a></small>`;
        }

        function translateAdvanced(text) {
            if (!settings.translateInterface) return null;
            if (!text) return null;

            const cleanText = text.replace(/\s+/g, ' ').trim();
            if (cleanText.length < 2) return null;
            if (/^[\d\s.,\-:[\]()]+$/.test(cleanText)) return null;

            if (Object.prototype.hasOwnProperty.call(dictionary, cleanText)) return dictionary[cleanText];

            if (cleanText.includes(' · ')) {
                return cleanText.split(' · ').map(p => {
                    return (Object.prototype.hasOwnProperty.call(dictionary, p.trim()) ? dictionary[p.trim()] : null) || translateAdvanced(p.trim()) || p.trim();
                }).join(' · ');
            }

            let match;
            if ((match = cleanText.match(rxRole))) {
                let roleTr = (Object.prototype.hasOwnProperty.call(dictionary, match[1].trim()) ? dictionary[match[1].trim()] : null) || match[1].trim();
                let episodes = match[2].trim().replace(rxRoleEps, 'сер.').replace(rxRoleOP, 'OP').replace(rxRoleED, 'ED');
                return `${roleTr} (${episodes})`;
            }

            if ((match = cleanText.match(rxRanking))) {
                const rank = match[1];
                const type = match[2].toLowerCase() === 'highest rated' ? 'в рейтинге' : 'популярности';
                let time = match[3].toLowerCase();
                if (time === 'all time') {
                    time = 'за всё время';
                } else {
                    const seasonMatch = time.match(/^(winter|spring|summer|fall)\s+(\d{4})$/);
                    if (seasonMatch) {
                        const sMap = { winter: 'зимы', spring: 'весны', summer: 'лета', fall: 'осени' };
                        time = `за сезон ${sMap[seasonMatch[1]]} ${seasonMatch[2]} года`;
                    } else if (/^\d{4}$/.test(time)) {
                        time = `за ${time} год`;
                    }
                }
                return `#${rank} ${type} ${time}`;
            }

            if ((match = cleanText.match(rxAiringEp))) {
                const units = { second:['секунду', 'секунды', 'секунд'], minute: ['минуту', 'минуты', 'минут'], min: ['минуту', 'минуты', 'минут'], hour:['час', 'часа', 'часов'], day: ['день', 'дня', 'дней'], week:['неделю', 'недели', 'недель'], month: ['месяц', 'месяца', 'месяцев'] };
                return `${match[1]} серия выйдет через ${match[2]} ${getPlural(parseInt(match[2]), units[match[3].toLowerCase()])}`;
            }
            if ((match = cleanText.match(rxAiringOnly))) {
                const units = { second:['секунду', 'секунды', 'секунд'], minute: ['минуту', 'минуты', 'минут'], min: ['минуту', 'минуты', 'минут'], hour:['час', 'часа', 'часов'], day: ['день', 'дня', 'дней'], week:['неделю', 'недели', 'недель'], month: ['месяц', 'месяца', 'месяцев'] };
                return `Выйдет через ${match[1]} ${getPlural(parseInt(match[1]), units[match[2].toLowerCase()])}`;
            }

            if ((match = cleanText.match(rxTimeComplex))) {
                const p1 = translateAdvanced(match[1]); const p2 = translateAdvanced(match[2]);
                if (p1 && p2) return `${p1} ${p2}`;
            }
            if ((match = cleanText.match(rxHeight))) return `${match[1].trim()} см${match[2] ? ` (${match[2]})` : ''}`;
            if ((match = cleanText.match(rxLiked))) return `${match[1]} из ${match[2]} оценили этот отзыв`;
            if ((match = cleanText.match(rxDateFull))) return `${match[2]} ${monthsFull[match[1]]} ${match[3]} г.`;
            if ((match = cleanText.match(rxBday))) return match[2].length > 2 ? `${monthsFull[match[1]]} ${match[2]} г.` : `${match[2]} ${monthsFull[match[1]]}`;
            if ((match = cleanText.match(rxSeason))) return `${seasons[match[1]]} ${match[2]}`;

            if ((match = cleanText.match(rxAct))) {
                const isRange = match[3].includes('-') || match[3].includes('–');
                const actRu = { watched: isRange ? 'Просмотрены' : 'Просмотрена', rewatched: isRange ? 'Пересмотрены' : 'Пересмотрена', read: isRange ? 'Прочитаны' : 'Прочитана', reread: isRange ? 'Перечитаны' : 'Перечитана' };
                const typeRu = { episode: isRange ? 'серии' : 'серия', chapter: isRange ? 'главы' : 'глава' };
                return `${actRu[match[1].toLowerCase()]} ${typeRu[match[2].toLowerCase()]} ${match[3].trim()}`;
            }

            if ((match = cleanText.match(rxLabel))) {
                const labels = { 'Format': 'Формат', 'Status': 'Статус', 'Country': 'Страна', 'Chapters': 'Главы', 'Score': 'Оценка', 'Count': 'Количество', 'Hours Watched': 'Часов просмотрено', 'Mean Score': 'Средний балл', 'Chapters Read': 'Глав прочитано', 'Episodes': 'Серии', 'Released': 'Выпущено', 'Started': 'Начато', 'Amount': 'Всего', 'Progress': 'Прогресс', 'Finish Date': 'Дата завершения', 'Birthday': 'День рождения', 'Height': 'Рост', 'Age': 'Возраст', 'Gender': 'Пол', 'Blood Type': 'Группа крови', 'Blood type': 'Группа крови', 'Occupation': 'Род занятий', 'Affiliation': 'Принадлежность', 'Grade': 'Ранг' };
                const val = match[2].trim();
                return `${labels[match[1]]}: ${(Object.prototype.hasOwnProperty.call(dictionary, val) ? dictionary[val] : null) || translateAdvanced(val) || val}`;
            }

            if ((match = cleanText.match(rxUnit))) {
                const num = parseInt(match[1]);
                const forms = { day: ['день', 'дня', 'дней'], hour:['час', 'часа', 'часов'], hr: ['час', 'часа', 'часов'], minute:['минуту', 'минуты', 'минут'], min: ['минуту', 'минуты', 'минут'], mins: ['минуту', 'минуты', 'минут'], sec:['секунду', 'секунды', 'секунд'], episode: ['серия', 'серии', 'серий'], chapter: ['глава', 'главы', 'глав'], volume:['том', 'тома', 'томов'], reply: ['ответ', 'ответа', 'ответов'], user:['пользователь', 'пользователя', 'пользователей'] };
                return `${num} ${getPlural(num, forms[match[2].toLowerCase()])}`;
            }

            if ((match = cleanText.match(rxRecent))) return `${match[1]} недавно ${match[2].toLowerCase() === 'watched' ? 'смотрели' : 'читали'}`;
            if ((match = cleanText.match(rxReviewBy))) return `отзыв от ${match[1]}`;
            if ((match = cleanText.match(rxDayDate))) return `${days[match[1]]}, ${match[3]} ${monthsFull[match[2]]} ${match[4]} г.`;
            if ((match = cleanText.match(rxAgo))) {
                const units = { second:['секунду', 'секунды', 'секунд'], minute:['минуту', 'минуты', 'минут'], hour: ['час', 'часа', 'часов'], day:['день', 'дня', 'дней'], week: ['неделю', 'недели', 'недель'], month:['месяц', 'месяца', 'месяцев'], year: ['год', 'года', 'лет'] };
                return `${match[1]} ${getPlural(parseInt(match[1]), units[match[2].toLowerCase()])} назад`;
            }

            if ((match = cleanText.match(rxListAdded))) {
                const title = (Object.prototype.hasOwnProperty.call(dictionary, match[1]) ? dictionary[match[1]] : null) || match[1];
                const listsMap = { completed: 'Просмотрено', watching: 'Смотрю', reading: 'Читаю', planning: 'В планах', dropped: 'Брошено', paused: 'Отложено' };
                return `«${title}» добавлено в список «${listsMap[match[2].toLowerCase()] || match[2]}»`;
            }

            if ((match = cleanText.match(rxListUpdated))) {
                const title = (Object.prototype.hasOwnProperty.call(dictionary, match[1]) ? dictionary[match[1]] : null) || match[1];
                return `Запись «${title}» обновлена`;
            }

            return null;
        }

        function translateNode(node) {
            if (!node) return;
            if (node.nodeType === Node.ELEMENT_NODE && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(node.tagName)) {
                ['placeholder', 'title', 'aria-label', 'value', 'label'].forEach(attr => {
                    const val = node.getAttribute(attr);
                    if (val) {
                        const tr = translateAdvanced(val);
                        if (tr && val !== tr) {
                            node.setAttribute(attr, tr);
                            if (attr === 'value' && ('value' in node)) node.value = tr;
                        }
                    }
                });
                if ((node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') && node.value) {
                    const trValue = translateAdvanced(node.value);
                    if (trValue && node.value !== trValue) node.value = trValue;
                }
                node.childNodes.forEach(translateNode);
            } else if (node.nodeType === Node.TEXT_NODE) {
                const clean = node.nodeValue.trim();
                if (clean) {
                    const tr = translateAdvanced(clean);
                    if (tr && node.nodeValue.trim() !== tr) node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), tr);
                }
            }
        }

        // Перехват Vue Inputs
        // Переопределяем нативный сеттер, чтобы текст не сбрасывался реактивностью Vue
        function setupVueInputInterceptor() {
            const inputDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (!inputDescriptor || !inputDescriptor.set) return;

            const originalSet = inputDescriptor.set;
            Object.defineProperty(HTMLInputElement.prototype, 'value', {
                configurable: true, enumerable: true, get: inputDescriptor.get,
                set: function(val) {
                    let finalVal = val;
                    try {
                        if (typeof val === 'string' && val.trim() !== '' && this.classList && this.classList.contains('el-input__inner')) {
                            const trValue = translateAdvanced(val);
                            if (trValue && trValue !== val) finalVal = trValue;
                        }
                    } catch (e) {}
                    return originalSet.call(this, finalVal);
                }
            });
        }

        function processTooltip(tooltipNode) {
            const titleEl = tooltipNode.querySelector('.title');
            if (!titleEl) return;

            const hovers = document.querySelectorAll(':hover');
            if (hovers.length === 0) return;

            const deepest = hovers[hovers.length - 1];
            let targetLink = deepest.closest('a[href^="/anime/"], a[href^="/manga/"], a[href^="/character/"], a[href^="/staff/"]');

            if (!targetLink) {
                const card = deepest.closest('.media-card, .character-card, .staff-card, .relation-card, .studio-anime');
                if (card) {
                    targetLink = card.querySelector('a[href^="/anime/"], a[href^="/manga/"], a[href^="/character/"], a[href^="/staff/"]');
                }
            }

            if (targetLink) {
                const href = targetLink.getAttribute('href');
                let targetId = null;
                let targetType = null;
                let extra = false;

                let matchMed = href.match(/\/(anime|manga)\/(\d+)/);
                let matchChar = href.match(/\/character\/(\d+)\/([^/]+)/);
                let matchStaff = href.match(/\/staff\/(\d+)\/([^/]+)/);

                if (matchMed && settings.translateTitles) { targetId = matchMed[2]; targetType = 'MED2'; }
                else if (matchChar && settings.translateCharacters) { targetId = matchChar[1]; targetType = 'CHR2'; extra = matchChar[2]; }
                else if (matchStaff && settings.translateStaff) { targetId = matchStaff[1]; targetType = 'STF3'; extra = matchStaff[2]; }

                if (targetId) {
                    if (titleEl.dataset.translated === String(targetId)) return;
                    titleEl.dataset.translatingId = String(targetId);
                    return queueContent(targetId, targetType, titleEl, extra);
                }
            }
        }

        function debouncedFindContent() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!settings.translateTitles && !settings.translateCharacters && !settings.translateStaff) return;

                document.querySelectorAll('a[href^="/anime/"], a[href^="/manga/"], a[href^="/character/"], a[href^="/staff/"]').forEach(link => {
                    if (link.querySelector('img') || link.closest('.nav') || link.classList.contains('cover')) return;

                    const href = link.getAttribute('href');
                    const isMedia = href.startsWith('/anime/') || href.startsWith('/manga/');
                    if (isMedia && (link.classList.contains('relation-title') || link.closest('.relations') || link.closest('.role'))) return;

                    let match;
                    if ((match = href.match(/\/(anime|manga)\/(\d+)/)) && settings.translateTitles) {
                        if (link.dataset.translated === match[2]) return;
                        queueContent(match[2], 'MED2', link);
                    } else if ((match = href.match(/\/character\/(\d+)\/([^/]+)/)) && settings.translateCharacters) {
                        if (link.dataset.translated === match[1]) return;
                        queueContent(match[1], 'CHR2', link, match[2]);
                    } else if ((match = href.match(/\/staff\/(\d+)\/([^/]+)/)) && settings.translateStaff) {
                        if (link.dataset.translated === match[1]) return;
                        queueContent(match[1], 'STF3', link, match[2]);
                    }
                });

                const url = location.href;
                if (settings.translateTitles) {
                    const m = url.match(/\/(anime|manga)\/(\d+)/);
                    if (m) {
                        const h1 = document.querySelector('.header .content h1');
                        if (h1 && h1.dataset.translated !== m[2]) queueContent(m[2], 'MED2', h1, true);

                        const desc = document.querySelector('.description');
                        if (desc && (!desc.querySelector('.ru-desc') || desc.dataset.translated !== m[2])) queueContent(m[2], 'MED2', desc);
                    }
                }

                if (settings.translateCharacters) {
                    const m = url.match(/\/character\/(\d+)\/([^/]+)/);
                    if (m) {
                        const h1 = document.querySelector('.header .names h1.name, .header h1.name, .header .content h1');
                        if (h1 && h1.dataset.translated !== m[1]) queueContent(m[1], 'CHR2', h1, true);

                        const desc = document.querySelector('.description');
                        if (desc && (!desc.querySelector('.ru-desc') || desc.dataset.translated !== m[1])) queueContent(m[1], 'CHR2', desc, m[2]);
                    }
                }

                if (settings.translateStaff) {
                    const m = url.match(/\/staff\/(\d+)\/([^/]+)/);
                    if (m) {
                        const h1 = document.querySelector('.header .names h1.name, .header h1.name, .header .content h1');
                        if (h1 && h1.dataset.translated !== m[1]) queueContent(m[1], 'STF3', h1, true);

                        const desc = document.querySelector('.description');
                        if (desc && (!desc.querySelector('.ru-desc') || desc.dataset.translated !== m[1])) queueContent(m[1], 'STF3', desc, m[2]);
                    }
                }
            }, 300);
        }

        async function queueContent(id, type, el, extra = false) {
            if (el.dataset.queued === String(id)) return;
            el.dataset.queued = String(id);

            const key = `${type}_${id}`;
            if (!queue.has(key)) {
                queue.set(key,[]);
            }

            const isAlreadyInQueue = queue.get(key).some(item => item.el === el);
            if (!isAlreadyInQueue) {
                queue.get(key).push({ el, extra });
            }

            const cached = await dbGet('shikiCache', key);
            if (cached && (Date.now() - cached.ts < CACHE_TIME)) {
                const ageMins = Math.round((Date.now() - cached.ts) / 60000);
                Logger('DB', `[Cache HIT] ${key} (возраст ${ageMins} мин)`);
                applyTranslation(type, id, cached.data);
                return;
            }

            Logger('QUEUE', `[Cache MISS] ${key} ➜ Помещено в очередь перевода`);

            if (type === 'MED2') pending.MED2.add(id);
            else if (type === 'CHR2') pending.CHR2.set(id, extra);
            else if (type === 'STF3') pending.STF3.set(id, extra);

            if (!isProcessing) {
                isProcessing = true;
                setTimeout(processTransQueue, 500);
            }
        }

        async function processTransQueue() {
            if (!processTransQueue.activeRound) {
                const total = pending.MED2.size + pending.CHR2.size + pending.STF3.size;
                Logger('QUEUE', `[Process] Запуск обработки. В ожидании: ${total} элементов.`);
                processTransQueue.activeRound = true;
            }

            if (Date.now() < alRateLimitPause || Date.now() < shikiRateLimitPause) {
                return setTimeout(processTransQueue, 1000 + Math.floor(Math.random() * 500));
            }

            if (pending.MED2.size > 0) {
                const ids = Array.from(pending.MED2).slice(0, 40);
                const query = `query ($ids:[Int]) { Page { media(id_in: $ids) { id type idMal seasonYear title { romaji } } } }`;
                const res = await anilistQuery(query, { ids: ids.map(i => parseInt(i)) });

                for (const m of (res?.data?.Page?.media ||[])) {
                    pending.MED2.delete(m.id.toString());
                    if (m.idMal) {
                        dbSet('malCache', { id: m.id, data: m });
                        const shiki = await fetchShiki(`/api/${m.type === 'MANGA' ? 'mangas' : 'animes'}/${m.idMal}`);
                        if (shiki.data) {
                            const data = { ru: shiki.data.russian, desc: cleanShikiBB(shiki.data.description, `https://${shiki.domain}${shiki.data.url}`) };
                            dbSet('shikiCache', { key: `MED2_${m.id}`, data, ts: Date.now() });
                            applyTranslation('MED2', m.id, data);
                        } else {
                            dbSet('shikiCache', { key: `MED2_${m.id}`, data: { ru: 'NOT_FOUND' }, ts: Date.now() });
                            applyTranslation('MED2', m.id, { ru: 'NOT_FOUND' });
                        }
                    } else {
                        applyTranslation('MED2', m.id, { ru: 'NOT_FOUND' });
                    }
                }
                await new Promise(r => setTimeout(r, 250));
            }
            else if (pending.CHR2.size > 0) {
                const ids = Array.from(pending.CHR2.keys()).slice(0, 10);
                const query = `query ($ids:[Int]) { Page(page:1, perPage:10) { characters(id_in: $ids) { id name { full native } media(sort: POPULARITY_DESC, page: 1, perPage: 2) { nodes { idMal } } } } }`;
                const res = await anilistQuery(query, { ids: ids.map(i => parseInt(i)) });

                const charMap = {};
                if (res?.data?.Page?.characters) res.data.Page.characters.forEach(c => charMap[c.id] = c);

                for (const id of ids) {
                    if (Date.now() < shikiRateLimitPause || Date.now() < alRateLimitPause) break;
                    const fallbackName = pending.CHR2.get(id);
                    pending.CHR2.delete(id);

                    const charData = charMap[id];
                    let searchName = charData ? charData.name.full : (typeof fallbackName === 'string' ? fallbackName : "");
                    let nativeName = charData ? charData.name.native : "";

                    let shikiItem = null;
                    if (charData) shikiItem = await resolveShikiPersonByMedia(charData, 'characters');

                    if (!shikiItem) {
                        const sRes = await fetchShikiPersonREST('characters', searchName, nativeName);
                        if (sRes.status === 200 && sRes.data) shikiItem = sRes.data;
                        else if (sRes.status === 429) { shikiRateLimitPause = Date.now() + 6000; pending.CHR2.set(id, fallbackName); break; }
                    } else {
                        let det = await fetchShiki(`/api/characters/${shikiItem.id}`);
                        if (det.data) shikiItem = { ...shikiItem, description: det.data.description, url: det.data.url, domain: det.domain };
                    }

                    if (shikiItem && shikiItem.russian) {
                        const data = { ru: shikiItem.russian, desc: cleanShikiBB(shikiItem.description, `https://${shikiItem.domain || SHIKI_DOMAINS[0]}${shikiItem.url}`) };
                        dbSet('shikiCache', { key: `CHR2_${id}`, data, ts: Date.now() });
                        applyTranslation('CHR2', id, data);
                    } else {
                        dbSet('shikiCache', { key: `CHR2_${id}`, data: { ru: 'NOT_FOUND' }, ts: Date.now() });
                        applyTranslation('CHR2', id, { ru: 'NOT_FOUND' });
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
            }
            else if (pending.STF3.size > 0) {
                const ids = Array.from(pending.STF3.keys()).slice(0, 10);
                const query = `query ($ids:[Int]) { Page(page:1, perPage:10) { staff(id_in: $ids) { id name { full native } staffMedia(sort: POPULARITY_DESC, page: 1, perPage: 2) { nodes { idMal } } } } }`;
                const res = await anilistQuery(query, { ids: ids.map(i => parseInt(i)) });

                const staffMap = {};
                if (res?.data?.Page?.staff) res.data.Page.staff.forEach(s => staffMap[s.id] = s);

                for (const id of ids) {
                    if (Date.now() < shikiRateLimitPause || Date.now() < alRateLimitPause) break;
                    const fallbackName = pending.STF3.get(id);
                    pending.STF3.delete(id);

                    const staffData = staffMap[id];
                    let searchName = staffData ? staffData.name.full : (typeof fallbackName === 'string' ? fallbackName : "");
                    let nativeName = staffData ? staffData.name.native : "";

                    let shikiItem = null;
                    if (staffData) shikiItem = await resolveShikiPersonByMedia(staffData, 'people');

                    if (!shikiItem) {
                        const sRes = await fetchShikiPersonREST('people', searchName, nativeName);
                        if (sRes.status === 200 && sRes.data) shikiItem = sRes.data;
                        else if (sRes.status === 429) { shikiRateLimitPause = Date.now() + 6000; pending.STF3.set(id, fallbackName); break; }
                    } else {
                        let det = await fetchShiki(`/api/people/${shikiItem.id}`);
                        if (det.data) shikiItem = { ...shikiItem, description: det.data.description, url: det.data.url, domain: det.domain };
                    }

                    if (shikiItem && shikiItem.russian) {
                        const data = { ru: shikiItem.russian, desc: cleanShikiBB(shikiItem.description, `https://${shikiItem.domain || SHIKI_DOMAINS[0]}${shikiItem.url}`) };
                        dbSet('shikiCache', { key: `STF3_${id}`, data, ts: Date.now() });
                        applyTranslation('STF3', id, data);
                    } else {
                        dbSet('shikiCache', { key: `STF3_${id}`, data: { ru: 'NOT_FOUND' }, ts: Date.now() });
                        applyTranslation('STF3', id, { ru: 'NOT_FOUND' });
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            if (pending.MED2.size > 0 || pending.CHR2.size > 0 || pending.STF3.size > 0) {
                setTimeout(processTransQueue, 1000 + Math.floor(Math.random() * 500));
            } else {
                Logger('QUEUE', '[Process] Очередь пуста. Ожидание новых элементов.');
                processTransQueue.activeRound = false;
                isProcessing = false;
            }
        }

        function safelySetText(el, text) {
            for (let n of el.childNodes) {
                if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim().length > 0) {
                    n.nodeValue = text;
                    return true;
                }
            }
            return false;
        }

        function applyTranslation(type, id, data) {
            const key = `${type}_${id}`;
            const items = queue.get(key) ||[];

            if (data && data.ru && data.ru !== 'NOT_FOUND') {
                items.forEach(item => {
                    if (!document.body.contains(item.el)) return;

                    if (item.el.classList && item.el.classList.contains('title') && item.el.closest('.tooltip')) {
                        if (item.el.dataset.translatingId === String(id)) {
                            item.el.dataset.ru = data.ru;
                            if (!safelySetText(item.el, data.ru)) item.el.innerText = data.ru;
                        }
                    }
                    else if (item.extra === true) {
                        if (!safelySetText(item.el, data.ru)) item.el.innerText = data.ru;
                        document.title = `${data.ru} · AniList`;
                    }
                    else if (item.el.classList && item.el.classList.contains('description') && data.desc) {
                        if (!item.el.querySelector('.ru-desc')) {
                            const origHTML = item.el.innerHTML;
                            item.el.innerHTML = `<div class="ru-desc" style="margin-bottom:20px;">${data.desc}</div><details style="opacity:0.85;font-size:0.9em;background:rgba(128,128,128,0.15);padding:10px;border-radius:5px;"><summary style="cursor:pointer;color:#3dbbee;font-weight:bold;outline:none;">Оригинальное описание (AniList)</summary><div style="margin-top:10px;">${origHTML}</div></details>`;
                        }
                    }
                    else {
                        let targetEl = item.el.querySelector('.name') || item.el;
                        safelySetText(targetEl, data.ru);
                        if (item.el.hasAttribute('title')) item.el.setAttribute('title', data.ru);
                        if (item.el.hasAttribute('aria-label')) item.el.setAttribute('aria-label', data.ru);
                    }

                    item.el.dataset.translated = String(id);
                });
            } else {
                items.forEach(item => {
                    if (item.el) item.el.dataset.translated = String(id);
                });
            }
            queue.delete(key);
        }

        // MutationObserver для динамического отлова новых элементов на странице
        let mutationQueue =[];
        let rAF_ID = null;

        const processMutations = () => {
            let changed = false;

            mutationQueue.forEach((m) => {
               if (m.addedNodes.length) {
                    m.addedNodes.forEach(node => {
                        translateNode(node);
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.classList && node.classList.contains('description-length-toggle')) node.click();
                            else node.querySelectorAll('.description-length-toggle').forEach(btn => btn.click());

                            if (node.classList && node.classList.contains('tooltip')) {
                                processTooltip(node);
                            } else {
                                node.querySelectorAll('.tooltip').forEach(processTooltip);
                            }
                        }
                    });
                    changed = true;
                }
                if (m.type === 'characterData') {
                    translateNode(m.target);
                    const parent = m.target.parentNode;
                    if (parent && parent.closest && parent.closest('.tooltip')) processTooltip(parent.closest('.tooltip'));
                    changed = true;
                }
                if (m.type === 'childList' && m.target.nodeType === Node.ELEMENT_NODE) {
                    if (m.target.classList && m.target.classList.contains('tooltip')) processTooltip(m.target);
                    else if (m.target.closest && m.target.closest('.tooltip')) processTooltip(m.target.closest('.tooltip'));
                }
                if (m.type === 'attributes' && ['title', 'aria-label', 'placeholder', 'value', 'label'].includes(m.attributeName)) {
                    translateNode(m.target);
                    changed = true;
                }
            });

            mutationQueue =[];
            rAF_ID = null;

            if (changed) {
                debouncedFindContent();
                if (typeof ensureWidgets === 'function') {
                    clearTimeout(ensureWidgetsTimer);
                    ensureWidgetsTimer = setTimeout(ensureWidgets, 200);
                }
            }
        };

        const obs = new MutationObserver((mutations) => {
            mutationQueue.push(...mutations);
            // Обрабатываем мутации порциями (batching) чтобы не вешать UI браузера
            if (!rAF_ID) rAF_ID = requestAnimationFrame(() => {
                const startTimer = performance.now();
                processMutations();
                const diff = performance.now() - startTimer;
                // Метрика производительности
                if (diff > 50) Logger('INFO', `[Performance] Обновление интерфейса заняло ${diff.toFixed(2)}ms`, { totalMutations: mutations.length });
            });
        });

        obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter:['title', 'aria-label', 'placeholder', 'value', 'label'] });
        setupVueInputInterceptor();
        translateNode(document.body);
        debouncedFindContent();
    }

    // ==========================================
    // 6. МОДУЛЬ МЕДИА (ПЛЕЕР, РЕЙТИНГИ, ФРАНШИЗА)
    // ==========================================
    let currentMediaId = null;
    let currentMediaData = null;

    async function injectMediaExtensions() {
        const path = window.location.pathname.split('/');
        if (!(path[1] === 'anime' || path[1] === 'manga') || !path[2]) return;

        const aniId = parseInt(path[2]);

        if (currentMediaId === aniId && currentMediaData) {
            ensureWidgets();
            return;
        }

        // Очищаем старые виджеты при смене роута
        if (currentMediaId !== aniId) {
            document.querySelectorAll('.animori-ratings, .animori-franchise, .animori-themes, .animori-extlinks').forEach(el => el.remove());
            const playBtn = document.getElementById('ru-player-btn');
            if (playBtn) playBtn.style.display = 'none';
        }

        currentMediaId = aniId;
        currentMediaData = null;

        Logger('INFO', `[Widget] Открыта страница медиа ID: ${aniId}`);

        let malData = (await dbGet('malCache', aniId))?.data;
        if (currentMediaId !== aniId) return;

        // Если в кэше нет MAL ID или averageScore, тянем из GraphQL
        if (!malData || !malData.averageScore) {
            const q = `query($id:Int){Media(id:$id){id type idMal seasonYear averageScore title{romaji english}}}`;
            malData = (await anilistQuery(q, { id: aniId }))?.data?.Media;

            if (currentMediaId !== aniId) return;
            if (malData) dbSet('malCache', { id: aniId, data: malData });
        }

        if (!malData || !malData.idMal) {
            Logger('INFO', 'MAL ID отсутствует, виджеты отключены.');
            return;
        }

        const endpoint = malData.type === 'MANGA' ? 'mangas' : 'animes';
        let shikiData = (await dbGet('shikiCache', `FULL_${aniId}`))?.data;
        if (currentMediaId !== aniId) return;

        let usedDomain = SHIKI_DOMAINS[0];

        if (!shikiData) {
            const res = await fetchShiki(`/api/${endpoint}/${malData.idMal}`);
            if (currentMediaId !== aniId) return;

            shikiData = res.data;
            usedDomain = res.domain || usedDomain;
            if (shikiData) dbSet('shikiCache', { key: `FULL_${aniId}`, data: shikiData, ts: Date.now() });
        }

        currentMediaData = { malData, shikiData, franchiseBox: null };
        ensureWidgets();

        // Загрузка дерева Франшизы
        if (settings.enableFranchise && shikiData) {
            const fRes = await fetchShiki(`/api/${endpoint}/${malData.idMal}/franchise`);
            if (currentMediaId !== aniId) return;

            if (fRes.data && fRes.data.nodes && fRes.data.nodes.length > 1) {
                const sorted = fRes.data.nodes.sort((a, b) => {
                    const yA = a.year || Infinity;
                    const yB = b.year || Infinity;
                    if (yA !== yB) return yA - yB;
                    return (a.id || 0) - (b.id || 0);
                });

                const malIds = sorted.map(n => n.id);
                const qMap = `query($m:[Int],$t:MediaType){Page{media(idMal_in:$m,type:$t){id idMal type mediaListEntry{status}}}}`;
                const mapRes = await anilistQuery(qMap, { m: malIds, t: malData.type }, true);
                if (currentMediaId !== aniId) return;

                let alMap = {};
                mapRes?.data?.Page?.media.forEach(m => alMap[m.idMal] = m);

                let franchiseBox = document.createElement('div');
                franchiseBox.className = 'animori-franchise';
                const fTitle = document.createElement('h2');
                fTitle.textContent = 'Хронология Франшизы';
                franchiseBox.appendChild(fTitle);

                const list = document.createElement('div');
                list.className = 'franchise-list';
                franchiseBox.appendChild(list);

                sorted.forEach(node => {
                    const alItem = alMap[node.id];
                    const alId = alItem ? alItem.id : null;
                    const listStatus = alItem && alItem.mediaListEntry ? alItem.mediaListEntry.status : null;

                    const link = document.createElement('a');
                    link.href = alId ? `/${malData.type.toLowerCase()}/${alId}` : `https://${usedDomain}${node.url}`;
                    link.className = `franchise-node ${node.id === malData.idMal ? 'active' : ''}`;

                    let statusText = ''; let statusColor = '';
                    let isShikiOnly = !alId; let isCurrentPage = node.id === malData.idMal;

                    if (isShikiOnly) {
                        statusText = ' (Только на Shiki)'; statusColor = '#a0aec0';
                        link.classList.add('shiki-only'); link.target = "_blank";
                    } else if (listStatus) {
                        const isManga = alItem.type === 'MANGA';
                        switch (listStatus) {
                            case 'COMPLETED': statusText = isManga ? ' (Прочитано)' : ' (Просмотрено)'; statusColor = '#a6e3a1'; break;
                            case 'CURRENT':   statusText = isManga ? ' (Читаю)' : ' (Смотрю)'; statusColor = '#89b4fa'; break;
                            case 'PLANNING':  statusText = ' (В планах)'; statusColor = '#cba6f7'; break;
                            case 'REPEATING': statusText = isManga ? ' (Перечитываю)' : ' (Пересматриваю)'; statusColor = '#f5c2e7'; break;
                            case 'PAUSED':    statusText = ' (Отложено)'; statusColor = '#f9e2af'; break;
                            case 'DROPPED':   statusText = ' (Брошено)'; statusColor = '#f38ba8'; break;
                        }
                        if (!isCurrentPage) {
                            link.style.borderLeftColor = statusColor; link.style.background = `${statusColor}15`;
                        }
                    }

                    const divYear = document.createElement('div'); divYear.className = 'node-year'; divYear.textContent = node.year || '???';
                    const divTitle = document.createElement('div'); divTitle.className = 'node-title';
                    const spanTitle = document.createElement('span'); spanTitle.textContent = node.name; divTitle.appendChild(spanTitle);

                    if (statusText) {
                        const spanStatus = document.createElement('span');
                        spanStatus.textContent = statusText; spanStatus.style.color = statusColor;
                        spanStatus.style.fontSize = '0.85em'; spanStatus.style.fontWeight = 'bold'; spanStatus.style.marginLeft = '8px';
                        divTitle.appendChild(spanStatus);
                    }

                    if (isCurrentPage) {
                        const spanHere = document.createElement('span');
                        spanHere.textContent = ' ⬅ Сейчас здесь'; spanHere.style.color = 'rgb(var(--color-blue))';
                        spanHere.style.fontSize = '0.85em'; spanHere.style.fontWeight = 'bold'; spanHere.style.marginLeft = statusText ? '4px' : '8px';
                        divTitle.appendChild(spanHere);
                    }

                    const divKind = document.createElement('div'); divKind.className = 'node-kind'; divKind.textContent = node.kind;
                    link.append(divYear, divTitle, divKind);
                    list.appendChild(link);
                });

                if (sorted.length > 5) {
                    // Верхняя кнопка «Свернуть» (sticky, видна только в развёрнутом виде): при
                    // 50–100 тайтлах нижняя кнопка улетает вниз, поэтому дублируем сверху.
                    const topToggle = document.createElement('button');
                    topToggle.className = 'franchise-toggle franchise-toggle-top';
                    topToggle.innerText = 'Свернуть ▲';
                    topToggle.style.display = 'none';
                    fTitle.after(topToggle);

                    const bottomToggle = document.createElement('button');
                    bottomToggle.className = 'franchise-toggle';
                    bottomToggle.innerText = `Развернуть (${sorted.length}) ▼`;

                    let expanded = false;
                    const setExpanded = (state) => {
                        expanded = state;
                        list.classList.toggle('expanded', expanded);
                        topToggle.style.display = expanded ? 'block' : 'none';
                        bottomToggle.innerText = expanded ? 'Свернуть ▲' : `Развернуть (${sorted.length}) ▼`;
                        if (!expanded) {
                            setTimeout(() => {
                                const activeNode = list.querySelector('.active');
                                if (activeNode) list.scrollTop = activeNode.offsetTop - (list.clientHeight / 2) + (activeNode.clientHeight / 2);
                                franchiseBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            }, 50);
                        }
                    };
                    topToggle.onclick = () => setExpanded(false);
                    bottomToggle.onclick = () => setExpanded(!expanded);
                    franchiseBox.appendChild(bottomToggle);
                }

                currentMediaData.franchiseBox = franchiseBox;
                ensureWidgets();
            }
        }
    }

    // Размещение виджетов (Рейтинги, Темы, Франшиза, Кнопка Плеера)
    window.ensureWidgets = function() {
        if (!currentMediaData) return;
        const path = window.location.pathname.split('/');
        if (!(path[1] === 'anime' || path[1] === 'manga') || parseInt(path[2]) !== currentMediaId) return;

        const { malData, shikiData, franchiseBox } = currentMediaData;
        const sidebar = document.querySelector('.sidebar');

        // Виджет Рейтингов (Shiki, MAL, AniList)
        if (sidebar && settings.enableRatings && shikiData && !document.querySelector('.animori-ratings')) {
            const ratesBox = document.createElement('div');
            ratesBox.className = 'animori-ratings';
            let pureScore = "N/A", votes = 0;
            if (shikiData.rates_scores_stats) {
                let sum = 0;
                shikiData.rates_scores_stats.forEach(s => { sum += parseInt(s.name) * s.value; votes += s.value; });
                if (votes > 0) pureScore = (sum / votes).toFixed(2);
            }

            const shikiLink = `https://${shikiData.domain || 'shikimori.io'}${shikiData.url}`;
            const malLink = `https://myanimelist.net/${malData.type === 'MANGA' ? 'manga' : 'anime'}/${malData.idMal}`;

            // Форматируем среднюю оценку AniList в 10-балльную систему
            let alScoreText = "N/A";
            if (malData.averageScore) {
                alScoreText = (malData.averageScore / 10).toFixed(2);
            }

            ratesBox.innerHTML = `
                <div class="rating-item"><a href="${shikiLink}" target="_blank" class="rating-badge shiki-badge" style="text-decoration:none;">SHIKIMORI</a><div class="rating-value">${pureScore}</div></div>
                <div class="rating-item"><a href="${malLink}" target="_blank" class="rating-badge mal-badge" style="text-decoration:none;">MYANIMELIST</a><div class="rating-value">${shikiData.score || 'N/A'}</div></div>
                <div class="rating-item"><span class="rating-badge al-badge" style="text-decoration:none; cursor:default;" title="Официальная средняя оценка AniList">ANILIST</span><div class="rating-value al-score-val" style="font-size: 1.4rem;">${alScoreText}</div></div>
            `;
            sidebar.prepend(ratesBox);
        }

        // Блок Франшизы
        if (franchiseBox) {
            const existing = document.querySelector('.animori-franchise:not(.animori-themes):not(.animori-extlinks)');
            const relations = document.querySelector('.relations');
            let justAdded = false;
            if (!existing) {
                if (relations) relations.before(franchiseBox);
                else if (sidebar) sidebar.append(franchiseBox);
                justAdded = true;
            } else if (relations && existing.parentNode === sidebar) {
                relations.before(existing);
                justAdded = true;
            }
            if (justAdded) {
                setTimeout(() => {
                    const list = franchiseBox.querySelector('.franchise-list');
                    if (list && !list.classList.contains('expanded')) {
                        const active = list.querySelector('.active');
                        if (active) list.scrollTop = active.offsetTop - (list.clientHeight / 2) + (active.clientHeight / 2);
                    }
                }, 100);
            }
        }

        // Музыкальные темы (VK / YouTube Music)
        if (settings.enableThemes && malData.type === 'ANIME' && sidebar && !document.querySelector('.animori-themes')) {
            const themesBox = document.createElement('div');
            themesBox.className = 'animori-themes animori-franchise';
            themesBox.style.display = 'none';

            const ratingsBlock = sidebar.querySelector('.animori-ratings');
            if (ratingsBlock) ratingsBlock.after(themesBox);
            else sidebar.prepend(themesBox);

            fetchMalThemes(malData.idMal).then(themes => {
                if (!themes || (!themes.openings.length && !themes.endings.length)) {
        // Больше не удаляем themesBox. Он останется скрытым (display: none),
        // тем самым блокируя повторные запуски ensureWidgets.
        return;
                }

                let activeMusicService = GM_getValue('am_music_service', 'vk');
                const headerFlex = document.createElement('div');
                headerFlex.style.cssText = 'display: flex; flex-direction: column; align-items: center; margin-bottom: 15px; gap: 10px;';

                const titleEl = document.createElement('h2');
                titleEl.textContent = 'Музыкальные темы'; titleEl.style.margin = '0'; titleEl.style.width = '100%'; titleEl.style.textAlign = 'center';

                // Формирование поисковой ссылки под выбранный сервис
                const musicUrl = (svc, q) => {
                    const eq = encodeURIComponent(q);
                    if (svc === 'vk') return `https://vk.com/audio?q=${eq}`;
                    if (svc === 'spotify') return `https://open.spotify.com/search/${eq}`;
                    if (svc === 'sc') return `https://soundcloud.com/search?q=${eq}`;
                    return `https://music.youtube.com/search?q=${eq}`;
                };
                // Брендовые иконки (монохром, fill наследуется от цвета кнопки)
                const svcIcons = {
                    vk: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M13.16 18.06c-6.27 0-9.85-4.3-10-11.45h3.14c.1 5.25 2.42 7.47 4.25 7.93V6.61h2.96v4.53c1.81-.19 3.71-2.26 4.35-4.53h2.96c-.49 2.8-2.56 4.87-4.03 5.72 1.47.69 3.83 2.49 4.73 5.73h-3.26c-.7-2.18-2.44-3.87-4.75-4.09v4.09h-.36z"/></svg>',
                    yt: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm-1.75 14.5v-9l6 4.5-6 4.5z"/></svg>',
                    spotify: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.59 14.42a.62.62 0 0 1-.86.21c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.22c3.81-.87 7.08-.5 9.72 1.11.29.18.39.57.21.86zm1.23-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.98-1.17a.78.78 0 1 1-.45-1.49c3.64-1.1 8.16-.57 11.24 1.33.37.22.49.71.26 1.07zm.11-2.85C14.72 8.95 9.5 8.76 6.53 9.66a.94.94 0 1 1-.54-1.8c3.41-1.03 9.17-.83 12.79 1.31a.94.94 0 0 1-.96 1.62z"/></svg>',
                    sc: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M1.4 13.2c-.08 0-.14.06-.15.15l-.18 1.85.18 1.82c.01.08.07.14.15.14.08 0 .14-.06.15-.15l.21-1.81-.21-1.85c-.01-.08-.07-.15-.15-.15zm1.02-.95c-.09 0-.16.07-.17.16l-.24 2.79.24 2.7c.01.09.08.16.17.16.09 0 .16-.07.17-.16l.27-2.7-.27-2.79c-.01-.09-.08-.16-.17-.16zm7.72-3.13c-.14 0-.25.11-.26.25l-.3 6.63.3 3.6c.01.14.12.25.26.25.14 0 .25-.11.26-.25l.34-3.6-.34-6.63c-.01-.14-.12-.25-.26-.25zm-2.5.9c-.13 0-.23.1-.24.23l-.27 5.98.27 3.63c.01.13.11.23.24.23s.23-.1.24-.24l.31-3.62-.31-5.98c-.01-.13-.11-.23-.24-.23zm-2.48.62c-.11 0-.2.09-.21.21l-.28 5.38.28 3.65c.01.12.1.21.21.21.11 0 .2-.09.21-.21l.31-3.65-.31-5.38c-.01-.12-.1-.21-.21-.21zm-1.24-.12c-.11 0-.19.08-.2.2l-.26 5.31.26 3.64c.01.11.09.2.2.2.1 0 .19-.09.2-.2l.29-3.64-.29-5.31c-.01-.12-.1-.2-.2-.2zm8.75-1.03c-.15 0-.27.12-.28.28l-.27 6.28.27 3.58c.01.16.13.28.28.28.15 0 .27-.12.28-.28l.3-3.58-.3-6.28c-.01-.16-.13-.28-.28-.28zm2.71 10.7c1.86 0 3.37-1.5 3.37-3.35 0-1.86-1.51-3.36-3.37-3.36-.46 0-.9.09-1.3.26-.27-3.04-2.83-5.43-5.95-5.43-.76 0-1.5.15-2.16.4-.26.1-.33.2-.33.4v11.09c0 .21.16.38.36.4h9.38z"/></svg>'
                };
                const svcTitles = { vk: 'VK Музыка', yt: 'YouTube Music', spotify: 'Spotify', sc: 'SoundCloud' };

                const serviceToggle = document.createElement('div');
                serviceToggle.className = 'am-service-toggle';
                serviceToggle.innerHTML = ['vk', 'yt', 'spotify', 'sc'].map(v =>
                    `<div class="am-service-btn ${activeMusicService === v ? 'active' : ''}" data-val="${v}" title="${svcTitles[v]}" aria-label="${svcTitles[v]}">${svcIcons[v]}</div>`
                ).join('');

                headerFlex.appendChild(titleEl); headerFlex.appendChild(serviceToggle);

                const listEl = document.createElement('div');
                listEl.className = 'themes-list'; listEl.style.cssText = 'max-height: 300px; overflow-y: auto; padding-right: 5px;';

                const renderTrack = (track, type) => {
                    const cleanName = track.replace(/^\d+:\s*/, '');
                    const searchQ = cleanName.replace(/\s*\(eps.*?\)/i, '').replace(/"/g, '').trim();

                    const wrap = document.createElement('a');
                    wrap.className = 'franchise-node am-theme-track'; wrap.dataset.query = searchQ;
                    wrap.href = musicUrl(activeMusicService, searchQ);
                    wrap.target = '_blank'; wrap.style.cssText = 'flex-direction: column; align-items: flex-start; gap: 4px; margin-bottom: 8px; cursor: pointer; text-decoration: none;';

                    const typeBadge = document.createElement('span'); typeBadge.className = 'node-kind';
                    typeBadge.style.cssText = `font-size:0.8rem; padding:2px 9px; border-radius:6px; font-weight:800; background:${type === 'OP' ? 'rgba(var(--color-blue),0.2)' : 'rgba(var(--color-red),0.22)'}; color:${type === 'OP' ? 'rgb(var(--color-blue))' : 'rgb(var(--color-red))'}; border:1px solid ${type === 'OP' ? 'rgba(var(--color-blue),0.55)' : 'rgba(var(--color-red),0.65)'};`;
                    typeBadge.textContent = type;

                    const titleSpan = document.createElement('span'); titleSpan.className = 'node-title';
                    titleSpan.style.cssText = 'white-space: normal; font-size: 1.1rem; line-height: 1.3; width: 100%;';
                    titleSpan.textContent = cleanName;

                    wrap.append(typeBadge, titleSpan);
                    return wrap;
                };

                if (themes.openings.length > 0) themes.openings.forEach(op => listEl.appendChild(renderTrack(op, 'OP')));
                if (themes.endings.length > 0) themes.endings.forEach(ed => listEl.appendChild(renderTrack(ed, 'ED')));

                themesBox.appendChild(headerFlex); themesBox.appendChild(listEl); themesBox.style.display = 'block';

                serviceToggle.querySelectorAll('.am-service-btn').forEach(btn => {
                    btn.onclick = () => {
                        serviceToggle.querySelectorAll('.am-service-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        activeMusicService = btn.dataset.val; GM_setValue('am_music_service', activeMusicService);

                        listEl.querySelectorAll('.am-theme-track').forEach(tr => {
                            tr.href = musicUrl(activeMusicService, tr.dataset.query);
                        });
                    };
                });
            });
        }

        // Внешние ссылки
        if (settings.enableExtLinks && (malData.type === 'ANIME' || malData.type === 'MANGA') && sidebar && !document.querySelector('.animori-extlinks')) {
            const extBox = document.createElement('div'); extBox.className = 'animori-extlinks animori-franchise';
            const pTitle = document.createElement('h2'); pTitle.textContent = malData.type === 'ANIME' ? 'Где посмотреть' : 'Где почитать';
            pTitle.style.textAlign = 'center'; pTitle.style.marginBottom = '15px'; extBox.appendChild(pTitle);

            const pList = document.createElement('div'); pList.style.cssText = 'display:flex; flex-wrap:wrap; gap:12px; justify-content:center;';

            const romaji = malData.title.romaji; const ruTitle = shikiData?.russian || romaji;
            const yummyDomain = settings.yummyDomain || 'yummyanime.tv'; const animegoDomain = settings.animegoDomain || 'animego.org'; const mangalibDomain = settings.mangalibDomain || 'mangalib.me';

            // token — имя тема-токена AniList (blue/red/green/orange/pink/purple/...),
            // цвет чипа адаптируется под тему сайта. Стили — в классе .am-extlink.
            // Фолбэк-триплы на случай, если тема AniList не определяет часть --color-* токенов
            const tokenFallback = { blue: '61, 187, 238', red: '252, 129, 129', green: '166, 227, 161', orange: '246, 193, 119', pink: '243, 139, 168', purple: '183, 148, 244' };
            const createExtLink = (name, token, action) => {
                const a = document.createElement('a');
                if (typeof action === 'string') { a.href = action; a.target = '_blank'; a.rel = 'noopener noreferrer'; } else { a.href = '#'; a.onclick = action; }
                a.textContent = name;
                a.className = 'am-extlink';
                a.style.setProperty('--c', `var(--color-${token}, ${tokenFallback[token] || '120, 130, 150'})`);
                return a;
            };

            let linksAdded = 0;
            if (settings.enableLinkRutracker) { pList.appendChild(createExtLink('RuTracker', 'orange', `https://rutracker.org/forum/tracker.php?nm=${encodeURIComponent(romaji)}`)); linksAdded++; }
            if (malData.type === 'ANIME') {
                if (settings.enableLinkYummy) { pList.appendChild(createExtLink('YummyAnime', 'pink', `https://${yummyDomain}/index.php?do=search&subaction=search&story=${encodeURIComponent(ruTitle)}`)); linksAdded++; }
                if (settings.enableLinkAnimego) { pList.appendChild(createExtLink('AnimeGO', 'purple', `https://${animegoDomain}/search/anime?q=${encodeURIComponent(ruTitle)}`)); linksAdded++; }
            } else if (malData.type === 'MANGA') {
                if (settings.enableLinkMangalib) { pList.appendChild(createExtLink('MangaLib', 'blue', `https://${mangalibDomain}/ru/catalog?q=${encodeURIComponent(ruTitle)}`)); linksAdded++; }
            }

            if (linksAdded > 0) {
                extBox.appendChild(pList);
                const themesBlock = sidebar.querySelector('.animori-themes'); const ratingsBlock = sidebar.querySelector('.animori-ratings');
                if (themesBlock) themesBlock.after(extBox); else if (ratingsBlock) ratingsBlock.after(extBox); else sidebar.prepend(extBox);
            }
        }

        // Плеер (Kodik)
        if (settings.enablePlayer && malData.type === 'ANIME') {
            let btn = document.getElementById('ru-player-btn');
            if (!btn) {
                const actionsContainer = document.getElementById('animori-actions');
                if (actionsContainer) {
                    btn = document.createElement('button'); btn.id = 'ru-player-btn'; btn.className = 'am-premium-btn'; btn.innerHTML = '▶ Плеер'; btn.title = 'Смотреть онлайн'; actionsContainer.prepend(btn);
                }
            }

            if (btn) {
                btn.style.display = 'flex';
                if (!document.getElementById('ru-player-overlay')) {
                    const overlay = document.createElement('div'); overlay.id = 'ru-player-overlay';
                    overlay.innerHTML = `<div id="ru-player-close">&times;</div><div id="ru-info-panel"><div style="color:rgb(var(--color-blue));font-weight:bold;font-size:16px;text-transform:uppercase;letter-spacing:1px;text-align:center;" id="info-anime-title">Загрузка...</div></div><div id="ru-translations-panel" style="display:none;"></div><div id="ru-player-container"><iframe id="ru-p-iframe" allowfullscreen allow="autoplay; fullscreen"></iframe></div><div id="ru-episodes-panel" style="display:none;"></div>`;
                    document.body.appendChild(overlay);
                    const closeOverlay = () => { overlay.style.display = 'none'; document.getElementById('ru-p-iframe').src = ''; };
                    document.getElementById('ru-player-close').onclick = closeOverlay;
                    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
                }

                btn.onclick = async () => {
                    Logger('INFO', 'Запуск плеера Kodik');
                    const overlay = document.getElementById('ru-player-overlay'); overlay.style.display = 'flex';

                    const rusTitle = shikiData?.russian; const romTitle = malData.title.romaji; const defaultTitle = rusTitle || romTitle;
                    const titleEl = document.getElementById('info-anime-title'); const iframe = document.getElementById('ru-p-iframe');
                    const tPanel = document.getElementById('ru-translations-panel'); const ePanel = document.getElementById('ru-episodes-panel');

                    iframe.src = ''; tPanel.style.display = 'none'; ePanel.style.display = 'none'; titleEl.innerText = "Подключение к базе...";

                    let userProgress = 0; let userStatus = null;
                    if (getAlToken()) {
                        try {
                            const progRes = await anilistQuery(`query($id:Int){Media(id:$id){mediaListEntry{progress status}}}`, { id: currentMediaId }, true);
                            if (progRes?.data?.Media?.mediaListEntry) { userProgress = progRes.data.Media.mediaListEntry.progress || 0; userStatus = progRes.data.Media.mediaListEntry.status; }
                        } catch(e) { Logger('ERROR', 'Ошибка получения прогресса AL для плеера', e); }
                    }

                    const fallbackPlayer = (err = '') => {
                        Logger('ERROR', `Срабатывание fallback плеера Kodik: ${err}`);
                        iframe.src = `https://kodikplayer.com/find-player?shikimoriID=${malData.idMal}&types=anime-serial,anime`;
                        titleEl.innerText = defaultTitle + (err ? ` (Резерв: ${err})` : ' (Резервный плеер)');
                    };

                    const kodikToken = '16f20d024a6fa20700b389c44d9ab159';

                    GM_xmlhttpRequest({
                        method: "GET", url: `https://kodik-api.com/search?token=${kodikToken}&shikimori_id=${malData.idMal}`,
                        onload: (res) => {
                            try {
                                const data = JSON.parse(res.responseText);
                                if (data.results && data.results.length > 0) {
                                    const trMap = new Map();
                                    data.results.forEach(r => {
                                        if (r.translation && r.translation.title && !trMap.has(r.translation.title)) {
                                            let link = r.link;
                                            if (link.startsWith('//')) link = 'https:' + link;
                                            // Скрываем родные селекторы (наш UI), но функционал жив — сериями рулим
                                            // через API плеера (change_episode) без перезагрузки, даже в фуллскрине.
                                            link += (link.includes('?') ? '&' : '?') + 'hide_selectors=true';

                                            let eps =[];
                                            if (r.seasons) {
                                                const seasonKeys = Object.keys(r.seasons);
                                                if (seasonKeys.length > 0) {
                                                    const firstSeason = r.seasons[seasonKeys[0]];
                                                    if (firstSeason.episodes) eps = Object.keys(firstSeason.episodes).map(Number).sort((a,b) => a - b);
                                                }
                                            }
                                            if (eps.length === 0) {
                                                const max = r.last_episode || r.episodes_count || 1;
                                                for (let i = 1; i <= max; i++) eps.push(i);
                                            }
                                            trMap.set(r.translation.title, { title: r.translation.title, link: link, episodes: eps, type: r.type });
                                        }
                                    });

                                    const translations = Array.from(trMap.values());
                                    if (translations.length === 0) throw new Error("No translations");

                                    let favs = GM_getValue('am_fav_translations',[]); let defaultTr = null;
                                    for (let fav of favs) { const match = translations.find(t => t.title === fav); if (match) { defaultTr = match; break; } }
                                    if (!defaultTr) defaultTr = translations[0];

                                    let activeTranslation = defaultTr;
                                    let activeEpisode = activeTranslation.episodes.length > 0 ? activeTranslation.episodes[0] : 1;
                                    let loadedTranslation = null; // какая озвучка реально загружена в iframe

                                    const setTitle = () => {
                                        titleEl.innerText = activeTranslation.type === 'anime-serial'
                                            ? `${defaultTitle} — ${activeTranslation.title} (Серия ${activeEpisode})`
                                            : `${defaultTitle} — ${activeTranslation.title}`;
                                    };

                                    // seamless=true — сменить серию через API плеера, без перезагрузки iframe
                                    // (видео не перезапускается, нативный фуллскрин не слетает). Работает только
                                    // внутри уже загруженной озвучки; смена озвучки = загрузка её ссылки.
                                    const updatePlayer = (seamless = false) => {
                                        const isSerial = activeTranslation.type === 'anime-serial';
                                        if (seamless && isSerial && loadedTranslation === activeTranslation && iframe.contentWindow) {
                                            try {
                                                iframe.contentWindow.postMessage({ key: 'kodik_player_api', value: { method: 'change_episode', episode: activeEpisode } }, '*');
                                            } catch (e) { Logger('ERROR', 'Kodik API change_episode', e); }
                                        } else {
                                            iframe.src = isSerial ? activeTranslation.link + '&episode=' + activeEpisode : activeTranslation.link;
                                            loadedTranslation = activeTranslation;
                                        }
                                        setTitle();
                                    };

                                    const renderEpisodes = () => {
                                        ePanel.innerHTML = '';
                                        if (activeTranslation.type === 'anime' || activeTranslation.episodes.length <= 1) { ePanel.style.display = 'none'; return; }
                                        ePanel.style.display = 'flex';
                                        const isCompleted = userStatus === 'COMPLETED';

                                        activeTranslation.episodes.forEach(ep => {
                                            const btnEp = document.createElement('div'); btnEp.className = 'ep-btn';
                                            const isWatched = isCompleted || ep <= userProgress;
                                            if (isWatched) btnEp.classList.add('watched');
                                            if (ep === activeEpisode) btnEp.classList.add('active');
                                            btnEp.textContent = ep;
                                            btnEp.onclick = () => { activeEpisode = ep; renderEpisodes(); updatePlayer(true); };
                                            ePanel.appendChild(btnEp);
                                        });
                                    };

                                    const renderTranslations = () => {
                                        tPanel.innerHTML = '';
                                        translations.forEach(tr => {
                                            const isFav = favs.includes(tr.title);
                                            const btnTr = document.createElement('div'); btnTr.className = `tr-btn ${tr.title === activeTranslation.title ? 'active' : ''} ${isFav ? 'favorite' : ''}`;
                                            const nameSpan = document.createElement('span'); nameSpan.className = 'tr-name'; nameSpan.textContent = tr.title;
                                            const heartSpan = document.createElement('span'); heartSpan.className = 'tr-heart'; heartSpan.innerHTML = isFav ? '❤️' : '🤍';

                                            btnTr.onclick = (e) => {
                                                if (e.target === heartSpan) return;
                                                activeTranslation = tr;
                                                if (!tr.episodes.includes(activeEpisode)) activeEpisode = tr.episodes[tr.episodes.length - 1] || 1;
                                                renderTranslations(); renderEpisodes(); updatePlayer();
                                            };

                                            heartSpan.onclick = (e) => {
                                                e.stopPropagation();
                                                let currentFavs = GM_getValue('am_fav_translations',[]);
                                                if (currentFavs.includes(tr.title)) currentFavs = currentFavs.filter(f => f !== tr.title);
                                                else currentFavs.unshift(tr.title);
                                                GM_setValue('am_fav_translations', currentFavs);
                                                favs = currentFavs; renderTranslations();
                                            };
                                            btnTr.appendChild(nameSpan); btnTr.appendChild(heartSpan); tPanel.appendChild(btnTr);
                                        });
                                    };

                                    tPanel.style.display = 'flex'; renderTranslations(); renderEpisodes(); updatePlayer();

                                    // Синхронизация: плеер сам сообщает текущую серию (автопереход по окончании,
                                    // либо смена изнутри). Подсвечиваем её в нашей панели и правим заголовок.
                                    // Слушатель один — снимаем предыдущий, чтобы не накапливались при переоткрытии.
                                    if (window.__amKodikSync) window.removeEventListener('message', window.__amKodikSync);
                                    window.__amKodikSync = (message) => {
                                        const d = message && message.data;
                                        if (!d || d.key !== 'kodik_player_current_episode' || !d.value) return;
                                        const ep = Number(d.value.episode);
                                        if (!ep || ep === activeEpisode || !activeTranslation.episodes.includes(ep)) return;
                                        activeEpisode = ep; renderEpisodes(); setTitle();
                                    };
                                    window.addEventListener('message', window.__amKodikSync);
                                } else { fallbackPlayer(); }
                            } catch(e) { fallbackPlayer('API Error'); }
                        },
                        onerror: () => { fallbackPlayer('Network Error'); }
                    });
                };
            }
        } else { const btn = document.getElementById('ru-player-btn'); if (btn) btn.style.display = 'none'; }
    };

    // ==========================================
    // 7. МОДУЛЬ РУССКОГО ПОИСКА
    // ==========================================
    function initRussianSearch() {
        let searchTimeout = null; let activeQuery = ""; let cachedHtml = "";

        // Слушаем ввод в главный инпут поиска AniList
        document.body.addEventListener('input', (e) => {
            const target = e.target;
            if (target.tagName !== 'INPUT' || target.getAttribute('placeholder') !== 'Поиск в AniList') return;

            const query = target.value.trim(); const hasCyrillic = /[а-яА-ЯёЁ]/.test(query);

            if (!hasCyrillic || query.length < 2) {
                document.body.classList.remove('am-ru-search-active'); activeQuery = ""; cachedHtml = ""; removeCustomResults(); return;
            }
            if (query === activeQuery) return;

            activeQuery = query; document.body.classList.add('am-ru-search-active'); clearTimeout(searchTimeout);
            cachedHtml = `<div class="am-ru-loading">Ищем на Shikimori... 🔍</div>`; renderCustomResults(cachedHtml);
            searchTimeout = setTimeout(() => performRussianSearch(query), 600);
        });

        async function performRussianSearch(query) {
            Logger('INFO', `Русский поиск: ${query}`);
            try {
                const [animeRes, mangaRes] = await Promise.all([
                    fetchShiki(`/api/animes?search=${encodeURIComponent(query)}&limit=4`),
                    fetchShiki(`/api/mangas?search=${encodeURIComponent(query)}&limit=4`)
                ]);
                if (activeQuery !== query) return;

                const shikiAnime = animeRes.data || []; const shikiManga = mangaRes.data ||[];
                if (shikiAnime.length === 0 && shikiManga.length === 0) {
                    cachedHtml = `<div class="am-ru-empty">Ничего не найдено ¯\\_(ツ)_/¯</div>`; renderCustomResults(cachedHtml); return;
                }

                const malIds =[...shikiAnime.map(i => i.id), ...shikiManga.map(i => i.id)];
                const alQuery = `query($m:[Int]){ Page{ media(idMal_in:$m){ id idMal type format seasonYear coverImage{medium} } } }`;
                const alRes = await anilistQuery(alQuery, { m: malIds });
                if (activeQuery !== query) return;

                const alData = alRes?.data?.Page?.media ||[]; const alMap = {};
                alData.forEach(item => { alMap[`${item.type}_${item.idMal}`] = item; });

                let html = '';
                const generateCol = (title, items, typeStr) => {
                    if (items.length === 0) return '';
                    let colHtml = `<div class="result-col animori-custom-result-col"><h3 class="title">${escapeHTML(title)}</h3>`;
                    items.forEach(item => {
                        const alItem = alMap[`${typeStr.toUpperCase()}_${item.id}`]; if (!alItem) return;
                        const year = alItem.seasonYear || (item.aired_on ? new Date(item.aired_on).getFullYear() : '???');
                        const format = (alItem.format || typeStr).replace(/_/g, ' ');
                        const coverSafe = encodeURI(alItem.coverImage.medium).replace(/'/g, "%27");
                        colHtml += `<div class="result"><div><a href="/${escapeHTML(alItem.type).toLowerCase()}/${escapeHTML(alItem.id)}" class=""><div class="image" style="background-image: url('${coverSafe}');"></div><div class="name">${escapeHTML(item.russian || item.name)}<div class="info"><span>${escapeHTML(year)}</span> <span>${escapeHTML(format)}</span></div></div></a></div></div>`;
                    });
                    colHtml += `</div>`; return colHtml;
                };

                html += generateCol('Аниме (RU)', shikiAnime, 'Anime'); html += generateCol('Манга (RU)', shikiManga, 'Manga');
                if (html === '') html = `<div class="am-ru-empty">Совпадений на AniList не найдено</div>`;
                cachedHtml = html; renderCustomResults(html);

            } catch (e) {
                if (activeQuery !== query) return;
                cachedHtml = `<div class="am-ru-empty">Ошибка соединения с базе</div>`; renderCustomResults(cachedHtml);
                Logger('ERROR', 'Ошибка русского поиска', e);
            }
        }

        function renderCustomResults(htmlContent) {
            let resultsContainer = document.querySelector('.results:not(.am-fake-results)');
            if (!resultsContainer) {
                resultsContainer = document.querySelector('.am-fake-results');
                if (!resultsContainer) {
                    const inputWrap = document.querySelector('.input');
                    if (inputWrap && inputWrap.parentNode) {
                        resultsContainer = document.createElement('div'); resultsContainer.className = 'results am-fake-results';
                        const dataAttr = Array.from(inputWrap.attributes).find(a => a.name.startsWith('data-v-'));
                        if (dataAttr) resultsContainer.setAttribute(dataAttr.name, '');
                        inputWrap.parentNode.appendChild(resultsContainer);
                    } else return;
                }
            }

            document.querySelectorAll('.am-ru-injected-container').forEach(el => el.remove());
            const wrapper = document.createElement('div'); wrapper.className = 'am-ru-injected-container'; wrapper.innerHTML = htmlContent;
            resultsContainer.appendChild(wrapper);
        }

        function removeCustomResults() {
            document.querySelectorAll('.am-ru-injected-container').forEach(el => el.remove());
            document.querySelectorAll('.am-fake-results').forEach(el => el.remove());
        }

        const observer = new MutationObserver((mutations) => {
            if (document.body.classList.contains('am-ru-search-active') && activeQuery.length >= 2) {
                const realResults = document.querySelector('.results:not(.am-fake-results)');
                const fakeResults = document.querySelector('.am-fake-results');
                if (realResults && fakeResults) fakeResults.remove();

                const resultsContainer = document.querySelector('.results');
                const hasOurContainer = document.querySelector('.am-ru-injected-container');
                if (resultsContainer && !hasOurContainer && cachedHtml) renderCustomResults(cachedHtml);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ==========================================
    // 8. ИНИЦИАЛИЗАЦИЯ И UI НАСТРОЕК
    // ==========================================
    async function init() {
        Logger('INFO', 'Скрипт AniMori загружается...');

        GM_addStyle(`
            /* Единый блок-пилюля из кнопок (плеер прирастает слева при наличии) */
            #animori-actions { position:fixed; bottom:25px; left:25px; z-index:9999; display:flex; align-items:stretch; gap:0; background:rgba(var(--color-foreground),0.8); backdrop-filter:blur(16px) saturate(170%); -webkit-backdrop-filter:blur(16px) saturate(170%); border:1px solid rgba(var(--color-text-light),0.2); border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.18); overflow:hidden; }
            .am-premium-btn { background:transparent; border:none; border-radius:0; box-shadow:none; color:rgb(var(--color-text)); padding:11px 18px; font-family:inherit; font-size:14px; font-weight:600; cursor:pointer; transition:background .15s, color .15s; display:flex; align-items:center; justify-content:center; letter-spacing:0.3px; }
            .am-premium-btn + .am-premium-btn { border-left:1px solid rgba(var(--color-text-light),0.14); }
            .am-premium-btn:hover { background:rgba(var(--color-text-light),0.1); color:rgb(var(--color-blue)); }
            #am-set-btn, #am-log-btn, #am-cmp-btn { font-size:15px; width:46px; padding:11px 0; }
            #ru-player-btn { color:rgb(var(--color-blue)); font-weight:700; }
            #ru-player-btn:hover { background:rgba(var(--color-blue),0.14); }
            .pulse-glow { animation: am-pulse 2.5s infinite cubic-bezier(0.66, 0, 0, 1); }
            @keyframes am-pulse { 0% { box-shadow: 0 0 0 0 rgba(var(--color-blue), 0.3); } 70% { box-shadow: 0 0 0 15px rgba(var(--color-blue), 0); border-color: rgba(var(--color-blue), 0.5); } 100% { box-shadow: 0 0 0 0 rgba(var(--color-blue), 0); } }
            /* #am-panel теперь модалка-overlay (см. UI-кит выше) */
            @keyframes panel-pop { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
            #am-panel::-webkit-scrollbar { width: 6px; } #am-panel::-webkit-scrollbar-thumb { background: rgba(var(--color-blue), 0.4); border-radius: 4px; }
            #am-panel h3 { margin:0 0 15px 0; font-size:14px; color:rgb(var(--color-blue)); text-transform:uppercase; border-bottom:1px solid rgba(var(--color-blue),0.3); padding-bottom:10px; font-weight: 700; letter-spacing: 1px;}
            .am-opt { display:flex; justify-content:space-between; margin-bottom:12px; font-size:13px; font-weight: 500; align-items:center; }
            .am-opt input[type="checkbox"] { accent-color: rgb(var(--color-blue)); width: 16px; height: 16px; cursor: pointer; }
            .am-btn { background: rgba(var(--color-background-200), 1); color: rgb(var(--color-text)); border: 1px solid rgba(var(--color-text-light), 0.2); padding:10px; border-radius:8px; cursor:pointer; font-size:13px; width:100%; margin-top:15px; font-weight:600; transition: all 0.2s; }
            .am-btn:hover { background: rgba(var(--color-background-300), 1); border-color: rgb(var(--color-blue)); color: rgb(var(--color-blue)); transform: translateY(-1px); }

            /* ===== AniMori UI Kit — тема-нативные компоненты (адаптируются ко всем темам AniList) ===== */
            .amk-overlay, #am-panel { position:fixed; inset:0; z-index:999999; display:none; align-items:center; justify-content:center; padding:24px; background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); animation:amk-fade .18s ease; }
            @keyframes amk-fade { from{opacity:0} to{opacity:1} }
            @keyframes amk-pop { from{transform:translateY(10px) scale(.985); opacity:0} to{transform:none; opacity:1} }
            .amk-modal { display:flex; flex-direction:column; width:540px; max-width:96vw; max-height:88vh; background:rgba(var(--color-foreground),0.8); backdrop-filter:blur(22px) saturate(170%); -webkit-backdrop-filter:blur(22px) saturate(170%); color:rgb(var(--color-text)); border:1px solid rgba(var(--color-text-light),0.16); border-radius:14px; box-shadow:0 12px 44px rgba(0,0,0,0.22); overflow:hidden; animation:amk-pop .2s cubic-bezier(.2,.8,.2,1); font-family:inherit; font-size:14px; }
            .amk-modal.amk-wide { width:920px; }
            .amk-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; border-bottom:1px solid rgba(var(--color-text-light),0.1); flex-wrap:wrap; flex-shrink:0; }
            .amk-title { margin:0; font-size:15px; font-weight:700; letter-spacing:.3px; display:flex; align-items:center; gap:9px; }
            .amk-title .amk-dot { width:9px; height:9px; border-radius:50%; background:rgb(var(--color-blue)); box-shadow:0 0 10px rgba(var(--color-blue),0.6); }
            .amk-sub { font-size:12px; color:rgb(var(--color-text-light)); font-weight:500; }
            .amk-body { padding:16px 18px; overflow-y:auto; display:flex; flex-direction:column; gap:14px; flex:1 1 auto; min-height:0; }
            .amk-body > * { flex-shrink:0; }
            .amk-foot { padding:12px 18px; border-top:1px solid rgba(var(--color-text-light),0.1); display:flex; gap:10px; flex-shrink:0; }
            .amk-body::-webkit-scrollbar { width:8px; } .amk-body::-webkit-scrollbar-thumb { background:rgba(var(--color-text-light),0.25); border-radius:4px; }
            .amk-card { background:rgba(var(--color-background-100),0.55); border:1px solid rgba(var(--color-text-light),0.1); border-radius:10px; padding:2px 12px 6px; }
            .amk-card-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.7px; color:rgb(var(--color-text-light)); padding:10px 2px 4px; }
            .amk-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 2px; }
            .amk-row + .amk-row { border-top:1px solid rgba(var(--color-text-light),0.07); }
            .amk-row-label { display:flex; flex-direction:column; gap:2px; min-width:0; }
            .amk-row-label b { font-weight:600; }
            .amk-row-hint { font-size:11px; color:rgb(var(--color-text-light)); line-height:1.45; }
            .amk-switch { position:relative; width:38px; height:22px; flex-shrink:0; cursor:pointer; display:inline-block; }
            .amk-switch input { position:absolute; opacity:0; width:0; height:0; }
            .amk-track { position:absolute; inset:0; border-radius:6px; background:rgba(var(--color-text-light),0.3); transition:background .18s; }
            .amk-thumb { position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:4px; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.35); transition:transform .18s; }
            .amk-switch input:checked ~ .amk-track { background:rgb(var(--color-blue)); }
            .amk-switch input:checked ~ .amk-thumb { transform:translateX(16px); }
            .amk-input, .amk-select { width:100%; box-sizing:border-box; background:rgba(var(--color-background-200),0.7); border:1px solid rgba(var(--color-text-light),0.18); color:rgb(var(--color-text)); border-radius:8px; padding:8px 10px; font-size:13px; font-family:inherit; outline:none; transition:border-color .15s, box-shadow .15s; }
            .amk-input:focus, .amk-select:focus { border-color:rgb(var(--color-blue)); box-shadow:0 0 0 3px rgba(var(--color-blue),0.18); }
            .amk-input.amk-mono { font-family:"Cascadia Code","Fira Code",Consolas,monospace; font-size:12px; }
            .amk-input::placeholder { color:rgba(var(--color-text-light),0.7); }
            .amk-btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:9px 16px; border-radius:8px; font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; border:1px solid transparent; transition:all .15s; white-space:nowrap; }
            .amk-btn-primary { background:rgb(var(--color-blue)); color:#fff; }
            .amk-btn-primary:hover { filter:brightness(1.08); box-shadow:0 4px 14px rgba(var(--color-blue),0.35); }
            .amk-btn-ghost { background:rgba(var(--color-text-light),0.08); color:rgb(var(--color-text)); border-color:rgba(var(--color-text-light),0.18); }
            .amk-btn-ghost:hover { background:rgba(var(--color-text-light),0.15); border-color:rgb(var(--color-blue)); color:rgb(var(--color-blue)); }
            .amk-btn-danger { background:rgba(var(--color-red),0.12); color:rgb(var(--color-red)); border-color:rgba(var(--color-red),0.35); }
            .amk-btn-danger:hover { background:rgba(var(--color-red),0.2); }
            .amk-btn:disabled { opacity:.5; cursor:default; }
            .amk-btn-block { width:100%; }
            .amk-close { background:rgba(var(--color-text-light),0.1); border:1px solid rgba(var(--color-text-light),0.18); color:rgb(var(--color-text)); width:30px; height:30px; border-radius:8px; cursor:pointer; font-size:15px; line-height:1; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
            .amk-close:hover { background:rgba(var(--color-red),0.15); color:rgb(var(--color-red)); border-color:rgba(var(--color-red),0.3); }
            .amk-chip { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; background:rgba(var(--color-text-light),0.08); border:1px solid rgba(var(--color-text-light),0.15); color:rgb(var(--color-text)); transition:all .15s; }
            .amk-chip:hover { border-color:rgb(var(--color-blue)); }
            .amk-chip.active { background:rgba(var(--color-blue),0.15); border-color:rgb(var(--color-blue)); color:rgb(var(--color-blue)); }
            .amk-collapse { border:1px solid rgba(var(--color-text-light),0.1); border-radius:10px; overflow:hidden; margin:6px 0; }
            .amk-collapse > summary { list-style:none; cursor:pointer; padding:10px 12px; font-weight:600; font-size:13px; background:rgba(var(--color-background-100),0.5); display:flex; align-items:center; gap:8px; }
            .amk-collapse > summary::-webkit-details-marker { display:none; }
            .amk-collapse > summary:hover { background:rgba(var(--color-text-light),0.06); }
            .amk-collapse[open] > summary { border-bottom:1px solid rgba(var(--color-text-light),0.1); }
            .amk-collapse-body { padding:4px 6px; max-height:340px; overflow:auto; }
            .amk-count { color:rgb(var(--color-text-light)); font-weight:500; }
            .amk-diffrow { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px; border-bottom:1px solid rgba(var(--color-text-light),0.06); font-size:12px; }
            .amk-diffrow .amk-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
            .amk-diffrow .amk-meta { opacity:.85; white-space:nowrap; }
            .amk-x { cursor:pointer; opacity:.5; padding:0 4px; flex-shrink:0; } .amk-x:hover { opacity:1; color:rgb(var(--color-red)); }
            .amk-table { width:100%; border-collapse:collapse; font-size:13px; }
            .amk-table th, .amk-table td { padding:4px 8px; text-align:center; } .amk-table th:first-child, .amk-table td:first-child { text-align:left; }
            .amk-table thead th { border-bottom:1px solid rgba(var(--color-text-light),0.15); font-weight:600; }
            .amk-table tbody tr:not(:last-child) td { border-bottom:1px solid rgba(var(--color-text-light),0.06); }
            #ru-player-overlay { position:fixed; inset:0; width:100vw; height:100vh; background:rgba(0,0,0,0.82); backdrop-filter:blur(14px) saturate(160%); -webkit-backdrop-filter:blur(14px) saturate(160%); z-index:10000; display:none; justify-content:center; align-items:center; flex-direction:column; gap:12px; animation: player-fade 0.3s ease; }
            @keyframes player-fade { from { opacity: 0; } to { opacity: 1; } }
            #ru-player-container { width:90%; max-width:1100px; aspect-ratio:16/9; background:#000; border-radius:12px; overflow:hidden; border:1px solid rgba(var(--color-blue),0.3); position:relative; box-shadow: 0 20px 60px rgba(0,0,0,0.55); flex-shrink: 0;}
            #ru-p-iframe { width:100%; height:100%; border:none; }
            #ru-player-close { position:absolute; top:18px; right:24px; width:40px; height:40px; display:flex; align-items:center; justify-content:center; line-height:1; color:rgb(var(--color-text-light)); font-size:26px; cursor:pointer; border-radius:8px; background:rgba(var(--color-foreground),0.6); border:1px solid rgba(var(--color-text-light),0.15); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); transition:all .18s; }
            #ru-player-close:hover { color:#fff; background:rgb(var(--color-red)); border-color:rgb(var(--color-red)); transform:scale(1.05); }
            #ru-info-panel { width:90%; max-width:1100px; background:rgba(var(--color-foreground),0.85); backdrop-filter:blur(14px) saturate(160%); -webkit-backdrop-filter:blur(14px) saturate(160%); border-radius:10px; padding:12px 16px; border:1px solid rgba(var(--color-text-light),0.15); flex-shrink:0; }
            #ru-translations-panel { width:90%; max-width:1100px; display:flex; gap:8px; overflow-x:auto; padding-bottom:6px; flex-shrink:0; }
            #ru-translations-panel::-webkit-scrollbar { height: 6px; } #ru-translations-panel::-webkit-scrollbar-track { background: rgba(var(--color-text-light),0.08); border-radius: 4px; } #ru-translations-panel::-webkit-scrollbar-thumb { background: rgba(var(--color-blue), 0.4); border-radius: 4px; } #ru-translations-panel::-webkit-scrollbar-thumb:hover { background: rgba(var(--color-blue), 0.8); }
            .tr-btn { flex-shrink:0; display:flex; align-items:center; background:rgba(var(--color-foreground),0.8); border:1px solid rgba(var(--color-text-light),0.18); padding:8px 14px; border-radius:8px; cursor:pointer; white-space:nowrap; transition:all .18s; color:rgb(var(--color-text)); font-weight:600; font-size:13px; gap:8px; }
            .tr-btn:hover { border-color:rgba(var(--color-blue),0.5); transform:translateY(-2px); } .tr-btn.active { border-color:rgb(var(--color-blue)); background:rgba(var(--color-blue),0.15); color:rgb(var(--color-blue)); } .tr-btn.favorite { border-color:rgb(var(--color-pink, 243,139,168)); color:rgb(var(--color-pink, 243,139,168)); background:rgba(var(--color-pink, 243,139,168),0.06); } .tr-btn.favorite.active { background:rgba(var(--color-pink, 243,139,168),0.16); }
            .tr-heart { font-size:15px; transition:transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275); user-select:none; } .tr-heart:hover { transform:scale(1.3); } .tr-name { font-family:inherit; }
            #ru-episodes-panel { width: 90%; max-width: 1100px; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-height: 180px; overflow-y: auto; padding-right: 4px; flex-shrink: 0; }
            #ru-episodes-panel::-webkit-scrollbar { width: 6px; } #ru-episodes-panel::-webkit-scrollbar-track { background: rgba(var(--color-text-light),0.08); border-radius: 4px; } #ru-episodes-panel::-webkit-scrollbar-thumb { background: rgba(var(--color-blue), 0.4); border-radius: 4px; }
            .ep-btn { width: 46px; height: 36px; display: flex; justify-content: center; align-items: center; flex-shrink: 0; background: rgba(var(--color-foreground),0.8); border: 1px solid rgba(var(--color-text-light),0.18); color: rgb(var(--color-text)); font-weight: 700; font-size: 13px; border-radius: 8px; cursor: pointer; transition: all .18s; }
            .ep-btn:hover { border-color: rgba(var(--color-blue), 0.5); transform: translateY(-2px); } .ep-btn.active { background: rgb(var(--color-blue)); color: #fff; border-color: rgb(var(--color-blue)); box-shadow: 0 4px 12px rgba(var(--color-blue), 0.3); }
            .ep-btn.watched { border-color: rgb(var(--color-green, 166,227,161)); color: rgb(var(--color-green, 166,227,161)); } .ep-btn.watched:hover { background: rgba(var(--color-green, 166,227,161),0.12); } .ep-btn.watched.active { background: rgb(var(--color-green, 166,227,161)); color: rgb(var(--color-background, 17,17,27)); border-color: rgb(var(--color-green, 166,227,161)); box-shadow: 0 4px 12px rgba(var(--color-green, 166,227,161),0.3); }
            .animori-ratings { display:flex; flex-direction:column; gap:6px; margin-bottom:20px; background:rgba(var(--color-foreground),1); border-radius:12px; padding:14px 16px; border:1px solid rgba(var(--color-text-light),0.1); box-shadow:0 1px 3px rgba(0,0,0,0.06); }
            .rating-item { display:flex; justify-content:space-between; align-items:center; padding:7px 0; border-bottom:1px solid rgba(var(--color-text-light),0.08); } .rating-item:last-child { border-bottom:none; }
            .rating-badge { transition:transform .15s; cursor:pointer; padding:5px 10px; border-radius:6px; font-size:11px; font-weight:800; letter-spacing:.8px; font-family:inherit; display:flex; align-items:center; background:rgba(var(--color-text-light),0.1); border:1px solid rgba(var(--color-text-light),0.14); border-left-width:3px; text-decoration:none; }
            .rating-badge:hover { transform:translateY(-1px); }
            .animori-ratings .rating-badge.shiki-badge { color:#e05264 !important; border-left-color:#e05264; } .animori-ratings .rating-badge.mal-badge { color:#5a7fd4 !important; border-left-color:#5a7fd4; } .animori-ratings .rating-badge.al-badge { color:rgb(var(--color-blue)) !important; border-left-color:rgb(var(--color-blue)); }
            .rating-value { font-size:1.4rem; font-weight:700; color:rgb(var(--color-text)); }
            .animori-franchise { margin:0 0 20px; background:rgba(var(--color-foreground),1); border-radius:12px; padding:16px; border:1px solid rgba(var(--color-text-light),0.1); box-shadow:0 1px 3px rgba(0,0,0,0.06); }
            .animori-franchise h2 { font-size:1.2rem; margin:0 0 12px; color:rgb(var(--color-text)); font-weight:700; letter-spacing:.3px; }

            .franchise-list { max-height:300px; overflow-y:auto; scroll-behavior:smooth; padding-right:4px; position:relative; transition:max-height .4s ease; display:flex; flex-direction:column; gap:4px; } .franchise-list.expanded { max-height:none; }
            .franchise-list::-webkit-scrollbar, .themes-list::-webkit-scrollbar { width:6px; } .franchise-list::-webkit-scrollbar-track, .themes-list::-webkit-scrollbar-track { background:transparent; } .franchise-list::-webkit-scrollbar-thumb, .themes-list::-webkit-scrollbar-thumb { background:rgba(var(--color-text-light),0.25); border-radius:4px; } .franchise-list::-webkit-scrollbar-thumb:hover, .themes-list::-webkit-scrollbar-thumb:hover { background:rgba(var(--color-blue),0.6); }
            .franchise-node { display:flex; gap:10px; padding:8px 10px; border-radius:8px; text-decoration:none !important; border-left:3px solid transparent; align-items:center; transition:background .15s, border-color .15s; background:rgba(var(--color-text-light),0.04); } .franchise-node:hover { background:rgba(var(--color-text-light),0.1); } .franchise-node.active { background:rgba(var(--color-blue),0.12); border-left:3px solid rgb(var(--color-blue)); } .franchise-node.shiki-only { border-left:3px dashed rgba(var(--color-text-light),0.5); opacity:0.8; }
            .node-year { font-size:0.95rem; color:rgb(var(--color-text-light)); min-width:38px; font-weight:600; font-variant-numeric:tabular-nums; } .node-title { font-size:1.15rem; color:rgb(var(--color-text)); flex-grow:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; } .node-kind { font-size:0.85rem; padding:3px 8px; background:rgba(var(--color-text-light),0.12); color:rgb(var(--color-text-light)); border-radius:6px; text-transform:uppercase; font-weight:700; letter-spacing:.5px; flex-shrink:0; }
            .franchise-toggle { display:block; width:100%; text-align:center; padding:9px; margin-top:10px; background:rgba(var(--color-text-light),0.08); border-radius:8px; color:rgb(var(--color-blue)); cursor:pointer; font-weight:600; font-size:1rem; transition:background .15s, border-color .15s; border:1px solid rgba(var(--color-blue),0.25); outline:none; } .franchise-toggle:hover { background:rgba(var(--color-blue),0.12); border-color:rgb(var(--color-blue)); }
            .franchise-toggle-top { margin-top:0; margin-bottom:12px; position:sticky; top:0; z-index:2; background:rgba(var(--color-foreground),0.92); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); }
            .am-extlink { text-decoration:none; font-weight:700; font-size:1rem; padding:11px 20px; border-radius:9px; background:rgba(var(--c),0.14); color:rgb(var(--c)); border:1px solid rgba(var(--c),0.4); transition:background .15s, border-color .15s, transform .15s; letter-spacing:0.3px; display:inline-block; } .am-extlink:hover { transform:translateY(-2px); background:rgba(var(--c),0.24); border-color:rgb(var(--c)); }
            .am-service-toggle { display:flex; width:100%; box-sizing:border-box; background:rgba(var(--color-text-light),0.1); border-radius:8px; padding:3px; border:1px solid rgba(var(--color-text-light),0.15); gap:3px; margin:0 auto; } .am-service-btn { flex:1 1 0; min-width:0; display:flex; align-items:center; justify-content:center; padding:8px 0; border-radius:6px; cursor:pointer; transition:all .15s; color:rgb(var(--color-text-light)); user-select:none; } .am-service-btn svg { display:block; } .am-service-btn:hover:not(.active) { color:rgb(var(--color-text)); background:rgba(var(--color-text-light),0.1); } .am-service-btn.active { color:#fff; }
            .am-service-btn.active[data-val="vk"] { background:rgb(var(--color-blue)); box-shadow:0 2px 8px rgba(var(--color-blue),0.35); }
            .am-service-btn.active[data-val="yt"] { background:rgb(var(--color-red)); box-shadow:0 2px 8px rgba(var(--color-red),0.35); }
            .am-service-btn.active[data-val="spotify"] { background:rgb(var(--color-green)); box-shadow:0 2px 8px rgba(var(--color-green),0.35); }
            .am-service-btn.active[data-val="sc"] { background:rgb(var(--color-orange)); box-shadow:0 2px 8px rgba(var(--color-orange),0.35); }
            body.am-ru-search-active .results .result-col:not(.animori-custom-result-col) { display: none !important; } .animori-custom-result-col { flex: 1; padding: 0 10px; } .am-ru-loading { text-align: center; padding: 20px; color: rgb(var(--color-text-light)); font-weight: bold; animation: am-pulse 1.5s infinite; width: 100%; } .am-ru-empty { text-align: center; padding: 20px; color: #fc8181; font-weight: bold; width: 100%; } .am-ru-injected-container { display: flex; width: 100%; }

            #am-logger-overlay { position:fixed; inset:0; z-index:999999; display:flex; justify-content:center; align-items:center; padding:24px; background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); animation:amk-fade .18s ease; }
            .am-logger-modal { background:rgba(var(--color-foreground),0.8); backdrop-filter:blur(22px) saturate(170%); -webkit-backdrop-filter:blur(22px) saturate(170%); color:rgb(var(--color-text)); width:920px; max-width:96vw; height:82vh; border-radius:14px; border:1px solid rgba(var(--color-text-light),0.16); display:flex; flex-direction:column; overflow:hidden; box-shadow:0 12px 44px rgba(0,0,0,0.22); animation:amk-pop .2s cubic-bezier(.2,.8,.2,1); }
            .am-logger-header { padding:14px 18px; border-bottom:1px solid rgba(var(--color-text-light),0.1); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; }
            .am-logger-header h2 { margin:0; color:rgb(var(--color-text)); font-size:15px; font-weight:700; display:flex; align-items:center; gap:9px; }
            #am-log-search { background:rgba(var(--color-background-200),0.7) !important; border:1px solid rgba(var(--color-text-light),0.18) !important; color:rgb(var(--color-text)) !important; }
            .am-logger-filters { display:flex; gap:4px; background:rgba(var(--color-text-light),0.08); padding:4px; border-radius:8px; }
            .am-log-filter { background:transparent; border:none; color:rgb(var(--color-text-light)); padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; transition:.15s; } .am-log-filter:hover { background:rgba(var(--color-text-light),0.1); color:rgb(var(--color-text)); } .am-log-filter.active { background:rgba(var(--color-blue),0.18); color:rgb(var(--color-blue)); }
            .am-logger-actions { display:flex; gap:8px; } .am-logger-actions button { background:rgba(var(--color-text-light),0.08); border:1px solid rgba(var(--color-text-light),0.18); color:rgb(var(--color-text)); padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; transition:.15s; } .am-logger-actions button:hover { background:rgba(var(--color-text-light),0.15); border-color:rgb(var(--color-blue)); color:rgb(var(--color-blue)); }
            #am-log-close { background:rgba(var(--color-red),0.14) !important; color:rgb(var(--color-red)) !important; border-color:rgba(var(--color-red),0.3) !important; } #am-log-close:hover { background:rgba(var(--color-red),0.24) !important; }
            #am-log-container { flex:1; overflow-y:auto; padding:14px; font-family:"Cascadia Code","Fira Code",Consolas,monospace; font-size:12px; background:rgba(var(--color-background),0.35); }
            #am-log-container::-webkit-scrollbar { width:8px; } #am-log-container::-webkit-scrollbar-thumb { background:rgba(var(--color-text-light),0.25); border-radius:4px; }
            .am-log-entry { margin-bottom:6px; border-radius:8px; background:rgba(var(--color-text-light),0.04); border:1px solid transparent; }
            .am-log-header { padding:8px 12px; display:flex; align-items:center; gap:10px; } .am-log-header:hover { background:rgba(var(--color-text-light),0.06); }
            .am-log-time { color:rgb(var(--color-text-light)); font-size:11px; flex-shrink:0; } .am-log-badge { padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px; flex-shrink:0; width:50px; text-align:center; text-transform:uppercase; } .am-log-msg { color:rgb(var(--color-text)); flex-grow:1; word-break:break-word; } .am-log-expand { color:rgb(var(--color-text-light)); font-size:10px; transition:.2s; user-select:none; }
            .am-log-details { padding:10px 12px; background:rgba(var(--color-background),0.4); border-top:1px solid rgba(var(--color-text-light),0.08); border-radius:0 0 8px 8px; font-family:inherit; font-size:11.5px; line-height:1.4; }
            .am-log-details details summary::-webkit-details-marker { display:none; }
            .type-info .am-log-badge { background:rgba(var(--color-blue),0.15); color:rgb(var(--color-blue)); border:1px solid rgba(var(--color-blue),0.3); } .type-api .am-log-badge { background:rgba(var(--color-purple),0.15); color:rgb(var(--color-purple)); border:1px solid rgba(var(--color-purple),0.3); } .type-db .am-log-badge { background:rgba(var(--color-green),0.15); color:rgb(var(--color-green)); border:1px solid rgba(var(--color-green),0.3); } .type-queue .am-log-badge { background:rgba(var(--color-orange),0.15); color:rgb(var(--color-orange)); border:1px solid rgba(var(--color-orange),0.3); } .type-error .am-log-badge { background:rgba(var(--color-red),0.15); color:rgb(var(--color-red)); border:1px solid rgba(var(--color-red),0.3); } .type-error { border-color:rgba(var(--color-red),0.2); background:rgba(var(--color-red),0.05); }
            .am-log-path { color:rgb(var(--color-text-light)); font-size:10px; max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; background:rgba(var(--color-text-light),0.08); padding:2px 4px; border-radius:4px; cursor:default; }
            .am-log-btn-stack { font-size:10px; color:rgb(var(--color-red)); cursor:pointer; transition:.2s; user-select:none; font-weight:700; background:rgba(var(--color-red),0.1); padding:2px 4px; border-radius:4px; border:1px solid rgba(var(--color-red),0.3); }
            .am-log-btn-stack:hover { background:rgba(var(--color-red),0.24); }
        `);

        if (IS_SHIKI) {
            initExporter();
        } else if (IS_ANILIST) {
            const actionsRoot = document.createElement('div'); actionsRoot.id = 'animori-actions'; document.body.appendChild(actionsRoot);
            const btnSet = document.createElement('button'); btnSet.id = 'am-set-btn'; btnSet.className = 'am-premium-btn'; btnSet.innerHTML = '⚙'; btnSet.title = 'Настройки AniMori';
            btnSet.onclick = () => { const p = document.getElementById('am-panel'); p.style.display = window.getComputedStyle(p).display === 'none' ? 'flex' : 'none'; };
            actionsRoot.appendChild(btnSet);

            // Кнопка Логгера
            if (settings.enableLogger) {
                const btnLog = document.createElement('button'); btnLog.id = 'am-log-btn'; btnLog.className = 'am-premium-btn'; btnLog.innerHTML = '&lt;/&gt;'; btnLog.title = 'Открыть логгер (AniMori)'; btnLog.onclick = openLoggerModal; actionsRoot.appendChild(btnLog);
            }

            // Кнопка Сравнения списков (сканер дельты Shikimori <-> AniList)
            const btnCmp = document.createElement('button'); btnCmp.id = 'am-cmp-btn'; btnCmp.className = 'am-premium-btn'; btnCmp.innerHTML = '⇄'; btnCmp.title = 'Сравнить списки Shikimori и AniList (AniMori)'; btnCmp.onclick = openCompareModal; actionsRoot.appendChild(btnCmp);

            // Рендер настроек — модалка на UI-ките (id инпутов сохранены для биндингов).
            const sw = (id, on, extra = '') => `<label class="amk-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${extra}><span class="amk-track"></span><span class="amk-thumb"></span></label>`;
            const panel = document.createElement('div'); panel.id = 'am-panel';
            panel.innerHTML = `
                <div class="amk-modal">
                    <div class="amk-head">
                        <h2 class="amk-title"><span class="amk-dot"></span>AniMori <span class="amk-sub">настройки</span></h2>
                        <button class="amk-close" id="am-set-close" title="Закрыть">✕</button>
                    </div>
                    <div class="amk-body">
                        <div class="amk-card">
                            <div class="amk-card-title">Перевод</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Интерфейс</b></span>${sw('set_interface', settings.translateInterface)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Тайтлы и описания</b><span class="amk-row-hint">с Shikimori</span></span>${sw('set_titles', settings.translateTitles)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Персонажи</b><span class="amk-row-hint">с Shikimori</span></span>${sw('set_chars', settings.translateCharacters)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Персонал</b><span class="amk-row-hint">с Shikimori</span></span>${sw('set_staff', settings.translateStaff)}</div>
                        </div>
                        <div class="amk-card">
                            <div class="amk-card-title">Модули</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Аниме-плеер</b></span>${sw('set_player', settings.enablePlayer)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Рейтинги MAL и Shiki</b></span>${sw('set_ratings', settings.enableRatings)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Дерево франшизы</b></span>${sw('set_franchise', settings.enableFranchise)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Музыкальные темы</b></span>${sw('set_themes', settings.enableThemes)}</div>
                        </div>
                        <div class="amk-card">
                            <div class="amk-card-title">Внешние ссылки</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Показывать ссылки</b></span>${sw('set_extlinks', settings.enableExtLinks)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>RuTracker</b></span>${sw('set_link_rutracker', settings.enableLinkRutracker)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>YummyAnime</b></span>${sw('set_link_yummy', settings.enableLinkYummy)}</div>
                            <input class="amk-input amk-mono" id="set_yummy_domain" placeholder="yummyanime.tv" style="margin:2px 0 8px;">
                            <div class="amk-row"><span class="amk-row-label"><b>AnimeGO</b></span>${sw('set_link_animego', settings.enableLinkAnimego)}</div>
                            <input class="amk-input amk-mono" id="set_animego_domain" placeholder="animego.org" style="margin:2px 0 8px;">
                            <div class="amk-row"><span class="amk-row-label"><b>MangaLib</b></span>${sw('set_link_mangalib', settings.enableLinkMangalib)}</div>
                            <input class="amk-input amk-mono" id="set_mangalib_domain" placeholder="mangalib.me" style="margin:2px 0 6px;">
                        </div>
                        <div class="amk-card">
                            <div class="amk-card-title">Авторизация AniList</div>
                            <div class="amk-row-hint" style="padding:8px 2px 6px;">Токен нужен для экспорта и сравнения списков. Создайте Client <a href="https://anilist.co/settings/developer" target="_blank" style="color:rgb(var(--color-blue));text-decoration:none;">здесь</a>, redirect URL: <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;">https://anilist.co/api/v2/oauth/pin</code></div>
                            <input class="amk-input amk-mono" type="password" id="set_al_token" placeholder="Токен AniList" style="margin-bottom:8px;">
                            <div style="display:flex; gap:8px; margin-bottom:6px;"><input class="amk-input amk-mono" id="set_al_client" placeholder="Client ID" style="flex:1;"><button class="amk-btn amk-btn-ghost" id="set_al_gen" title="Создать ссылку авторизации">Ссылка</button></div>
                            <div id="set_al_link_wrap" style="text-align:center; font-size:12px;"></div>
                        </div>
                        <div class="amk-card">
                            <div class="amk-card-title">Прочее</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Логгер</b><span class="amk-row-hint">отслеживание действий скрипта (для отладки)</span></span>${sw('set_logger', settings.enableLogger)}</div>
                        </div>
                    </div>
                    <div class="amk-foot">
                        <button class="amk-btn amk-btn-primary amk-btn-block" id="am-apply">Применить и перезагрузить</button>
                        <button class="amk-btn amk-btn-danger" id="am-clear">Очистить кэш</button>
                    </div>
                </div>
            `;
            document.body.appendChild(panel);

            document.getElementById('set_yummy_domain').value = settings.yummyDomain; document.getElementById('set_animego_domain').value = settings.animegoDomain; document.getElementById('set_mangalib_domain').value = settings.mangalibDomain;

            // Закрытие модалки настроек: клик по фону-оверлею или по кнопке ✕.
            panel.addEventListener('click', (e) => { if (e.target === panel) panel.style.display = 'none'; });
            { const c = document.getElementById('am-set-close'); if (c) c.onclick = () => { panel.style.display = 'none'; }; }

            // Биндим сохранение настроек
            const booleanSettings =['set_interface', 'set_titles', 'set_chars', 'set_staff', 'set_player', 'set_ratings', 'set_franchise', 'set_themes', 'set_extlinks', 'set_link_rutracker', 'set_link_yummy', 'set_link_animego', 'set_link_mangalib', 'set_logger'];
            booleanSettings.forEach(id => { const el = document.getElementById(id); if (el) el.onchange = (e) => GM_setValue(id, e.target.checked); });

            const textSettings =['set_yummy_domain', 'set_animego_domain', 'set_mangalib_domain'];
            textSettings.forEach(id => { const el = document.getElementById(id); if (el) el.onchange = (e) => GM_setValue(id, e.target.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')); });

            const tokenInput = document.getElementById('set_al_token');
            if (tokenInput) { tokenInput.value = GM_getValue("AL_TOKEN", ""); tokenInput.onchange = (e) => GM_setValue("AL_TOKEN", e.target.value.trim()); }

            const genBtn = document.getElementById('set_al_gen');
            if (genBtn) {
                genBtn.onclick = () => {
                    const cid = document.getElementById('set_al_client').value.trim();
                    if (!cid) return alert("Введите Client ID (его можно создать в настройках AniList -> Developer)");
                    const authLink = document.createElement('a');
                    authLink.href = `https://anilist.co/api/v2/oauth/authorize?client_id=${cid}&response_type=token`;
                    authLink.target = "_blank"; authLink.style.cssText = "color:rgb(var(--color-blue)); text-decoration:none; font-weight:bold; display:block; padding:6px; border:1px dashed rgb(var(--color-blue)); border-radius:6px; margin-top:5px; transition: 0.2s;";
                    authLink.textContent = "👉 Клик: Перейти к авторизации";
                    const wrap = document.getElementById('set_al_link_wrap'); wrap.innerHTML = ''; wrap.appendChild(authLink);
                };
            }

            document.getElementById('am-apply').onclick = () => { location.reload(); };
            document.getElementById('am-clear').onclick = async () => { await clearCache(); alert('Кэш сброшен!'); location.reload(); };

            await openDB();

            // Старт модуля перевода и загрузка внешнего словаря
            if (settings.translateInterface || settings.translateTitles || settings.translateCharacters || settings.translateStaff) {
                Logger('API', 'Загрузка словаря интерфейса...');
                GM_xmlhttpRequest({
                    method: "GET", url: DICT_URL,
                    onload: (res) => {
                        if (res.status === 200) { try { dictionary = Object.assign(Object.create(null), JSON.parse(res.responseText)); Logger('INFO', 'Словарь загружен и распарсен'); } catch (e) { Logger('ERROR', 'Ошибка парсинга словаря', e); } }
                        initTranslator();
                    },
                    onerror: (e) => { Logger('ERROR', 'Сетевая ошибка при загрузке словаря', e); initTranslator(); }
                });
            } else { initTranslator(); }

            initRussianSearch();

            // Перехват SPA-навигации для инъекции виджетов
            const originalPushState = history.pushState;
            history.pushState = function() {
                originalPushState.apply(this, arguments);
                Logger('INFO', `[Router] Переход по ссылке на ${location.pathname}`);
                setTimeout(injectMediaExtensions, 50);
            };

            const originalReplaceState = history.replaceState;
            history.replaceState = function() {
                originalReplaceState.apply(this, arguments);
                Logger('INFO', `[Router] Обновление роута ${location.pathname}`);
                setTimeout(injectMediaExtensions, 50);
            };

            window.addEventListener('popstate', () => {
                Logger('INFO', `[Router] Кнопка Назад/Вперед ➜ ${location.pathname}`);
                setTimeout(injectMediaExtensions, 50);
            });

            // Страховочный пулинг для отлова смены URL
            let lastUrl = location.href;
            setInterval(() => {
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    const path = location.pathname.split('/');
                    if (!(path[1] === 'anime' || path[1] === 'manga')) {
                        document.querySelectorAll('.animori-ratings, .animori-franchise, .animori-themes, .animori-extlinks').forEach(el => el.remove());
                        const playBtn = document.getElementById('ru-player-btn'); if (playBtn) playBtn.style.display = 'none';
                        const iframe = document.getElementById('ru-p-iframe'); if (iframe) iframe.src = '';
                    }
                    injectMediaExtensions();
                }
            }, 800);

            injectMediaExtensions();

            // Запускаем очистку старого кэша через 15 секунд
            setTimeout(runGarbageCollector, 15000);
        }
    }

    // Запуск
    init();
})();