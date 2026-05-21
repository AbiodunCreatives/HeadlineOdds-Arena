-- Migration: 003_prize_ledger_idempotency
-- Fixes award_fantasy_prize_with_credit so the ledger INSERT is idempotent.
-- A retry after a crash between wallet credit and ledger insert previously
-- threw a unique_violation. ON CONFLICT DO NOTHING makes it safe to retry.
-- Safe to run multiple times.

CREATE OR REPLACE FUNCTION award_fantasy_prize_with_credit(
  p_game_id UUID,
  p_member_id UUID,
  p_telegram_id BIGINT,
  p_place INT,
  p_amount NUMERIC,
  p_reference_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_amount NUMERIC(20,6) := ROUND(COALESCE(p_amount, 0)::NUMERIC, 6);
BEGIN
  IF normalized_amount <= 0 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO fantasy_payouts (
    game_id,
    telegram_id,
    place,
    amount
  )
  VALUES (
    p_game_id,
    p_telegram_id,
    p_place,
    normalized_amount
  )
  ON CONFLICT (game_id, telegram_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE fantasy_users
  SET
    wallet_balance = ROUND((wallet_balance + normalized_amount)::NUMERIC, 6),
    updated_at = NOW()
  WHERE telegram_id = p_telegram_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet user not found.';
  END IF;

  INSERT INTO fantasy_wallet_ledger (
    telegram_id,
    entry_type,
    direction,
    amount,
    asset,
    status,
    reference_type,
    reference_id,
    idempotency_key,
    metadata
  )
  VALUES (
    p_telegram_id,
    'fantasy_prize',
    'credit',
    normalized_amount,
    'USDC',
    'confirmed',
    'fantasy_game',
    COALESCE(p_reference_id, p_game_id::TEXT),
    'fantasy_prize:' || p_game_id::TEXT || ':' || p_telegram_id::TEXT,
    jsonb_build_object(
      'game_id',   p_game_id,
      'member_id', p_member_id,
      'place',     p_place
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN TRUE;
END;
$$;
