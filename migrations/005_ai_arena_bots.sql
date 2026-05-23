-- AI arena bots: ghost players that auto-trade in free trial arenas

ALTER TABLE fantasy_users
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS ai_arena_bots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL UNIQUE,  -- negative IDs, e.g. -1001 to -1005
  display_name TEXT NOT NULL,
  style       TEXT NOT NULL CHECK (style IN ('aggressive', 'conservative', 'random', 'trend', 'contrarian')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed 5 bots with negative telegram_ids to avoid collision with real users
INSERT INTO fantasy_users (telegram_id, username, is_bot)
VALUES
  (-1001, 'Phiona',      TRUE),
  (-1002, 'Danfo_Dave',  TRUE),
  (-1003, 'Fave',        TRUE),
  (-1004, 'Mallam_Odds', TRUE),
  (-1005, 'Alhaji_Pump', TRUE)
ON CONFLICT (telegram_id) DO NOTHING;

INSERT INTO ai_arena_bots (telegram_id, display_name, style)
VALUES
  (-1001, 'Phiona',      'aggressive'),
  (-1002, 'Danfo_Dave',  'conservative'),
  (-1003, 'Fave',        'random'),
  (-1004, 'Mallam_Odds', 'trend'),
  (-1005, 'Alhaji_Pump', 'contrarian')
ON CONFLICT (telegram_id) DO NOTHING;
