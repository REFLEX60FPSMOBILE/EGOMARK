-- Console staff + espace client sécurisé.
-- Toutes les tables sont additives : les commandes existantes restent lisibles.
-- Le statut métier vit dans order_workflow ; manual_orders.status reste la
-- valeur historique utilisée par les anciens clients/API.

CREATE TABLE IF NOT EXISTS order_workflow (
  order_id     TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','delivered','dispute','cancelled')),
  updated_at   TEXT NOT NULL,
  updated_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_workflow_status ON order_workflow (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS order_events (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  actor        TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_members (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','support','logistics')),
  token_hash    TEXT NOT NULL UNIQUE,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT,
  actor_name    TEXT NOT NULL,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  details_json  TEXT,
  ip_hash       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blacklist (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('ip','paypal','discord','email')),
  value_hash    TEXT NOT NULL,
  value_masked  TEXT NOT NULL,
  reason        TEXT,
  created_by    TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (kind, value_hash)
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL,
  discord         TEXT NOT NULL,
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assignee        TEXT,
  source          TEXT NOT NULL DEFAULT 'site',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_message_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON support_tickets (order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('client','staff','system')),
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages (ticket_id, created_at ASC);

CREATE TABLE IF NOT EXISTS canned_responses (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_stock (
  slug                TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  category            TEXT,
  price_cents         INTEGER,
  stock               INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 3,
  active              INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_keys (
  id           TEXT PRIMARY KEY,
  product_slug TEXT NOT NULL,
  secret       TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','delivered','disabled')),
  order_id     TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (product_slug, secret_hash)
);
CREATE INDEX IF NOT EXISTS idx_stock_keys_product ON stock_keys (product_slug, status, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_keys_order ON stock_keys (order_id, status);

CREATE TABLE IF NOT EXISTS client_accounts (
  id                  TEXT PRIMARY KEY,
  email_hash          TEXT NOT NULL UNIQUE,
  email_masked        TEXT NOT NULL,
  password_hash       TEXT NOT NULL,
  password_salt       TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  totp_secret         TEXT,
  totp_enabled        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  ip_hash      TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_sessions_account ON client_sessions (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS client_order_links (
  account_id TEXT NOT NULL,
  order_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_client_links_order ON client_order_links (order_id);

CREATE TABLE IF NOT EXISTS client_login_events (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ip_hash    TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_login_account ON client_login_events (account_id, created_at DESC);

-- Reprend les statuts historiques dans le nouveau workflow.
INSERT OR IGNORE INTO order_workflow (order_id, status, updated_at, updated_by)
SELECT order_id, status, updated_at, 'migration'
FROM manual_orders;

-- Modèles de réponse utiles au support.
INSERT OR IGNORE INTO canned_responses (id, title, body, created_at)
VALUES
  ('commande-recue', 'Commande reçue', 'Merci pour ton message. Je vérifie ta commande et je reviens vers toi rapidement.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('livraison-discord', 'Livraison Discord', 'Ta commande est prête. Ouvre un ticket dans #support-achat avec ton numéro de commande et ton ID de transaction PayPal.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
