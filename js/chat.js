// Chat between consumer and producer: text, emoji, photos, voice messages, audio files,
// and voice / video calls. Shared by both dashboards.
// Use: HBChat.openProduct(productId) (consumer) and HBChat.openInbox() (both).
(function () {
  "use strict";

  function readStored(key) {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  }

  const token = readStored("token");
  if (!token) return;

  const MAX_FILE_MB = 10;
  const FILE_OK = /^(image\/(jpeg|png|webp|gif)|audio\/(webm|ogg|mpeg|mp3|mp4|x-m4a|aac|wav|x-wav))$/;
  const EMOJIS = ("😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 😘 😋 😎 🤩 🥳 🤗 🤔 😐 😮 😢 😭 😡 🙏 👍 👎 👏 🙌 💪 👋 🤝 ❤️ 💚 💛 🔥 ✨ 🎉 💯 ✅ ❌ ⭐ 📦 🚚 💳 💰 🛒 🍎 🍞 ☕ 🌽 🐄 🌾").split(" ");

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  async function api(url, options) {
    const opts = options || {};
    const headers = Object.assign({ Authorization: "Bearer " + token }, opts.headers || {});
    const response = await fetch(url, Object.assign({}, opts, { headers }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Something went wrong.");
    return data;
  }

  function postJSON(url, body) {
    return api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  function timeText(value) {
    const d = new Date(value);
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return time;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + time;
  }

  const $ = (id) => document.getElementById(id);

  // ---------- Build the windows once ----------
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "chatModal";
  modal.hidden = true;
  modal.innerHTML =
    '<div class="modal-box chat-box" role="dialog" aria-modal="true" aria-label="Chat">' +
    '<button type="button" class="modal-close" data-close aria-label="Close">×</button>' +
    '<div class="chat-head"><button type="button" class="chat-back" id="chatBack" aria-label="Back to messages" hidden>←</button>' +
    '<div class="chat-head-text"><h2 id="chatTitle">Messages</h2><p id="chatSub"></p></div>' +
    '<div class="chat-calls" id="chatCalls" hidden>' +
    '<button type="button" class="chat-icon" id="chatVoiceCall" aria-label="Voice call" title="Voice call">📞</button>' +
    '<button type="button" class="chat-icon" id="chatVideoCall" aria-label="Video call" title="Video call">🎥</button></div></div>' +
    '<p class="chat-safe" id="chatSafe" hidden>For your safety, keep payments inside this website. Never send money directly to someone you chat with.</p>' +
    '<div class="chat-list" id="chatInbox"></div>' +
    '<div class="chat-msgs" id="chatMsgs" hidden></div>' +
    '<div class="chat-error" id="chatError" role="alert"></div>' +
    '<div class="emoji-panel" id="emojiPanel" hidden></div>' +
    '<div class="rec-bar" id="recBar" hidden><span class="rec-dot"></span><span id="recTime">0:00</span>' +
    '<button type="button" class="mini danger" id="recCancel">Cancel</button>' +
    '<button type="button" class="mini ok" id="recSend">Send</button></div>' +
    '<form class="chat-form" id="chatForm" hidden>' +
    '<button type="button" class="chat-icon" id="emojiBtn" aria-label="Emoji">😊</button>' +
    '<button type="button" class="chat-icon" id="attachBtn" aria-label="Send a photo or audio file">📎</button>' +
    '<input type="file" id="chatFile" accept="image/jpeg,image/png,image/webp,image/gif,audio/*" hidden />' +
    '<textarea id="chatInput" rows="1" maxlength="1000" placeholder="Write a message..." aria-label="Message"></textarea>' +
    '<button type="button" class="chat-icon" id="micBtn" aria-label="Record a voice message">🎤</button>' +
    '<button type="submit" class="btn" id="chatSend">Send</button></form></div>';
  document.body.appendChild(modal);

  const overlay = document.createElement("div");
  overlay.className = "call-overlay";
  overlay.id = "callOverlay";
  overlay.hidden = true;
  overlay.innerHTML =
    '<video id="callRemote" class="call-remote" autoplay playsinline></video>' +
    '<video id="callLocal" class="call-local" autoplay playsinline muted></video>' +
    '<div class="call-info"><div class="call-avatar" id="callAvatar">📞</div><h3 id="callName"></h3><p id="callStatus"></p></div>' +
    '<div class="call-actions">' +
    '<button type="button" class="call-btn" id="callMute" aria-label="Mute microphone">🎤</button>' +
    '<button type="button" class="call-btn" id="callCam" aria-label="Turn camera off">📷</button>' +
    '<button type="button" class="call-btn accept" id="callAccept" aria-label="Accept">📞</button>' +
    '<button type="button" class="call-btn hang" id="callHang" aria-label="Hang up">✖</button></div>';
  document.body.appendChild(overlay);

  // =====================================================
  // WINDOW STATE
  // =====================================================
  let currentId = null;
  let lastMessageId = 0;
  let pollTimer = null;
  let busy = false;
  let currentOther = "";

  function show() {
    modal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function hideTools() {
    $("emojiPanel").hidden = true;
  }

  function setMode(mode) {
    const inRoom = mode === "room";
    $("chatInbox").hidden = inRoom;
    $("chatMsgs").hidden = !inRoom;
    $("chatForm").hidden = !inRoom;
    $("chatSafe").hidden = !inRoom;
    $("chatBack").hidden = !inRoom;
    $("chatCalls").hidden = !inRoom;
    $("chatError").textContent = "";
    hideTools();
    if (!inRoom) {
      cancelRecording();
      currentId = null;
      lastMessageId = 0;
      stopPolling();
      $("chatTitle").textContent = "Messages";
      $("chatSub").textContent = "";
    }
  }

  // ---------- Inbox ----------
  async function openInbox() {
    show();
    setMode("inbox");
    $("chatInbox").innerHTML = '<p class="chat-empty">Loading...</p>';
    try {
      const data = await api("/api/chat/conversations");
      if (data.conversations.length === 0) {
        $("chatInbox").innerHTML = '<p class="chat-empty">No messages yet. Open a product and tap "Ask the seller" to start a chat.</p>';
        return;
      }
      $("chatInbox").innerHTML = data.conversations.map((c) =>
        '<button type="button" class="chat-item" data-chat-open="' + esc(c.id) + '">' +
        '<div class="ci-main"><strong>' + esc(c.otherName) + " · " + esc(c.productName) + "</strong>" +
        "<small>" + esc(c.lastMessage || "") + "</small></div>" +
        (c.unread > 0 ? '<span class="ci-badge">' + esc(c.unread) + "</span>" : "") + "</button>"
      ).join("");
    } catch (err) {
      $("chatInbox").innerHTML = '<p class="chat-empty">' + esc(err.message) + "</p>";
    }
    refreshBadge();
  }

  // ---------- Showing messages ----------
  const mediaCache = new Map(); // message id -> object URL

  async function mediaUrl(id) {
    if (mediaCache.has(id)) return mediaCache.get(id);
    const response = await fetch("/api/chat/files/" + encodeURIComponent(id), { headers: { Authorization: "Bearer " + token } });
    if (!response.ok) throw new Error("File not available.");
    const url = URL.createObjectURL(await response.blob());
    mediaCache.set(id, url);
    return url;
  }

  function fillMedia(div, m) {
    const slot = div.querySelector("[data-media]");
    if (!slot) return;
    mediaUrl(m.id).then((url) => {
      if (m.kind === "image") {
        slot.innerHTML = '<a href="' + url + '" target="_blank" rel="noopener"><img src="' + url + '" alt="Photo"></a>';
      } else {
        slot.innerHTML = '<audio controls preload="metadata" src="' + url + '"></audio>';
      }
    }).catch(() => { slot.textContent = "⚠️ File not available"; });
  }

  function addMessages(list) {
    const box = $("chatMsgs");
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    list.forEach((m) => {
      if (m.id <= lastMessageId) return;
      lastMessageId = m.id;

      const div = document.createElement("div");
      if (m.kind === "call") {
        div.className = "msg call-note";
        div.textContent = m.body + " · " + timeText(m.createdAt);
      } else {
        div.className = "msg" + (m.mine ? " mine" : "") + (m.kind === "image" ? " media" : "");
        let inner;
        if (m.kind === "image") inner = '<div data-media class="media-slot">Loading photo...</div>';
        else if (m.kind === "voice") inner = '<div class="voice-label">🎤 Voice message</div><div data-media class="media-slot">Loading...</div>';
        else if (m.kind === "audio") inner = '<div class="voice-label">🎵 ' + esc(m.fileName || "Audio") + '</div><div data-media class="media-slot">Loading...</div>';
        else inner = esc(m.body);
        div.innerHTML = inner + "<time>" + esc(timeText(m.createdAt)) + "</time>";
        if (m.kind !== "text") fillMedia(div, m);
      }
      box.appendChild(div);
    });
    if (list.length > 0 && nearBottom) box.scrollTop = box.scrollHeight;
  }

  async function fetchMessages(first) {
    if (!currentId || busy) return;
    const id = currentId;
    busy = true;
    try {
      const data = await api("/api/chat/conversations/" + encodeURIComponent(id) + "/messages?after=" + lastMessageId);
      if (id !== currentId) return;
      if (first) {
        currentOther = data.conversation.otherName;
        $("chatTitle").textContent = data.conversation.otherName + (data.conversation.otherNickname ? " @" + data.conversation.otherNickname : "");
        $("chatSub").textContent = "About: " + data.conversation.productName;
        $("chatMsgs").innerHTML = "";
        if (data.messages.length === 0) {
          $("chatMsgs").innerHTML = '<p class="chat-empty">Say hello and ask your question about the product.</p>';
        }
      }
      if (data.messages.length > 0) {
        const empty = $("chatMsgs").querySelector(".chat-empty");
        if (empty) empty.remove();
        addMessages(data.messages);
        if (first) $("chatMsgs").scrollTop = $("chatMsgs").scrollHeight;
      }
    } catch (err) {
      if (first) $("chatError").textContent = err.message;
    } finally {
      busy = false;
    }
  }

  async function openConversation(id) {
    show();
    setMode("room");
    currentId = id;
    lastMessageId = 0;
    $("chatMsgs").innerHTML = '<p class="chat-empty">Loading...</p>';
    await fetchMessages(true);

    stopPolling();
    pollTimer = setInterval(() => {
      if (modal.hidden) { stopPolling(); currentId = null; return; }
      fetchMessages(false);
    }, 3000);
    $("chatInput").focus();
  }

  async function openProduct(productId) {
    try {
      const data = await postJSON("/api/chat/start", { productId });
      await openConversation(data.conversationId);
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- Sending text ----------
  function showSent(message) {
    const empty = $("chatMsgs").querySelector(".chat-empty");
    if (empty) empty.remove();
    addMessages([message]);
    $("chatMsgs").scrollTop = $("chatMsgs").scrollHeight;
  }

  $("chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("chatInput");
    const text = input.value.trim();
    if (!text || !currentId) return;

    const button = $("chatSend");
    button.disabled = true;
    $("chatError").textContent = "";
    hideTools();
    try {
      const data = await postJSON("/api/chat/conversations/" + encodeURIComponent(currentId) + "/messages", { body: text });
      input.value = "";
      showSent(data.message);
    } catch (err) {
      $("chatError").textContent = err.message;
    } finally {
      button.disabled = false;
      input.focus();
    }
  });

  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("chatForm").requestSubmit();
    }
  });

  // ---------- Emoji ----------
  $("emojiPanel").innerHTML = EMOJIS.map((em) => '<button type="button" data-emoji="' + em + '">' + em + "</button>").join("");

  $("emojiBtn").addEventListener("click", () => {
    $("emojiPanel").hidden = !$("emojiPanel").hidden;
  });

  $("emojiPanel").addEventListener("click", (e) => {
    const b = e.target.closest("[data-emoji]");
    if (!b) return;
    const input = $("chatInput");
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? start : input.selectionEnd;
    const next = input.value.slice(0, start) + b.dataset.emoji + input.value.slice(end);
    if (next.length > input.maxLength) return;
    input.value = next;
    const pos = start + b.dataset.emoji.length;
    input.focus();
    input.setSelectionRange(pos, pos);
  });

  // ---------- Photos and audio files ----------
  async function uploadFile(file, kind) {
    if (!currentId) return;
    const mime = String(file.type).split(";")[0].toLowerCase();
    if (!FILE_OK.test(mime)) {
      $("chatError").textContent = "Only photos (JPG, PNG, WEBP, GIF) and audio files can be sent.";
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      $("chatError").textContent = "The file is too big (max " + MAX_FILE_MB + "MB).";
      return;
    }
    $("chatError").textContent = "Sending...";
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file, file.name || (kind === "voice" ? "voice" : "file"));
    try {
      const data = await api("/api/chat/conversations/" + encodeURIComponent(currentId) + "/attachments", { method: "POST", body: form });
      $("chatError").textContent = "";
      showSent(data.message);
    } catch (err) {
      $("chatError").textContent = err.message;
    }
  }

  $("attachBtn").addEventListener("click", () => $("chatFile").click());

  $("chatFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    uploadFile(file, file.type.startsWith("image/") ? "image" : "audio");
  });

  // ---------- Voice messages ----------
  let recorder = null;
  let recChunks = [];
  let recStream = null;
  let recTimer = null;
  let recStarted = 0;
  let recSendOnStop = false;

  function micSupported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function pickMime() {
    const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    return options.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  function recClock() {
    const secs = Math.floor((Date.now() - recStarted) / 1000);
    $("recTime").textContent = Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
    if (secs >= 180) stopRecording(true); // 3 minutes maximum
  }

  async function startRecording() {
    if (recorder) return;
    if (!micSupported()) {
      $("chatError").textContent = "Your browser cannot record voice. Try Chrome, Edge or Firefox, on https or localhost.";
      return;
    }
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      $("chatError").textContent = "Microphone is blocked. Allow the microphone in your browser and try again.";
      return;
    }

    const mime = pickMime();
    recChunks = [];
    recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
    recorder.onstop = () => {
      const type = (recorder && recorder.mimeType) || mime || "audio/webm";
      const chunks = recChunks;
      const send = recSendOnStop;
      cleanupRecording();
      if (send && chunks.length > 0) {
        uploadFile(new Blob(chunks, { type }), "voice");
      }
    };
    recSendOnStop = false;
    recorder.start();
    recStarted = Date.now();
    $("recTime").textContent = "0:00";
    $("recBar").hidden = false;
    $("chatForm").hidden = true;
    recTimer = setInterval(recClock, 500);
  }

  function cleanupRecording() {
    clearInterval(recTimer);
    recTimer = null;
    if (recStream) recStream.getTracks().forEach((t) => t.stop());
    recStream = null;
    recorder = null;
    recChunks = [];
    $("recBar").hidden = true;
    if (currentId) $("chatForm").hidden = false;
  }

  function stopRecording(send) {
    if (!recorder) return;
    recSendOnStop = send;
    if (recorder.state !== "inactive") recorder.stop();
    else cleanupRecording();
  }

  function cancelRecording() {
    if (recorder) stopRecording(false);
  }

  $("micBtn").addEventListener("click", startRecording);
  $("recCancel").addEventListener("click", () => stopRecording(false));
  $("recSend").addEventListener("click", () => stopRecording(true));

  $("chatBack").addEventListener("click", openInbox);

  $("chatInbox").addEventListener("click", (e) => {
    const item = e.target.closest("[data-chat-open]");
    if (item) openConversation(Number(item.dataset.chatOpen));
  });

  function afterClose() {
    setTimeout(() => {
      if (modal.hidden) {
        cancelRecording();
        stopPolling();
        currentId = null;
        refreshBadge();
      }
    }, 0);
  }
  modal.addEventListener("click", afterClose);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") afterClose(); });

  // =====================================================
  // VOICE AND VIDEO CALLS (WebRTC)
  // =====================================================
  const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };
  let call = null;          // the call in progress
  let incoming = null;      // a call that is ringing for me
  let incomingBusy = false;

  function setCallUI(opts) {
    overlay.hidden = false;
    document.body.classList.add("modal-open");
    overlay.classList.toggle("is-video", opts.type === "video");
    $("callName").textContent = opts.name || "";
    $("callStatus").textContent = opts.status || "";
    $("callAccept").hidden = !opts.ringing;
    $("callMute").hidden = opts.ringing;
    $("callCam").hidden = opts.ringing || opts.type !== "video";
    $("callHang").setAttribute("aria-label", opts.ringing ? "Decline" : "Hang up");
  }

  function hideCallUI() {
    overlay.hidden = true;
    $("callRemote").srcObject = null;
    $("callLocal").srcObject = null;
    $("callMute").textContent = "🎤";
    $("callCam").textContent = "📷";
    if (!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("modal-open");
  }

  function getMedia(type) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
      return Promise.reject(new Error("Calls are not supported in this browser (use Chrome, Edge or Firefox, on https or localhost)."));
    }
    return navigator.mediaDevices.getUserMedia({ audio: true, video: type === "video" }).catch(() => {
      throw new Error("Could not use your microphone" + (type === "video" ? " or camera" : "") + ". Allow it in your browser and try again.");
    });
  }

  function newCall(id, type, role, name, stream) {
    const c = {
      id, type, role, name, stream,
      pc: null, pending: [], remoteSet: false, offered: false,
      timer: null, startedAt: 0, closed: false, polling: false, loop: null
    };

    const pc = new RTCPeerConnection(ICE);
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.onicecandidate = (e) => {
      if (e.candidate) postJSON("/api/chat/calls/" + c.id + "/signal", { data: { candidate: e.candidate.toJSON() } }).catch(() => {});
    };
    pc.ontrack = (e) => {
      const remote = $("callRemote");
      if (remote.srcObject !== e.streams[0]) remote.srcObject = e.streams[0];
      remote.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (c.closed) return;
      if (pc.connectionState === "connected" && !c.startedAt) {
        c.startedAt = Date.now();
        c.timer = setInterval(() => {
          const secs = Math.floor((Date.now() - c.startedAt) / 1000);
          $("callStatus").textContent = Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
        }, 1000);
      }
      if (pc.connectionState === "failed") endCall("Connection failed. Both people may be behind a strict network.", true);
    };
    c.pc = pc;

    $("callLocal").srcObject = type === "video" ? stream : null;
    return c;
  }

  async function handleSignals(c, signals) {
    for (const s of signals) {
      try {
        if (s.sdp) {
          await c.pc.setRemoteDescription(s.sdp);
          c.remoteSet = true;
          if (s.sdp.type === "offer") {
            const answer = await c.pc.createAnswer();
            await c.pc.setLocalDescription(answer);
            await postJSON("/api/chat/calls/" + c.id + "/signal", { data: { sdp: c.pc.localDescription.toJSON() } });
          }
          while (c.pending.length) await c.pc.addIceCandidate(c.pending.shift());
        } else if (s.candidate) {
          if (c.remoteSet) await c.pc.addIceCandidate(s.candidate);
          else c.pending.push(s.candidate);
        }
      } catch (err) {
        // one bad message should not drop the call
      }
    }
  }

  function startCallLoop(c) {
    c.loop = setInterval(async () => {
      if (c.closed || c.polling) return;
      c.polling = true;
      try {
        const data = await api("/api/chat/calls/" + c.id + "/poll");
        if (c.closed) return;

        if (["ended", "declined", "missed", "cancelled"].includes(data.state)) {
          const text = data.state === "declined" ? "Call declined."
            : data.state === "missed" || data.state === "cancelled" ? "No answer." : "Call ended.";
          await handleSignals(c, data.signals);
          endCall(text, false);
          return;
        }

        if (data.state === "active" && c.role === "caller" && !c.offered) {
          c.offered = true;
          $("callStatus").textContent = "Connecting...";
          const offer = await c.pc.createOffer();
          await c.pc.setLocalDescription(offer);
          await postJSON("/api/chat/calls/" + c.id + "/signal", { data: { sdp: c.pc.localDescription.toJSON() } });
        }
        await handleSignals(c, data.signals);
      } catch (err) {
        // network hiccup: try again on the next tick
      } finally {
        c.polling = false;
      }
    }, 1000);
  }

  function endCall(text, tellServer) {
    const c = call;
    if (!c || c.closed) return;
    c.closed = true;
    clearInterval(c.loop);
    clearInterval(c.timer);
    if (tellServer) postJSON("/api/chat/calls/" + c.id + "/end").catch(() => {});
    try { c.pc.close(); } catch (e) { /* already closed */ }
    c.stream.getTracks().forEach((t) => t.stop());
    call = null;
    if (text) {
      $("callStatus").textContent = text;
      $("callAccept").hidden = true;
      $("callMute").hidden = true;
      $("callCam").hidden = true;
      setTimeout(() => { if (!call && !incoming) hideCallUI(); }, 1500);
    } else {
      hideCallUI();
    }
    if (currentId) fetchMessages(false);
  }

  async function startCall(type) {
    if (!currentId || call || incoming) return;
    let stream;
    try {
      stream = await getMedia(type);
    } catch (err) {
      $("chatError").textContent = err.message;
      return;
    }

    try {
      const data = await postJSON("/api/chat/conversations/" + encodeURIComponent(currentId) + "/call", { type });
      call = newCall(data.callId, type, "caller", currentOther, stream);
      setCallUI({ type, name: currentOther, status: "Ringing...", ringing: false });
      startCallLoop(call);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      $("chatError").textContent = err.message;
    }
  }

  $("chatVoiceCall").addEventListener("click", () => startCall("voice"));
  $("chatVideoCall").addEventListener("click", () => startCall("video"));

  // Someone is calling me
  async function checkIncoming() {
    if (call || incoming || incomingBusy || document.hidden) return;
    incomingBusy = true;
    try {
      const data = await api("/api/chat/calls/incoming");
      if (data.call && !call && !incoming) {
        incoming = data.call;
        setCallUI({
          type: incoming.type,
          name: incoming.callerName,
          status: "Incoming " + (incoming.type === "video" ? "video" : "voice") + " call about " + incoming.productName,
          ringing: true
        });
      }
    } catch (err) {
      // ignore
    } finally {
      incomingBusy = false;
    }
  }

  async function acceptIncoming() {
    const inc = incoming;
    if (!inc) return;
    let stream;
    try {
      stream = await getMedia(inc.type);
    } catch (err) {
      incoming = null;
      postJSON("/api/chat/calls/" + inc.id + "/answer", { accept: false }).catch(() => {});
      hideCallUI();
      alert(err.message);
      return;
    }

    try {
      call = newCall(inc.id, inc.type, "callee", inc.callerName, stream);
      incoming = null;
      await postJSON("/api/chat/calls/" + inc.id + "/answer", { accept: true });
      setCallUI({ type: inc.type, name: inc.callerName, status: "Connecting...", ringing: false });
      startCallLoop(call);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      if (call) { call.closed = true; try { call.pc.close(); } catch (e) { /* ignore */ } }
      call = null;
      incoming = null;
      hideCallUI();
      alert(err.message);
    }
  }

  function declineIncoming() {
    const inc = incoming;
    incoming = null;
    if (inc) postJSON("/api/chat/calls/" + inc.id + "/answer", { accept: false }).catch(() => {});
    hideCallUI();
  }

  $("callAccept").addEventListener("click", acceptIncoming);

  $("callHang").addEventListener("click", () => {
    if (incoming) declineIncoming();
    else if (call) endCall("", true);
  });

  $("callMute").addEventListener("click", () => {
    if (!call) return;
    const track = call.stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $("callMute").textContent = track.enabled ? "🎤" : "🔇";
  });

  $("callCam").addEventListener("click", () => {
    if (!call) return;
    const track = call.stream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $("callCam").textContent = track.enabled ? "📷" : "🚫";
  });

  // The ringing stops by itself if the caller gives up
  setInterval(async () => {
    if (incoming && !call) {
      try {
        const data = await api("/api/chat/calls/incoming");
        if (!data.call || data.call.id !== incoming.id) {
          incoming = null;
          $("callStatus").textContent = "Missed call.";
          $("callAccept").hidden = true;
          setTimeout(() => { if (!call && !incoming) hideCallUI(); }, 1500);
        }
      } catch (err) { /* ignore */ }
    }
  }, 3000);

  setInterval(checkIncoming, 3000);
  checkIncoming();

  window.addEventListener("beforeunload", () => {
    if (call && !call.closed) {
      try {
        fetch("/api/chat/calls/" + call.id + "/end", { method: "POST", keepalive: true, headers: { Authorization: "Bearer " + token } });
      } catch (e) { /* ignore */ }
    }
  });

  // ---------- Unread badge ----------
  async function refreshBadge() {
    try {
      const data = await api("/api/chat/unread");
      document.querySelectorAll("[data-chat-badge]").forEach((el) => {
        el.textContent = data.unread;
        el.hidden = data.unread === 0;
      });
    } catch (err) {
      // not important
    }
  }

  refreshBadge();
  setInterval(() => { if (!document.hidden) refreshBadge(); }, 30000);

  window.HBChat = { openProduct, openInbox };
})();
