/* Аудио-комната.

   Основной режим — серверный TCP/WebSocket-микшер: браузер отправляет
   µ-law PCM, сервер складывает голоса и раздаёт микс. Второй режим —
   прежний WebRTC mesh, который остаётся запасным вариантом и
   выбирается в настройках аудио. */
(function () {
    "use strict";

    var micButton = document.getElementById("us-mic");
    var meId = window.SYNX_UID != null ? String(window.SYNX_UID) : "";
    var roomId = "";
    var peerId = "";
    var host = false;
    var connected = false;
    var joining = false;
    var localStream = null;
    var peers = {};
    var pendingIce = {};
    var remoteAudio = {};
    var lastSignalId = 0;
    var pollTimer = 0;
    var pollBusy = false;
    var joinSeq = 0;

    var ICE = [{urls: "stun:stun.l.google.com:19302"}];
    var muteButton = document.getElementById("us-mute");
    var muted = false;
    var peerUsers = {};
    var audioCtx = null;
    var analysers = {};
    var levelTimer = 0;

    /* Настройки нового серверного аудиочата. WebRTC остаётся вторым
       режимом и выбирается в том же маленьком окне настроек. */
    /* v2: у всех, кто уже открывал аудио раньше, сбрасываем сохранённый
       WebRTC-режим на серверный. Иначе участники одной комнаты могут
       оказаться в разных транспортах и не слышать друг друга. */
    var AUDIO_SETTINGS_KEY = "synx.audio.settings.v2";
    var RATE_STEPS = [4000, 8000, 12000, 16000]; // 32/64/96/128 кбит/с µ-law
    var audioSettings = {mode: "server", kbps: "auto"};
    try {
        var savedAudio = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) || "null");
        if (savedAudio && (savedAudio.mode === "server" || savedAudio.mode === "webrtc")) {
            audioSettings.mode = savedAudio.mode;
        }
        if (savedAudio && (savedAudio.kbps === "auto" || Number(savedAudio.kbps) > 0)) {
            audioSettings.kbps = savedAudio.kbps;
        }
    } catch (e) { /* приватный режим */ }

    var serverWs = null;
    var serverRoom = "";
    var serverInRate = 8000;
    var serverOutRate = 8000;
    var serverAuto = true;
    var serverProcessor = null;
    var serverSource = null;
    var serverSink = null;
    var captureLowPass = 0;
    var serverPlayData = [];
    var serverPlayRead = 0;
    var serverPlayNode = null;
    var serverPlayPrimed = false;
    var serverStatsTimer = 0;
    var serverHeartbeatTimer = 0;
    var serverGoodStreak = 0;
    var serverClosing = false;
    var serverOpened = false;
    var lastJoinPeers = [];

    function rateForKbps(kbps) {
        if (kbps === "auto") return 8000;
        var n = Number(kbps) || 64;
        var rate = Math.round(n * 125); // µ-law: 8 бит на отсчёт
        var best = RATE_STEPS[1];
        RATE_STEPS.forEach(function (r) {
            if (Math.abs(r - rate) < Math.abs(best - rate)) best = r;
        });
        return best;
    }

    function rateStep(rate, dir) {
        var idx = RATE_STEPS.indexOf(rate);
        if (idx < 0) idx = 1;
        idx = Math.max(0, Math.min(RATE_STEPS.length - 1, idx + dir));
        return RATE_STEPS[idx];
    }

    function saveAudioSettings(next) {
        audioSettings.mode = next.mode === "webrtc" ? "webrtc" : "server";
        audioSettings.kbps = next.kbps === "auto" ? "auto" : String(next.kbps);
        try {
            localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(audioSettings));
        } catch (e) {}
        document.dispatchEvent(new CustomEvent("synx-audio-settings", {
            detail: {mode: audioSettings.mode, kbps: audioSettings.kbps}
        }));
    }

    function getAudioSettings() {
        return {mode: audioSettings.mode, kbps: audioSettings.kbps};
    }

    /* µ-law: компактный 8-битный поток, который умеет собирать сервер
       без Opus/ffmpeg и который хорошо переживает медленные каналы. */
    function linearToUlaw(sample) {
        var sign = sample < 0 ? 0x80 : 0;
        if (sample < 0) sample = -sample;
        if (sample > 32635) sample = 32635;
        sample += 0x84;
        var exponent = 7;
        for (var mask = 0x4000; (sample & mask) === 0 && exponent > 0;
                exponent--, mask >>= 1) { /* ищем старший бит */ }
        var mantissa = (sample >> (exponent + 3)) & 0x0f;
        return (~(sign | (exponent << 4) | mantissa)) & 0xff;
    }

    function ulawToLinear(u) {
        u = (~u) & 0xff;
        var sign = u & 0x80;
        var exponent = (u >> 4) & 0x07;
        var mantissa = u & 0x0f;
        var sample = ((mantissa << 3) + 0x84) << exponent;
        sample -= 0x84;
        return sign ? -sample : sample;
    }

    function downmixToInt16(input, fromRate, toRate) {
        // Простой антиалиасинговый ФНЧ перед децимацией: без него
        // высокие частоты заворачиваются в слышимый «песок»/хрип.
        var filtered = new Float32Array(input.length);
        var alpha = 1 - Math.exp(-2 * Math.PI * 3400 / fromRate);
        for (var f = 0; f < input.length; f++) {
            captureLowPass += alpha * (input[f] - captureLowPass);
            filtered[f] = captureLowPass;
        }
        var outLen = Math.max(1, Math.floor(input.length * toRate / fromRate));
        var out = new Int16Array(outLen);
        var ratio = fromRate / toRate;
        for (var i = 0; i < outLen; i++) {
            var start = Math.floor(i * ratio);
            var end = Math.max(start + 1, Math.floor((i + 1) * ratio));
            var sum = 0, n = 0;
            for (var j = start; j < end && j < filtered.length; j++) {
                sum += filtered[j];
                n++;
            }
            var v = n ? sum / n : 0;
            out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        }
        return out;
    }

    function qs(sel, root) {
        return (root || document).querySelector(sel);
    }

    function api(path, body) {
        return fetch(path, {
            method: "POST",
            credentials: "same-origin",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body || {})
        }).then(function (r) {
            if (!r.ok) {
                return r.text().then(function (text) {
                    var err = new Error("HTTP " + r.status);
                    err.status = r.status;
                    err.detail = text;
                    throw err;
                });
            }
            return r.json();
        });
    }

    function refreshPresence() {
        document.dispatchEvent(new CustomEvent("synx-presence-refresh"));
    }

    function isConnected(id) {
        return connected && String(roomId) === String(id);
    }

    function setMuteUI() {
        if (!muteButton) return;
        muteButton.hidden = !connected;
        muteButton.textContent = "mute";
        muteButton.classList.toggle("muted", !!muted);
        muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
        muteButton.title = muted
            ? "Включить свой микрофон"
            : "Выключить свой микрофон";
    }

    function applyMuteToTracks() {
        if (!localStream) return;
        localStream.getTracks().forEach(function (t) {
            t.enabled = !muted;
        });
    }

    function toggleMute() {
        muted = !muted;
        applyMuteToTracks();
        setMuteUI();
    }

    function ensureAudioContext() {
        if (!audioCtx) {
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                return null;
            }
        }
        if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(function () {});
        }
        return audioCtx;
    }

    function attachAnalyser(stream, key) {
        var ctx = ensureAudioContext();
        if (!ctx || !stream) return;
        try {
            var src = ctx.createMediaStreamSource(stream);
            var an = ctx.createAnalyser();
            an.fftSize = 512;
            an.smoothingTimeConstant = 0.35;
            src.connect(an);
            analysers[key] = an;
        } catch (e) {}
    }

    function levelOf(an) {
        if (!an) return 0;
        var buf = new Uint8Array(an.fftSize);
        an.getByteTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) {
            var v = (buf[i] - 128) / 128;
            sum += v * v;
        }
        return Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 180));
    }

    function tickLevels() {
        if (!connected) return;
        var levels = {};
        if (analysers.local) levels[meId] = levelOf(analysers.local);
        Object.keys(analysers).forEach(function (key) {
            if (key === "local") return;
            var uid = peerUsers[key] || "";
            if (!uid) return;
            var v = levelOf(analysers[key]);
            levels[uid] = Math.max(levels[uid] || 0, v);
        });
        document.dispatchEvent(new CustomEvent("synx-audio-levels", {
            detail: {levels: levels}
        }));
        levelTimer = setTimeout(tickLevels, 90);
    }

    function setButton() {
        if (!micButton) return;
        micButton.hidden = false;
        micButton.classList.toggle("on", connected);
        micButton.setAttribute("aria-pressed", connected ? "true" : "false");
        micButton.title = connected
            ? "Выйти из аудио-комнаты"
            : "Открыть аудио-комнату";
        document.body.classList.toggle("audio-connected", connected);
    }

    function newPeerId() {
        try {
            if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        } catch (e) {}
        return "p-" + Date.now().toString(36) + "-" +
            Math.random().toString(36).slice(2);
    }

    function signal(to, kind, payload) {
        if (!connected || !roomId || !peerId) return Promise.resolve();
        return api("/api/audio/" + encodeURIComponent(roomId) + "/signal", {
            from_peer: peerId,
            to_peer: to,
            kind: kind,
            payload: payload
        }).catch(function () {});
    }

    function closePeer(id) {
        var pc = peers[id];
        if (pc) {
            try { pc.close(); } catch (e) {}
            delete peers[id];
        }
        delete pendingIce[id];
        delete analysers[id];
        var a = remoteAudio[id];
        if (a) {
            try {
                a.pause();
                a.srcObject = null;
                a.remove();
            } catch (e) {}
            delete remoteAudio[id];
        }
    }

    function closeAll() {
        Object.keys(peers).forEach(closePeer);
        Object.keys(remoteAudio).forEach(function (id) {
            var a = remoteAudio[id];
            try { a.pause(); a.srcObject = null; a.remove(); } catch (e) {}
            delete remoteAudio[id];
        });
    }

    function ensurePeer(id) {
        if (peers[id]) return peers[id];
        var pc = new RTCPeerConnection({iceServers: ICE});
        peers[id] = pc;
        pendingIce[id] = [];
        if (localStream) {
            localStream.getTracks().forEach(function (track) {
                pc.addTrack(track, localStream);
            });
        }
        pc.onicecandidate = function (e) {
            if (!e.candidate) return;
            signal(id, "ice", {candidate: e.candidate});
        };
        pc.ontrack = function (e) {
            var a = remoteAudio[id];
            if (!a) {
                a = document.createElement("audio");
                a.autoplay = true;
                a.playsInline = true;
                a.className = "audio-chat-remote";
                document.body.appendChild(a);
                remoteAudio[id] = a;
            }
            var stream = e.streams && e.streams[0];
            if (stream) a.srcObject = stream;
            else if (!a.srcObject) a.srcObject = new MediaStream([e.track]);
            a.muted = false;
            a.volume = 1;
            a.play().catch(function (err) {
                if (window.console) {
                    console.warn("[audio] autoplay blocked:", err && err.message);
                }
                setTimeout(function () {
                    a.play().catch(function () {});
                }, 300);
            });
            attachAnalyser(a.srcObject, id);
        };
        pc.onconnectionstatechange = function () {
            if (pc.connectionState === "failed" ||
                    pc.connectionState === "closed") {
                closePeer(id);
            }
        };
        return pc;
    }

    function flushIce(id) {
        var pc = peers[id];
        var list = pendingIce[id] || [];
        pendingIce[id] = [];
        list.forEach(function (candidate) {
            pc.addIceCandidate(candidate).catch(function () {});
        });
    }

    function handleSignal(msg) {
        var from = String(msg.from_peer || "");
        if (!from) return;
        var pc = ensurePeer(from);
        var payload = msg.payload || {};
        if (msg.kind === "offer") {
            return pc.setRemoteDescription(payload)
                .then(function () {
                    flushIce(from);
                    return pc.createAnswer();
                })
                .then(function (answer) {
                    return pc.setLocalDescription(answer).then(function () {
                        signal(from, "answer", answer);
                    });
                })
                .catch(function () {});
        }
        if (msg.kind === "answer") {
            return pc.setRemoteDescription(payload)
                .then(function () { flushIce(from); })
                .catch(function () {});
        }
        if (msg.kind === "ice" && payload.candidate) {
            if (pc.remoteDescription && pc.remoteDescription.type) {
                pc.addIceCandidate(payload.candidate).catch(function () {});
            } else {
                pendingIce[from].push(payload.candidate);
            }
        }
        return Promise.resolve();
    }

    function pollSignals() {
        if (!connected || pollBusy) return;
        pollBusy = true;
        fetch("/api/audio/" + encodeURIComponent(roomId) +
              "/signals?peer_id=" + encodeURIComponent(peerId) +
              "&after=" + encodeURIComponent(String(lastSignalId)), {
            credentials: "same-origin",
            cache: "no-store"
        }).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function (d) {
            (d.signals || []).forEach(function (s) {
                lastSignalId = Math.max(lastSignalId, Number(s.id) || 0);
                handleSignal(s);
            });
            var alive = {};
            var hasHost = false;
            (d.peers || []).forEach(function (p) {
                alive[String(p.peer_id)] = true;
                peerUsers[String(p.peer_id)] = String(p.user_id || "");
                if (p.host) hasHost = true;
            });
            Object.keys(peers).forEach(function (id) {
                if (!alive[id]) closePeer(id);
            });
            if (!host && !hasHost) {
                leave("host left");
            }
        }).catch(function () {
            /* signaling может мигнуть; соединение продолжает работать */
        }).finally(function () {
            pollBusy = false;
            if (connected) {
                if (pollTimer) clearTimeout(pollTimer);
                pollTimer = setTimeout(pollSignals, 400);
            }
        });
    }

    function offerTo(id) {
        if (!id || String(id) === String(peerId)) return;
        var pc = ensurePeer(id);
        pc.createOffer()
            .then(function (offer) {
                return pc.setLocalDescription(offer).then(function () {
                    signal(id, "offer", offer);
                });
            })
            .catch(function () {});
    }

    function stopTracks() {
        if (localStream) {
            localStream.getTracks().forEach(function (t) {
                try { t.stop(); } catch (e) {}
            });
            localStream = null;
        }
    }

    function getMic() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return Promise.reject(new Error("Микрофон недоступен"));
        }
        return navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                // AGC в браузере даёт рывки громкости и «глохнет» на
                // громких согласных; регулировку оставляем серверу.
                autoGainControl: false
            },
            video: false
        });
    }

    function stopServerAudio() {
        serverClosing = true;
        if (serverStatsTimer) {
            clearInterval(serverStatsTimer);
            serverStatsTimer = 0;
        }
        if (serverHeartbeatTimer) {
            clearInterval(serverHeartbeatTimer);
            serverHeartbeatTimer = 0;
        }
        if (serverWs) {
            try { serverWs.close(); } catch (e) {}
            serverWs = null;
        }
        if (serverProcessor) {
            try { serverProcessor.disconnect(); } catch (e) {}
            serverProcessor.onaudioprocess = null;
            serverProcessor = null;
        }
        if (serverSource) {
            try { serverSource.disconnect(); } catch (e) {}
            serverSource = null;
        }
        if (serverSink) {
            try { serverSink.disconnect(); } catch (e) {}
            serverSink = null;
        }
        if (serverPlayNode) {
            try { serverPlayNode.disconnect(); } catch (e) {}
            serverPlayNode.onaudioprocess = null;
            serverPlayNode = null;
        }
        serverRoom = "";
        serverPlayData = [];
        serverPlayRead = 0;
        serverPlayPrimed = false;
        serverGoodStreak = 0;
        setTimeout(function () { serverClosing = false; }, 0);
    }

    function enqueueServerAudio(buffer) {
        if (!buffer || !buffer.byteLength) return;
        var bytes = new Uint8Array(buffer);
        for (var i = 0; i < bytes.length; i++) {
            serverPlayData.push(ulawToLinear(bytes[i]) / 32768);
        }
        // Не держим больше ~2 секунд: при перегрузке лучше отстать,
        // чем накапливать задержку.
        var maxSamples = Math.max(serverOutRate * 2, 2048);
        if (serverPlayData.length > maxSamples) {
            var drop = serverPlayData.length - maxSamples;
            serverPlayData.splice(0, drop);
            serverPlayRead = Math.max(0, serverPlayRead - drop);
        }
    }

    function startServerPlayback() {
        if (serverPlayNode) return;
        var ctx = ensureAudioContext();
        if (!ctx) return;
        serverPlayNode = ctx.createScriptProcessor(1024, 1, 1);
        serverPlayNode.onaudioprocess = function (ev) {
            var out = ev.outputBuffer.getChannelData(0);
            var srcRate = serverOutRate || 8000;
            var step = srcRate / ctx.sampleRate;
            if (!serverPlayData.length) {
                out.fill(0);
                serverPlayRead = 0;
                serverPlayPrimed = false;
                return;
            }
            if (!serverPlayPrimed) {
                if (serverPlayData.length < (serverOutRate || 8000) * 0.08) {
                    out.fill(0);
                    return;
                }
                serverPlayPrimed = true;
                serverPlayRead = 0;
            }
            if (serverPlayRead >= serverPlayData.length) serverPlayRead = 0;
            var read = serverPlayRead;
            for (var i = 0; i < out.length; i++) {
                var idx = Math.floor(read);
                var frac = read - idx;
                var a = idx < serverPlayData.length ? serverPlayData[idx] : 0;
                var b = idx + 1 < serverPlayData.length ? serverPlayData[idx + 1] : a;
                out[i] = a + (b - a) * frac;
                read += step;
            }
            serverPlayRead = read;
            if (serverPlayRead > 8192 && serverPlayRead > serverPlayData.length / 2) {
                var drop = Math.floor(serverPlayRead) - 1;
                if (drop > 0) {
                    serverPlayData.splice(0, drop);
                    serverPlayRead -= drop;
                }
            }
        };
        serverPlayNode.connect(ctx.destination);
    }

    function startPcmCapture() {
        if (serverProcessor || !localStream) return;
        var ctx = ensureAudioContext();
        if (!ctx) return;
        captureLowPass = 0;
        try {
            serverSource = ctx.createMediaStreamSource(localStream);
            serverProcessor = ctx.createScriptProcessor(1024, 1, 1);
            serverSink = ctx.createGain();
            serverSink.gain.value = 0;
            serverProcessor.onaudioprocess = function (ev) {
                if (!serverWs || serverWs.readyState !== 1 || muted) return;
                try {
                    var pcm = downmixToInt16(
                        ev.inputBuffer.getChannelData(0), ctx.sampleRate,
                        serverInRate);
                    var out = new Uint8Array(pcm.length);
                    for (var i = 0; i < pcm.length; i++) {
                        out[i] = linearToUlaw(pcm[i]);
                    }
                    serverWs.send(out.buffer);
                } catch (e) {}
            };
            serverSource.connect(serverProcessor);
            serverProcessor.connect(serverSink);
            serverSink.connect(ctx.destination);
        } catch (e) {
            stopPcmCapture();
        }
    }

    function stopPcmCapture() {
        if (serverProcessor) {
            try { serverProcessor.disconnect(); } catch (e) {}
            serverProcessor.onaudioprocess = null;
            serverProcessor = null;
        }
        if (serverSource) {
            try { serverSource.disconnect(); } catch (e) {}
            serverSource = null;
        }
        if (serverSink) {
            try { serverSink.disconnect(); } catch (e) {}
            serverSink = null;
        }
    }

    function sendServerSettings() {
        if (!serverWs || serverWs.readyState !== 1) return;
        try {
            serverWs.send(JSON.stringify({
                type: "in_rate", value: serverInRate
            }));
        } catch (e) {}
    }

    function serverStatsTick() {
        if (!serverWs || serverWs.readyState !== 1) return;
        var buffered = Number(serverWs.bufferedAmount) || 0;
        if (serverAuto) {
            var next = serverInRate;
            if (buffered > 64000) {
                next = rateStep(serverInRate, -1);
                serverGoodStreak = 0;
            } else if (buffered < 8000) {
                serverGoodStreak++;
                if (serverGoodStreak >= 3) {
                    next = rateStep(serverInRate, 1);
                    serverGoodStreak = 0;
                }
            } else {
                serverGoodStreak = 0;
            }
            if (next !== serverInRate) {
                serverInRate = next;
                sendServerSettings();
            }
        }
        var ctx = ensureAudioContext();
        var latency = 0;
        if (ctx && serverOutRate) {
            latency = Math.max(0, Math.round(
                (serverPlayData.length - serverPlayRead) /
                serverOutRate * 1000));
        }
        try {
            serverWs.send(JSON.stringify({
                type: "stats", buffered: buffered,
                latency: latency, in_rate: serverInRate
            }));
        } catch (e) {}
    }

    function serverHeartbeat() {
        if (!connected || !serverRoom || serverRoom !== String(roomId)) return;
        api("/api/audio/" + encodeURIComponent(serverRoom) + "/join", {
            peer_id: peerId,
            name: (window.SYNX_SHORT_NAME || meId),
            host: host
        }).catch(function () {});
    }

    function fallbackToWebRtc() {
        if (!connected) return;
        if (window.console) {
            console.warn("[audio] server mixer unavailable, using WebRTC fallback");
        }
        if (serverStatsTimer) {
            clearInterval(serverStatsTimer);
            serverStatsTimer = 0;
        }
        if (serverHeartbeatTimer) {
            clearInterval(serverHeartbeatTimer);
            serverHeartbeatTimer = 0;
        }
        if (serverWs) {
            try { serverWs.close(); } catch (e) {}
            serverWs = null;
        }
        serverRoom = "";
        serverPlayData = [];
        serverPlayRead = 0;
        serverOpened = false;
        startWebRtcAudio(lastJoinPeers);
    }

    function applyLiveServerRate(kbps) {
        if (!connected || audioSettings.mode !== "server" ||
                !serverWs || serverWs.readyState !== 1) return;
        serverAuto = kbps === "auto";
        serverInRate = rateForKbps(kbps);
        if (!serverAuto) serverOutRate = serverInRate;
        try {
            serverWs.send(JSON.stringify({
                type: "in_rate", value: serverInRate
            }));
            serverWs.send(JSON.stringify({
                type: "out_rate", value: serverOutRate, auto: serverAuto
            }));
        } catch (e) {}
        serverPlayData = [];
        serverPlayRead = 0;
        serverPlayPrimed = false;
    }

    document.addEventListener("synx-audio-settings", function (e) {
        if (!connected || audioSettings.mode !== "server") return;
        applyLiveServerRate(e.detail && e.detail.kbps);
    });

    function startServerAudio(room, peer) {
        serverAuto = audioSettings.kbps === "auto";
        serverInRate = rateForKbps(audioSettings.kbps);
        serverOutRate = serverInRate;
        serverRoom = String(room);
        serverPlayData = [];
        serverPlayRead = 0;
        serverPlayPrimed = false;
        serverClosing = false;
        serverOpened = false;
        var wsLoc = window.location;
        if (!wsLoc.host && window.opener && window.opener.location) {
            try { wsLoc = window.opener.location; } catch (e) {}
        }
        var proto = wsLoc.protocol === "https:" ? "wss:" : "ws:";
        var url = proto + "//" + wsLoc.host +
            "/api/audio/" + encodeURIComponent(room) + "/ws?" +
            "peer=" + encodeURIComponent(peer) +
            "&in_rate=" + encodeURIComponent(serverInRate) +
            "&out_rate=" + encodeURIComponent(serverOutRate) +
            "&auto=" + (serverAuto ? "1" : "0");
        try {
            serverWs = new WebSocket(url);
        } catch (e) {
            fallbackToWebRtc();
            return;
        }
        serverWs.binaryType = "arraybuffer";
        serverWs.onopen = function () {
            if (!connected || serverRoom !== String(roomId)) return;
            serverOpened = true;
            startPcmCapture();
            startServerPlayback();
            if (serverStatsTimer) clearInterval(serverStatsTimer);
            serverStatsTimer = setInterval(serverStatsTick, 2000);
            if (serverHeartbeatTimer) clearInterval(serverHeartbeatTimer);
            serverHeartbeatTimer = setInterval(serverHeartbeat, 30000);
            serverHeartbeat();
        };
        serverWs.onmessage = function (ev) {
            if (typeof ev.data === "string") {
                try {
                    var msg = JSON.parse(ev.data);
                    if (msg.type === "settings") {
                        if (msg.out_rate) {
                            var nextOut = Number(msg.out_rate);
                            if (nextOut && nextOut !== serverOutRate) {
                                serverOutRate = nextOut;
                                serverPlayData = [];
                                serverPlayRead = 0;
                                serverPlayPrimed = false;
                            }
                        }
                    } else if (msg.type === "levels") {
                        document.dispatchEvent(new CustomEvent("synx-audio-levels", {
                            detail: {levels: msg.levels || {}}
                        }));
                    }
                } catch (e) {}
                return;
            }
            enqueueServerAudio(ev.data);
        };
        serverWs.onclose = function (ev) {
            serverWs = null;
            if (serverStatsTimer) {
                clearInterval(serverStatsTimer);
                serverStatsTimer = 0;
            }
            if (serverHeartbeatTimer) {
                clearInterval(serverHeartbeatTimer);
                serverHeartbeatTimer = 0;
            }
            if (ev && ev.code === 4001) {
                // Эту вкладку заменило более новое подключение того же
                // пользователя. Не запускаем WebRTC-дубль.
                leave("replaced by newer audio connection", true);
                return;
            }
            if (!serverClosing && connected && serverRoom === String(roomId)) {
                // Маршрут /ws не настроен в nginx или микшер недоступен.
                // Не оставляем пользователя с мигающей кнопкой: на этот
                // сеанс возвращаемся к прежнему WebRTC-механизму.
                fallbackToWebRtc();
            }
        };
        serverWs.onerror = function () {
            /* onclose сделает уборку */
        };
    }

    function leave(reason, skipServerLeave) {
        stopServerAudio();
        var oldRoom = roomId;
        var oldPeer = peerId;
        connected = false;
        joining = false;
        host = false;
        roomId = "";
        peerId = "";
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
        if (levelTimer) { clearTimeout(levelTimer); levelTimer = 0; }
        closeAll();
        stopTracks();
        analysers = {};
        peerUsers = {};
        document.dispatchEvent(new CustomEvent("synx-audio-levels", {
            detail: {levels: {}}
        }));
        setButton();
        setMuteUI();
        if (oldRoom && oldPeer && !skipServerLeave) {
            api("/api/audio/" + encodeURIComponent(oldRoom) + "/leave", {
                peer_id: oldPeer
            }).catch(function () {});
        }
        refreshPresence();
        if (reason && window.console) console.debug("[audio]", reason);
    }

    function startWebRtcAudio(existingPeers) {
        if (!levelTimer) tickLevels();
        (existingPeers || []).forEach(function (p) {
            if (p.peer_id) peerUsers[String(p.peer_id)] = String(p.user_id || "");
            if (String(p.peer_id) !== String(peerId)) {
                offerTo(String(p.peer_id));
            }
        });
        if (localStream) attachAnalyser(localStream, "local");
        refreshPresence();
        pollSignals();
    }

    function join(target, asHost) {
        if (!target || joining) return;
        if (connected) {
            leave("switch room");
        }
        // Создаём/возобновляем AudioContext прямо в обработчике клика:
        // иначе после ожидания getUserMedia/HTTP браузер может оставить
        // контекст suspended, и связь есть, а звука нет.
        ensureAudioContext();
        var seq = ++joinSeq;
        joining = true;
        roomId = String(target);
        host = !!asHost;
        peerId = newPeerId();
        lastSignalId = 0;
        getMic().then(function (stream) {
            if (seq !== joinSeq) return null;
            localStream = stream;
            return api("/api/audio/" + encodeURIComponent(roomId) + "/join", {
                peer_id: peerId,
                name: (window.SYNX_SHORT_NAME || meId),
                host: host
            });
        }).then(function (d) {
            if (seq !== joinSeq || !d) return;
            connected = true;
            joining = false;
            applyMuteToTracks();
            setButton();
            setMuteUI();
            lastJoinPeers = (d && d.peers) || [];
            if (audioSettings.mode === "webrtc") {
                startWebRtcAudio(lastJoinPeers);
            } else {
                if (localStream) attachAnalyser(localStream, "local");
                startServerAudio(roomId, peerId);
                refreshPresence();
            }
        }).catch(function (err) {
            if (seq !== joinSeq) return;
            joining = false;
            leave("join failed");
            if (window.console) console.warn("[audio] join:", err && err.message);
            alert("Не удалось подключиться к аудио-комнате: " +
                  (err && err.message ? err.message : "нет доступа к микрофону"));
        });
    }

    function toggleRoom(target) {
        if (!target) return;
        if (isConnected(target)) {
            leave("user");
            return;
        }
        join(target, false);
    }

    function createRoom(name, inviteIds, autoJoin) {
        return api("/api/audio/rooms", {
            name: name,
            invite_ids: inviteIds || []
        }).then(function (d) {
            var room = d && d.room;
            if (!room || !room.id) throw new Error("Пустая комната");
            if (autoJoin !== false) join(room.id, true);
            return room;
        });
    }

    function joinRoom(roomId) {
        if (!roomId) return;
        if (isConnected(roomId)) {
            leave("user");
            return;
        }
        fetch("/api/audio/rooms/" + encodeURIComponent(roomId), {
            credentials: "same-origin", cache: "no-store"
        }).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function (d) {
            var room = (d && d.room) || {};
            if (room.audio !== false) join(String(roomId), false);
        }).catch(function (err) {
            alert("Не удалось подключиться к чат-руму: " + err.message);
        });
    }

    function toggleHost() {
        if (connected) {
            leave("host");
            return;
        }
        createRoom("Чат-рум " + (window.SYNX_SHORT_NAME || ""), [], true)
            .catch(function (err) {
                alert("Не удалось создать аудио-комнату: " +
                      (err && err.message ? err.message : "ошибка"));
            });
    }

    if (micButton) {
        micButton.hidden = false;
        micButton.addEventListener("click", function (e) {
            e.stopPropagation();
            toggleHost();
        });
    }
    if (muteButton) {
        muteButton.hidden = true;
        muteButton.addEventListener("click", function (e) {
            e.stopPropagation();
            toggleMute();
        });
    }
    setMuteUI();

    /* Некоторые браузеры блокируют autoplay входящего WebRTC-звука до
       явного клика. Любой клик по странице — разрешённый жест: возобновляем
       AudioContext и повторяем play() для уже созданных remote audio. */
    document.addEventListener("pointerdown", function () {
        ensureAudioContext();
        Object.keys(remoteAudio).forEach(function (id) {
            var a = remoteAudio[id];
            if (a && a.paused) a.play().catch(function () {});
        });
    }, true);

    window.addEventListener("pagehide", function () {
        if (connected && roomId && peerId) {
            try {
                navigator.sendBeacon(
                    "/api/audio/" + encodeURIComponent(roomId) + "/leave",
                    new Blob([JSON.stringify({peer_id: peerId})], {
                        type: "application/json"
                    })
                );
            } catch (e) {}
        }
    });

    window.SynxAudioChat = {
        toggleRoom: toggleRoom,
        joinRoom: joinRoom,
        joinAsHost: function (roomId) {
            if (roomId) join(String(roomId), true);
        },
        createRoom: createRoom,
        isConnected: isConnected,
        isHost: function () { return host; },
        isActive: function () { return connected; },
        getSettings: getAudioSettings,
        setSettings: saveAudioSettings
    };
})();
