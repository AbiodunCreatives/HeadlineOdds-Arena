-- Tracks each user's bet on a Bayse market, mapped to an aggregated Bayse order
CREATE TABLE IF NOT EXISTS bayse_positions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     BIGINT NOT NULL,
  event_id        TEXT NOT NULL,
  event_slug      TEXT NOT NULL,
  event_title     TEXT NOT NULL,
  market_id       TEXT NOT NULL,
  outcome_id      TEXT NOT NULL,
  outcome_label   TEXT NOT NULL,          -- YES | NO
  amount_ngn      NUMERIC(18,2) NOT NULL, -- user's NGN stake
  amount_usdc     NUMERIC(18,6) NOT NULL, -- USDC debited from wallet
  shares          NUMERIC(18,6) NOT NULL, -- shares purchased
  price_at_bet    NUMERIC(6,4) NOT NULL,  -- probability at time of bet
  bayse_order_id  TEXT,                   -- filled after Bayse order placed
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | open | won | lost | refunded
  payout_ngn      NUMERIC(18,2),
  payout_usdc     NUMERIC(18,6),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bayse_positions_telegram_id ON bayse_positions (telegram_id);
CREATE INDEX IF NOT EXISTS idx_bayse_positions_status ON bayse_positions (status);
CREATE INDEX IF NOT EXISTS idx_bayse_positions_market_id ON bayse_positions (market_id);
