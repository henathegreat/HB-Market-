const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth-middleware");

const router = express.Router();

// Platform commission (25% by default, can be changed in .env)
function commissionRate() {
  const rate = Number(process.env.COMMISSION_RATE);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.25;
}

function mapProduct(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description || "",
    price: Number(r.price),
    stock: r.stock,
    imageUrl: r.image_url,
    producerId: r.producer_id,
    producerName: r.first_name ? `${r.first_name} ${r.last_name}` : undefined,
    producerNickname: r.nickname || null,
    createdAt: r.created_at
  };
}

const toMoney = (cents) => (cents / 100).toFixed(2);

// =====================================================
// GET /api/shop/products  (latest products for the shop page)
// =====================================================
router.get("/shop/products", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.description, p.price, p.stock, p.image_url, p.producer_id, p.created_at,
              u.first_name, u.last_name, u.nickname
       FROM products p
       JOIN users u ON u.id = p.producer_id
       WHERE p.is_active = TRUE AND u.is_active = TRUE
       ORDER BY p.created_at DESC
       LIMIT 60`
    );
    res.json({ products: result.rows.map(mapProduct) });
  } catch (err) {
    console.error("Shop products error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// POST /api/orders  (customer places an order)
// The price always comes from the database, never from the browser.
// =====================================================
router.post("/orders", requireAuth, requireRole("consumer"), async (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (rawItems.length === 0 || rawItems.length > 50) {
    return res.status(400).json({ message: "Your cart is empty." });
  }

  // Merge duplicate products and check the numbers
  const wanted = new Map();
  for (const item of rawItems) {
    const id = Number.parseInt(item && item.productId, 10);
    const qty = Number(item && item.quantity);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty < 1 || qty > 1000) {
      return res.status(400).json({ message: "Invalid cart item." });
    }
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }

  const ids = [...wanted.keys()].sort((a, b) => a - b);
  const rate = commissionRate();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the products so two customers cannot buy the last item together
    const found = await client.query(
      `SELECT p.id, p.producer_id, p.name, p.price, p.stock
       FROM products p
       JOIN users u ON u.id = p.producer_id
       WHERE p.id = ANY($1::int[]) AND p.is_active = TRUE AND u.is_active = TRUE
       ORDER BY p.id
       FOR UPDATE OF p`,
      [ids]
    );

    if (found.rows.length !== ids.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "One of the products in your cart is no longer available." });
    }

    // Work in cents so there are no rounding mistakes
    let totalCents = 0;
    const lines = [];

    for (const p of found.rows) {
      const qty = wanted.get(p.id);

      if (p.stock < qty) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: `Not enough stock for "${p.name}". Only ${p.stock} left.` });
      }

      const priceCents = Math.round(Number(p.price) * 100);
      const subtotalCents = priceCents * qty;
      const commissionCents = Math.round(subtotalCents * rate);

      lines.push({
        product: p,
        qty,
        priceCents,
        subtotalCents,
        commissionCents,
        earningCents: subtotalCents - commissionCents
      });
      totalCents += subtotalCents;
    }

    const order = await client.query(
      "INSERT INTO orders (consumer_id, status, total_amount) VALUES ($1, 'pending', $2) RETURNING id",
      [req.user.id, toMoney(totalCents)]
    );
    const orderId = order.rows[0].id;

    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items
          (order_id, product_id, producer_id, quantity, price, subtotal, commission_rate, commission_amount, producer_earning)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          orderId,
          line.product.id,
          line.product.producer_id,
          line.qty,
          toMoney(line.priceCents),
          toMoney(line.subtotalCents),
          rate.toFixed(2),
          toMoney(line.commissionCents),
          toMoney(line.earningCents)
        ]
      );
      await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [line.qty, line.product.id]);
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Order placed.", order: { id: orderId, total: totalCents / 100 } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Place order error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  } finally {
    client.release();
  }
});

// =====================================================
// GET /api/orders/mine  (customer's order history)
// =====================================================
router.get("/orders/mine", requireAuth, requireRole("consumer"), async (req, res) => {
  try {
    const orders = await pool.query(
      `SELECT id, status, total_amount, created_at
       FROM orders WHERE consumer_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
      [req.user.id]
    );

    if (orders.rows.length === 0) return res.json({ orders: [] });

    const ids = orders.rows.map((o) => o.id);
    const items = await pool.query(
      `SELECT oi.order_id, oi.quantity, oi.price, oi.subtotal, oi.fulfillment,
              p.name, p.image_url, u.first_name, u.last_name
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       JOIN users u ON u.id = oi.producer_id
       WHERE oi.order_id = ANY($1::int[])
       ORDER BY oi.id`,
      [ids]
    );

    const pays = await pool.query(
      `SELECT DISTINCT ON (order_id) order_id, status, method, reference, note, created_at
       FROM payments
       WHERE order_id = ANY($1::int[])
       ORDER BY order_id, created_at DESC, id DESC`,
      [ids]
    );
    const payByOrder = new Map();
    for (const row of pays.rows) {
      payByOrder.set(row.order_id, {
        status: row.status,
        method: row.method,
        reference: row.reference,
        note: row.note,
        createdAt: row.created_at
      });
    }

    const byOrder = new Map();
    for (const row of items.rows) {
      if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
      byOrder.get(row.order_id).push({
        name: row.name,
        imageUrl: row.image_url,
        quantity: row.quantity,
        price: Number(row.price),
        subtotal: Number(row.subtotal),
        fulfillment: row.fulfillment,
        producerName: `${row.first_name} ${row.last_name}`
      });
    }

    res.json({
      orders: orders.rows.map((o) => ({
        id: o.id,
        status: o.status,
        total: Number(o.total_amount),
        createdAt: o.created_at,
        items: byOrder.get(o.id) || [],
        payment: payByOrder.get(o.id) || null
      }))
    });
  } catch (err) {
    console.error("My orders error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;
