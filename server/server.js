require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing in the .env file. Add it and restart.");
  process.exit(1);
}

// Make sure the uploads folder exists (profile pictures, product images)
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve ONLY the public front-end folders (never the server folder or .env)
const webRoot = path.join(__dirname, "..");
app.use("/html", express.static(path.join(webRoot, "html")));
app.use("/css", express.static(path.join(webRoot, "css")));
app.use("/js", express.static(path.join(webRoot, "js")));
app.use(
  "/uploads",
  express.static(uploadsDir, {
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff")
  })
);

app.get("/", (req, res) => res.redirect("/html/login.html"));

// Test route: checks that the server and PostgreSQL are connected
app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS time");
    res.json({ status: "ok", database: "connected", time: result.rows[0].time });
  } catch (err) {
    res.status(500).json({ status: "error", database: "not connected", message: err.message });
  }
});

// Routes
app.use("/api/auth", require("./routes/auth-routes"));
app.use("/api", require("./routes/dashboard-routes"));
app.use("/api", require("./routes/consumer-routes"));
app.use("/api", require("./routes/payment-routes"));
app.use("/api", require("./routes/admin-routes"));
app.use("/api", require("./routes/seller-routes"));
app.use("/api", require("./routes/chat-routes"));

// Unknown API route
app.use("/api", (req, res) => {
  res.status(404).json({ message: "API route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Server error" });
});

// Create or update the extra tables/columns automatically
async function setupTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMP   NOT NULL,
        used       BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP   NOT NULL DEFAULT NOW()
      )
    `);

    // Payments (bank transfer receipts)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id            SERIAL PRIMARY KEY,
        order_id      INTEGER       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        method        VARCHAR(20)   NOT NULL CHECK (method IN ('bank_transfer', 'telebirr')),
        sender_bank   VARCHAR(60),
        reference     VARCHAR(60)   NOT NULL,
        amount        NUMERIC(12,2) NOT NULL,
        receipt_file  VARCHAR(255)  NOT NULL,
        status        VARCHAR(10)   NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'confirmed', 'rejected')),
        note          VARCHAR(200),
        created_at    TIMESTAMP     NOT NULL DEFAULT NOW(),
        reviewed_at   TIMESTAMP,
        reviewed_by   INTEGER REFERENCES users(id)
      )
    `);
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_reference ON payments (LOWER(reference)) WHERE status <> 'rejected'"
    );
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_open ON payments (order_id) WHERE status = 'submitted'"
    );

    // Extra product photos, payout account, shipping and payout progress
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_images (
        id         SERIAL PRIMARY KEY,
        product_id INTEGER      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        image_url  VARCHAR(255) NOT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id)");

    // Chat between consumer and producer about a product
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id              SERIAL PRIMARY KEY,
        product_id      INTEGER   NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        consumer_id     INTEGER   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        producer_id     INTEGER   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        last_message_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (product_id, consumer_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id              SERIAL PRIMARY KEY,
        conversation_id INTEGER   NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id       INTEGER   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body            TEXT      NOT NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        read_at         TIMESTAMP
      )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_conversations_users ON conversations(consumer_id, producer_id)");

    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_bank VARCHAR(60)");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_account_name VARCHAR(80)");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_account_number VARCHAR(30)");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_mobile VARCHAR(20)");

    await pool.query(
      "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fulfillment VARCHAR(10) NOT NULL DEFAULT 'new' CHECK (fulfillment IN ('new', 'shipped', 'delivered'))"
    );
    await pool.query(
      "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS payout_status VARCHAR(10) NOT NULL DEFAULT 'unpaid' CHECK (payout_status IN ('unpaid', 'paid'))"
    );
    await pool.query("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS payout_at TIMESTAMP");
    await pool.query("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS payout_reference VARCHAR(60)");

    // Profile fields used by the producer dashboard
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(30)");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(300)");
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users (LOWER(nickname)) WHERE nickname IS NOT NULL"
    );
  } catch (err) {
    console.error("Could not prepare tables. Did you run database.sql first?");
    console.error(err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Register page: http://localhost:${PORT}/html/register.html`);
  setupTables();
});
