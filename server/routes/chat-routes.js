const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth-middleware");

const router = express.Router();
const MAX_MESSAGE = 1000;
const MAX_FILE_MB = 10;

// Private folder (NOT served publicly). Files are sent only through the checked route below.
const chatDir = path.join(__dirname, "..", "chat-files");
fs.mkdirSync(chatDir, { recursive: true });

const FILE_TYPES = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
  "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/wav": ".wav", "audio/x-wav": ".wav"
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, chatDir),
    filename: (req, file, cb) => {
      const mime = String(file.mimetype).split(";")[0].toLowerCase();
      cb(null, crypto.randomBytes(16).toString("hex") + (FILE_TYPES[mime] || ".bin"));
    }
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype).split(";")[0].toLowerCase();
    cb(null, Boolean(FILE_TYPES[mime]));
  }
});

function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message = err.code === "LIMIT_FILE_SIZE" ? "File is too big (max " + MAX_FILE_MB + "MB)." : "Upload failed.";
      return res.status(400).json({ message });
    }
    next();
  });
}

function mapMessage(m, userId) {
  return {
    id: m.id,
    mine: m.sender_id === userId,
    kind: m.kind,
    body: m.body,
    fileName: m.file_name || null,
    mime: m.file_mime || null,
    createdAt: m.created_at
  };
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Loads a conversation only if the logged-in user is the consumer or the producer in it
async function getMyConversation(conversationId, userId) {
  const result = await pool.query(
    `SELECT c.id, c.product_id, c.consumer_id, c.producer_id, p.name AS product_name, p.image_url,
            o.first_name AS other_first, o.last_name AS other_last, o.nickname AS other_nick, o.profile_picture AS other_pic
     FROM conversations c
     JOIN products p ON p.id = c.product_id
     JOIN users o ON o.id = CASE WHEN c.consumer_id = $2 THEN c.producer_id ELSE c.consumer_id END
     WHERE c.id = $1 AND (c.consumer_id = $2 OR c.producer_id = $2)`,
    [conversationId, userId]
  );
  return result.rows[0] || null;
}

// Consumer starts (or reopens) a chat about a product
router.post("/chat/start", requireAuth, requireRole("consumer"), async (req, res) => {
  const productId = parseId(req.body.productId);
  if (!productId) return res.status(400).json({ message: "Invalid product." });

  try {
    const product = await pool.query("SELECT id, producer_id FROM products WHERE id = $1 AND is_active = TRUE", [productId]);
    if (product.rows.length === 0) return res.status(404).json({ message: "Product not found." });

    const result = await pool.query(
      `INSERT INTO conversations (product_id, consumer_id, producer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_id, consumer_id) DO UPDATE SET product_id = EXCLUDED.product_id
       RETURNING id`,
      [productId, req.user.id, product.rows[0].producer_id]
    );
    res.json({ conversationId: result.rows[0].id });
  } catch (err) {
    console.error("Chat start error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// My conversations (works for consumers and producers)
router.get("/chat/conversations", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.last_message_at, p.name AS product_name, p.image_url,
              o.first_name, o.last_name, o.nickname, o.profile_picture,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT m.kind FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_kind,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.read_at IS NULL) AS unread
       FROM conversations c
       JOIN products p ON p.id = c.product_id
       JOIN users o ON o.id = CASE WHEN c.consumer_id = $1 THEN c.producer_id ELSE c.consumer_id END
       WHERE (c.consumer_id = $1 OR c.producer_id = $1)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
       ORDER BY c.last_message_at DESC
       LIMIT 100`,
      [req.user.id]
    );

    res.json({
      conversations: result.rows.map((r) => ({
        id: r.id,
        productName: r.product_name,
        productImage: r.image_url,
        otherName: `${r.first_name} ${r.last_name}`,
        otherNickname: r.nickname,
        otherPicture: r.profile_picture,
        lastMessage: r.last_kind === "image" ? "📷 Photo"
          : r.last_kind === "voice" ? "🎤 Voice message"
          : r.last_kind === "audio" ? "🎵 Audio"
          : r.last_body,
        lastMessageAt: r.last_message_at,
        unread: Number(r.unread)
      }))
    });
  } catch (err) {
    console.error("Conversations error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Total unread messages (for the badge)
router.get("/chat/unread", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS n FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE (c.consumer_id = $1 OR c.producer_id = $1) AND m.sender_id <> $1 AND m.read_at IS NULL`,
      [req.user.id]
    );
    res.json({ unread: Number(result.rows[0].n) });
  } catch (err) {
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Messages of one conversation. ?after=ID returns only newer messages.
router.get("/chat/conversations/:id/messages", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid conversation." });
  const after = parseId(req.query.after) || 0;

  try {
    const conv = await getMyConversation(id, req.user.id);
    if (!conv) return res.status(404).json({ message: "Conversation not found." });

    const messages = await pool.query(
      `SELECT id, sender_id, body, kind, file_name, file_mime, created_at FROM messages
       WHERE conversation_id = $1 AND id > $2
       ORDER BY id ASC LIMIT 200`,
      [id, after]
    );

    await pool.query(
      "UPDATE messages SET read_at = NOW() WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL",
      [id, req.user.id]
    );

    res.json({
      conversation: {
        id: conv.id,
        productId: conv.product_id,
        productName: conv.product_name,
        productImage: conv.image_url,
        otherName: `${conv.other_first} ${conv.other_last}`,
        otherNickname: conv.other_nick
      },
      messages: messages.rows.map((m) => mapMessage(m, req.user.id))
    });
  } catch (err) {
    console.error("Messages error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Send a message
router.post("/chat/conversations/:id/messages", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid conversation." });

  const body = String(req.body.body ?? "").trim();
  if (!body) return res.status(400).json({ message: "Write a message first." });
  if (body.length > MAX_MESSAGE) return res.status(400).json({ message: "Message is too long (max " + MAX_MESSAGE + " characters)." });

  try {
    const conv = await getMyConversation(id, req.user.id);
    if (!conv) return res.status(404).json({ message: "Conversation not found." });

    // Simple spam limit: 20 messages per minute per user
    const recent = await pool.query(
      "SELECT COUNT(*) AS n FROM messages WHERE sender_id = $1 AND created_at > NOW() - INTERVAL '1 minute'",
      [req.user.id]
    );
    if (Number(recent.rows[0].n) >= 20) {
      return res.status(429).json({ message: "You are sending messages too fast. Please wait a moment." });
    }

    const result = await pool.query(
      "INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id, created_at",
      [id, req.user.id, body]
    );
    await pool.query("UPDATE conversations SET last_message_at = NOW() WHERE id = $1", [id]);

    res.status(201).json({ message: { id: result.rows[0].id, mine: true, kind: "text", body, fileName: null, mime: null, createdAt: result.rows[0].created_at } });
  } catch (err) {
    console.error("Send message error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Send an image, voice message or audio file
router.post("/chat/conversations/:id/attachments", requireAuth, handleUpload, async (req, res) => {
  const file = req.file;
  const id = parseId(req.params.id);

  function discard() {
    if (file) fs.unlink(file.path, () => {});
  }

  if (!id) { discard(); return res.status(400).json({ message: "Invalid conversation." }); }
  if (!file) return res.status(400).json({ message: "Choose an image or audio file (JPG, PNG, WEBP, GIF, MP3, M4A, OGG, WAV, WEBM)." });

  try {
    const conv = await getMyConversation(id, req.user.id);
    if (!conv) { discard(); return res.status(404).json({ message: "Conversation not found." }); }

    const recent = await pool.query(
      "SELECT COUNT(*) AS n FROM messages WHERE sender_id = $1 AND created_at > NOW() - INTERVAL '1 minute'",
      [req.user.id]
    );
    if (Number(recent.rows[0].n) >= 20) {
      discard();
      return res.status(429).json({ message: "You are sending too fast. Please wait a moment." });
    }

    const mime = String(file.mimetype).split(";")[0].toLowerCase();
    let kind = mime.startsWith("image/") ? "image" : "audio";
    if (kind === "audio" && req.body.kind === "voice") kind = "voice";
    const original = String(file.originalname || "").replace(/[^\w.\- ]/g, "").slice(0, 80);

    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body, kind, file_path, file_name, file_mime)
       VALUES ($1, $2, '', $3, $4, $5, $6) RETURNING id, created_at`,
      [id, req.user.id, kind, file.filename, original || null, mime]
    );
    await pool.query("UPDATE conversations SET last_message_at = NOW() WHERE id = $1", [id]);

    res.status(201).json({
      message: { id: result.rows[0].id, mine: true, kind, body: "", fileName: original || null, mime, createdAt: result.rows[0].created_at }
    });
  } catch (err) {
    discard();
    console.error("Attachment error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Download a chat file (only the two people in the conversation)
router.get("/chat/files/:messageId", requireAuth, async (req, res) => {
  const id = parseId(req.params.messageId);
  if (!id) return res.status(400).json({ message: "Invalid file." });

  try {
    const result = await pool.query(
      `SELECT m.file_path, m.file_mime FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = $1 AND m.file_path IS NOT NULL AND (c.consumer_id = $2 OR c.producer_id = $2)`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "File not found." });

    const row = result.rows[0];
    const full = path.join(chatDir, path.basename(row.file_path));
    if (!fs.existsSync(full)) return res.status(404).json({ message: "File not found." });

    res.setHeader("Content-Type", row.file_mime || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(full);
  } catch (err) {
    console.error("File error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// VOICE AND VIDEO CALLS
// The browsers talk directly to each other (WebRTC).
// The server only passes the connection messages between them (kept in memory).
// =====================================================
const calls = new Map();
const RING_SECONDS = 45;

function newCallId() {
  return crypto.randomBytes(8).toString("hex");
}

async function logCall(call, text) {
  if (call.logged) return;
  call.logged = true;
  try {
    await pool.query("INSERT INTO messages (conversation_id, sender_id, body, kind) VALUES ($1, $2, $3, 'call')", [call.convId, call.callerId, text]);
    await pool.query("UPDATE conversations SET last_message_at = NOW() WHERE id = $1", [call.convId]);
  } catch (err) {
    console.error("Call log error:", err.message);
  }
}

function label(call) {
  return call.type === "video" ? "Video call" : "Voice call";
}

function finish(call, state) {
  if (["ended", "declined", "missed", "cancelled"].includes(call.state)) return;
  call.state = state;
  call.endedAt = Date.now();
  if (state === "ended" && call.answeredAt) {
    const secs = Math.max(0, Math.round((call.endedAt - call.answeredAt) / 1000));
    logCall(call, "📞 " + label(call) + " · " + Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0"));
  } else if (state === "declined") {
    logCall(call, "📞 " + label(call) + " declined");
  } else {
    logCall(call, "📞 Missed " + label(call).toLowerCase());
  }
}

function checkStale(call) {
  if (call.state === "ringing" && Date.now() - call.createdAt > RING_SECONDS * 1000) finish(call, "missed");
  if (call.state === "active" && Date.now() - call.lastSeen > 20000) finish(call, "ended"); // both browsers closed
}

function sweep() {
  const now = Date.now();
  for (const [id, call] of calls) {
    checkStale(call);
    if (call.endedAt && now - call.endedAt > 120000) calls.delete(id);
  }
}

function myCall(req) {
  const call = calls.get(String(req.params.id));
  if (!call || (call.callerId !== req.user.id && call.calleeId !== req.user.id)) return null;
  return call;
}

// Start a call
router.post("/chat/conversations/:id/call", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const type = req.body.type === "video" ? "video" : "voice";
  if (!id) return res.status(400).json({ message: "Invalid conversation." });

  try {
    const conv = await getMyConversation(id, req.user.id);
    if (!conv) return res.status(404).json({ message: "Conversation not found." });

    sweep();
    for (const call of calls.values()) {
      const busy = !call.endedAt;
      if (busy && (call.callerId === req.user.id || call.calleeId === req.user.id)) {
        return res.status(409).json({ message: "You are already in a call." });
      }
      if (busy && (call.callerId === (conv.consumer_id === req.user.id ? conv.producer_id : conv.consumer_id) ||
                   call.calleeId === (conv.consumer_id === req.user.id ? conv.producer_id : conv.consumer_id))) {
        return res.status(409).json({ message: "The other person is busy in another call." });
      }
    }

    const calleeId = conv.consumer_id === req.user.id ? conv.producer_id : conv.consumer_id;
    const me = await pool.query("SELECT first_name, last_name FROM users WHERE id = $1", [req.user.id]);

    const call = {
      id: newCallId(), convId: id, type, callerId: req.user.id, calleeId,
      callerName: `${me.rows[0].first_name} ${me.rows[0].last_name}`,
      productName: conv.product_name,
      state: "ringing", createdAt: Date.now(), lastSeen: Date.now(),
      queues: { [req.user.id]: [], [calleeId]: [] }
    };
    calls.set(call.id, call);
    res.status(201).json({ callId: call.id });
  } catch (err) {
    console.error("Start call error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Is someone calling me?
router.get("/chat/calls/incoming", requireAuth, (req, res) => {
  sweep();
  for (const call of calls.values()) {
    if (call.calleeId === req.user.id && call.state === "ringing") {
      return res.json({ call: { id: call.id, type: call.type, callerName: call.callerName, productName: call.productName } });
    }
  }
  res.json({ call: null });
});

// Accept or decline
router.post("/chat/calls/:id/answer", requireAuth, (req, res) => {
  const call = myCall(req);
  if (!call || call.calleeId !== req.user.id) return res.status(404).json({ message: "Call not found." });
  checkStale(call);
  if (call.state !== "ringing") return res.status(409).json({ message: "This call is no longer available." });

  if (req.body.accept === true) {
    call.state = "active";
    call.answeredAt = Date.now();
    call.lastSeen = Date.now();
  } else {
    finish(call, "declined");
  }
  res.json({ state: call.state });
});

// Pass a connection message (offer, answer or network candidate) to the other person
router.post("/chat/calls/:id/signal", requireAuth, (req, res) => {
  const call = myCall(req);
  if (!call || call.endedAt) return res.status(404).json({ message: "Call not found." });
  const other = call.callerId === req.user.id ? call.calleeId : call.callerId;
  const data = req.body.data;
  if (!data || typeof data !== "object") return res.status(400).json({ message: "Invalid data." });
  if (call.queues[other].length < 200) call.queues[other].push(data);
  res.json({ ok: true });
});

// Ask for news (state of the call and waiting connection messages)
router.get("/chat/calls/:id/poll", requireAuth, (req, res) => {
  const call = myCall(req);
  if (!call) return res.status(404).json({ message: "Call not found." });
  checkStale(call);
  call.lastSeen = Date.now();
  const signals = call.queues[req.user.id].splice(0);
  res.json({ state: call.state, type: call.type, signals });
});

// Hang up (or cancel before answer)
router.post("/chat/calls/:id/end", requireAuth, (req, res) => {
  const call = myCall(req);
  if (!call) return res.status(404).json({ message: "Call not found." });
  finish(call, call.state === "active" ? "ended" : "cancelled");
  res.json({ state: call.state });
});

module.exports = router;
