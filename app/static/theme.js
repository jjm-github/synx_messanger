/* ============================================================
   Цветовые схемы synx engine — порт системы тем из SYNX Place.

   Модель темы — четыре базовых цвета (как в SYNX Place):
     bg    — фон страницы
     field — фон текстовых полей
     text  — цвет текста
     sel   — цвет выделения и акцента

   Остальные цвета интерфейса выводятся из них смешиванием, поэтому
   тема остаётся читаемой в обе стороны: тёмный фон — светлый текст и
   наоборот. Базовые светлая/тёмная/пепельная в меню не показываются
   (они нужны как запасной рендер), в меню одна группа — Themes — с
   темами из SYNX Place и своей темой из редактора.

   Тема хранится в куке (в имени — id пользователя, чтобы темы были
   своими у каждого) и применяется ДО отрисовки страницы: вспышки цвета
   нет. Свои цвета (из редактора) лежат в отдельной куке.

   Редактор — всплывающая панель внутри страницы (не отдельное окно
   браузера): картинка-источник, подбор цветов из неё, образцы, сохранение
   и загрузка файла темы, живой предпросмотр.
   ============================================================ */
(function (global) {
    "use strict";

    /* ---------------- работа с цветом ---------------- */

    function hexToRgb(hex) {
        var h = String(hex || "").trim().replace(/^#/, "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return {r: 0, g: 0, b: 0};
        var n = parseInt(h, 16);
        return {r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255};
    }

    function rgbToHex(r, g, b) {
        function p(v) {
            v = Math.max(0, Math.min(255, Math.round(v)));
            return (v < 16 ? "0" : "") + v.toString(16);
        }
        return "#" + p(r) + p(g) + p(b);
    }

    /* смешивание: a*(1-t) + b*t */
    function mix(a, b, t) {
        var x = hexToRgb(a), y = hexToRgb(b);
        return rgbToHex(x.r * (1 - t) + y.r * t, x.g * (1 - t) + y.g * t, x.b * (1 - t) + y.b * t);
    }

    /* умножение каналов ( shade() в SYNX Place ) */
    function shade(c, f) {
        var x = hexToRgb(c);
        return rgbToHex(x.r * f, x.g * f, x.b * f);
    }

    function luma(c) {
        var x = hexToRgb(c);
        return 0.2126 * x.r + 0.7152 * x.g + 0.0722 * x.b;
    }

    function sat(c) {
        var x = hexToRgb(c);
        return Math.max(x.r, x.g, x.b) - Math.min(x.r, x.g, x.b);
    }

    function isLight(c) { return luma(c) > 170; }

    /* ---------------- темы ---------------- */

    var THEMES = [
        {id: "light", group: "synx engine", name: "Светлая",
         colors: {bg: "#f4f6f8", field: "#ffffff", text: "#1c2128", sel: "#14599e"}},
        {id: "dark", group: "synx engine", name: "Тёмная",
         colors: {bg: "#101318", field: "#171b21", text: "#e7eaef", sel: "#2f6fb8"}},
        {id: "ash", group: "synx engine", name: "Пепельная",
         colors: {bg: "#949497", field: "#a3a3a3", text: "#16181b", sel: "#364550"}},

        {id: "redmond", group: "Themes", name: "Redmond",
         colors: {bg: "#818181", field: "#ebebeb", text: "#000000", sel: "#060d70"}},
        {id: "place-ash", group: "Themes", name: "Ash",
         colors: {bg: "#43474a", field: "#4e5357", text: "#d3d7da", sel: "#8fa1b3"}},
        {id: "place-dark", group: "Themes", name: "Dark",
         colors: {bg: "#232323", field: "#2d2d2d", text: "#c8c8c8", sel: "#bf6e1d"}},
        {id: "cs16", group: "Themes", name: "cs 1.6",
         colors: {bg: "#5a6650", field: "#667259", text: "#e4ead6", sel: "#a08c28"}},

        {id: "custom", group: "своя", name: "Своя", colors: null}
    ];

    var KEYS = ["bg", "field", "text", "sel"];
    var ITEMS = [
        ["bg", "Цвет фона окна"],
        ["field", "Цвет текстовых полей"],
        ["text", "Цвет текста"],
        ["sel", "Цвет выделения"]
    ];

    var DEFAULT_COLORS = {bg: "#f4f6f8", field: "#ffffff", text: "#1c2128", sel: "#14599e"};

    function themeById(id) {
        for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
        return null;
    }

    /* ---------------- вывод переменных CSS ---------------- */

    /* Все цветовые переменные интерфейса — из четырёх базовых.
       Смешивание идёт к тексту (линии, зебра) и к полю (панели),
       поэтому тёмная и светлая темы получаются одинаково читаемыми. */
    function themeVars(c) {
        var bg = c.bg, field = c.field, text = c.text, sel = c.sel;
        var ink = text;
        var inkSoft = mix(ink, bg, 0.34);
        var panel = mix(bg, field, 0.16);
        var line = mix(bg, text, 0.16);
        var lineSoft = mix(bg, text, 0.09);
        var head = mix(bg, text, 0.07);
        var headInk = mix(ink, bg, 0.12);
        var zebra = mix(bg, text, 0.035);
        var hover = mix(bg, text, 0.07);
        var thHover = mix(bg, text, 0.10);
        var selected = mix(sel, bg, 0.80);
        var selectedHover = mix(sel, bg, 0.68);
        /* выделенные СТРОКИ таблиц — 70 % цвета выделения (было 20 %),
           заметнее прочих «выделенных» поверхностей (пузырь чата и т. п.) */
        var rowSelected = mix(sel, bg, 0.30);
        var rowSelectedHover = mix(sel, bg, 0.22);
        var accent = sel;
        var accentHover = mix(sel, ink, 0.18);
        /* приглушённый акцент: 20 % цвета выделения поверх своего
           базового цвета — рамка и текст остаются своими, но с лёгким
           синеватым оттенком (например, строка фильтра) */
        var accentSoftInk = mix(ink, sel, 0.20);
        var accentSoftLine = mix(line, sel, 0.20);
        var accentInk = isLight(sel) ? "#101010" : "#ffffff";
        /* кнопки: заливка — 30 % цвета выделения поверх панели (не 100 %),
           обводка — как у строки фильтра (accentSoftLine) */
        var btnFill = mix(sel, panel, 0.70);
        var btnFillHover = mix(sel, panel, 0.58);
        /* Ссылки и акценты на тёмном фоне должны быть светлее, на
           светлом — темнее: смешиваем с цветом текста тем сильнее,
           чем темнее фон. */
        var dark = luma(bg) < 120;
        var kLink = dark ? 0.55 : 0.12;
        var link = mix(sel, ink, kLink);
        var linkHover = mix(sel, ink, dark ? 0.72 : 0.30);
        var ok = mix("#1a7f37", text, 0.28);
        var warn = mix("#9a6700", text, 0.28);
        var danger = mix("#cf222e", text, 0.28);
        var fieldBg = field;
        var zoneBg = mix(bg, field, 0.45);
        var zoneOver = mix(bg, sel, 0.12);
        var tabBg = mix(bg, text, 0.05);
        var sbTrack = mix(bg, field, 0.55);
        var sbThumb = mix(bg, text, 0.30);
        var sbThumbHover = mix(bg, text, 0.45);
        var chipBg = mix(bg, field, 0.55);
        var chipInk = mix(ink, bg, 0.20);
        var chipLine = mix(bg, text, 0.22);
        var chipOnBg = mix(bg, ok, 0.16), chipOnInk = ok, chipOnLine = mix(bg, ok, 0.42);
        var chipOffBg = mix(bg, danger, 0.15), chipOffInk = danger, chipOffLine = mix(bg, danger, 0.42);
        var chipWarnBg = mix(bg, warn, 0.16), chipWarnInk = warn, chipWarnLine = mix(bg, warn, 0.42);
        var badgeBg = mix(bg, sel, 0.16), badgeInk = mix(sel, ink, 0.35), badgeLine = mix(bg, sel, 0.36);
        var badgeAdminBg = mix(bg, warn, 0.18), badgeAdminInk = mix(warn, ink, 0.30), badgeAdminLine = mix(bg, warn, 0.42);
        var badgeArtistBg = mix(bg, ok, 0.16), badgeArtistInk = mix(ok, ink, 0.25), badgeArtistLine = mix(bg, ok, 0.42);
        var errorBg = mix(bg, danger, 0.14), errorLine = mix(bg, danger, 0.42);
        var noticeBg = mix(bg, ok, 0.14), noticeLine = mix(bg, ok, 0.42);
        var flashBg = noticeBg, flashLine = noticeLine;
        var r = function (hex, a) {
            var x = hexToRgb(hex);
            return "rgba(" + x.r + "," + x.g + "," + x.b + "," + a + ")";
        };
        return {
            "--bg": bg,
            "--panel": panel,
            "--ink": ink,
            "--ink-soft": inkSoft,
            "--line": line,
            "--line-soft": lineSoft,
            "--zebra": zebra,
            "--hover": hover,
            "--th-hover": thHover,
            "--head": head,
            "--head-ink": headInk,
            "--selected": selected,
            "--selected-hover": selectedHover,
            "--row-selected": rowSelected,
            "--row-selected-hover": rowSelectedHover,
            "--link": link,
            "--link-hover": linkHover,
            "--accent": accent,
            "--accent-hover": accentHover,
            "--accent-soft-ink": accentSoftInk,
            "--accent-soft-line": accentSoftLine,
            "--accent-ink": accentInk,
            "--btn-fill": btnFill,
            "--btn-fill-hover": btnFillHover,
            "--btn-line": accentSoftLine,
            "--focus-ring": r(sel, 0.14),
            "--accent-soft": r(sel, 0.40),
            "--ok": ok,
            "--warn": warn,
            "--danger": danger,
            "--field-bg": fieldBg,
            "--zone-bg": zoneBg,
            "--zone-over": zoneOver,
            "--tab-bg": tabBg,
            "--sb-track": sbTrack,
            "--sb-thumb": sbThumb,
            "--sb-thumb-hover": sbThumbHover,
            "--chip-bg": chipBg, "--chip-ink": chipInk, "--chip-line": chipLine,
            "--chip-on-bg": chipOnBg, "--chip-on-ink": chipOnInk, "--chip-on-line": chipOnLine,
            "--chip-off-bg": chipOffBg, "--chip-off-ink": chipOffInk, "--chip-off-line": chipOffLine,
            "--chip-warn-bg": chipWarnBg, "--chip-warn-ink": chipWarnInk, "--chip-warn-line": chipWarnLine,
            "--badge-bg": badgeBg, "--badge-ink": badgeInk, "--badge-line": badgeLine,
            "--badge-admin-bg": badgeAdminBg, "--badge-admin-ink": badgeAdminInk, "--badge-admin-line": badgeAdminLine,
            "--badge-artist-bg": badgeArtistBg, "--badge-artist-ink": badgeArtistInk, "--badge-artist-line": badgeArtistLine,
            "--error-bg": errorBg, "--error-line": errorLine,
            "--notice-bg": noticeBg, "--notice-line": noticeLine,
            "--flash-bg": flashBg, "--flash-line": flashLine
        };
    }

    /* ---------------- применение и хранение ---------------- */

    function uid() {
        if (global.SYNX_UID) return global.SYNX_UID;
        var b = document.body;
        var v = b && b.getAttribute("data-user-id");
        return v || "anon";
    }

    function cookie(name, value, days) {
        var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
        var val = m ? decodeURIComponent(m[1]) : "";
        if (arguments.length < 2) return val;
        var d = days || 365;
        document.cookie = name + "=" + encodeURIComponent(value) +
            "; path=/; max-age=" + (d * 86400) + "; samesite=lax";
        return value;
    }

    function themeCookie() { return "synx_theme_" + uid(); }
    function customCookie() { return "synx_theme4_" + uid(); }

    function readCustom() {
        var raw = cookie(customCookie());
        if (!raw) {
            /* куки этого браузера нет — берём цвета из профиля на сервере */
            var saved = global.SYNX_UI_STATE || {};
            raw = saved.theme_colors || "";
        }
        if (!raw) return null;
        var parts = raw.split(",");
        if (parts.length !== 4) return null;
        var out = {};
        for (var i = 0; i < 4; i++) {
            var v = (parts[i] || "").trim();
            if (!/^#[0-9a-fA-F]{6}$/.test(v)) return null;
            out[KEYS[i]] = v;
        }
        return out;
    }

    function currentThemeId() {
        var id = cookie(themeCookie());
        if (id && themeById(id)) return id;
        /* в этом браузере куки нет, но тема сохранена в профиле на сервере
           (вход с другого браузера) — открываемся сразу в ней */
        var saved = global.SYNX_UI_STATE || {};
        if (saved.theme && themeById(saved.theme)) return saved.theme;
        return "place-dark";
    }

    function currentColors() {
        var id = currentThemeId();
        if (id === "custom") {
            var c = readCustom();
            if (c) return c;
        }
        var th = themeById(id);
        return th && th.colors ? copyColors(th.colors) : copyColors(DEFAULT_COLORS);
    }

    function copyColors(c) {
        var out = {};
        for (var i = 0; i < KEYS.length; i++) out[KEYS[i]] = c[KEYS[i]];
        return out;
    }

    var styleEl = null;

    function styleNode() {
        if (!styleEl) {
            styleEl = document.getElementById("synx-theme-vars");
            if (!styleEl) {
                styleEl = document.createElement("style");
                styleEl.id = "synx-theme-vars";
                document.head.appendChild(styleEl);
            }
        }
        return styleEl;
    }

    /* Применить цвета: к документу (:root) или к отдельному элементу
       (предпросмотр в редакторе — переменные ставим ему инлайном). */
    function applyColors(colors, target) {
        var vars = themeVars(colors);
        if (target && target !== document.documentElement) {
            for (var t in vars) target.style.setProperty(t, vars[t]);
            return;
        }
        var css = ":root{";
        for (var k in vars) css += k + ":" + vars[k] + ";";
        css += "}";
        styleNode().textContent = css;
        var root = document.documentElement;
        // старая система (data-theme/data-accent) больше не используется —
        // убираем, чтобы её правила не перебивали новые переменные
        root.removeAttribute("data-theme");
        root.removeAttribute("data-accent");
        var light = isLight(colors.bg);
        root.setAttribute("data-theme-mode", light ? "light" : "dark");
        root.style.colorScheme = light ? "light" : "dark";
    }

    /* Тема хранится и на сервере (users.ui_state): куки свои у каждого
       браузера, а при входе с нового login_action ставит их из профиля. */
    function saveThemeToServer(id, colors) {
        try {
            var body = { theme: id };
            if (colors) {
                body.theme_colors = KEYS.map(function (k) { return colors[k]; }).join(",");
            }
            var res = fetch("/api/me/ui-state", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                keepalive: true
            });
            if (res && res.catch) res.catch(function () {});
        } catch (e) { /* без сети тема останется в куках */ }
    }

    function saveTheme(id, colors) {
        cookie(themeCookie(), id);
        if (colors) cookie(customCookie(), KEYS.map(function (k) { return colors[k]; }).join(","));
        saveThemeToServer(id, colors);
    }

    /* Вызывается до отрисовки страницы: тема применяется сразу. */
    function applyStored() {
        var id = currentThemeId();
        var colors = currentColors();
        applyColors(colors);
        document.documentElement.setAttribute("data-theme-id", id);
        /* тема пришла из профиля, а куки в этом браузере не было —
           запомним её локально, чтобы следующие страницы брали куку */
        if (!cookie(themeCookie()) && id) {
            cookie(themeCookie(), id);
            if (id === "custom") {
                cookie(customCookie(), KEYS.map(function (k) { return colors[k]; }).join(","));
            }
        }
    }

    /* ---------------- меню выбора темы ---------------- */

    function buildMenu() {
        var btn = document.getElementById("theme-btn");
        if (!btn) return null;
        var menu = document.createElement("div");
        menu.className = "ctx-menu theme-menu";

        var current = currentThemeId();
        var groups = {};
        THEMES.forEach(function (t) {
            if (t.id === "custom" && !readCustom()) return;
            if (t.group === "synx engine") return;   // базовые — прочь из меню
            (groups[t.group] = groups[t.group] || []).push(t);
        });

        Object.keys(groups).forEach(function (group) {
            var head = document.createElement("div");
            head.className = "ctx-head";
            head.textContent = group;
            menu.appendChild(head);
            groups[group].forEach(function (t) {
                var it = document.createElement("div");
                it.className = "ctx-item";
                var colors = t.id === "custom" ? (readCustom() || DEFAULT_COLORS) : t.colors;
                it.innerHTML = '<span class="ctx-check">' + (current === t.id ? "✓" : "") + "</span>" +
                    '<span class="theme-swatch" style="background:' + colors.bg + '"></span>' +
                    '<span class="theme-swatch" style="background:' + colors.sel + '"></span>' +
                    t.name;
                it.addEventListener("click", function () {
                    selectTheme(t.id);
                    menu.remove();
                });
                menu.appendChild(it);
            });
        });

        var sep = document.createElement("div");
        sep.className = "ctx-sep";
        menu.appendChild(sep);

        var ed = document.createElement("div");
        ed.className = "ctx-item";
        ed.innerHTML = '<span class="ctx-check"></span>Редактор тем…';
        ed.addEventListener("click", function () {
            menu.remove();
            openEditor();
        });
        menu.appendChild(ed);

        return {btn: btn, menu: menu};
    }

    function selectTheme(id) {
        var colors = id === "custom" ? (readCustom() || DEFAULT_COLORS)
            : (themeById(id) || themeById("light")).colors;
        saveTheme(id, id === "custom" ? colors : null);
        applyColors(colors);
        document.documentElement.setAttribute("data-theme-id", id);
    }

    /* ---------------- редактор тем ---------------- */

    var editor = null;

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /* Окно редактора перетаскивается за заголовок: при захвате окно
       переводится из центрированного в абсолютное положение, дальше
       двигается вместе с курсором. Заголовок всегда остаётся на экране. */
    function makeDraggable(win, handle) {
        var drag = null;

        function onMove(e) {
            if (!drag) return;
            var w = win.offsetWidth;
            var x = e.clientX - drag.dx;
            var y = e.clientY - drag.dy;
            // окно не уводим за края: заголовок должен остаться видимым
            x = Math.min(Math.max(x, 24 - w), window.innerWidth - 90);
            y = Math.min(Math.max(y, 0), Math.max(0, window.innerHeight - 44));
            win.style.left = Math.round(x) + "px";
            win.style.top = Math.round(y) + "px";
            // высота не должна вылезать за нижний край экрана
            win.style.maxHeight = Math.max(120, window.innerHeight - y - 8) + "px";
        }

        function onUp() {
            drag = null;
            win.classList.remove("dragging");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        }

        handle.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return;
            if (e.target.closest && e.target.closest("button, a, input, select, textarea")) return;
            var r = win.getBoundingClientRect();
            win.style.position = "absolute";
            win.style.margin = "0";
            win.style.left = Math.round(r.left) + "px";
            win.style.top = Math.round(r.top) + "px";
            drag = {dx: e.clientX - r.left, dy: e.clientY - r.top};
            win.classList.add("dragging");
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
            e.preventDefault();
        });
    }

    /* вернуть окно в исходное (центрированное) положение */
    function resetWindowPos(win) {
        win.style.position = "";
        win.style.margin = "";
        win.style.left = "";
        win.style.top = "";
        win.style.maxHeight = "";
        win.classList.remove("dragging");
    }

    function buildEditor() {
        var root = el("div", "theme-editor");
        root.hidden = true;

        /* фон не затемняет страницу: под окном редактора всё видно в
           реальных цветах. Клик по фону закрывает окно, только если оно
           не закреплено (Pin). */
        var back = el("div", "theme-editor-backdrop");
        back.addEventListener("click", function () {
            if (!editorPinned) closeEditor();
        });
        root.appendChild(back);

        var win = el("div", "theme-editor-window");
        root.appendChild(win);

        var head = el("div", "theme-editor-head");
        head.appendChild(el("strong", null, "Редактор тем"));
        var pin = el("button", "te-pin", "Pin");
        var editorPinned = false;
        try {
            editorPinned = localStorage.getItem("synx.themeeditor.pinned") === "1";
        } catch (e) {}
        pin.classList.toggle("on", editorPinned);
        pin.title = editorPinned
            ? "Окно закреплено: не закрывать при клике вне его"
            : "Закрепить окно: не закрывать при клике вне его";
        pin.addEventListener("click", function (e) {
            e.stopPropagation();
            editorPinned = !editorPinned;
            pin.classList.toggle("on", editorPinned);
            pin.title = editorPinned
                ? "Окно закреплено: не закрывать при клике вне его"
                : "Закрепить окно: не закрывать при клике вне его";
            try {
                localStorage.setItem("synx.themeeditor.pinned",
                    editorPinned ? "1" : "0");
            } catch (err) {}
        });
        head.appendChild(pin);
        win.appendChild(head);
        makeDraggable(win, head);
        /* таскается и за свободное место (заголовок таскаем как раньше) */
        if (global.SynxFloatFrame) {
            global.SynxFloatFrame(win, {exclude: ".theme-editor-head"});
        }

        var body = el("div", "theme-editor-body");
        win.appendChild(body);

        /* --- левая колонка: источник и образцы --- */
        var left = el("div", "te-left");
        body.appendChild(left);

        left.appendChild(el("h4", null, "1. Картинка-источник"));
        var file = document.createElement("input");
        file.type = "file";
        file.accept = "image/*";
        left.appendChild(file);

        left.appendChild(el("h4", null, "2. Образцы (≤ 300 px)"));
        var imgWrap = el("div", "te-preview");
        var img = document.createElement("img");
        img.alt = "";
        img.hidden = true;
        imgWrap.appendChild(img);
        var hint = el("div", "te-hint", "Клик по картинке — взять цвет под курсором");
        imgWrap.appendChild(hint);
        left.appendChild(imgWrap);

        var sampleBtn = el("button", "te-btn", "3. Sample!");
        sampleBtn.disabled = true;
        left.appendChild(sampleBtn);

        var autoLabel = el("label", "te-check");
        var auto = document.createElement("input");
        auto.type = "checkbox";
        auto.checked = true;
        autoLabel.appendChild(auto);
        autoLabel.appendChild(document.createTextNode(" Умное распределение (фон светлее, текст темнее)"));
        left.appendChild(autoLabel);

        left.appendChild(el("h4", null, "Цветовые образцы:"));
        var swatches = el("div", "te-swatches");
        left.appendChild(swatches);

        var actions = el("div", "te-actions");
        var saveBtn = el("button", "te-btn", "Сохранить тему…");
        var loadBtn = el("button", "te-btn", "Загрузить тему…");
        var applyBtn = el("button", "te-btn primary", "Применить");
        var resetBtn = el("button", "te-btn", "Сбросить");
        actions.appendChild(saveBtn);
        actions.appendChild(loadBtn);
        actions.appendChild(applyBtn);
        actions.appendChild(resetBtn);
        left.appendChild(actions);

        var loadFile = document.createElement("input");
        loadFile.type = "file";
        loadFile.accept = ".json,application/json";
        loadFile.hidden = true;
        left.appendChild(loadFile);

        /* --- правая колонка: живой предпросмотр --- */
        var prev = el("div", "te-preview-panel");
        body.appendChild(prev);
        prev.appendChild(el("div", "te-pv-title", "synx engine — предпросмотр"));
        var pv = el("div", "te-pv");
        prev.appendChild(pv);
        pv.appendChild(el("div", "te-pv-head", "Проект · Настройки"));
        var pvTable = el("table", "te-pv-table");
        pvTable.innerHTML = "<tr><th>сущность</th><th>статус</th></tr>" +
            "<tr><td>016_0060</td><td><span class='te-pv-chip'>todo</span></td></tr>" +
            "<tr><td>hero_ship</td><td><span class='te-pv-chip on'>wip</span></td></tr>";
        pv.appendChild(pvTable);
        var pvRow = el("div", "te-pv-row");
        pvRow.appendChild(el("span", "te-pv-chip", "Camera"));
        pvRow.appendChild(el("span", "te-pv-chip accent", "Rendering"));
        pvRow.appendChild(el("button", "te-pv-btn", "Сохранить"));
        pv.appendChild(pvRow);
        var pvField = el("input", "te-pv-field");
        pvField.placeholder = "поле ввода";
        pv.appendChild(pvField);

        /* --- состояние редактора --- */
        var state = {
            colors: copyColors(currentColors()),
            image: null,          // ImageData для подбора цвета
            canvas: null,
            swatches: {},
            hexes: {},
            picks: {}
        };

        function paintSwatches() {
            ITEMS.forEach(function (it) {
                var key = it[0], label = it[1];
                var row = state.swatches[key];
                if (!row) return;
                var col = state.colors[key];
                row.swatch.style.background = col;
                row.hex.textContent = col;
                row.input.value = col;
            });
        }

        ITEMS.forEach(function (it) {
            var key = it[0], label = it[1];
            var row = el("div", "te-swatch-row");
            row.appendChild(el("span", "te-swatch-label", label));
            var sw = el("span", "te-swatch");
            row.appendChild(sw);
            var hex = el("span", "te-hex", "");
            row.appendChild(hex);
            var input = document.createElement("input");
            input.type = "color";
            input.className = "te-color-input";
            input.addEventListener("input", function () {
                state.colors[key] = input.value;
                paintSwatches();
                applyColors(state.colors, prev);
            });
            row.appendChild(input);
            swatches.appendChild(row);
            state.swatches[key] = {swatch: sw, hex: hex, input: input};
        });

        function refresh() {
            paintSwatches();
            applyColors(state.colors, prev);
        }

        /* картинка-источник */
        file.addEventListener("change", function () {
            var f = file.files && file.files[0];
            if (!f) return;
            var reader = new FileReader();
            reader.onload = function () {
                var im = new Image();
                im.onload = function () {
                    var max = 300;
                    var w = im.width, h = im.height;
                    if (w > max || h > max) {
                        var k = Math.min(max / w, max / h);
                        w = Math.round(w * k); h = Math.round(h * k);
                    }
                    img.src = im.src;
                    img.width = w; img.height = h;
                    img.hidden = false;
                    hint.hidden = true;
                    state.image = im;
                    sampleBtn.disabled = false;
                };
                im.src = reader.result;
            };
            reader.readAsDataURL(f);
        });

        /* клик по картинке — взять цвет под курсором */
        img.addEventListener("click", function (e) {
            if (!state.image) return;
            var r = img.getBoundingClientRect();
            var x = Math.floor((e.clientX - r.left) * state.image.width / r.width);
            var y = Math.floor((e.clientY - r.top) * state.image.height / r.height);
            x = Math.max(0, Math.min(state.image.width - 1, x));
            y = Math.max(0, Math.min(state.image.height - 1, y));
            var d = state.image.getContext("2d").getImageData(x, y, 1, 1).data;
            var hex = rgbToHex(d[0], d[1], d[2]);
            var key = state.pickKey;
            if (!key) {
                /* без выбранного образца — кладём в тот, что сейчас пустой */
                for (var i = 0; i < KEYS.length; i++) {
                    if (!state.picked[KEYS[i]]) { key = KEYS[i]; break; }
                }
            }
            if (!key) key = "bg";
            state.colors[key] = hex;
            state.picked[key] = true;
            refresh();
        });
        state.picked = {};

        /* выбор, в какой образец попадёт цвет с картинки */
        Object.keys(state.swatches).forEach(function (key) {
            state.swatches[key].swatch.addEventListener("click", function () {
                state.pickKey = key;
                state.picked[key] = true;
                Object.keys(state.swatches).forEach(function (k) {
                    state.swatches[k].swatch.classList.toggle("pick", k === key);
                });
            });
        });

        /* 3. Sample! — четыре цвета с картинки (как в SYNX Place) */
        sampleBtn.addEventListener("click", function () {
            if (!state.image) return;
            var cv = document.createElement("canvas");
            cv.width = state.image.width;
            cv.height = state.image.height;
            var cx = cv.getContext("2d");
            cx.drawImage(state.image, 0, 0);
            var w = cv.width, h = cv.height;
            var centers = [], attempts = 0;
            while (centers.length < 4 && attempts < 200) {
                var px = 1 + Math.floor(Math.random() * Math.max(1, w - 2));
                var py = 1 + Math.floor(Math.random() * Math.max(1, h - 2));
                var far = true;
                for (var i = 0; i < centers.length; i++) {
                    if (Math.max(Math.abs(px - centers[i][0]), Math.abs(py - centers[i][1])) < 3) {
                        far = false; break;
                    }
                }
                if (far) centers.push([px, py]);
                attempts++;
            }
            while (centers.length < 4) {
                centers.push([Math.floor(Math.random() * w), Math.floor(Math.random() * h)]);
            }
            var sampled = centers.map(function (c) {
                var r = 0, g = 0, b = 0, n = 0;
                for (var dy = -1; dy <= 1; dy++) {
                    for (var dx = -1; dx <= 1; dx++) {
                        var xx = Math.max(0, Math.min(w - 1, c[0] + dx));
                        var yy = Math.max(0, Math.min(h - 1, c[1] + dy));
                        var d = cx.getImageData(xx, yy, 1, 1).data;
                        if (d[3] < 16) continue;
                        r += d[0]; g += d[1]; b += d[2]; n++;
                    }
                }
                if (!n) {
                    var d2 = cx.getImageData(c[0], c[1], 1, 1).data;
                    r = d2[0]; g = d2[1]; b = d2[2]; n = 1;
                }
                return rgbToHex(r / n, g / n, b / n);
            });
            assignSampled(sampled, auto.checked);
            refresh();
        });

        /* Распределение образцов по ролям.
           В SYNX Place «умное» распределение всегда считало фон самым
           светлым, а текст самым тёмным — это годится только для светлых
           картинок. Здесь смотрим на саму картинку: тёмная — значит фон
           берём тёмный, а текст светлый. */
        function assignSampled(cols, smart) {
            if (!smart) {
                KEYS.forEach(function (k, i) { state.colors[k] = cols[i]; });
                return;
            }
            var ordered = cols.slice().sort(function (a, b) { return luma(a) - luma(b); });
            var avgLuma = cols.reduce(function (s, c) { return s + luma(c); }, 0) / cols.length;
            var dark = avgLuma < 120;
            var bg, text, mids;
            if (dark) {
                text = ordered[ordered.length - 1];
                bg = ordered[0];
                mids = ordered.slice(1, -1);
            } else {
                text = ordered[0];
                bg = ordered[ordered.length - 1];
                mids = ordered.slice(1, -1);
            }
            var sel, field;
            if (mids.length >= 2) {
                if (sat(mids[0]) >= sat(mids[1])) { sel = mids[0]; field = mids[1]; }
                else { sel = mids[1]; field = mids[0]; }
            } else if (mids.length === 1) {
                field = mids[0]; sel = mids[0];
            } else {
                field = bg; sel = text;
            }
            state.colors.bg = bg;
            state.colors.field = field;
            state.colors.text = text;
            state.colors.sel = sel;
        }

        /* сохранение и загрузка файла темы (как в SYNX Place) */
        saveBtn.addEventListener("click", function () {
            var data = {bg: state.colors.bg, field: state.colors.field,
                        text: state.colors.text, sel: state.colors.sel};
            var blob = new Blob([JSON.stringify(data, null, 2) + "\n"],
                                {type: "application/json"});
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "synx.theme.json";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        });

        loadBtn.addEventListener("click", function () { loadFile.click(); });
        loadFile.addEventListener("change", function () {
            var f = loadFile.files && loadFile.files[0];
            if (!f) return;
            var reader = new FileReader();
            reader.onload = function () {
                try {
                    var data = JSON.parse(reader.result);
                    KEYS.forEach(function (k) {
                        var v = data && data[k];
                        if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim())) {
                            state.colors[k] = v.trim();
                        }
                    });
                    refresh();
                } catch (e) {
                    window.alert("Не удалось прочитать файл темы: " + e.message);
                }
                loadFile.value = "";
            };
            reader.readAsText(f);
        });

        applyBtn.addEventListener("click", function () {
            saveTheme("custom", state.colors);
            applyColors(state.colors);
            document.documentElement.setAttribute("data-theme-id", "custom");
            closeEditor();
        });

        resetBtn.addEventListener("click", function () {
            state.colors = copyColors(DEFAULT_COLORS);
            state.picked = {};
            refresh();
        });

        refresh();
        document.body.appendChild(root);

        return {
            root: root,
            isPinned: function () { return editorPinned; },
            open: function () {
                state.colors = copyColors(currentColors());
                state.picked = {};
                refresh();
                resetWindowPos(win);
                root.hidden = false;
                document.body.classList.add("theme-editor-open");
            },
            close: function () {
                root.hidden = true;
                document.body.classList.remove("theme-editor-open");
            }
        };
    }

    function openEditor() {
        if (!editor) editor = buildEditor();
        editor.open();
    }

    function closeEditor() {
        if (editor) editor.close();
    }

    /* ---------------- запуск ---------------- */

    function init() {
        var built = buildMenu();
        if (!built) return;
        var btn = built.btn, menu = built.menu;

        btn.addEventListener("click", function (e) {
            e.stopPropagation();
            var old = document.querySelector(".theme-menu");
            if (old) { old.remove(); return; }
            document.body.appendChild(menu);
            menu.style.left = "";
            menu.style.top = "";
            var r = btn.getBoundingClientRect();
            var mw = menu.offsetWidth || 220;
            var left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
            menu.style.left = left + "px";
            menu.style.top = (r.bottom + 6) + "px";
        });
        document.addEventListener("click", function (e) {
            if (!menu.contains(e.target) && e.target !== btn) menu.remove();
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                menu.remove();
                // закреплённый редактор тем не закрываем
                if (!editor || !editor.isPinned || !editor.isPinned()) closeEditor();
            }
        });
    }

    global.SynxTheme = {
        THEMES: THEMES,
        ITEMS: ITEMS,
        applyStored: applyStored,
        applyColors: applyColors,
        currentColors: currentColors,
        currentThemeId: currentThemeId,
        selectTheme: selectTheme,
        openEditor: openEditor,
        closeEditor: closeEditor,
        themeVars: themeVars,
        mix: mix, shade: shade, luma: luma, sat: sat
    };

    /* Тему применяем сразу — до того, как браузер нарисует страницу
       (скрипт подключён в head до таблицы стилей), поэтому вспышки
       цвета нет. Меню и редактор собираем, когда появится DOM. */
    applyStored();
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})(window);
