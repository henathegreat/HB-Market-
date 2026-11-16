const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth-middleware");

const router = express.Router();
const uploadsDir = path.join(__dirname, "..", "uploads");
const MAX_EXTRA = 5; // extra photos per product (the main photo is separate)

// ---------- Helpers ----------
const s = (value) => String(value ?? "").trim();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function removeFile(file) {
  if (file && file.path) fs.unlink(file.path, () => {});
}

function removeUpload(urlPath) {
  if (!urlPath) return;
  fs.unlink(path.join(uploadsDir, path.basename(urlPath)), () => {});
}

const cleanDigits = (value) => String(value ?? "").replace(/[\s-]/g, "");

// ---------- Gallery upload ----------
const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

const galleryUpload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      cb(null, "product-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + (IMAGE_EXT[file.mimetype] || ".jpg"));
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024, files: MAX_EXTRA },
  fileFilter: (req, file, cb) => {
    const ok = Boolean(IMAGE_EXT[file.mimetype]);
    cb(ok ? null : new Error("INVALID_IMAGE"), ok);
  }
}).array("images", MAX_EXTRA);

function handleGalleryUpload(req, res, next) {
  galleryUpload(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "Each photo must be 3MB or smaller." });
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ message: `You can upload up to ${MAX_EXTRA} photos at once.` });
      }
      return res.status(400).json({ message: "Only JPG, PNG or WEBP images are allowed." });
    }
    next();
  });
}

// Recalculates the order status from the status of its items
async function syncOrderStatus(db, orderId) {
  await db.query(
    `UPDATE orders o SET status = CASE
       WHEN NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.fulfillment <> 'delivered') THEN 'delivered'
       WHEN NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.fulfillment = 'new') THEN 'shipped'
       ELSE 'paid'
     END
     WHERE o.id = $1 AND o.status IN ('paid', 'shipped', 'delivered')`,
    [orderId]
  );
}

// =====================================================
// PRODUCT PHOTOS
// =====================================================

