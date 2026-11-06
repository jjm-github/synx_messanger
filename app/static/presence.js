/* Онлайн-присутствие: раз в 15 секунд сообщаем серверу, что вкладка жива. */
(function () {
    "use strict";

    if (!document.body || document.body.dataset.userId === "anon") return;
    var timer = 0;

    function build() {
        return {
            page: location.pathname + location.search,
            title: document.title,
            activity: "в мессенджере",
            visible: document.visibilityState !== "hidden"
        };
    }

    function beat(keepalive) {
        var data;
        try { data = JSON.stringify(build()); } catch (e) { return; }
        fetch("/api/presence/heartbeat", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: data,
            keepalive: !!keepalive
        }).catch(function () {});
    }

    beat(false);
    setInterval(function () { beat(false); }, 15000);
    document.addEventListener("visibilitychange", function () {
        beat(false);
    });
    window.addEventListener("pagehide", function () { beat(true); });
})();
