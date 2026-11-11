-- Commandes de la boutique : paiement PayPal.Me manuel, livraison Discord.
-- Une transaction PayPal ne peut être associée qu'à une seule commande.

CREATE TABLE IF NOT EXISTS manual_orders (
  order_id      TEXT PRIMARY KEY,
  discord       TEXT NOT NULL,
  paypal_ref    TEXT NOT NULL,
  items_json    TEXT NOT NULL,
  total_cents   INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'EUR',
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'cancelled')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_orders_paypal_ref ON manual_orders (paypal_ref);
CREATE INDEX IF NOT EXISTS idx_manual_orders_status ON manual_orders (status, created_at DESC);
