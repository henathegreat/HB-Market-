// Chat between consumer and producer (shared by both dashboards).
// Use: HBChat.openProduct(productId) (consumer) and HBChat.openInbox() (both).
(function () {
  "use strict";

  function readStored(key) {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  }

  const token = readStored("token");
  if (!token) return;

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

  function timeText(value) {
    const d = new Date(value);
    const today = new Date();
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === today.toDateString()) return time;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + time;
  }

  // ---------- Build the window once ----------
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "chatModal";
  modal.hidden = true;
  modal.innerHTML =
    '<div class="modal-box chat-box" role="dialog" aria-modal="true" aria-label="Chat">' +
    '<button type="button" class="modal-close" data-close aria-label="Close">×</button>' +
    '<div class="chat-head"><button type="button" class="chat-back" id="chatBack" aria-label="Back to messages" hidden>←</button>' +
    '<div><h2 id="chatTitle">Messages</h2><p id="chatSub"></p></div></div>' +
    '<p class="chat-safe" id="chatSafe" hidden>For your safety, keep payments inside this website. Never send money directly to someone you chat with.</p>' +
    '<div class="chat-list" id="chatInbox"></div>' +
    '<div class="chat-msgs" id="chatMsgs" hidden></div>' +
    '<div class="chat-error" id="chatError" role="alert"></div>' +
    '<form class="chat-form" id="chatForm" hidden>' +
    '<textarea id="chatInput" rows="1" maxlength="1000" placeholder="Write a message..." aria-label="Message"></textarea>' +
    '<button type="submit" class="btn" id="chatSend">Send</button></form></div>';
  document.body.appendChild(modal);

  const $ = (id) => document.getElementById(id);
  let currentId = null;
  let lastMessageId = 0;
  let pollTimer = null;
  let busy = false;

  function show() {
    modal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function setMode(mode) {
    const inRoom = mode === "room";
    $("chatInbox").hidden = inRoom;
    $("chatMsgs").hidden = !inRoom;
    $("chatForm").hidden = !inRoom;
    $("chatSafe").hidden = !inRoom;
    $("chatBack").hidden = !inRoom;
    $("chatError").textContent = "";
    if (!inRoom) {
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
        $("chatInbox").innerHTML = '<p class="chat-empty">No messages yet. Buyers can write to you from your product pages.</p>';
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

  // ---------- A conversation ----------
  function addMessages(list) {
    const box = $("chatMsgs");
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    list.forEach((m) => {
      if (m.id <= lastMessageId) return;
      lastMessageId = m.id;
      const div = document.createElement("div");
      div.className = "msg" + (m.mine ? " mine" : "");
      div.innerHTML = esc(m.body) + "<time>" + esc(timeText(m.createdAt)) + "</time>";
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
    }, 4000);
    $("chatInput").focus();
  }

  async function openProduct(productId) {
    try {
      const data = await api("/api/chat/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId })
      });
      await openConversation(data.conversationId);
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- Sending ----------
  $("chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("chatInput");
    const text = input.value.trim();
    if (!text || !currentId) return;

    const button = $("chatSend");
    button.disabled = true;
    $("chatError").textContent = "";
    try {
      const data = await api("/api/chat/conversations/" + encodeURIComponent(currentId) + "/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text })
      });
      input.value = "";
      const empty = $("chatMsgs").querySelector(".chat-empty");
      if (empty) empty.remove();
      addMessages([data.message]);
      $("chatMsgs").scrollTop = $("chatMsgs").scrollHeight;
    } catch (err) {
      $("chatError").textContent = err.message;
    } finally {
      button.disabled = false;
      input.focus();
    }
  });

  // Enter sends, Shift+Enter makes a new line
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("chatForm").requestSubmit();
    }
  });

  $("chatBack").addEventListener("click", openInbox);

  $("chatInbox").addEventListener("click", (e) => {
    const item = e.target.closest("[data-chat-open]");
    if (item) openConversation(Number(item.dataset.chatOpen));
  });

  // Close button, backdrop and Escape are handled by the page; stop the timer when it closes
  modal.addEventListener("click", () => setTimeout(() => { if (modal.hidden) { stopPolling(); currentId = null; refreshBadge(); } }, 0));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setTimeout(() => { if (modal.hidden) { stopPolling(); currentId = null; } }, 0);
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
