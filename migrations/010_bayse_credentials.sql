-- Per-user Bayse API credentials (encrypted at rest)
CREATE TABLE IF NOT EXISTS bayse_credentials (
  telegram_id BIGINT PRIMARY KEY REFERENCES fantasy_users(telegram_id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,
  secret_key  TEXT NOT NULL,  -- AES-256-GCM encrypted, stored as hex: iv:authTag:ciphertext
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
