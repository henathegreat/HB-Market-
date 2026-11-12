-- =====================================================
-- HB Marketplace database (PostgreSQL)
-- Run inside the database hb_marketplace
-- =====================================================

-- USERS (producer, consumer, admin)
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    role            VARCHAR(10)  NOT NULL CHECK (role IN ('producer', 'consumer', 'admin')),
    first_name      VARCHAR(50)  NOT NULL,
    last_name       VARCHAR(50)  NOT NULL,
    email           VARCHAR(120) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    phone           VARCHAR(20)  NOT NULL,
    birthday        DATE         NOT NULL,
    gender          VARCHAR(10)  NOT NULL CHECK (gender IN ('male', 'female', 'other')),
    country         VARCHAR(60)  NOT NULL,
    city            VARCHAR(60)  NOT NULL,
    address         VARCHAR(200) NOT NULL,
    profile_picture VARCHAR(255),
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- PRODUCTS (created by producers)
CREATE TABLE IF NOT EXISTS products (
    id           SERIAL PRIMARY KEY,
    producer_id  INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         VARCHAR(120)  NOT NULL,
    description  TEXT,
    price        NUMERIC(12,2) NOT NULL CHECK (price > 0),
    stock        INTEGER       NOT NULL DEFAULT 0 CHECK (stock >= 0),
    image_url    VARCHAR(255),
    is_active    BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- ORDERS (created by consumers)
CREATE TABLE IF NOT EXISTS orders (
    id            SERIAL PRIMARY KEY,
    consumer_id   INTEGER       NOT NULL REFERENCES users(id),
    status        VARCHAR(15)   NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
    total_amount  NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
    created_at    TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- ORDER ITEMS (25% commission saved here for every sale)
CREATE TABLE IF NOT EXISTS order_items (
    id                SERIAL PRIMARY KEY,
    order_id          INTEGER       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id        INTEGER       NOT NULL REFERENCES products(id),
    producer_id       INTEGER       NOT NULL REFERENCES users(id),
    quantity          INTEGER       NOT NULL CHECK (quantity > 0),
    price             NUMERIC(12,2) NOT NULL,   -- price of one item at order time
    subtotal          NUMERIC(12,2) NOT NULL,   -- price * quantity
    commission_rate   NUMERIC(4,2)  NOT NULL DEFAULT 0.25,
    commission_amount NUMERIC(12,2) NOT NULL,   -- platform share (25%)
    producer_earning  NUMERIC(12,2) NOT NULL    -- producer share (75%)
);

-- Indexes for faster searching
CREATE INDEX IF NOT EXISTS idx_products_producer ON products(producer_id);
CREATE INDEX IF NOT EXISTS idx_orders_consumer   ON orders(consumer_id);
CREATE INDEX IF NOT EXISTS idx_items_order       ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_producer    ON order_items(producer_id);
