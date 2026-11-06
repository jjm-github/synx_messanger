/* Мессенджер: список людей слева, личный чат справа.
   Это выделенная версия правой панели «Люди» из synx engine в том
   виде, в каком она выглядит откреплённой в отдельном окне. */
(function () {
    "use strict";

    var panel = document.getElementById("us-panel");
    if (!panel) return;
    var list = document.getElementById("us-list");
    var count = document.getElementById("us-count");
    var refresh = document.getElementById("us-refresh");
    var statusSelect = document.getElementById("us-status");
    var audioSettingsBtn = document.getElementById("us-audio-settings");
    var hsplit = document.getElementById("us-hsplit");
    var chatWrap = document.getElementById("us-chat-wrap");
    var chatRoot = document.getElementById("us-chat");
    var chatSub = chatRoot && chatRoot.querySelector(".chat-sub");

    var LS = "synx.messenger";
    var NOTIFY_MEMORY_KEY = "synx.messenger.notify.v1";
    var state = { selected: null, chatW: null };
    try {
        var saved = JSON.parse(localStorage.getItem(LS) || "{}");
        if (saved && saved.selected && saved.selected.id) {
            state.selected = saved.selected;
        }
        if (saved && typeof saved.chatW === "number" && saved.chatW > 180) {
            state.chatW = saved.chatW;
        }
    } catch (e) { /* приватный режим */ }

    var known = null;
    var order = [];
    var currentUserId = window.SYNX_UID != null
        ? String(window.SYNX_UID) : "";
    var STATUS_LABELS = {
        online: "в сети",
        away: "отошёл",
        dnd: "не беспокоить",
        offline: "не в сети"
    };

    function statusLabel(status) {
        return STATUS_LABELS[status] || STATUS_LABELS.online;
    }

    function avatarInitials(u) {
        var name = String((u && (u.full_name || u.short_name)) || "").trim();
        if (!name) return "?";
        var parts = name.split(/\s+/).filter(Boolean);
        var s = (parts[0] || "").charAt(0);
        if (parts[1]) s += parts[1].charAt(0);
        return s.toUpperCase();
    }

    function setMyStatusValue(value) {
        if (!statusSelect) return;
        var v = STATUS_LABELS[value] ? value : "online";
        statusSelect.value = v;
    }
    setMyStatusValue((window.SYNX_UI_STATE &&
        window.SYNX_UI_STATE.presence_status) || "online");

    var currentAudioLinks = [];
    var lastAudioLevels = {};
    var linkFrame = 0;
    var loading = false;
    var unreadTotal = 0;
    var lastPresenceSignature = null;
    var userChat = null;
    var selectedUserId = state.selected ? String(state.selected.id) : "";
    var selectedUserIds = selectedUserId ? [selectedUserId] : [];

    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    function persist() {
        try {
            localStorage.setItem(LS, JSON.stringify(state));
        } catch (e) {}
    }

    function rowKey(u) {
        return String(u.user_id || u.short_name || "");
    }

    function updateTitle() {
        document.title = (unreadTotal > 0 ? "(" + unreadTotal + ") " : "") +
            "synx messenger";
    }

    /* ---------- линии к значку микрофона в аудио-комнате ---------- */
    var SVG_NS = "http://www.w3.org/2000/svg";

    function drawLinks() {
        if (!list) return;
        var old = list.querySelector(".us-links");
        if (old) old.parentNode.removeChild(old);
        var links = currentAudioLinks || [];
        if (!links.length) return;

        var rows = {};
        Array.prototype.forEach.call(list.querySelectorAll(".us-row"),
            function (row) {
                if (row.dataset.userId) rows[row.dataset.userId] = row;
            });
        var lr = list.getBoundingClientRect();
        var scrollTop = list.scrollTop || 0;
        var w = Math.max(1, list.clientWidth);
        var h = Math.max(list.scrollHeight, list.clientHeight, 1);
        var svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "us-links");
        svg.setAttribute("width", String(w));
        svg.setAttribute("height", String(h));
        svg.setAttribute("viewBox", "0 0 " + w + " " + h);
        svg.setAttribute("aria-hidden", "true");

        var defs = document.createElementNS(SVG_NS, "defs");
        var marker = document.createElementNS(SVG_NS, "marker");
        marker.setAttribute("id", "us-link-arrow-audio");
        marker.setAttribute("markerWidth", "5");
        marker.setAttribute("markerHeight", "5");
        marker.setAttribute("refX", "5");
        marker.setAttribute("refY", "2.5");
        marker.setAttribute("orient", "auto");
        var markerPath = document.createElementNS(SVG_NS, "path");
        markerPath.setAttribute("d", "M0,0 L5,2.5 L0,5 Z");
        marker.appendChild(markerPath);
        defs.appendChild(marker);
        svg.appendChild(defs);

        links.forEach(function (link) {
            var viewer = rows[String(link.viewer_id)];
            var broadcaster = rows[String(link.broadcaster_id)];
            if (!viewer || !broadcaster) return;
            if (viewer.dataset.online !== "1" ||
                    broadcaster.dataset.online !== "1") return;
            var mic = broadcaster.querySelector(".us-mic");
            if (!mic) return;
            var vr = viewer.getBoundingClientRect();
            var mr = mic.getBoundingClientRect();
            var x1 = vr.left - lr.left + vr.width / 2;
            var y1 = vr.top - lr.top + scrollTop + vr.height / 2;
            var mcx = mr.left - lr.left + mr.width / 2;
            var mcy = mr.top - lr.top + scrollTop + mr.height / 2;
            var rx = Math.max(1, mr.width / 2);
            var ry = Math.max(1, mr.height / 2);
            var dx = mcx - x1, dy = mcy - y1;
            var edge = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
            var x2 = edge > 0.0001 ? mcx - dx / edge : mcx;
            var y2 = edge > 0.0001 ? mcy - dy / edge : mcy;
            var dot = document.createElementNS(SVG_NS, "circle");
            dot.setAttribute("class", "us-link-dot us-audio-link-dot");
            dot.setAttribute("cx", String(x1));
            dot.setAttribute("cy", String(y1));
            dot.setAttribute("r", "1.5");
            svg.appendChild(dot);
            var line = document.createElementNS(SVG_NS, "line");
            line.setAttribute("class", "us-link us-audio-link");
            line.setAttribute("x1", String(x1));
            line.setAttribute("y1", String(y1));
            line.setAttribute("x2", String(x2));
            line.setAttribute("y2", String(y2));
            line.setAttribute("marker-end", "url(#us-link-arrow-audio)");
            svg.appendChild(line);
        });
        if (svg.querySelector("line")) list.appendChild(svg);
    }

    function scheduleLinks() {
        if (linkFrame) return;
        linkFrame = window.requestAnimationFrame(function () {
            linkFrame = 0;
            drawLinks();
        });
    }

    function setRowAudioLevel(row, level) {
        if (!row) return;
        var bars = row.querySelectorAll(".us-audio-level i");
        if (!bars.length) return;
        var n = Math.max(0, Math.min(4, Math.round((Number(level) || 0) / 25)));
        Array.prototype.forEach.call(bars, function (bar, i) {
            bar.classList.toggle("on", i < n);
            bar.style.height = (4 + i * 2) + "px";
        });
    }

    function stableValue(value) {
        if (Array.isArray(value)) return value.map(stableValue);
        if (value && typeof value === "object") {
            var out = {};
            Object.keys(value).sort().forEach(function (key) {
                out[key] = stableValue(value[key]);
            });
            return out;
        }
        return value;
    }

    function presenceSignature(data, unreadData) {
        var items = ((data && data.connections) || []).map(function (u) {
            var copy = {};
            Object.keys(u).forEach(function (key) {
                if (key !== "last_seen") copy[key] = u[key];
            });
            return copy;
        });
        return JSON.stringify(stableValue([
            data && data.online,
            data && data.connections_total,
            items,
            (data && data.audio_links) || [],
            unreadData || {},
            selectedUserId || ""
        ]));
    }

    function render(data, unreadData) {
        var signature = presenceSignature(data, unreadData);
        if (signature === lastPresenceSignature) return;
        lastPresenceSignature = signature;

        var items = (data && data.connections) || [];
        var unreadMap = (unreadData && unreadData.unread) || {};
        var unreadSenders = (unreadData && unreadData.senders) || [];
        currentAudioLinks = (data && data.audio_links) || [];
        var ids = items.map(function (u) { return String(u.user_id); });

        /* Новые подключения добавляются в конец, существующие строки
           не перетасовываются на каждом heartbeat. */
        var byKey = {};
        items.forEach(function (u) { byKey[rowKey(u)] = u; });
        var nextOrder = order.filter(function (key) { return !!byKey[key]; });
        items.forEach(function (u) {
            var key = rowKey(u);
            if (nextOrder.indexOf(key) === -1) nextOrder.push(key);
        });
        order = nextOrder;
        items = order.map(function (key) { return byKey[key]; });

        /* Пользователь уже вышел, но его сообщения должны быть видны:
           показываем его отдельной offline-строкой. */
        var onlineIds = {};
        items.forEach(function (u) {
            onlineIds[String(u.user_id)] = true;
        });
        unreadSenders.forEach(function (u) {
            var uid = String(u.user_id);
            if (!uid || onlineIds[uid]) return;
            onlineIds[uid] = true;
            items.push({
                user_id: uid,
                short_name: u.short_name,
                full_name: u.full_name,
                photo_id: u.photo_id || null,
                photo_url: u.photo_url || null,
                photo_thumb_url: u.photo_thumb_url || null,
                presence_status: "offline",
                connections: 0,
                offline: true
            });
        });
        if (selectedUserId && !onlineIds[selectedUserId]) {
            var sel = state.selected || {};
            items.push({
                user_id: selectedUserId,
                short_name: sel.short || sel.short_name || selectedUserId,
                full_name: sel.full_name || sel.short_name || selectedUserId,
                connections: 0,
                offline: true
            });
        }

        /* Своя строка — первая; ниже онлайн, ещё ниже офлайн. */
        items.sort(function (a, b) {
            var as = String(a.user_id) === currentUserId ? 0 : 1;
            var bs = String(b.user_id) === currentUserId ? 0 : 1;
            if (as !== bs) return as - bs;
            var ao = (a.online !== false && !a.offline) ? 0 : 1;
            var bo = (b.online !== false && !b.offline) ? 0 : 1;
            return ao - bo;
        });
        order = items.map(rowKey);

        var n = data && typeof data.online === "number"
            ? data.online : items.length;
        if (count) {
            count.textContent = String(n);
            count.hidden = n <= 0;
        }

        unreadTotal = 0;
        Object.keys(unreadMap).forEach(function (uid) {
            unreadTotal += Number(unreadMap[uid]) || 0;
        });
        updateTitle();

        list.textContent = "";
        if (!items.length) {
            list.appendChild(el("div", "us-empty",
                                "Нет доступных пользователей."));
            return;
        }

        items.forEach(function (u) {
            var uid = String(u.user_id || "");
            var isSelf = uid === currentUserId;
            var unread = Number(unreadMap[uid]) || 0;
            var online = u.online !== false && !u.offline;
            var status = online ? (u.presence_status || "online") : "offline";
            if (!STATUS_LABELS[status]) status = "online";
            if (status === "offline") online = false;
            var row = el("div", "us-row" +
                (isSelf ? " self" : "") +
                (unread ? " has-unread" : "") +
                (online ? "" : " offline") +
                (selectedUserIds.indexOf(uid) !== -1 ? " selected" : ""));

            var avatar = el("span", "us-avatar status-" + status);
            var avatarSrc = u.photo_thumb_url || u.photo_url;
            if (avatarSrc) {
                var avatarImg = document.createElement("img");
                avatarImg.src = avatarSrc;
                avatarImg.alt = "";
                avatarImg.loading = "lazy";
                avatarImg.addEventListener("error", function () {
                    if (!avatarImg.dataset.fallback && u.photo_url &&
                            avatarImg.src !== u.photo_url) {
                        avatarImg.dataset.fallback = "1";
                        avatarImg.src = u.photo_url;
                        return;
                    }
                    avatar.textContent = avatarInitials(u);
                    avatar.classList.add("no-photo");
                    avatarImg.remove();
                });
                avatar.appendChild(avatarImg);
            } else {
                avatar.textContent = avatarInitials(u);
                avatar.classList.add("no-photo");
            }
            row.appendChild(avatar);

            var line1 = el("div", "us-line1");
            line1.appendChild(el("span", "us-user",
                                 u.short_name || u.user_id || "—"));
            var levelEl = el("span", "us-audio-level");
            for (var li = 0; li < 4; li++) levelEl.appendChild(el("i"));
            line1.appendChild(levelEl);
            if (isSelf) {
                line1.appendChild(el("span", "us-self-badge", "это вы"));
            }
            if (unread) {
                line1.appendChild(el("span", "us-unread-badge",
                                     String(unread)));
            }
            var connCount = Number(u.connections) || 0;
            if (online && connCount) {
                line1.appendChild(el("span", "us-multi" +
                    (connCount === 1 ? " one" : ""), "×" + connCount));
            }
            var audioRoomId = u.audio_room_id || "";
            var audioConnected = isSelf ||
                !!(window.SynxAudioChat &&
                   window.SynxAudioChat.isConnected(audioRoomId));
            if (u.mic) {
                var micFrame = el("span", "us-mic-frame" +
                    (audioConnected ? " connected" : ""));
                micFrame.appendChild(el("span", "us-mic", "🎤"));
                line1.appendChild(micFrame);
            }
            row.appendChild(line1);

            var line2 = el("div", "us-line2");
            line2.appendChild(el("span", "us-online-status",
                                 statusLabel(status)));
            row.appendChild(line2);
            row.appendChild(el("div", "us-where us-last-message",
                               u.last_message || ""));

            row.dataset.userId = uid;
            row.dataset.shortName = u.short_name || "";
            row.dataset.fullName = u.full_name || u.short_name || "";
            row.dataset.mic = u.mic ? "1" : "0";
            row.dataset.audioRoomId = audioRoomId;
            row.dataset.online = online ? "1" : "0";
            var titleParts = [u.short_name, u.full_name, statusLabel(status)];
            if (isSelf) titleParts.push("это вы");
            else if (u.mic) {
                titleParts.push("двойной клик по строке — " +
                    (audioConnected ? "выйти из аудио-комнаты"
                                    : "войти в аудио-комнату"));
            }
            row.title = titleParts.filter(Boolean).join(" · ");
            setRowAudioLevel(row, Number(lastAudioLevels[uid]) || 0);
            list.appendChild(row);
        });

        if (userChat) {
            userChat.setUsers(items);
            if (selectedUserId) {
                var cur = null;
                for (var i = 0; i < items.length; i++) {
                    if (String(items[i].user_id) === selectedUserId) {
                        cur = items[i];
                        break;
                    }
                }
                if (cur && selectedUserIds.length === 1) {
                    var st = cur.online !== false && !cur.offline
                        ? (cur.presence_status || "online") : "offline";
                    userChat.setTarget({
                        kind: "dm",
                        id: selectedUserId,
                        sub: (cur.full_name || cur.short_name || "") +
                            " · " + statusLabel(st)
                    });
                    if (chatSub) {
                        chatSub.textContent = (cur.full_name ||
                            cur.short_name || "") + " · " + statusLabel(st);
                    }
                }
            }
        }
        scheduleLinks();
    }

    function load() {
        if (loading) return;
        loading = true;
        var presence = fetch("/api/presence/users", {
            credentials: "same-origin",
            cache: "no-store"
        }).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        });
        var unread = fetch("/api/direct/unread", {
            credentials: "same-origin",
            cache: "no-store"
        }).then(function (r) {
            return r.ok ? r.json() : { unread: {}, senders: [] };
        }).catch(function () { return { unread: {}, senders: [] }; });
        Promise.all([presence, unread]).then(function (parts) {
            render(parts[0], parts[1]);
        }).catch(function () {
            if (lastPresenceSignature !== null) return;
            list.textContent = "";
            list.appendChild(el("div", "us-empty",
                                "Не удалось получить список."));
        }).finally(function () {
            loading = false;
        });
    }

    /* ---------- статус пользователя ---------- */
    if (statusSelect) {
        setMyStatusValue((window.SYNX_UI_STATE &&
            window.SYNX_UI_STATE.presence_status) || statusSelect.value);
        statusSelect.addEventListener("change", function () {
            var value = statusSelect.value;
            var prev = (window.SYNX_UI_STATE &&
                window.SYNX_UI_STATE.presence_status) || "online";
            statusSelect.disabled = true;
            fetch("/api/me/ui-state", {
                method: "PUT",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ presence_status: value })
            }).then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                window.SYNX_UI_STATE = window.SYNX_UI_STATE || {};
                window.SYNX_UI_STATE.presence_status = value;
                statusSelect.disabled = false;
                lastPresenceSignature = null;
                load();
            }).catch(function () {
                statusSelect.value = prev;
                statusSelect.disabled = false;
            });
        });
    }

    /* ---------- выбор пользователя и личный чат ---------- */
    function selectUser(uid, shortName, fullName) {
        if (!uid || String(uid) === currentUserId) return;
        selectedUserId = String(uid);
        selectedUserIds = [selectedUserId];
        state.selected = {
            id: selectedUserId,
            short: shortName || "",
            full_name: fullName || shortName || ""
        };
        persist();
        Array.prototype.forEach.call(list.querySelectorAll(".us-row"),
            function (row) {
                row.classList.toggle("selected",
                    selectedUserIds.indexOf(row.dataset.userId) !== -1);
            });
        if (chatSub) {
            chatSub.textContent = (fullName || shortName || "") + " · личный чат";
        }
        if (userChat) {
            userChat.setTarget({
                kind: "dm",
                id: selectedUserId,
                sub: (fullName || shortName || "") + " · личный чат"
            });
            var input = chatRoot && chatRoot.querySelector(".chat-text");
            if (input && !input.disabled) {
                setTimeout(function () { input.focus(); }, 50);
            }
        }
        setTimeout(load, 700);
    }

    function toggleAudio(row) {
        if (!row) return false;
        var uid = String(row.dataset.userId || "");
        if (!uid || uid === currentUserId) return false;
        var roomId = String(row.dataset.audioRoomId || "");
        if (!roomId || !window.SynxAudioChat) return false;
        if (window.SynxAudioChat.isConnected(roomId)) {
            window.SynxAudioChat.toggleRoom(roomId);
        } else {
            window.SynxAudioChat.toggleRoom(roomId);
        }
        return true;
    }

    var userMenu = null;

    function closeUserMenu() {
        if (!userMenu) return;
        userMenu.remove();
        userMenu = null;
        document.removeEventListener("mousedown", onMenuOutside, true);
        document.removeEventListener("keydown", onMenuKey, true);
    }

    function onMenuOutside(e) {
        if (userMenu && !userMenu.contains(e.target)) closeUserMenu();
    }

    function onMenuKey(e) {
        if (e.key === "Escape") closeUserMenu();
    }

    function showUserMenu(row, x, y) {
        closeUserMenu();
        if (!row.dataset.shortName) return;
        var menu = el("div", "ctx-menu us-user-menu");
        if (selectedUserIds.length > 0) {
            var makeRoom = el("div", "ctx-item", "Создать аудио-комнату...");
            makeRoom.addEventListener("click", function (ev) {
                ev.stopPropagation();
                closeUserMenu();
                createChatRoom();
            });
            menu.appendChild(makeRoom);

            var notify = el("div", "ctx-item", "Отправить уведомление...");
            notify.addEventListener("click", function (ev) {
                ev.stopPropagation();
                closeUserMenu();
                openNotifyFrame();
            });
            menu.appendChild(notify);
        }
        if (row.dataset.mic === "1") {
            var connected = window.SynxAudioChat &&
                window.SynxAudioChat.isConnected(row.dataset.audioRoomId);
            var connect = el("div", "ctx-item",
                connected ? "Выйти из аудио-комнаты"
                          : "Войти в аудио-комнату");
            connect.addEventListener("click", function () {
                closeUserMenu();
                toggleAudio(row);
            });
            menu.appendChild(connect);
        }
        if (!menu.children.length) return;
        document.body.appendChild(menu);
        var w = menu.offsetWidth, h = menu.offsetHeight;
        menu.style.left = Math.min(x, window.innerWidth - w - 8) + "px";
        menu.style.top = Math.min(y, window.innerHeight - h - 8) + "px";
        userMenu = menu;
        setTimeout(function () {
            document.addEventListener("mousedown", onMenuOutside, true);
            document.addEventListener("keydown", onMenuKey, true);
        }, 0);
    }

    /* ---------- создать аудио-комнату ---------- */
    function createChatRoom() {
        var selected = selectedUserIds.slice();
        if (!selected.length) return;
        var overlay = el("div", "us-room-modal-backdrop");
        var box = el("div", "us-room-modal");
        box.appendChild(el("div", "us-room-modal-title",
                           "Создать аудио-комнату"));
        var nameInput = el("input", "us-room-name");
        nameInput.type = "text";
        nameInput.placeholder = "Имя комнаты";
        nameInput.value = "Аудио-комната";
        box.appendChild(nameInput);
        box.appendChild(el("div", "muted small",
            "Участники получат приглашение в личный чат со ссылкой."));
        var actions = el("div", "us-room-modal-actions");
        var cancel = el("button", "secondary", "Отмена");
        var create = el("button", "", "Создать");
        cancel.type = "button";
        create.type = "button";
        actions.appendChild(cancel);
        actions.appendChild(create);
        box.appendChild(actions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        function close() {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
        cancel.addEventListener("click", close);
        overlay.addEventListener("mousedown", function (e) {
            if (e.target === overlay) close();
        });
        nameInput.focus();
        nameInput.select();

        function submit() {
            var name = String(nameInput.value || "").trim();
            if (!name) {
                nameInput.focus();
                return;
            }
            close();
            fetch("/api/audio/rooms", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: name,
                    invite_ids: selected,
                    audio: true
                })
            }).then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            }).then(function (d) {
                if (!d || !d.room) return;
                if (window.SynxAudioChat) {
                    window.SynxAudioChat.joinAsHost(d.room.id);
                }
            }).catch(function (err) {
                alert("Не удалось создать комнату: " + err.message);
            });
        }
        create.addEventListener("click", submit);
        nameInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
                e.preventDefault();
                submit();
            } else if (e.key === "Escape") {
                close();
            }
        });
    }

    /* ---------- уведомление в личные чаты ---------- */
    function openNotifyFrame() {
        var selected = selectedUserIds.slice();
        if (!selected.length) return;
        var back = el("div", "modal-backdrop");
        var box = el("div", "modal frame-modal notify-modal");
        box.innerHTML =
            '<h3>Уведомление</h3>' +
            '<div class="field field-wide"><label>Текст уведомления</label>' +
            '<textarea class="notify-text" rows="4" ' +
            'placeholder="Напишите уведомление"></textarea></div>' +
            '<div class="field"><label>Название аудио-комнаты</label>' +
            '<input type="text" class="notify-room-name" ' +
            'placeholder="Имя комнаты"></div>' +
            '<label class="notify-check"><input type="checkbox" ' +
            'class="notify-audio" checked> создать аудио-комнату</label>' +
            '<div class="modal-actions">' +
            '<button type="button" class="notify-send">Отправить</button>' +
            '<button type="button" class="notify-cancel secondary">Отмена</button>' +
            '</div>' +
            '<div class="notify-result muted small"></div>';
        back.appendChild(box);
        document.body.appendChild(back);

        var text = box.querySelector(".notify-text");
        var roomName = box.querySelector(".notify-room-name");
        var audioCb = box.querySelector(".notify-audio");
        var send = box.querySelector(".notify-send");
        var result = box.querySelector(".notify-result");
        var memo = null;
        try {
            memo = JSON.parse(localStorage.getItem(NOTIFY_MEMORY_KEY) || "null");
        } catch (e) {}
        text.value = (memo && memo.text) || "Новое уведомление";
        roomName.value = (memo && memo.room) || "Аудио-комната";

        function close() {
            document.removeEventListener("keydown", onKey);
            back.remove();
        }
        function onKey(e) {
            if (e.key === "Escape") close();
        }
        document.addEventListener("keydown", onKey);
        back.addEventListener("click", function (e) {
            if (e.target === back) close();
        });
        box.querySelector(".notify-cancel").addEventListener("click", close);

        send.addEventListener("click", function () {
            var message = String(text.value || "").trim() ||
                "Новое уведомление";
            var name = String(roomName.value || "").trim() || "Аудио-комната";
            result.textContent = "";
            send.disabled = true;
            var roomPromise = Promise.resolve(null);
            if (audioCb.checked) {
                roomPromise = fetch("/api/audio/rooms", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: name,
                        invite_ids: selected,
                        audio: true,
                        notify: false
                    })
                }).then(function (r) {
                    if (!r.ok) throw new Error("HTTP " + r.status);
                    return r.json();
                }).then(function (d) {
                    var room = d && d.room;
                    if (!room || !room.id) throw new Error("Пустая комната");
                    if (window.SynxAudioChat &&
                            window.SynxAudioChat.joinAsHost) {
                        window.SynxAudioChat.joinAsHost(room.id);
                    }
                    return room;
                });
            }
            roomPromise.then(function (room) {
                var finalText = message;
                if (room) {
                    finalText += "\n\n[[" + room.name + "]](synx-audio:" +
                        room.id + ")";
                }
                return Promise.all(selected.map(function (uid) {
                    var fd = new FormData();
                    fd.append("body", finalText);
                    return fetch("/api/direct/" + encodeURIComponent(uid) +
                                 "/messages", {
                        method: "POST",
                        credentials: "same-origin",
                        body: fd
                    }).then(function (r) {
                        if (!r.ok) throw new Error("HTTP " + r.status);
                    });
                }));
            }).then(function () {
                try {
                    localStorage.setItem(NOTIFY_MEMORY_KEY, JSON.stringify({
                        text: message, room: name
                    }));
                } catch (e) {}
                close();
                load();
                if (userChat) userChat.reload();
            }).catch(function (err) {
                send.disabled = false;
                result.textContent = "Не удалось отправить: " + err.message;
            });
        });
        setTimeout(function () { try { text.focus(); } catch (e) {} }, 0);
    }

    /* ---------- настройки аудио ---------- */
    function openAudioSettings() {
        var api = window.SynxAudioChat;
        var current = (api && api.getSettings) ? api.getSettings()
            : { mode: "server", kbps: "auto" };
        var back = el("div", "us-room-modal-backdrop");
        var box = el("div", "us-room-modal");
        box.appendChild(el("div", "us-room-modal-title", "Настройки аудио"));
        var modeLabel = el("label", "us-room-check", "Режим: ");
        var mode = document.createElement("select");
        mode.className = "us-room-name";
        [["server", "Сервер (TCP, общий микс)"],
         ["webrtc", "WebRTC (напрямую между клиентами)"]]
            .forEach(function (x) {
                var o = document.createElement("option");
                o.value = x[0];
                o.textContent = x[1];
                mode.appendChild(o);
            });
        mode.value = current.mode === "webrtc" ? "webrtc" : "server";
        modeLabel.appendChild(mode);
        box.appendChild(modeLabel);

        var rateLabel = el("label", "us-room-check", "Битрейт: ");
        var rate = document.createElement("select");
        rate.className = "us-room-name";
        [["auto", "авто (подстройка)"], ["32", "32 кбит/с"],
         ["64", "64 кбит/с"], ["96", "96 кбит/с"],
         ["128", "128 кбит/с"]].forEach(function (x) {
            var o = document.createElement("option");
            o.value = x[0];
            o.textContent = x[1];
            rate.appendChild(o);
        });
        rate.value = String(current.kbps || "auto");
        rateLabel.appendChild(rate);
        box.appendChild(rateLabel);
        box.appendChild(el("div", "muted small",
            "Режим применяется при следующем подключении; битрейт в " +
            "серверном режиме меняется сразу. В режиме «авто» сервер и " +
            "клиент подстраиваются под буфер канала. Все участники " +
            "комнаты должны использовать одинаковый режим."));

        var actions = el("div", "us-room-modal-actions");
        var cancel = el("button", "secondary", "Отмена");
        var save = el("button", "primary", "Сохранить");
        cancel.type = "button";
        save.type = "button";
        actions.appendChild(cancel);
        actions.appendChild(save);
        box.appendChild(actions);
        back.appendChild(box);
        document.body.appendChild(back);

        function close() {
            document.removeEventListener("keydown", onKey);
            back.remove();
        }
        function onKey(e) {
            if (e.key === "Escape") close();
        }
        document.addEventListener("keydown", onKey);
        back.addEventListener("click", function (e) {
            if (e.target === back) close();
        });
        cancel.addEventListener("click", close);
        save.addEventListener("click", function () {
            if (api && api.setSettings) {
                api.setSettings({ mode: mode.value, kbps: rate.value });
            }
            close();
        });
    }

    if (audioSettingsBtn) {
        audioSettingsBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            openAudioSettings();
        });
    }

    if (refresh) {
        refresh.addEventListener("click", function (e) {
            e.stopPropagation();
            lastPresenceSignature = null;
            load();
            if (userChat) userChat.reload();
        });
    }

    /* ---------- события списка ---------- */
    list.addEventListener("click", function (e) {
        var row = e.target.closest(".us-row");
        if (!row || !row.dataset.userId) return;
        var uid = String(row.dataset.userId);
        if (uid === currentUserId) return;
        if (e.ctrlKey || e.metaKey) {
            var pos = selectedUserIds.indexOf(uid);
            if (pos === -1) selectedUserIds.push(uid);
            else selectedUserIds.splice(pos, 1);
            selectedUserId = uid;
            Array.prototype.forEach.call(
                list.querySelectorAll(".us-row"), function (r) {
                    r.classList.toggle("selected",
                        selectedUserIds.indexOf(r.dataset.userId) !== -1);
                });
            return;
        }
        selectUser(row.dataset.userId, row.dataset.shortName,
                   row.dataset.fullName);
    });

    list.addEventListener("dblclick", function (e) {
        var row = e.target.closest(".us-row");
        if (!row || !row.dataset.userId) return;
        if (String(row.dataset.userId) === currentUserId) return;
        toggleAudio(row);
        e.preventDefault();
        e.stopPropagation();
    });

    list.addEventListener("contextmenu", function (e) {
        var row = e.target.closest(".us-row");
        if (!row) return;
        if (String(row.dataset.userId || "") === currentUserId) return;
        e.preventDefault();
        e.stopPropagation();
        if (selectedUserIds.indexOf(String(row.dataset.userId || "")) === -1) {
            selectUser(row.dataset.userId, row.dataset.shortName,
                       row.dataset.fullName);
        }
        showUserMenu(row, e.clientX, e.clientY);
    });

    list.addEventListener("scroll", scheduleLinks);

    /* ---------- сплиттер список/чат ---------- */
    if (hsplit && chatWrap) {
        hsplit.addEventListener("mousedown", function (e) {
            if (e.detail && e.detail > 1) return;
            e.preventDefault();
            var startX = e.clientX;
            var startW = chatWrap.getBoundingClientRect().width;
            document.body.classList.add("us-chat-resizing-x");
            function move(ev) {
                var maxW = Math.max(260, panel.clientWidth - 230);
                var w = Math.max(260, Math.min(
                    maxW, startW - (ev.clientX - startX)));
                chatWrap.style.flexBasis = w + "px";
            }
            function up() {
                document.body.classList.remove("us-chat-resizing-x");
                state.chatW = Math.round(
                    chatWrap.getBoundingClientRect().width);
                persist();
                document.removeEventListener("mousemove", move);
                document.removeEventListener("mouseup", up);
            }
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
        });
    }

    /* ---------- чат ---------- */
    if (chatRoot && window.SynxChat) {
        userChat = window.SynxChat.create({
            root: chatRoot,
            myId: currentUserId,
            allowFiles: true,
            users: [],
            emptyText: "Выберите пользователя из списка — здесь появится личный чат.",
            emptySub: "Пользователь не выбран"
        });
        if (selectedUserId) {
            var savedSel = state.selected || {};
            selectUser(selectedUserId, savedSel.short || savedSel.short_name,
                       savedSel.full_name);
        }
    }

    document.addEventListener("synx-presence-refresh", function () {
        lastPresenceSignature = null;
        load();
    });
    document.addEventListener("synx-notify-open", openNotifyFrame);
    document.addEventListener("synx-audio-levels", function (e) {
        lastAudioLevels = (e.detail && e.detail.levels) || {};
        Array.prototype.forEach.call(list.querySelectorAll(".us-row"),
            function (row) {
                setRowAudioLevel(row,
                    Number(lastAudioLevels[row.dataset.userId]) || 0);
            });
    });
    document.addEventListener("synx-chat-loaded", function (e) {
        var d = e.detail || {};
        if (d.kind === "dm") setTimeout(load, 300);
    });

    window.addEventListener("resize", function () {
        scheduleLinks();
    });
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden) {
            lastPresenceSignature = null;
            load();
        }
    });

    if (state.chatW && chatWrap) {
        chatWrap.style.flexBasis = state.chatW + "px";
    }

    updateTitle();
    // presence.js отправляет первый heartbeat сразу; даём ему долететь
    setTimeout(load, 900);
    setInterval(load, 5000);
})();
