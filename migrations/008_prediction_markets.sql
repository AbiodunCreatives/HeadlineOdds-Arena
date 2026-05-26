-- Prediction markets (narrative YES/NO markets)
CREATE TABLE IF NOT EXISTS prediction_markets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question      TEXT NOT NULL,
  closes_at     TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | closed | resolved
  outcome       TEXT,                            -- YES | NO (set on resolve)
  yes_pool      NUMERIC(18,6) NOT NULL DEFAULT 0,
  no_pool       NUMERIC(18,6) NOT NULL DEFAULT 0,
  house_cut_pct NUMERIC(5,2)  NOT NULL DEFAULT 10,
  created_by    BIGINT NOT NULL,
  broadcast_message_ids TEXT,                   -- JSON array of {chat_id, message_id}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

-- Bets placed on prediction markets
CREATE TABLE IF NOT EXISTS prediction_market_bets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id   UUID NOT NULL REFERENCES prediction_markets(id),
  telegram_id BIGINT NOT NULL,
  side        TEXT NOT NULL,   -- YES | NO
  amount      NUMERIC(18,6) NOT NULL,
  payout      NUMERIC(18,6),   -- filled on resolve
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (market_id, telegram_id)  -- one bet per user per market
);
