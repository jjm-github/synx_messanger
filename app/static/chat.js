/* ============================================================
   Личный чат мессенджера.

   Один компонент на правую часть экрана. Цель задаётся через
   setTarget({kind:"dm", id, sub}); лента и отправка идут на
   /api/direct/{id}/messages, правка — на /api/direct/messages/{id}.
   ============================================================ */
(function () {
    "use strict";

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }

    function fmtTime(iso) {
        if (!iso) return "";
        var d = new Date(iso);
        if (isNaN(d)) return String(iso).slice(0, 16).replace("T", " ");
        var pad = function (n) { return (n < 10 ? "0" : "") + n; };
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" +
            pad(d.getDate()) + " " + pad(d.getHours()) + ":" +
            pad(d.getMinutes());
    }

    function httpError(r) {
        return r.json().then(function (d) {
            var det = d && d.detail;
            if (typeof det === "string") throw new Error(det);
            if (Array.isArray(det)) {
                throw new Error(det.map(function (i) { return i.msg; }).join("; "));
            }
            throw new Error("HTTP " + r.status);
        });
    }

    function apiBase(kind, id) {
        if (kind === "dm") return "/api/direct/" + id + "/messages";
        return null;
    }

    var PLACEHOLDER = {
        dm: "Сообщение пользователю… (Enter — отправить, Ctrl+Enter — перенос)"
    };

    /* ---------- поповер и лайтбокс ---------- */
    var menu = null;
    var lightbox = null;

    function closeMenu() {
        if (menu) { menu.remove(); menu = null; }
    }

    function openLightbox(src, name, doc) {
        closeLightbox();
        doc = doc || document;
        var el = doc.createElement("div");
        el.className = "lightbox";
        var im = doc.createElement("img");
        im.src = src;
        im.alt = name || "";
        el.appendChild(im);
        el.addEventListener("click", closeLightbox);
        doc.body.appendChild(el);
        lightbox = el;
    }

    function closeLightbox() {
        if (lightbox) { lightbox.remove(); lightbox = null; }
    }

    document.addEventListener("click", closeMenu);
    document.addEventListener("scroll", closeMenu, true);
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { closeMenu(); closeLightbox(); }
    });

    function placeMenu(el, x, y, doc) {
        doc = doc || document;
        var win = doc.defaultView || window;
        doc.body.appendChild(el);
        el.style.left = Math.min(x, win.innerWidth - el.offsetWidth - 8) + "px";
        el.style.top = Math.min(y, win.innerHeight - el.offsetHeight - 8) + "px";
        menu = el;
    }

    /* ---------- картинки: копирование и «Сохранить как» ---------- */
    function copyImage(url) {
        fetch(url, { credentials: "same-origin" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.blob();
            })
            .then(function (blob) {
                if (!window.ClipboardItem || !navigator.clipboard ||
                        !navigator.clipboard.write) {
                    throw new Error("браузер не поддерживает копирование изображений");
                }
                var ok = ["image/png", "image/jpeg", "image/webp", "image/gif"];
                if (ok.indexOf(blob.type) >= 0) {
                    var d = {}; d[blob.type] = blob;
                    return navigator.clipboard.write([new ClipboardItem(d)]);
                }
                return rasterizeToPng(blob).then(function (png) {
                    return navigator.clipboard.write([
                        new ClipboardItem({ "image/png": png })
                    ]);
                });
            })
            .catch(function (err) {
                alert("Не удалось скопировать изображение: " + err.message);
            });
    }

    function rasterizeToPng(blob) {
        return new Promise(function (res, rej) {
            var u = URL.createObjectURL(blob);
            var im = new Image();
            im.onload = function () {
                var c = document.createElement("canvas");
                c.width = im.naturalWidth;
                c.height = im.naturalHeight;
                c.getContext("2d").drawImage(im, 0, 0);
                URL.revokeObjectURL(u);
                c.toBlob(function (b) {
                    b ? res(b) : rej(new Error("конвертация в png не удалась"));
                }, "image/png");
            };
            im.onerror = function () {
                URL.revokeObjectURL(u);
                rej(new Error("не удалось прочитать файл изображения"));
            };
            im.src = u;
        });
    }

    function clipboardImageFile(blob, index) {
        return new Promise(function (resolve, reject) {
            var u = URL.createObjectURL(blob);
            var im = new Image();
            im.onload = function () {
                var c = document.createElement("canvas");
                c.width = Math.max(1, im.naturalWidth);
                c.height = Math.max(1, im.naturalHeight);
                c.getContext("2d").drawImage(im, 0, 0);
                URL.revokeObjectURL(u);
                c.toBlob(function (b) {
                    if (!b) { reject(new Error("JPEG не создался")); return; }
                    var name = "clipboard-" + Date.now() +
                        (index ? "-" + index : "") + ".jpg";
                    try {
                        resolve(new File([b], name, { type: "image/jpeg" }));
                    } catch (e) {
                        b.name = name;
                        resolve(b);
                    }
                }, "image/jpeg", 0.95);
            };
            im.onerror = function () {
                URL.revokeObjectURL(u);
                reject(new Error("не удалось прочитать картинку"));
            };
            im.src = u;
        });
    }

    function downloadBlob(blob, fname) {
        var u = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = u;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(u); }, 10000);
    }

    function saveImageAs(url, name) {
        fetch(url, { credentials: "same-origin" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.blob();
            })
            .then(function (blob) {
                var fname = name ||
                    (decodeURIComponent(url.split("/").pop() || "") || "image");
                if (window.showSaveFilePicker) {
                    window.showSaveFilePicker({ suggestedName: fname })
                        .then(function (handle) {
                            return handle.createWritable().then(function (w) {
                                return w.write(blob).then(function () {
                                    return w.close();
                                });
                            });
                        })
                        .catch(function (err) {
                            if (err && err.name === "AbortError") return;
                            downloadBlob(blob, fname);
                        });
                    return;
                }
                downloadBlob(blob, fname);
            })
            .catch(function (err) {
                alert("Не удалось сохранить изображение: " + err.message);
            });
    }

    function showImageMenu(x, y, img, doc) {
        closeMenu();
        var url = img.currentSrc || img.src;
        var name = img.alt || "";
        var el = document.createElement("div");
        el.className = "chat-menu";

        var bCopy = document.createElement("button");
        bCopy.type = "button";
        bCopy.textContent = "Copy Image";
        bCopy.addEventListener("click", function () {
            closeMenu(); copyImage(url);
        });

        var bSave = document.createElement("button");
        bSave.type = "button";
        bSave.textContent = "Save Image as...";
        bSave.addEventListener("click", function () {
            closeMenu(); saveImageAs(url, name);
        });

        el.appendChild(bCopy);
        el.appendChild(bSave);
        placeMenu(el, x, y, doc);
    }

    /* ---------- сам чат ---------- */
    function create(opts) {
        var root = opts.root;
        if (!root) return null;

        var myId = String(opts.myId || root.dataset.userId || "");
        var body = root.querySelector(".chat-body");
        var sub = root.querySelector(".chat-sub");
        var emptyText = opts.emptyText ||
            "Ничего не выбрано — здесь будет обсуждение.";
        var emptySub = opts.emptySub || "не выбрано";

        var form = root.querySelector(".chat-compose");
        var text = root.querySelector(".chat-text");
        var send = root.querySelector(".chat-send");
        var attach = root.querySelector(".chat-attach");
        var file = root.querySelector(".chat-file");
        var previews = root.querySelector(".chat-previews");
        if (opts.allowFiles && file) {
            file.removeAttribute("accept");
            file.setAttribute("multiple", "");
        }

        var target = null;
        var loadedFor = null;
        var loadingFor = null;
        var pending = [];
        var lastComments = [];
        var lastSig = "";
        var editingId = null;
        var canComment = false;

        /* ---------- подсказка @short_name ---------- */
        var USERS = [];

        function setUsers(users) {
            USERS = (users || []).filter(function (u) {
                return u && u.short_name && String(u.user_id) !== myId;
            });
        }
        setUsers(opts.users);

        var mention = { el: null, items: [], idx: 0, open: false };

        function mentionToken() {
            if (!text || text.disabled) return null;
            var pos = text.selectionStart;
            if (pos == null) return null;
            var before = text.value.slice(0, pos);
            var at = before.lastIndexOf("@");
            if (at < 0) return null;
            if (at > 0 && !/\s/.test(before.charAt(at - 1))) return null;
            var q = before.slice(at + 1);
            if (!/^[A-Za-z0-9._-]*$/.test(q)) return null;
            return { start: at, end: pos, query: q };
        }

        function closeMention() {
            if (mention.el) { mention.el.remove(); mention.el = null; }
            mention.open = false;
            mention.items = [];
            mention.idx = 0;
        }

        function placeMention() {
            if (!mention.el || !text) return;
            var r = text.getBoundingClientRect();
            var w = Math.max(220, Math.min(340, r.width));
            mention.el.style.width = w + "px";
            var h = mention.el.offsetHeight;
            var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
            var top = r.top - h - 6;
            if (top < 8) top = Math.min(window.innerHeight - h - 8,
                                        r.bottom + 6);
            mention.el.style.left = left + "px";
            mention.el.style.top = Math.max(8, top) + "px";
        }

        function highlightMention() {
            if (!mention.el) return;
            var btns = mention.el.querySelectorAll(".chat-mention");
            Array.prototype.forEach.call(btns, function (b, i) {
                b.classList.toggle("active", i === mention.idx);
            });
            var cur = mention.el.querySelector(".chat-mention.active");
            if (cur && cur.scrollIntoView) {
                cur.scrollIntoView({ block: "nearest" });
            }
        }

        function selectMention(u) {
            if (!u || !text) return;
            closeMention();
            var tok = mentionToken();
            if (!tok) return;
            var val = text.value;
            var after = val.slice(tok.end);
            var ins = "@" + u.short_name + (/^\s/.test(after) ? "" : " ");
            text.value = val.slice(0, tok.start) + ins + after;
            var caret = tok.start + ins.length;
            text.focus();
            text.setSelectionRange(caret, caret);
        }

        function renderMention() {
            if (mention.el) { mention.el.remove(); mention.el = null; }
            var el = document.createElement("div");
            el.className = "chat-mentions";
            el.setAttribute("role", "listbox");
            if (!mention.items.length) {
                var empty = document.createElement("div");
                empty.className = "chat-mention-empty";
                empty.textContent = "Нет пользователей";
                el.appendChild(empty);
            } else {
                mention.items.forEach(function (u, i) {
                    var b = document.createElement("button");
                    b.type = "button";
                    b.className = "chat-mention" +
                        (i === mention.idx ? " active" : "");
                    b.setAttribute("role", "option");
                    b.dataset.uid = u.user_id;
                    b.innerHTML = "<b>@" + esc(u.short_name) + "</b>" +
                        (u.full_name ? "<span>" + esc(u.full_name) + "</span>"
                                     : "");
                    b.addEventListener("mouseenter", function () {
                        mention.idx = i;
                        highlightMention();
                    });
                    b.addEventListener("mousedown", function (ev) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        selectMention(u);
                    });
                    el.appendChild(b);
                });
            }
            document.body.appendChild(el);
            mention.el = el;
            mention.open = true;
            placeMention();
        }

        function updateMention() {
            if (!text || !canComment) { closeMention(); return; }
            var tok = mentionToken();
            if (!tok) { closeMention(); return; }
            var q = tok.query.toLowerCase();
            var items = USERS.filter(function (u) {
                var sn = String(u.short_name || "").toLowerCase();
                var fn = String(u.full_name || "").toLowerCase();
                return !q || sn.indexOf(q) !== -1 || fn.indexOf(q) !== -1;
            });
            function score(u) {
                var sn = String(u.short_name || "").toLowerCase();
                var fn = String(u.full_name || "").toLowerCase();
                if (!q) return 0;
                if (sn === q) return 0;
                if (sn.indexOf(q) === 0) return 1;
                if (fn.indexOf(q) === 0) return 2;
                return 3;
            }
            items.sort(function (a, b) {
                var d = score(a) - score(b);
                if (d) return d;
                return String(a.short_name).localeCompare(
                    String(b.short_name));
            });
            mention.items = items;
            mention.idx = 0;
            renderMention();
        }

        if (text) {
            text.addEventListener("input", updateMention);
            text.addEventListener("click", updateMention);
            text.addEventListener("keyup", function (e) {
                if (/^(Arrow|Home|End|PageUp|PageDown)/.test(e.key)) {
                    updateMention();
                }
            });
            text.addEventListener("keydown", function (e) {
                if (!mention.open) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    if (!mention.items.length) return;
                    var dir = e.key === "ArrowDown" ? 1 : -1;
                    mention.idx = (mention.idx + dir + mention.items.length) %
                        mention.items.length;
                    highlightMention();
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    return;
                }
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    closeMention();
                    return;
                }
                if (e.key === "Enter") {
                    if (!mention.items.length) { closeMention(); return; }
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    selectMention(mention.items[mention.idx] ||
                                  mention.items[0]);
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    closeMention();
                }
            }, true);
        }
        document.addEventListener("pointerdown", function (e) {
            if (!mention.el) return;
            if (mention.el.contains(e.target) || e.target === text) return;
            closeMention();
        }, true);
        document.addEventListener("scroll", function (e) {
            if (mention.el && mention.el.contains(e.target)) return;
            closeMention();
        }, true);
        window.addEventListener("resize", function () {
            if (mention.open) placeMention();
        });

        function key() { return target ? target.kind + ":" + target.id : null; }

        function sigOfComments(list) {
            return (list || []).map(function (c) {
                var atts = (c.attachments || []).map(function (a) {
                    return a.id || a.url || a.name || "";
                }).join(",");
                return [c.id, c.updated_at || "", c.body || "", atts]
                    .join("\u0001");
            }).join("\u0002");
        }

        function setComposer(on) {
            canComment = !!on;
            if (!canComment) closeMention();
            [text, send].forEach(function (el) {
                if (el) el.disabled = !canComment;
            });
            if (attach) attach.disabled = !canComment;
            if (text) {
                text.placeholder = canComment
                    ? (PLACEHOLDER[target && target.kind] || PLACEHOLDER.dm)
                    : "Выберите пользователя";
            }
        }

        function renderEmpty(msg) {
            body.innerHTML = '<div class="chat-empty">' + esc(msg) + "</div>";
        }

        function announceComments(comments) {
            if (!target) return;
            var list = comments || [];
            var last = list.length ? list[list.length - 1] : null;
            document.dispatchEvent(new CustomEvent("synx-chat-loaded", {
                detail: {
                    root: root,
                    kind: target.kind,
                    id: target.id,
                    count: list.length,
                    latestId: last ? String(last.id) : null,
                    latestAuthorId: last ? String(last.author_id) : null,
                    latestAt: last ? last.created_at : null
                }
            }));
        }

        function renderMessageText(bodyText) {
            var out = esc(bodyText || "");
            out = out.replace(/\[\[([^\]]+)\]\]\(([^)]+)\)/g,
                function (m, label, href) {
                    if (/^synx-audio:[A-Za-z0-9_-]+$/.test(href)) {
                        return '<a href="#" class="chat-room-link" ' +
                            'data-room-id="' + esc(href.slice(11)) + '">' +
                            label + "</a>";
                    }
                    if (/^(https?:\/\/|\/)/.test(href)) {
                        return '<a href="' + esc(href) +
                            '" target="_blank" rel="noopener">' + label +
                            "</a>";
                    }
                    return m;
                });
            return out.split(String.fromCharCode(10)).join("<br>");
        }

        function render(comments) {
            lastComments = comments;
            if (!comments.length) {
                renderEmpty("Сообщений пока нет — напишите первое.");
                return;
            }
            body.innerHTML = comments.map(function (c) {
                var mine = String(c.author_id) === myId;
                var atts = (c.attachments || []).map(function (a) {
                    var aurl = a.pretty_url || a.url;
                    if ((a.mime || "").indexOf("image/") === 0) {
                        return '<a href="' + aurl +
                            '" target="_blank" rel="noopener">' +
                            '<img class="chat-img" src="' + aurl +
                            '" alt="' + esc(a.name) + '"></a>';
                    }
                    return '<a class="chat-file-link" href="' + aurl +
                        '" target="_blank" rel="noopener">' +
                        esc(a.name) + "</a>";
                }).join("");
                var txt = c.body
                    ? '<div class="chat-msg-text">' +
                      renderMessageText(c.body) + "</div>"
                    : "";
                var edited = c.updated_at
                    ? '<span class="chat-edited" title="изменён ' +
                      esc(fmtTime(c.updated_at)) + '">изменён</span>'
                    : "";
                var editBtn = (mine && c.can_edit)
                    ? '<button type="button" class="chat-edit-btn" ' +
                      'data-edit-id="' + esc(c.id) +
                      '" title="Редактировать сообщение" ' +
                      'aria-label="Редактировать">✎</button>'
                    : "";
                return '<div class="chat-msg' + (mine ? " mine" : "") + '"' +
                    ' data-comment-id="' + esc(c.id) + '"' +
                    ' data-can-edit="' + (c.can_edit ? "1" : "0") + '">' +
                    '<div class="chat-bubble">' +
                    '<div class="chat-meta"><b>' +
                    esc(c.author_full || c.author || "—") + "</b>" +
                    (c.author ? '<span class="chat-login">' +
                        esc(c.author) + "</span>" : "") +
                    "<span>" + esc(fmtTime(c.created_at)) + edited + "</span>" +
                    editBtn + "</div>" +
                    '<div class="chat-text-wrap">' + txt + "</div>" +
                    (atts ? '<div class="chat-atts">' + atts + "</div>" : "") +
                    "</div></div>";
            }).join("");
            body.scrollTop = body.scrollHeight;
        }

        function load() {
            if (!target) {
                loadedFor = null;
                loadingFor = null;
                sub.textContent = emptySub;
                renderEmpty(emptyText);
                setComposer(false);
                return;
            }
            var url = apiBase(target.kind, target.id);
            if (!url) {
                renderEmpty("Для этого объекта чат недоступен.");
                setComposer(false);
                return;
            }
            var k = key();
            if (loadingFor === k) return;
            loadingFor = k;
            sub.textContent = target.sub || "";
            fetch(url, { credentials: "same-origin" })
                .then(function (r) {
                    if (!r.ok) return httpError(r);
                    return r.json();
                })
                .then(function (data) {
                    if (key() !== k) return;
                    loadingFor = null;
                    var first = loadedFor !== k;
                    var list = data.comments || [];
                    var sig = sigOfComments(list);
                    loadedFor = k;
                    setComposer(data.can_comment);
                    if (first || sig !== lastSig) {
                        lastSig = sig;
                        render(list);
                    }
                    announceComments(list);
                })
                .catch(function (err) {
                    if (key() === k) loadingFor = null;
                    renderEmpty("Не удалось загрузить сообщения: " +
                                err.message);
                });
        }

        function setTarget(t) {
            var next = t ? {
                kind: t.kind,
                id: String(t.id),
                sub: t.sub || ""
            } : null;
            var prev = key();
            target = next;
            var k = key();
            if (k !== prev) {
                loadedFor = null;
                lastSig = "";
                editingId = null;
                closeMention();
                pending = [];
                if (previews) {
                    previews.hidden = true;
                    previews.innerHTML = "";
                }
            }
            if (k !== prev || (target && loadedFor !== k)) load();
            else if (!target) load();
            else if (t && t.sub) sub.textContent = t.sub;
        }

        function sync() {
            if (root.hidden) return;
            if (!target) { load(); return; }
            load();
        }

        /* ---- картинки к сообщению ---- */
        function renderPending() {
            if (!previews) return;
            previews.hidden = !pending.length;
            previews.innerHTML = pending.map(function (f, i) {
                var isImage = (f.type || "").indexOf("image/") === 0;
                var bodyHtml = isImage
                    ? '<img src="' + URL.createObjectURL(f) + '" alt="' +
                      esc(f.name) + '">'
                    : '<span class="chat-preview-file">' + esc(f.name) +
                      "</span>";
                return '<div class="chat-preview"><span ' +
                    'class="chat-preview-media">' + bodyHtml +
                    '</span><button type="button" data-i="' + i +
                    '" title="Убрать"><span class="icon-x"></span>' +
                    "</button></div>";
            }).join("");
            previews.querySelectorAll("button[data-i]").forEach(function (b) {
                b.addEventListener("click", function () {
                    pending.splice(parseInt(b.dataset.i, 10), 1);
                    renderPending();
                });
            });
        }

        if (attach && file) {
            attach.addEventListener("click", function () { file.click(); });
            file.addEventListener("change", function () {
                Array.from(file.files || []).forEach(function (f) {
                    pending.push(f);
                });
                file.value = "";
                renderPending();
            });
        }

        if (text) {
            text.addEventListener("paste", function (e) {
                if (!canComment || !e.clipboardData) return;
                var blobs = [];
                Array.prototype.forEach.call(
                    e.clipboardData.items || [], function (it) {
                        if (it.kind !== "file" ||
                                !/^image\//.test(it.type || "")) return;
                        var b = it.getAsFile();
                        if (b) blobs.push(b);
                    });
                if (!blobs.length) return;
                e.preventDefault();
                blobs.forEach(function (b, i) {
                    clipboardImageFile(b, i).then(function (f) {
                        pending.push(f);
                        renderPending();
                    }).catch(function (err) {
                        alert("Не удалось вставить картинку: " + err.message);
                    });
                });
            });
        }

        /* ---- отправка ---- */
        if (form) {
            form.addEventListener("submit", function (e) {
                e.preventDefault();
                closeMention();
                if (!target || !canComment) return;
                var txt = (text.value || "").trim();
                if (!txt && !pending.length) return;
                var url = apiBase(target.kind, target.id);
                if (!url) return;
                var k = key();

                var fd = new FormData();
                fd.append("body", txt);
                pending.forEach(function (f) { fd.append("files", f, f.name); });

                send.disabled = true;
                fetch(url, {
                    method: "POST",
                    body: fd,
                    credentials: "same-origin"
                }).then(function (r) {
                    if (!r.ok) return httpError(r);
                    return r.json();
                }).then(function (data) {
                    if (key() !== k) return;
                    text.value = "";
                    pending = [];
                    closeMention();
                    renderPending();
                    setComposer(data.can_comment);
                    var list = data.comments || [];
                    lastSig = sigOfComments(list);
                    render(list);
                    loadedFor = k;
                    announceComments(list);
                }).catch(function (err) {
                    alert("Не удалось отправить сообщение: " + err.message);
                }).then(function () {
                    setComposer(canComment);
                });
            });
        }

        /* ---- Enter — отправить, Ctrl+Enter — перевод строки ---- */
        if (text) {
            text.addEventListener("keydown", function (e) {
                if (e.key !== "Enter") return;
                if (!e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    if (form) form.requestSubmit
                        ? form.requestSubmit()
                        : form.dispatchEvent(
                            new Event("submit", { cancelable: true }));
                    return;
                }
                e.preventDefault();
                var v = text.value, s = text.selectionStart,
                    en = text.selectionEnd;
                text.value = v.slice(0, s) + "\n" + v.slice(en);
                text.selectionStart = text.selectionEnd = s + 1;
            });
        }

        /* ---- контекстное меню: правая кнопка на сообщении ---- */
        function rawBody(id) {
            for (var i = 0; i < lastComments.length; i++) {
                if (String(lastComments[i].id) === String(id)) {
                    return lastComments[i].body || "";
                }
            }
            return "";
        }

        function msgById(id) {
            return body.querySelector(
                '.chat-msg[data-comment-id="' + id + '"]');
        }

        function showMenu(x, y, msg) {
            closeMenu();
            if (msg.dataset.canEdit !== "1") return;
            var id = msg.dataset.commentId;
            var el = document.createElement("div");
            el.className = "chat-menu";
            var bEdit = document.createElement("button");
            bEdit.type = "button";
            bEdit.textContent = "Редактировать";
            bEdit.addEventListener("click", function () {
                closeMenu(); startEdit(id);
            });
            el.appendChild(bEdit);
            placeMenu(el, x, y, root.ownerDocument);
        }

        function startEdit(id) {
            var msg = msgById(id);
            if (!msg || editingId) return;
            editingId = id;
            var wrap = msg.querySelector(".chat-text-wrap");
            if (!wrap) return;

            var box = document.createElement("div");
            box.className = "chat-edit-box";
            var ta = document.createElement("textarea");
            ta.value = rawBody(id);
            box.appendChild(ta);

            var acts = document.createElement("div");
            acts.className = "chat-edit-actions";
            var btnCancel = document.createElement("button");
            btnCancel.type = "button";
            btnCancel.className = "chat-edit-cancel";
            btnCancel.textContent = "✕";
            btnCancel.title = "Отменить (Esc)";
            btnCancel.setAttribute("aria-label", "Отменить");
            var btnSave = document.createElement("button");
            btnSave.type = "button";
            btnSave.className = "primary chat-edit-save";
            btnSave.textContent = "✓";
            btnSave.title = "Сохранить (Enter)";
            btnSave.setAttribute("aria-label", "Сохранить");
            acts.appendChild(btnCancel);
            acts.appendChild(btnSave);
            box.appendChild(acts);

            wrap.innerHTML = "";
            wrap.appendChild(box);
            ta.focus();

            function cancel() {
                editingId = null;
                render(lastComments);
            }
            btnCancel.addEventListener("click", cancel);
            btnSave.addEventListener("click", function () {
                var txt = (ta.value || "").trim();
                if (!txt) { alert("Пустое сообщение"); return; }
                saveEdit(id, txt);
            });
            ta.addEventListener("keydown", function (e) {
                if (e.key === "Escape") { e.stopPropagation(); cancel(); }
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (e.ctrlKey || e.metaKey) {
                    var v = ta.value, s = ta.selectionStart,
                        en = ta.selectionEnd;
                    ta.value = v.slice(0, s) + "\n" + v.slice(en);
                    ta.selectionStart = ta.selectionEnd = s + 1;
                    return;
                }
                btnSave.click();
            });
        }

        function applyFeed(data) {
            lastComments = (data && data.comments) || [];
            setComposer(!!(data && data.can_comment));
            render(lastComments);
            loadedFor = key();
            announceComments(lastComments);
        }

        function saveEdit(id, txt) {
            var k = key();
            fetch("/api/direct/messages/" + id, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ body: txt })
            }).then(function (r) {
                if (!r.ok) return httpError(r);
                return r.json();
            }).then(function (data) {
                editingId = null;
                if (key() !== k) return;
                applyFeed(data);
            }).catch(function (err) {
                alert("Не удалось сохранить: " + err.message);
            });
        }

        body.addEventListener("contextmenu", function (e) {
            var img = e.target.closest(".chat-img");
            if (img) {
                e.preventDefault();
                showImageMenu(e.clientX, e.clientY, img, root.ownerDocument);
                return;
            }
            if (e.target.closest("a")) return;
            var msg = e.target.closest(".chat-msg");
            if (!msg || !msg.dataset.commentId) return;
            e.preventDefault();
            showMenu(e.clientX, e.clientY, msg);
        });

        body.addEventListener("click", function (e) {
            var roomLink = e.target.closest(".chat-room-link");
            if (roomLink) {
                e.preventDefault();
                var roomId = roomLink.dataset.roomId;
                if (roomId && window.SynxAudioChat &&
                        window.SynxAudioChat.joinRoom) {
                    window.SynxAudioChat.joinRoom(roomId);
                }
                return;
            }
            var edit = e.target.closest(".chat-edit-btn");
            if (edit && edit.dataset.editId) {
                e.preventDefault();
                startEdit(edit.dataset.editId);
                return;
            }
            var img = e.target.closest(".chat-img");
            if (!img) return;
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            openLightbox(img.currentSrc || img.src, img.alt,
                         root.ownerDocument);
        });

        function focusComment(id, tries) {
            if (!id) return false;
            var sel = '.chat-msg[data-comment-id="' +
                String(id).replace(/"/g, '\\"') + '"]';
            var msg = body.querySelector(sel);
            if (msg) {
                if (msg.scrollIntoView) {
                    try { msg.scrollIntoView({ block: "center" }); }
                    catch (e) {}
                }
                msg.classList.add("chat-msg-focus");
                setTimeout(function () {
                    msg.classList.remove("chat-msg-focus");
                }, 3200);
                return true;
            }
            if (tries == null) tries = 50;
            if (tries > 0) {
                setTimeout(function () { focusComment(id, tries - 1); }, 150);
            }
            return false;
        }

        /* Лента обновляется сама: раз в 12 секунд и после возврата
           на вкладку. */
        setInterval(function () {
            if (document.hidden || !target) return;
            if (loadingFor === key()) return;
            load();
        }, 12000);
        document.addEventListener("visibilitychange", function () {
            if (!document.hidden && target) load();
        });

        renderEmpty(emptyText);
        setComposer(false);

        return {
            setTarget: setTarget,
            setUsers: setUsers,
            sync: sync,
            reload: function () {
                if (target) {
                    loadedFor = null;
                    loadingFor = null;
                    load();
                }
            },
            target: function () { return target; },
            focusComment: focusComment
        };
    }

    window.SynxChat = { create: create };
})();
