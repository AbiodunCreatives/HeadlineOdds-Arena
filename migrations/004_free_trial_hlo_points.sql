-- Free trial arena support + HLO points ledger

ALTER TABLE fantasy_games
  ADD COLUMN IF NOT EXISTS is_free_trial BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS hlo_points (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL REFERENCES fantasy_users (telegram_id) ON DELETE CASCADE,
  amount      INT NOT NULL CHECK (amount > 0),
  reason      TEXT NOT NULL,
  reference_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hlo_points_telegram_id
  ON hlo_points (telegram_id, created_at DESC);

-- Creates a free-trial game (entry_fee=0, no wallet debit, no ledger entry)
CREATE OR REPLACE FUNCTION create_free_trial_game(
  p_code TEXT,
  p_creator_telegram_id BIGINT,
  p_virtual_start_balance NUMERIC,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ
)
RETURNS SETOF fantasy_games
LANGUAGE plpgsql
AS $$
DECLARE
  game_row fantasy_games%ROWTYPE;
BEGIN
  INSERT INTO fantasy_games (
    code, creator_telegram_id, asset,
    entry_fee, virtual_start_balance, prize_pool,
    status, start_at, end_at, is_free_trial
  )
  VALUES (
    UPPER(BTRIM(p_code)), p_creator_telegram_id, 'BTC',
    20, ROUND(p_virtual_start_balance::NUMERIC, 2), 120,
    'open', p_start_at, p_end_at, TRUE
  )
  RETURNING * INTO game_row;

  INSERT INTO fantasy_game_members (game_id, telegram_id, entry_fee_paid, virtual_balance)
  VALUES (game_row.id, p_creator_telegram_id, 20, ROUND(p_virtual_start_balance::NUMERIC, 2));

  RETURN NEXT game_row;
END;
$$;

-- Joins a free-trial game (no wallet debit, no ledger entry)
CREATE OR REPLACE FUNCTION join_free_trial_game(
  p_code TEXT,
  p_telegram_id BIGINT
)
RETURNS SETOF fantasy_games
LANGUAGE plpgsql
AS $$
DECLARE
  game_row fantasy_games%ROWTYPE;
BEGIN
  SELECT * INTO game_row
  FROM fantasy_games
  WHERE code = UPPER(BTRIM(p_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Arena not found.';
  END IF;

  IF NOT game_row.is_free_trial THEN
    RAISE EXCEPTION 'This is not a free trial arena.';
  END IF;

  IF game_row.status <> 'open' OR game_row.start_at <= NOW() THEN
    RAISE EXCEPTION 'This arena has already started.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM fantasy_game_members
    WHERE game_id = game_row.id AND telegram_id = p_telegram_id
  ) THEN
    RAISE EXCEPTION 'You already joined this arena.';
  END IF;

  BEGIN
    INSERT INTO fantasy_game_members (game_id, telegram_id, entry_fee_paid, virtual_balance)
    VALUES (game_row.id, p_telegram_id, 20, game_row.virtual_start_balance);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'You already joined this arena.';
  END;

  RETURN NEXT game_row;
END;
$$;
