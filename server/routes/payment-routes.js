const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth-middleware");

const router = express.Router();

// Receipts are private: they are NOT inside the public uploads folder
const receiptsDir = path.join(__dirname, "..", "receipts");
if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });

// ---------- Receipt upload ----------
const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: receiptsDir,
    filename: (req, file, cb) => {
      cb(null, "receipt-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + (IMAGE_EXT[file.mimetype] || ".jpg"));
    }
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = Boolean(IMAGE_EXT[file.mimetype]);
    cb(ok ? null : new Error("INVALID_IMAGE"), ok);
  }
}).single("receipt");

function handleReceiptUpload(req, res, next) {
  receiptUpload(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "Receipt image must be 4MB or smaller." });
      }
      return res.status(400).json({ message: "Receipt must be a JPG, PNG or WEBP image." });
    }
    next();
  });
}

// ---------- Helpers ----------
const s = (value) => String(value ?? "").trim();

function removeFile(file) {
  if (file && file.path) fs.unlink(file.path, () => {});
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// =====================================================
// GET /api/payment-info  (where the customer sends the money)
// Set these values in the .env file
// =====================================================
router.get("/payment-info", requireAuth, (req, res) => {
  const bankName = s(process.env.PAYMENT_BANK_NAME);
  const accountName = s(process.env.PAYMENT_ACCOUNT_NAME);
  const accountNumber = s(process.env.PAYMENT_ACCOUNT_NUMBER);
  const telebirrNumber = s(process.env.PAYMENT_TELEBIRR_NUMBER);

  res.json({
    configured: Boolean(bankName && accountName && accountNumber),
    bankName,
    accountName,
    accountNumber,
    telebirrNumber
  });
});

// =====================================================
// POST /api/orders/:id/payment  (customer sends the receipt)
// =====================================================
router.post("/orders/:id/payment", requireAuth, requireRole("consumer"), handleReceiptUpload, async (req, res) => {
  const file = req.file;
  const fail = (status, message) => {
    removeFile(file);
    return res.status(status).json({ message });
  };

  const orderId = parseId(req.params.id);
  if (!orderId) return fail(400, "Invalid order.");
  if (!file) return fail(400, "Please upload your receipt photo.");

  const method = s(req.body.method);
  const senderBank = s(req.body.senderBank);
  const reference = s(req.body.reference);
  const amount = Number(req.body.amountPaid);

  if (!["bank_transfer", "telebirr"].includes(method)) return fail(400, "Choose a payment method.");
  if (method === "bank_transfer" && (senderBank.length < 2 || senderBank.length > 60)) {
    return fail(400, "Enter the name of your bank.");
  }
  if (!/^[A-Za-z0-9._\/-]{4,60}$/.test(reference)) {
    return fail(400, "Enter the reference number from your receipt (4 to 60 letters or numbers).");
  }
  if (!Number.isFinite(amount) || amount <= 0) return fail(400, "Enter the amount you sent.");

  try {
    const order = await pool.query(
      "SELECT id, status, total_amount FROM orders WHERE id = $1 AND consumer_id = $2",
      [orderId, req.user.id]
    );
    if (order.rows.length === 0) return fail(404, "Order not found.");

    const row = order.rows[0];
    if (row.status !== "pending") return fail(400, "This order does not need payment.");

    const open = await pool.query("SELECT 1 FROM payments WHERE order_id = $1 AND status = 'submitted'", [orderId]);
    if (open.rows.length > 0) {
      return fail(400, "You already sent a receipt for this order. Please wait for confirmation.");
    }

    const totalCents = Math.round(Number(row.total_amount) * 100);
    if (Math.round(amount * 100) !== totalCents) {
      return fail(400, `The amount must be exactly ${(totalCents / 100).toFixed(2)} ETB.`);
    }

    await pool.query(
      `INSERT INTO payments (order_id, method, sender_bank, reference, amount, receipt_file)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, method, senderBank || null, reference, (totalCents / 100).toFixed(2), file.filename]
    );

    res.status(201).json({ message: "Receipt sent. We will confirm your payment soon." });
  } catch (err) {
    if (err.code === "23505") {
      if (err.constraint === "idx_payments_one_open") {
        return fail(400, "You already sent a receipt for this order. Please wait for confirmation.");
      }
      return fail(409, "This reference number was already used.");
    }
    console.error("Send receipt error:", err.message);
    fail(500, "Server error. Please try again.");
  }
});

// =====================================================
// GET /api/payments/:id/receipt  (only the customer or the admin)
// =====================================================
router.get("/payments/:id/receipt", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid payment." });

  try {
    const result = await pool.query(
      `SELECT p.receipt_file, o.consumer_id
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Receipt not found." });

    const row = result.rows[0];
    if (req.user.role !== "admin" && row.consumer_id !== req.user.id) {
      return res.status(403).json({ message: "You do not have access to this receipt." });
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.sendFile(path.join(receiptsDir, path.basename(row.receipt_file)), (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: "Receipt file not found." });
    });
  } catch (err) {
    console.error("Receipt error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// GET /api/admin/summary
// =====================================================
router.get("/admin/summary", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM payments WHERE status = 'submitted') AS waiting,
         (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'confirmed') AS confirmed_total,
         (SELECT COALESCE(SUM(oi.commission_amount), 0)
            FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.status IN ('paid', 'shipped', 'delivered')) AS commission,
         (SELECT COALESCE(SUM(oi.producer_earning), 0)
            FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.status IN ('paid', 'shipped', 'delivered')) AS producer_earnings`
    );
    const row = result.rows[0];
    res.json({
      waiting: row.waiting,
      confirmedTotal: Number(row.confirmed_total),
      commission: Number(row.commission),
      producerEarnings: Number(row.producer_earnings)
    });
  } catch (err) {
    console.error("Admin summary error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// GET /api/admin/payments?status=submitted|confirmed|rejected
// =====================================================
router.get("/admin/payments", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const status = ["submitted", "confirmed", "rejected"].includes(req.query.status) ? req.query.status : "submitted";

    const result = await pool.query(
      `SELECT p.id, p.order_id, p.method, p.sender_bank, p.reference, p.amount, p.status, p.note,
              p.created_at, p.reviewed_at, o.total_amount,
              u.first_name, u.last_name, u.email, u.phone
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       JOIN users u ON u.id = o.consumer_id
       WHERE p.status = $1
       ORDER BY p.created_at DESC
       LIMIT 50`,
      [status]
    );

    const orderIds = [...new Set(result.rows.map((r) => r.order_id))];
    const itemsByOrder = new Map();

    if (orderIds.length > 0) {
      const items = await pool.query(
        `SELECT oi.order_id, oi.quantity, pr.name, pu.first_name, pu.last_name
         FROM order_items oi
         JOIN products pr ON pr.id = oi.product_id
         JOIN users pu ON pu.id = oi.producer_id
         WHERE oi.order_id = ANY($1::int[])
         ORDER BY oi.id`,
        [orderIds]
      );
      for (const row of items.rows) {
        if (!itemsByOrder.has(row.order_id)) itemsByOrder.set(row.order_id, []);
        itemsByOrder.get(row.order_id).push({
          name: row.name,
          quantity: row.quantity,
          producerName: `${row.first_name} ${row.last_name}`
        });
      }
    }

    res.json({
      payments: result.rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        method: r.method,
        senderBank: r.sender_bank,
        reference: r.reference,
        amount: Number(r.amount),
        orderTotal: Number(r.total_amount),
        status: r.status,
        note: r.note,
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
        customer: { name: `${r.first_name} ${r.last_name}`, email: r.email, phone: r.phone },
        items: itemsByOrder.get(r.order_id) || []
      }))
    });
  } catch (err) {
    console.error("Admin payments error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// POST /api/admin/payments/:id/confirm  (money arrived)
// =====================================================
router.post("/admin/payments/:id/confirm", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid payment." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT order_id FROM payments WHERE id = $1 AND status = 'submitted' FOR UPDATE",
      [id]
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "This payment was already reviewed." });
    }

    await client.query(
      "UPDATE payments SET status = 'confirmed', reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2",
      [req.user.id, id]
    );
    await client.query("UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending'", [found.rows[0].order_id]);

    await client.query("COMMIT");
    res.json({ message: "Payment confirmed." });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Confirm payment error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  } finally {
    client.release();
  }
});

// =====================================================
// POST /api/admin/payments/:id/reject  (wrong or fake receipt)
// =====================================================
router.post("/admin/payments/:id/reject", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid payment." });

  const note = s(req.body.note);
  if (note.length < 3 || note.length > 200) {
    return res.status(400).json({ message: "Write a reason (3 to 200 characters)." });
  }

  try {
    const result = await pool.query(
      `UPDATE payments SET status = 'rejected', note = $1, reviewed_at = NOW(), reviewed_by = $2
       WHERE id = $3 AND status = 'submitted'`,
      [note, req.user.id, id]
    );
    if (result.rowCount === 0) return res.status(400).json({ message: "This payment was already reviewed." });
    res.json({ message: "Payment rejected." });
  } catch (err) {
    console.error("Reject payment error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;
