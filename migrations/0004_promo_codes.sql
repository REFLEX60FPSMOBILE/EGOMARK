-- Codes promo de la boutique.
-- Le code de lancement EGO10 offre 10 % et reste actif jusqu'à 1 000 usages.

CREATE TABLE IF NOT EXISTS promo_codes (
  code            TEXT PRIMARY KEY,
  percent_off     INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  amount_off_cents INTEGER NOT NULL DEFAULT 0,
  min_total_cents INTEGER NOT NULL DEFAULT 0,
  max_uses        INTEGER,
  uses            INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  expires_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  order_id       TEXT PRIMARY KEY,
  code           TEXT NOT NULL,
  discount_cents INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO promo_codes (code, percent_off, max_uses, uses, active)
VALUES ('EGO10', 10, 1000, 0, 1);
