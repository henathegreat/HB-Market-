const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth-middleware");

const router = express.Router();
const uploadsDir = path.join(__dirname, "..", "uploads");

// ---------- Image upload (profile pictures and product photos) ----------
const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

function makeUploader(prefix, fieldName, maxMB) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (req, file, cb) => {
        const ext = IMAGE_EXT[file.mimetype] || ".jpg";
        cb(null, prefix + "-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + ext);
      }
    }),
    limits: { fileSize: maxMB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = Boolean(IMAGE_EXT[file.mimetype]);
      cb(ok ? null : new Error("INVALID_IMAGE"), ok);
    }
  }).single(fieldName);

  return (req, res, next) => {
    upload(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ message: `Image must be ${maxMB}MB or smaller.` });
        }
        return res.status(400).json({ message: "Only JPG, PNG or WEBP images are allowed." });
      }
      next();
    });
  };
}

// ---------- Helpers ----------
const s = (value) => String(value ?? "").trim();

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function removeFile(file) {
  if (file && file.path) fs.unlink(file.path, () => {});
}

function removeUpload(urlPath) {
  if (!urlPath) return;
  fs.unlink(path.join(uploadsDir, path.basename(urlPath)), () => {});
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
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

function mapPerson(r) {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    nickname: r.nickname,
    bio: r.bio,
    city: r.city,
    country: r.country,
    profilePicture: r.profile_picture,
    createdAt: r.created_at
  };
}

// Checks product fields. Returns an error message, or null if everything is fine.
function checkProduct(b) {
  const name = s(b.name);
  const description = s(b.description);
  const price = Number(b.price);
  const stock = Number(b.stock);

  if (name.length < 2 || name.length > 120) return { error: "Product name must be 2 to 120 characters." };
  if (description.length > 1000) return { error: "Description must be 1000 characters or less." };
  if (s(b.price) === "" || !Number.isFinite(price) || price <= 0 || price > 1000000000) {
    return { error: "Enter a valid price." };
  }
  if (s(b.stock) === "" || !Number.isInteger(stock) || stock < 0 || stock > 1000000) {
    return { error: "Stock must be a whole number (0 or more)." };
  }
  return { value: { name, description, price: Math.round(price * 100) / 100, stock } };
}

