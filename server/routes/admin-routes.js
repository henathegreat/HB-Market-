const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth-middleware");

const router = express.Router();
const adminOnly = [requireAuth, requireRole("admin")];
const PAGE_SIZE = 20;

// ---------- Helpers ----------
const s = (value) => String(value ?? "").trim();

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parsePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function isStrongEnough(password) {
  return password.length >= 8 && password.length <= 72 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

function paging(total, page) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  return { pages, page: safePage, offset: (safePage - 1) * PAGE_SIZE };
}

// =====================================================
// GET /api/admin/overview  (counts for the first page)
// =====================================================
router.get("/admin/overview", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users WHERE role = 'consumer') AS consumers,
         (SELECT COUNT(*)::int FROM users WHERE role = 'producer') AS producers,
         (SELECT COUNT(*)::int FROM users WHERE is_active = FALSE) AS blocked,
         (SELECT COUNT(*)::int FROM products WHERE is_active = TRUE) AS products,
         (SELECT COUNT(*)::int FROM orders) AS orders,
         (SELECT COUNT(*)::int FROM orders WHERE status = 'pending') AS pending_orders`
    );
    const row = result.rows[0];
    res.json({
      consumers: row.consumers,
      producers: row.producers,
      blocked: row.blocked,
      products: row.products,
      orders: row.orders,
      pendingOrders: row.pending_orders
    });
  } catch (err) {
    console.error("Overview error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// USERS
// =====================================================
function mapUser(r) {
  return {
    id: r.id,
    role: r.role,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    birthday: r.birthday,
    gender: r.gender,
    country: r.country,
    city: r.city,
    address: r.address,
    nickname: r.nickname,
    bio: r.bio,
    profilePicture: r.profile_picture,
    isActive: r.is_active,
    createdAt: r.created_at,
    productCount: r.product_count,
    orderCount: r.order_count
  };
}

router.get("/admin/users", adminOnly, async (req, res) => {
  try {
    const role = ["consumer", "producer", "admin"].includes(req.query.role) ? req.query.role : "";
    const q = s(req.query.q).slice(0, 60);

    const where = [];
    const params = [];

    if (role) {
      params.push(role);
      where.push(`role = $${params.length}`);
    }
    if (q) {
      params.push("%" + escapeLike(q) + "%");
      const i = params.length;
      where.push(
        `(first_name ILIKE $${i} OR last_name ILIKE $${i} OR (first_name || ' ' || last_name) ILIKE $${i}
          OR email ILIKE $${i} OR phone ILIKE $${i} OR nickname ILIKE $${i})`
      );
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM users ${whereSql}`, params);
    const total = count.rows[0].n;
    const { pages, page, offset } = paging(total, parsePage(req.query.page));

    const listParams = params.concat([PAGE_SIZE, offset]);
    const rows = await pool.query(
      `SELECT id, role, first_name, last_name, email, phone,
              to_char(birthday, 'YYYY-MM-DD') AS birthday,
              gender, country, city, address, nickname, bio, profile_picture, is_active, created_at,
              (SELECT COUNT(*)::int FROM products p WHERE p.producer_id = users.id AND p.is_active = TRUE) AS product_count,
              (SELECT COUNT(*)::int FROM orders o WHERE o.consumer_id = users.id) AS order_count
       FROM users ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.json({ users: rows.rows.map(mapUser), total, page, pages });
  } catch (err) {
    console.error("Admin users error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Edit any user's information
router.put("/admin/users/:id", adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid user." });

  const b = req.body;
  const role = s(b.role);
  const firstName = s(b.firstName);
  const lastName = s(b.lastName);
  const email = s(b.email).toLowerCase();
  const phone = s(b.phone);
  const birthday = s(b.birthday);
  const gender = s(b.gender);
  const country = s(b.country);
  const city = s(b.city);
  const address = s(b.address);
  const nickname = s(b.nickname);
  const bio = s(b.bio);

  if (!["consumer", "producer", "admin"].includes(role)) return res.status(400).json({ message: "Choose a valid role." });
  if (firstName.length < 2 || firstName.length > 50) return res.status(400).json({ message: "First name must be 2 to 50 characters." });
  if (lastName.length < 2 || lastName.length > 50) return res.status(400).json({ message: "Last name must be 2 to 50 characters." });
  if (!isEmail(email) || email.length > 120) return res.status(400).json({ message: "Enter a valid email address." });
  if (!/^\+\d{8,15}$/.test(phone)) return res.status(400).json({ message: "Phone must start with + and the country code, for example +251912345678." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || isNaN(new Date(birthday)) || new Date(birthday) > new Date()) {
    return res.status(400).json({ message: "Enter a valid birthday." });
  }
  if (!["male", "female", "other"].includes(gender)) return res.status(400).json({ message: "Choose a gender." });
  if (country.length < 2 || country.length > 60) return res.status(400).json({ message: "Country must be 2 to 60 characters." });
  if (city.length < 2 || city.length > 60) return res.status(400).json({ message: "City must be 2 to 60 characters." });
  if (address.length < 5 || address.length > 200) return res.status(400).json({ message: "Address must be 5 to 200 characters." });
  if (nickname && !/^[A-Za-z0-9_.-]{3,30}$/.test(nickname)) {
    return res.status(400).json({ message: "Nickname must be 3 to 30 characters: letters, numbers, dot, dash or underscore." });
  }
  if (bio.length > 300) return res.status(400).json({ message: "Bio must be 300 characters or less." });

  try {
    const current = await pool.query("SELECT role FROM users WHERE id = $1", [id]);
    if (current.rows.length === 0) return res.status(404).json({ message: "User not found." });

    // The admin cannot remove their own admin rights by mistake
    if (id === req.user.id && role !== current.rows[0].role) {
      return res.status(400).json({ message: "You cannot change your own role." });
    }

    await pool.query(
      `UPDATE users SET role = $1, first_name = $2, last_name = $3, email = $4, phone = $5, birthday = $6,
              gender = $7, country = $8, city = $9, address = $10, nickname = $11, bio = $12
       WHERE id = $13`,
      [role, firstName, lastName, email, phone, birthday, gender, country, city, address, nickname || null, bio || null, id]
    );

    res.json({ message: "User updated." });
  } catch (err) {
    if (err.code === "23505") {
      const message = err.constraint === "idx_users_nickname" ? "This nickname is already taken." : "This email is already used by another account.";
      return res.status(409).json({ message });
    }
    console.error("Update user error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Block or unblock an account
router.post("/admin/users/:id/status", adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid user." });
  if (typeof req.body.active !== "boolean") return res.status(400).json({ message: "Invalid request." });
  if (id === req.user.id) return res.status(400).json({ message: "You cannot block your own account." });

  try {
    const result = await pool.query("UPDATE users SET is_active = $1 WHERE id = $2", [req.body.active, id]);
    if (result.rowCount === 0) return res.status(404).json({ message: "User not found." });
    res.json({ message: req.body.active ? "Account unblocked." : "Account blocked." });
  } catch (err) {
    console.error("User status error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Set a new password for any user (passwords are stored scrambled, so they cannot be read)
router.post("/admin/users/:id/password", adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid user." });

  const password = String(req.body.password ?? "");
  if (!isStrongEnough(password)) {
    return res.status(400).json({ message: "Password must be 8+ characters with letters and numbers." });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, id]);
    if (result.rowCount === 0) return res.status(404).json({ message: "User not found." });

    await pool.query("DELETE FROM password_resets WHERE user_id = $1", [id]);
    res.json({ message: "Password changed." });
  } catch (err) {
    console.error("Admin password error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// PRODUCTS
// =====================================================
function checkProduct(b) {
  const name = s(b.name);
  const description = s(b.description);
  const price = Number(b.price);
  const stock = Number(b.stock);

  if (name.length < 2 || name.length > 120) return { error: "Product name must be 2 to 120 characters." };
  if (description.length > 1000) return { error: "Description must be 1000 characters or less." };
  if (s(b.price) === "" || !Number.isFinite(price) || price <= 0 || price > 1000000000) return { error: "Enter a valid price." };
  if (s(b.stock) === "" || !Number.isInteger(stock) || stock < 0 || stock > 1000000) {
    return { error: "Stock must be a whole number (0 or more)." };
  }
  return { value: { name, description, price: Math.round(price * 100) / 100, stock } };
}

router.get("/admin/products", adminOnly, async (req, res) => {
  try {
    const status = ["active", "hidden"].includes(req.query.status) ? req.query.status : "all";
    const q = s(req.query.q).slice(0, 60);

    const where = [];
    const params = [];

    if (status === "active") where.push("p.is_active = TRUE");
    if (status === "hidden") where.push("p.is_active = FALSE");
    if (q) {
      params.push("%" + escapeLike(q) + "%");
      where.push(`(p.name ILIKE $${params.length} OR (u.first_name || ' ' || u.last_name) ILIKE $${params.length})`);
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM products p JOIN users u ON u.id = p.producer_id ${whereSql}`,
      params
    );
    const total = count.rows[0].n;
    const { pages, page, offset } = paging(total, parsePage(req.query.page));

    const listParams = params.concat([PAGE_SIZE, offset]);
    const rows = await pool.query(
      `SELECT p.id, p.name, p.description, p.price, p.stock, p.image_url, p.is_active, p.created_at,
              p.producer_id, u.first_name, u.last_name
       FROM products p
       JOIN users u ON u.id = p.producer_id
       ${whereSql}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.json({
      products: rows.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description || "",
        price: Number(r.price),
        stock: r.stock,
        imageUrl: r.image_url,
        isActive: r.is_active,
        createdAt: r.created_at,
        producerId: r.producer_id,
        producerName: `${r.first_name} ${r.last_name}`
      })),
      total,
      page,
      pages
    });
  } catch (err) {
    console.error("Admin products error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

router.put("/admin/products/:id", adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid product." });

  const checked = checkProduct(req.body);
  if (checked.error) return res.status(400).json({ message: checked.error });

  try {
    const { name, description, price, stock } = checked.value;
    const result = await pool.query(
      "UPDATE products SET name = $1, description = $2, price = $3, stock = $4 WHERE id = $5",
      [name, description || null, price, stock, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Product not found." });
    res.json({ message: "Product updated." });
  } catch (err) {
    console.error("Admin edit product error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Hide or show a product in the shop
router.post("/admin/products/:id/visibility", adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid product." });
  if (typeof req.body.active !== "boolean") return res.status(400).json({ message: "Invalid request." });

  try {
    const result = await pool.query("UPDATE products SET is_active = $1 WHERE id = $2", [req.body.active, id]);
    if (result.rowCount === 0) return res.status(404).json({ message: "Product not found." });
    res.json({ message: req.body.active ? "Product is visible again." : "Product hidden from the shop." });
  } catch (err) {
    console.error("Product visibility error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// ORDERS
// =====================================================
const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"];

router.get("/admin/orders", adminOnly, async (req, res) => {
  try {
    const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : "";
    const q = s(req.query.q).slice(0, 60);

    const where = [];
    const params = [];

    if (status) {
      params.push(status);
      where.push(`o.status = $${params.length}`);
    }
    if (q) {
      params.push(q);
      const idParam = params.length;
      params.push("%" + escapeLike(q) + "%");
      const likeParam = params.length;
      where.push(
        `(o.id::text = $${idParam} OR (u.first_name || ' ' || u.last_name) ILIKE $${likeParam} OR u.email ILIKE $${likeParam})`
      );
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM orders o JOIN users u ON u.id = o.consumer_id ${whereSql}`,
      params
    );
    const total = count.rows[0].n;
    const { pages, page, offset } = paging(total, parsePage(req.query.page));

    const listParams = params.concat([PAGE_SIZE, offset]);
    const rows = await pool.query(
      `SELECT o.id, o.status, o.total_amount, o.created_at, u.first_name, u.last_name, u.email, u.phone,
              (SELECT pm.status FROM payments pm WHERE pm.order_id = o.id ORDER BY pm.created_at DESC, pm.id DESC LIMIT 1) AS payment_status
       FROM orders o
       JOIN users u ON u.id = o.consumer_id
       ${whereSql}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    const ids = rows.rows.map((r) => r.id);
    const itemsByOrder = new Map();

    if (ids.length > 0) {
      const items = await pool.query(
        `SELECT oi.order_id, oi.quantity, oi.subtotal, pr.name, pu.first_name, pu.last_name
         FROM order_items oi
         JOIN products pr ON pr.id = oi.product_id
         JOIN users pu ON pu.id = oi.producer_id
         WHERE oi.order_id = ANY($1::int[])
         ORDER BY oi.id`,
        [ids]
      );
      for (const row of items.rows) {
        if (!itemsByOrder.has(row.order_id)) itemsByOrder.set(row.order_id, []);
        itemsByOrder.get(row.order_id).push({
          name: row.name,
          quantity: row.quantity,
          subtotal: Number(row.subtotal),
          producerName: `${row.first_name} ${row.last_name}`
        });
      }
    }

    res.json({
      orders: rows.rows.map((r) => ({
        id: r.id,
        status: r.status,
        total: Number(r.total_amount),
        createdAt: r.created_at,
        paymentStatus: r.payment_status,
        customer: { name: `${r.first_name} ${r.last_name}`, email: r.email, phone: r.phone },
        items: itemsByOrder.get(r.id) || []
      })),
      total,
      page,
      pages
    });
  } catch (err) {
    console.error("Admin orders error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Change the status of an order (cancelling returns the items to stock)
router.post("/admin/orders/:id/status", adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid order." });

  const status = s(req.body.status);
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ message: "Choose a valid status." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [id]);
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found." });
    }

    const current = found.rows[0].status;
    if (current === "cancelled") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled orders cannot be changed." });
    }
    if (current === status) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "The order already has this status." });
    }

    if (status === "cancelled") {
      await client.query(
        `UPDATE products p SET stock = p.stock + oi.quantity
         FROM order_items oi
         WHERE oi.order_id = $1 AND oi.product_id = p.id`,
        [id]
      );
    }

    await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, id]);

    // Keep the item progress in step with the order status
    if (status === "shipped") {
      await client.query("UPDATE order_items SET fulfillment = 'shipped' WHERE order_id = $1 AND fulfillment = 'new'", [id]);
    }
    if (status === "delivered") {
      await client.query("UPDATE order_items SET fulfillment = 'delivered' WHERE order_id = $1", [id]);
    }
    await client.query("COMMIT");

    res.json({ message: "Order status updated." });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Order status error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  } finally {
    client.release();
  }
});

// =====================================================
// POST /api/account/change-password  (any logged-in user, including the admin)
// =====================================================
router.post("/account/change-password", requireAuth, async (req, res) => {
  const currentPassword = String(req.body.currentPassword ?? "");
  const newPassword = String(req.body.newPassword ?? "");

  if (!currentPassword) return res.status(400).json({ message: "Enter your current password." });
  if (!isStrongEnough(newPassword)) {
    return res.status(400).json({ message: "New password must be 8+ characters with letters and numbers." });
  }
  if (currentPassword === newPassword) return res.status(400).json({ message: "Choose a different password." });

  try {
    const result = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    const correct = result.rows.length ? await bcrypt.compare(currentPassword, result.rows[0].password_hash) : false;
    if (!correct) return res.status(400).json({ message: "Your current password is not correct." });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, req.user.id]);
    res.json({ message: "Password changed." });
  } catch (err) {
    console.error("Change password error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;
