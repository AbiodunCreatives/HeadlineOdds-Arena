-- HeadlineOdds Arena - Traction Metrics
-- Run in Supabase SQL editor. All monetary values in USDC.

-- 1. USER OVERVIEW
SELECT
  COUNT(*) AS total_users,
  COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '7 days') AS active_7d,
  COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '30 days') AS active_30d,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS new_users_7d,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS new_users_30d,
  ROUND(SUM(wallet_balance)::NUMERIC, 2) AS total_live_balances_usdc,
  ROUND(AVG(wallet_balance)::NUMERIC, 4) AS avg_balance_usdc
FROM fantasy_users;

-- 2. ARENA OVERVIEW
SELECT
  COUNT(*) AS total_arenas,
  COUNT(*) FILTER (WHERE status = 'open') AS open,
  COUNT(*) FILTER (WHERE status = 'active') AS active,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
  ROUND(AVG(entry_fee)::NUMERIC, 2) AS avg_entry_fee_usdc,
  ROUND(SUM(prize_pool)::NUMERIC, 2) AS total_prize_pool_usdc,
  ROUND(AVG(prize_pool)::NUMERIC, 2) AS avg_prize_pool_usdc
FROM fantasy_games;

-- 3. ENTRY AND PARTICIPATION
SELECT
  COUNT(*) AS total_entries,
  COUNT(DISTINCT telegram_id) AS unique_players,
  COUNT(DISTINCT game_id) AS arenas_with_entries,
  ROUND(SUM(entry_fee_paid)::NUMERIC, 2) AS total_entry_volume_usdc,
  ROUND(AVG(entry_fee_paid)::NUMERIC, 2) AS avg_entry_fee_usdc,
  ROUND(AVG(total_trades)::NUMERIC, 2) AS avg_trades_per_player,
  MAX(total_trades) AS max_trades_single_player
FROM fantasy_game_members;

-- 4. TRADE OUTCOMES
SELECT
  COUNT(*) AS total_trades,
  COUNT(*) FILTER (WHERE outcome = 'PENDING') AS pending,
  COUNT(*) FILTER (WHERE outcome = 'WIN') AS wins,
  COUNT(*) FILTER (WHERE outcome = 'LOSS') AS losses,
  ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'WIN') / NULLIF(COUNT(*) FILTER (WHERE outcome IN ('WIN','LOSS')), 0), 1) AS win_rate_pct,
  ROUND(SUM(stake)::NUMERIC, 2) AS total_stake_usdc,
  ROUND(SUM(payout)::NUMERIC, 2) AS total_payout_usdc,
  ROUND(AVG(stake)::NUMERIC, 4) AS avg_stake_usdc
FROM fantasy_trades;

-- 5. DEPOSITS
SELECT
  COUNT(*) AS total_deposits,
  COUNT(DISTINCT telegram_id) AS unique_depositors,
  ROUND(SUM(amount)::NUMERIC, 2) AS total_deposited_usdc,
  ROUND(AVG(amount)::NUMERIC, 4) AS avg_deposit_usdc,
  ROUND(MAX(amount)::NUMERIC, 4) AS largest_deposit_usdc,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS deposits_7d,
  ROUND(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::NUMERIC, 2) AS deposit_volume_7d_usdc
FROM fantasy_wallet_deposits;

-- 6. WITHDRAWALS
SELECT
  COUNT(*) AS total_withdrawals,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE status IN ('pending','processing')) AS in_flight,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  ROUND(SUM(amount) FILTER (WHERE status = 'completed')::NUMERIC, 2) AS total_withdrawn_usdc,
  ROUND(AVG(amount) FILTER (WHERE status = 'completed')::NUMERIC, 4) AS avg_withdrawal_usdc
FROM fantasy_wallet_withdrawals;

-- 7. NGN ONRAMP
SELECT
  COUNT(*) AS total_onramp_orders,
  COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
  COUNT(*) FILTER (WHERE status = 'INIT') AS initiated,
  COUNT(DISTINCT telegram_id) AS unique_users,
  ROUND(SUM(fiat_amount) FILTER (WHERE status = 'COMPLETED')::NUMERIC, 2) AS total_ngn_received,
  ROUND(SUM(actual_usdc_amount) FILTER (WHERE status = 'COMPLETED')::NUMERIC, 2) AS total_usdc_credited
FROM fantasy_pajcash_onramps
WHERE transaction_type IS DISTINCT FROM 'OFF_RAMP';

-- 8. NGN OFFRAMP
SELECT
  COUNT(*) AS total_offramp_orders,
  COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
  COUNT(DISTINCT telegram_id) AS unique_users,
  ROUND(SUM(fiat_amount) FILTER (WHERE status = 'COMPLETED')::NUMERIC, 2) AS total_ngn_paid_out,
  ROUND(SUM(actual_usdc_amount) FILTER (WHERE status = 'COMPLETED')::NUMERIC, 2) AS total_usdc_converted
FROM fantasy_pajcash_onramps
WHERE transaction_type = 'OFF_RAMP';

-- 9. PLATFORM REVENUE BY TYPE
SELECT
  type,
  COUNT(*) AS events,
  ROUND(SUM(amount)::NUMERIC, 2) AS total_usdc
FROM fantasy_revenue
GROUP BY type
ORDER BY total_usdc DESC;

-- 10. PRIZE PAYOUTS
SELECT
  COUNT(*) AS total_prize_records,
  COUNT(*) FILTER (WHERE prize_transfer_status = 'confirmed') AS confirmed,
  COUNT(*) FILTER (WHERE prize_transfer_status = 'pending') AS pending,
  COUNT(*) FILTER (WHERE prize_transfer_status = 'failed') AS failed,
  ROUND(SUM(amount) FILTER (WHERE prize_transfer_status = 'confirmed')::NUMERIC, 2) AS total_paid_out_usdc
FROM fantasy_payouts;

-- 11. WALLET LEDGER SUMMARY
SELECT
  entry_type,
  direction,
  COUNT(*) AS events,
  ROUND(SUM(amount)::NUMERIC, 2) AS total_usdc
FROM fantasy_wallet_ledger
WHERE status = 'confirmed'
GROUP BY entry_type, direction
ORDER BY total_usdc DESC;

-- 12. DAILY NEW USERS (last 30 days)
SELECT
  DATE_TRUNC('day', created_at)::DATE AS day,
  COUNT(*) AS new_users
FROM fantasy_users
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY 1
ORDER BY 1;

-- 13. TOP 10 PLAYERS BY BALANCE
SELECT
  telegram_id,
  username,
  ROUND(wallet_balance::NUMERIC, 4) AS balance_usdc,
  created_at
FROM fantasy_users
ORDER BY wallet_balance DESC
LIMIT 10;

-- 14. COMPLETED ARENAS BY PRIZE POOL
SELECT
  g.code,
  g.entry_fee,
  g.prize_pool,
  COUNT(m.id) AS players,
  g.start_at,
  g.end_at
FROM fantasy_games g
LEFT JOIN fantasy_game_members m ON m.game_id = g.id
WHERE g.status = 'completed'
GROUP BY g.id
ORDER BY g.prize_pool DESC
LIMIT 20;