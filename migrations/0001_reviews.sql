-- Avis clients vérifiés après achat.
-- `orders` est la seule source de vérité : une ligne n'existe que si une
-- commande a réellement été payée. `reviews` ne peut référencer qu'une
-- commande existante, et une seule fois.

CREATE TABLE IF NOT EXISTS orders (
  order_id      TEXT PRIMARY KEY,
  email_hash    TEXT NOT NULL,
  product_slug  TEXT NOT NULL,
  product_name  TEXT,
  amount_cents  INTEGER,
  currency      TEXT,
  paid_at       TEXT NOT NULL,
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_email ON orders (email_hash);

CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE REFERENCES orders (order_id) ON DELETE CASCADE,
  product_slug  TEXT NOT NULL,
  product_name  TEXT,
  author        TEXT NOT NULL,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  created_at    TEXT NOT NULL,
  ip_hash       TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviews_published ON reviews (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews (product_slug, status);