// All photos of a product (main photo first)
router.get("/products/:id/images", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid product." });

  try {
    const result = await pool.query("SELECT producer_id, image_url, is_active FROM products WHERE id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: "Product not found." });

    const product = result.rows[0];
    if (!product.is_active && product.producer_id !== req.user.id && req.user.role !== "admin") {
      return res.status(404).json({ message: "Product not found." });
    }

    const extras = await pool.query("SELECT id, image_url FROM product_images WHERE product_id = $1 ORDER BY id", [id]);

    const images = [];
    if (product.image_url) images.push({ id: null, url: product.image_url, main: true });
    extras.rows.forEach((row) => images.push({ id: row.id, url: row.image_url, main: false }));

    res.json({ images, maxExtra: MAX_EXTRA });
  } catch (err) {
    console.error("Gallery error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Add extra photos
router.post("/products/:id/images", requireAuth, requireRole("producer"), handleGalleryUpload, async (req, res) => {
  const files = req.files || [];
  const fail = (status, message) => {
    files.forEach(removeFile);
    return res.status(status).json({ message });
  };

  const id = parseId(req.params.id);
  if (!id) return fail(400, "Invalid product.");
  if (files.length === 0) return fail(400, "Choose at least one photo.");

  try {
    const own = await pool.query(
      "SELECT id FROM products WHERE id = $1 AND producer_id = $2 AND is_active = TRUE",
      [id, req.user.id]
    );
    if (own.rows.length === 0) return fail(404, "Product not found.");

    const count = await pool.query("SELECT COUNT(*)::int AS n FROM product_images WHERE product_id = $1", [id]);
    const current = count.rows[0].n;
    if (current + files.length > MAX_EXTRA) {
      return fail(400, `A product can have up to ${MAX_EXTRA} extra photos. You already have ${current}.`);
    }

    for (const file of files) {
      await pool.query("INSERT INTO product_images (product_id, image_url) VALUES ($1, $2)", [id, "/uploads/" + file.filename]);
    }

    res.status(201).json({ message: "Photos added." });
  } catch (err) {
    console.error("Add photos error:", err.message);
    fail(500, "Server error. Please try again.");
  }
});

// Remove an extra photo
router.delete("/products/:id/images/:imageId", requireAuth, requireRole("producer"), async (req, res) => {
  const productId = parseId(req.params.id);
  const imageId = parseId(req.params.imageId);
  if (!productId || !imageId) return res.status(400).json({ message: "Invalid photo." });

  try {
    const found = await pool.query(
      `SELECT pi.image_url
       FROM product_images pi
       JOIN products p ON p.id = pi.product_id
       WHERE pi.id = $1 AND pi.product_id = $2 AND p.producer_id = $3`,
      [imageId, productId, req.user.id]
    );
    if (found.rows.length === 0) return res.status(404).json({ message: "Photo not found." });

    await pool.query("DELETE FROM product_images WHERE id = $1", [imageId]);
    removeUpload(found.rows[0].image_url);

    res.json({ message: "Photo removed." });
  } catch (err) {
    console.error("Remove photo error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// PRODUCER PAYOUT ACCOUNT (where the platform sends the producer's 75%)
// =====================================================
router.get("/payout-account", requireAuth, requireRole("producer"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT payout_bank, payout_account_name, payout_account_number, payout_mobile FROM users WHERE id = $1",
      [req.user.id]
    );
    const row = result.rows[0] || {};
    res.json({
      account: {
        bankName: row.payout_bank || "",
        accountName: row.payout_account_name || "",
        accountNumber: row.payout_account_number || "",
        mobile: row.payout_mobile || ""
      }
    });
  } catch (err) {
    console.error("Payout account error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

router.put("/payout-account", requireAuth, requireRole("producer"), async (req, res) => {
  const bankName = s(req.body.bankName);
  const accountName = s(req.body.accountName);
  const accountNumber = cleanDigits(req.body.accountNumber);
  const mobile = cleanDigits(req.body.mobile);

  if (bankName.length < 2 || bankName.length > 60) return res.status(400).json({ message: "Enter your bank name." });
  if (accountName.length < 2 || accountName.length > 80) return res.status(400).json({ message: "Enter the account holder name." });
  if (!/^\d{6,25}$/.test(accountNumber)) return res.status(400).json({ message: "Account number must be 6 to 25 digits." });
  if (mobile && !/^\+?\d{9,15}$/.test(mobile)) {
    return res.status(400).json({ message: "Enter a valid mobile number, or leave it empty." });
  }

  try {
    await pool.query(
      `UPDATE users SET payout_bank = $1, payout_account_name = $2, payout_account_number = $3, payout_mobile = $4
       WHERE id = $5`,
      [bankName, accountName, accountNumber, mobile || null, req.user.id]
    );
    res.json({ message: "Payout account saved." });
  } catch (err) {
    console.error("Save payout account error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// PRODUCER SALES AND PAYMENT PROGRESS
// =====================================================
router.get("/sales/mine", requireAuth, requireRole("producer"), async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT oi.id AS item_id, oi.order_id, oi.quantity, oi.price, oi.subtotal, oi.producer_earning,
              oi.fulfillment, oi.payout_status, oi.payout_at, oi.payout_reference,
              p.name, p.image_url, o.status AS order_status, o.created_at,
              u.first_name, u.last_name, u.phone, u.address, u.city, u.country,
              (SELECT pm.status FROM payments pm WHERE pm.order_id = o.id ORDER BY pm.created_at DESC, pm.id DESC LIMIT 1) AS payment_status
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       JOIN users u ON u.id = o.consumer_id
       WHERE oi.producer_id = $1
       ORDER BY o.created_at DESC, oi.id DESC
       LIMIT 100`,
      [req.user.id]
    );

    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(oi.producer_earning) FILTER (WHERE o.status = 'pending'), 0) AS awaiting_payment,
         COALESCE(SUM(oi.producer_earning) FILTER (
           WHERE o.status IN ('paid', 'shipped', 'delivered') AND oi.fulfillment <> 'delivered'), 0) AS in_progress,
         COALESCE(SUM(oi.producer_earning) FILTER (
           WHERE oi.fulfillment = 'delivered' AND oi.payout_status = 'unpaid' AND o.status <> 'cancelled'), 0) AS ready,
         COALESCE(SUM(oi.producer_earning) FILTER (WHERE oi.payout_status = 'paid'), 0) AS paid_out
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.producer_id = $1`,
      [req.user.id]
    );
    const t = totals.rows[0];

    res.json({
      totals: {
        awaitingPayment: Number(t.awaiting_payment),
        inProgress: Number(t.in_progress),
        ready: Number(t.ready),
        paidOut: Number(t.paid_out)
      },
      sales: rows.rows.map((r) => {
        // The customer's contact details are shown only after the payment is confirmed
        const revealed = ["paid", "shipped", "delivered"].includes(r.order_status);
        const customer = revealed
          ? { revealed: true, name: `${r.first_name} ${r.last_name}`, phone: r.phone, address: r.address, city: r.city, country: r.country }
          : { revealed: false, name: r.first_name };

        return {
          itemId: r.item_id,
          orderId: r.order_id,
          product: { name: r.name, imageUrl: r.image_url },
          quantity: r.quantity,
          price: Number(r.price),
          subtotal: Number(r.subtotal),
          earning: Number(r.producer_earning),
          fulfillment: r.fulfillment,
          payoutStatus: r.payout_status,
          payoutAt: r.payout_at,
          payoutReference: r.payout_reference,
          orderStatus: r.order_status,
          paymentStatus: r.payment_status,
          createdAt: r.created_at,
          customer
        };
      })
    });
  } catch (err) {
    console.error("Sales error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Producer marks an item as shipped (only after the payment is confirmed)
router.post("/sales/:id/ship", requireAuth, requireRole("producer"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid sale." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT oi.order_id, oi.fulfillment, o.status AS order_status
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.id = $1 AND oi.producer_id = $2
       FOR UPDATE OF oi`,
      [id, req.user.id]
    );

    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Sale not found." });
    }

    const row = found.rows[0];
    if (!["paid", "shipped", "delivered"].includes(row.order_status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "You can ship only after the customer's payment is confirmed." });
    }
    if (row.fulfillment !== "new") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "This item is already marked as shipped." });
    }

    await client.query("UPDATE order_items SET fulfillment = 'shipped' WHERE id = $1", [id]);
    await syncOrderStatus(client, row.order_id);

    await client.query("COMMIT");
    res.json({ message: "Marked as shipped." });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Ship error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  } finally {
    client.release();
  }
});

// =====================================================
// CUSTOMER CONFIRMS THAT THE ORDER ARRIVED
// =====================================================
router.post("/orders/:id/received", requireAuth, requireRole("consumer"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid order." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT status FROM orders WHERE id = $1 AND consumer_id = $2 FOR UPDATE",
      [id, req.user.id]
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found." });
    }

    const result = await client.query(
      "UPDATE order_items SET fulfillment = 'delivered' WHERE order_id = $1 AND fulfillment = 'shipped'",
      [id]
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Nothing has been shipped for this order yet." });
    }

    await syncOrderStatus(client, id);
    await client.query("COMMIT");
    res.json({ message: "Thank you for confirming." });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Received error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  } finally {
    client.release();
  }
});

// =====================================================
// ADMIN: PRODUCER PAYOUTS
// =====================================================
router.get("/admin/payouts", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.phone,
              u.payout_bank, u.payout_account_name, u.payout_account_number, u.payout_mobile,
              COALESCE(SUM(oi.producer_earning) FILTER (
                WHERE oi.fulfillment = 'delivered' AND oi.payout_status = 'unpaid' AND o.status <> 'cancelled'), 0) AS owed,
              COALESCE(SUM(oi.producer_earning) FILTER (
                WHERE o.status IN ('paid', 'shipped', 'delivered') AND oi.fulfillment <> 'delivered'), 0) AS in_progress,
              COALESCE(SUM(oi.producer_earning) FILTER (WHERE oi.payout_status = 'paid'), 0) AS paid_total
       FROM users u
       JOIN order_items oi ON oi.producer_id = u.id
       JOIN orders o ON o.id = oi.order_id
       WHERE u.role = 'producer'
       GROUP BY u.id
       ORDER BY owed DESC, u.first_name
       LIMIT 100`
    );

    res.json({
      payouts: result.rows.map((r) => ({
        producerId: r.id,
        name: `${r.first_name} ${r.last_name}`,
        phone: r.phone,
        account: r.payout_account_number
          ? { bank: r.payout_bank, name: r.payout_account_name, number: r.payout_account_number, mobile: r.payout_mobile }
          : null,
        owed: Number(r.owed),
        inProgress: Number(r.in_progress),
        paidTotal: Number(r.paid_total)
      }))
    });
  } catch (err) {
    console.error("Payouts error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Admin records that the money was sent to the producer
router.post("/admin/payouts/:producerId/pay", requireAuth, requireRole("admin"), async (req, res) => {
  const producerId = parseId(req.params.producerId);
  if (!producerId) return res.status(400).json({ message: "Invalid producer." });

  const reference = s(req.body.reference);
  if (reference.length < 3 || reference.length > 60) {
    return res.status(400).json({ message: "Enter the transfer reference (3 to 60 characters)." });
  }

  try {
    const account = await pool.query(
      "SELECT payout_account_number FROM users WHERE id = $1 AND role = 'producer'",
      [producerId]
    );
    if (account.rows.length === 0) return res.status(404).json({ message: "Producer not found." });
    if (!account.rows[0].payout_account_number) {
      return res.status(400).json({ message: "This producer has not added a payout account yet." });
    }

    const result = await pool.query(
      `UPDATE order_items oi
       SET payout_status = 'paid', payout_at = NOW(), payout_reference = $1
       FROM orders o
       WHERE o.id = oi.order_id AND oi.producer_id = $2 AND oi.fulfillment = 'delivered'
         AND oi.payout_status = 'unpaid' AND o.status <> 'cancelled'
       RETURNING oi.producer_earning`,
      [reference, producerId]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ message: "There is nothing to pay this producer right now." });
    }

    const cents = result.rows.reduce((sum, row) => sum + Math.round(Number(row.producer_earning) * 100), 0);
    res.json({ message: "Payout recorded.", amount: cents / 100 });
  } catch (err) {
    console.error("Pay producer error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;
