-- Identité Discord liée à un compte client existant ou créé via OAuth2.
-- Table additive et idempotente : les comptes e-mail/mot de passe continuent
-- de fonctionner sans identité Discord.

CREATE TABLE IF NOT EXISTS discord_identities (
  discord_id   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL UNIQUE,
  username     TEXT NOT NULL,
  display_name TEXT,
  avatar_url   TEXT,
  email_masked TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_identity_account ON discord_identities (account_id);
