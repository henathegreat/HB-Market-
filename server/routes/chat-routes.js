const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth-middleware");

const router = express.Router();
const MAX_MESSAGE = 1000;

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
        lastMessage: r.last_body,
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
      `SELECT id, sender_id, body, created_at FROM messages
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
      messages: messages.rows.map((m) => ({
        id: m.id,
        mine: m.sender_id === req.user.id,
        body: m.body,
        createdAt: m.created_at
      }))
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

    res.status(201).json({ message: { id: result.rows[0].id, mine: true, body, createdAt: result.rows[0].created_at } });
  } catch (err) {
    console.error("Send message error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;