// =====================================================
// GET /api/profile/me  (my profile + stats)
// =====================================================
router.get("/profile/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, role, first_name, last_name, email, phone, country, city, address,
              nickname, bio, profile_picture, created_at
       FROM users WHERE id = $1 AND is_active = TRUE`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Account not found." });
    const row = result.rows[0];

    const count = await pool.query(
      "SELECT COUNT(*)::int AS n FROM products WHERE producer_id = $1 AND is_active = TRUE",
      [row.id]
    );
    const sales = await pool.query(
      `SELECT COALESCE(SUM(oi.quantity), 0)::int AS items_sold,
              COALESCE(SUM(oi.producer_earning), 0) AS earnings
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.producer_id = $1 AND o.status IN ('paid', 'shipped', 'delivered')`,
      [row.id]
    );

    res.json({
      user: { ...mapPerson(row), role: row.role, email: row.email, phone: row.phone, address: row.address },
      stats: {
        products: count.rows[0].n,
        itemsSold: sales.rows[0].items_sold,
        earnings: Number(sales.rows[0].earnings)
      }
    });
  } catch (err) {
    console.error("Profile error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// PUT /api/profile/me  (nickname, bio, profile picture)
// =====================================================
router.put("/profile/me", requireAuth, makeUploader("profile", "profilePicture", 2), async (req, res) => {
  const file = req.file;
  const fail = (status, message) => {
    removeFile(file);
    return res.status(status).json({ message });
  };

  try {
    const nickname = s(req.body.nickname);
    const bio = s(req.body.bio);

    if (nickname && !/^[A-Za-z0-9_.-]{3,30}$/.test(nickname)) {
      return fail(400, "Nickname must be 3 to 30 characters: letters, numbers, dot, dash or underscore.");
    }
    if (bio.length > 300) return fail(400, "Bio must be 300 characters or less.");

    const old = await pool.query("SELECT profile_picture FROM users WHERE id = $1", [req.user.id]);
    if (old.rows.length === 0) return fail(404, "Account not found.");

    const picture = file ? "/uploads/" + file.filename : old.rows[0].profile_picture;

    await pool.query(
      "UPDATE users SET nickname = $1, bio = $2, profile_picture = $3 WHERE id = $4",
      [nickname || null, bio || null, picture, req.user.id]
    );

    if (file) removeUpload(old.rows[0].profile_picture);
    res.json({ message: "Profile updated." });
  } catch (err) {
    if (err.code === "23505") return fail(409, "This nickname is already taken.");
    console.error("Update profile error:", err.message);
    fail(500, "Server error. Please try again.");
  }
});

// =====================================================
// POST /api/products  (producer posts a product)
// =====================================================
router.post("/products", requireAuth, requireRole("producer"), makeUploader("product", "image", 3), async (req, res) => {
  const file = req.file;
  const checked = checkProduct(req.body);

  if (checked.error) {
    removeFile(file);
    return res.status(400).json({ message: checked.error });
  }

  try {
    const { name, description, price, stock } = checked.value;
    const result = await pool.query(
      `INSERT INTO products (producer_id, name, description, price, stock, image_url)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, name, description || null, price, stock, file ? "/uploads/" + file.filename : null]
    );
    res.status(201).json({ message: "Product posted.", product: mapProduct(result.rows[0]) });
  } catch (err) {
    removeFile(file);
    console.error("Post product error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// GET /api/products/mine  (my products)
// =====================================================
router.get("/products/mine", requireAuth, requireRole("producer"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products WHERE producer_id = $1 AND is_active = TRUE ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json({ products: result.rows.map(mapProduct) });
  } catch (err) {
    console.error("My products error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// PUT /api/products/:id  (edit my product)
// =====================================================
router.put("/products/:id", requireAuth, requireRole("producer"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid product." });

  const checked = checkProduct(req.body);
  if (checked.error) return res.status(400).json({ message: checked.error });

  try {
    const { name, description, price, stock } = checked.value;
    const result = await pool.query(
      `UPDATE products SET name = $1, description = $2, price = $3, stock = $4
       WHERE id = $5 AND producer_id = $6 AND is_active = TRUE RETURNING *`,
      [name, description || null, price, stock, id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Product not found." });
    res.json({ message: "Product updated.", product: mapProduct(result.rows[0]) });
  } catch (err) {
    console.error("Edit product error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// DELETE /api/products/:id  (hide my product)
// =====================================================
router.delete("/products/:id", requireAuth, requireRole("producer"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid product." });

  try {
    // The product is hidden, not erased, so old orders keep working
    const result = await pool.query(
      "UPDATE products SET is_active = FALSE WHERE id = $1 AND producer_id = $2 AND is_active = TRUE",
      [id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Product not found." });
    res.json({ message: "Product deleted." });
  } catch (err) {
    console.error("Delete product error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// GET /api/search?q=...&by=all|product|producer|nickname
// =====================================================
router.get("/search", requireAuth, async (req, res) => {
  try {
    const q = s(req.query.q).slice(0, 60);
    const by = ["all", "product", "producer", "nickname"].includes(req.query.by) ? req.query.by : "all";

    if (!q) return res.status(400).json({ message: "Type something to search." });

    const like = "%" + escapeLike(q) + "%";
    const nickLike = "%" + escapeLike(q.replace(/^@/, "")) + "%";

    let products = [];
    let producers = [];

    if (by === "all" || by === "product") {
      const result = await pool.query(
        `SELECT p.id, p.name, p.description, p.price, p.stock, p.image_url, p.producer_id, p.created_at,
                u.first_name, u.last_name, u.nickname
         FROM products p
         JOIN users u ON u.id = p.producer_id
         WHERE p.is_active = TRUE AND u.is_active = TRUE AND p.name ILIKE $1
         ORDER BY p.created_at DESC
         LIMIT 20`,
        [like]
      );
      products = result.rows.map(mapProduct);
    }

    if (by !== "product") {
      const nameWhere = "(u.first_name ILIKE $1 OR u.last_name ILIKE $1 OR (u.first_name || ' ' || u.last_name) ILIKE $1)";
      let where;
      let params;

      if (by === "producer") {
        where = nameWhere;
        params = [like];
      } else if (by === "nickname") {
        where = "u.nickname ILIKE $1";
        params = [nickLike];
      } else {
        where = `(${nameWhere} OR u.nickname ILIKE $2)`;
        params = [like, nickLike];
      }

      const result = await pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.nickname, u.bio, u.city, u.country, u.profile_picture, u.created_at
         FROM users u
         WHERE u.role = 'producer' AND u.is_active = TRUE AND ${where}
         ORDER BY u.first_name
         LIMIT 20`,
        params
      );
      producers = result.rows.map(mapPerson);
    }

    res.json({ products, producers });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// =====================================================
// GET /api/producers/:id  (public producer profile + products)
// =====================================================
router.get("/producers/:id", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid producer." });

  try {
    const person = await pool.query(
      `SELECT id, first_name, last_name, nickname, bio, city, country, profile_picture, created_at
       FROM users WHERE id = $1 AND role = 'producer' AND is_active = TRUE`,
      [id]
    );
    if (person.rows.length === 0) return res.status(404).json({ message: "Producer not found." });

    const items = await pool.query(
      "SELECT * FROM products WHERE producer_id = $1 AND is_active = TRUE ORDER BY created_at DESC",
      [id]
    );

    res.json({ producer: mapPerson(person.rows[0]), products: items.rows.map(mapProduct) });
  } catch (err) {
    console.error("Producer profile error:", err.message);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;
