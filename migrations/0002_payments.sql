-- Relie l'enregistrement des commandes au flux de paiement.
-- `payment_ref` identifie le paiement chez le prestataire (une référence ne
-- peut servir qu'à une seule commande). `source` distingue un achat réel
-- (webhook signé) d'un enregistrement manuel de secours (admin).

ALTER TABLE orders ADD COLUMN payment_ref TEXT;
ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'admin';

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_ref
  ON orders (payment_ref)
  WHERE payment_ref IS NOT NULL;
