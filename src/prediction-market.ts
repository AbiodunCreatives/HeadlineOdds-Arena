import { supabase } from "./db/client.ts";
import { getBalance, debitBalance, creditBalance } from "./db/balances.ts";

export interface PredictionMarket {
  id: string;
  question: string;
  closes_at: string;
  status: "open" | "closed" | "resolved";
  outcome: "YES" | "NO" | null;
  yes_pool: number;
  no_pool: number;
  house_cut_pct: number;
  created_by: number;
  broadcast_message_ids: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface PredictionMarketBet {
  id: string;
  market_id: string;
  telegram_id: number;
  side: "YES" | "NO";
  amount: number;
  payout: number | null;
}

function round(v: number): number {
  return Math.round((v + Number.EPSILON) * 1_000_000) / 1_000_000;
}

// ── Odds ──────────────────────────────────────────────────────────────────────

export function calcOdds(yesPool: number, noPool: number): { yes: number; no: number } {
  const total = yesPool + noPool;
  if (total === 0) return { yes: 2.0, no: 2.0 };
  return {
    yes: round(total / Math.max(yesPool, 0.000001)),
    no: round(total / Math.max(noPool, 0.000001)),
  };
}

export function formatOdds(odds: number): string {
  return `${odds.toFixed(2)}x`;
}

// Approximate NGN/USD rate — update periodically
const NGN_PER_USD = 1600;

// ── Market text ───────────────────────────────────────────────────────────────

export function buildMarketText(market: PredictionMarket): string {
  const odds = calcOdds(market.yes_pool, market.no_pool);
  const total = round(market.yes_pool + market.no_pool);
  const totalNgn = Math.round(total * NGN_PER_USD).toLocaleString("en-NG");
  const closes = new Date(market.closes_at).toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const statusLine =
    market.status === "resolved"
      ? `✅ *Resolved: ${market.outcome}*`
      : market.status === "closed"
      ? `🔒 Betting closed`
      : `⏳ Closes: ${closes}`;

  return (
    `🔥 *HeadlineOdds Market*\n\n` +
    `${market.question}\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `✅ YES  ${formatOdds(odds.yes)}  |  ❌ NO  ${formatOdds(odds.no)}\n` +
    `💰 Pool: $${total.toFixed(2)} USDC (~₦${totalNgn})\n` +
    `${statusLine}\n` +
    `━━━━━━━━━━━━━━━━`
  );
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function createMarket(input: {
  question: string;
  closesAt: Date;
  createdBy: number;
  houseCutPct?: number;
}): Promise<PredictionMarket> {
  const { data, error } = await supabase
    .from("prediction_markets")
    .insert({
      question: input.question,
      closes_at: input.closesAt.toISOString(),
      created_by: input.createdBy,
      house_cut_pct: input.houseCutPct ?? 10,
      status: "open",
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as PredictionMarket;
}

export async function getMarket(id: string): Promise<PredictionMarket | null> {
  const { data, error } = await supabase
    .from("prediction_markets")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as PredictionMarket | null;
}

export async function listAllUsers(): Promise<{ telegram_id: number }[]> {
  const { data, error } = await supabase
    .from("fantasy_users")
    .select("telegram_id")
    .gt("telegram_id", 0);
  if (error) throw error;
  return (data ?? []) as { telegram_id: number }[];
}

export async function saveBroadcastMessageIds(
  marketId: string,
  ids: { chat_id: number; message_id: number }[]
): Promise<void> {
  const { error } = await supabase
    .from("prediction_markets")
    .update({ broadcast_message_ids: JSON.stringify(ids) })
    .eq("id", marketId);
  if (error) throw error;
}

export async function getUserBet(
  marketId: string,
  telegramId: number
): Promise<PredictionMarketBet | null> {
  const { data, error } = await supabase
    .from("prediction_market_bets")
    .select("*")
    .eq("market_id", marketId)
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw error;
  return data as PredictionMarketBet | null;
}

// ── Place bet ─────────────────────────────────────────────────────────────────

export async function placeBet(input: {
  marketId: string;
  telegramId: number;
  side: "YES" | "NO";
  amount: number;
}): Promise<{ market: PredictionMarket; bet: PredictionMarketBet }> {
  const market = await getMarket(input.marketId);
  if (!market) throw new Error("Market not found.");
  if (market.status !== "open") throw new Error("This market is no longer accepting bets.");
  if (new Date(market.closes_at) < new Date()) throw new Error("Betting has closed for this market.");

  const existing = await getUserBet(input.marketId, input.telegramId);
  if (existing) throw new Error("You already placed a bet on this market.");

  const balance = await getBalance(input.telegramId);
  if (balance < input.amount) throw new Error(`Insufficient balance. You have $${balance.toFixed(2)} USDC.`);

  // Debit user
  const debited = await debitBalance(input.telegramId, input.amount, {
    reason: "prediction_market_bet",
    referenceType: "prediction_market",
    referenceId: input.marketId,
    idempotencyKey: `pmbet:${input.marketId}:${input.telegramId}`,
  });
  if (!debited) throw new Error("Could not debit balance. Please try again.");

  // Record bet
  const { data: bet, error: betError } = await supabase
    .from("prediction_market_bets")
    .insert({
      market_id: input.marketId,
      telegram_id: input.telegramId,
      side: input.side,
      amount: round(input.amount),
    })
    .select("*")
    .single();
  if (betError) throw betError;

  // Update pool
  const poolField = input.side === "YES" ? "yes_pool" : "no_pool";
  const { data: updated, error: updateError } = await supabase
    .from("prediction_markets")
    .update({ [poolField]: round((market[poolField as keyof PredictionMarket] as number) + input.amount) })
    .eq("id", input.marketId)
    .select("*")
    .single();
  if (updateError) throw updateError;

  return { market: updated as PredictionMarket, bet: bet as PredictionMarketBet };
}

// ── Resolve ───────────────────────────────────────────────────────────────────

export async function resolveMarket(input: {
  marketId: string;
  outcome: "YES" | "NO";
}): Promise<{ market: PredictionMarket; payouts: { telegram_id: number; payout: number }[] }> {
  const market = await getMarket(input.marketId);
  if (!market) throw new Error("Market not found.");
  if (market.status === "resolved") throw new Error("Market already resolved.");

  const { data: bets, error: betsError } = await supabase
    .from("prediction_market_bets")
    .select("*")
    .eq("market_id", input.marketId);
  if (betsError) throw betsError;

  const allBets = (bets ?? []) as PredictionMarketBet[];
  const losingPool = input.outcome === "YES" ? market.no_pool : market.yes_pool;
  const winningPool = input.outcome === "YES" ? market.yes_pool : market.no_pool;

  const payouts: { telegram_id: number; payout: number }[] = [];

  // No opposing bets — void the market, refund everyone
  if (losingPool === 0) {
    for (const bet of allBets) {
      await creditBalance(bet.telegram_id, bet.amount, {
        reason: "prediction_market_void_refund",
        referenceType: "prediction_market",
        referenceId: input.marketId,
        idempotencyKey: `pmvoid:${input.marketId}:${bet.telegram_id}`,
      });
      await supabase.from("prediction_market_bets").update({ payout: bet.amount }).eq("id", bet.id);
      payouts.push({ telegram_id: bet.telegram_id, payout: bet.amount });
    }

    const { data: resolved, error: resolveError } = await supabase
      .from("prediction_markets")
      .update({ status: "resolved", outcome: input.outcome, resolved_at: new Date().toISOString() })
      .eq("id", input.marketId)
      .select("*")
      .single();
    if (resolveError) throw resolveError;

    return { market: { ...(resolved as PredictionMarket), _voided: true } as PredictionMarket, payouts };
  }

  // Normal resolution — winners split the losing pool minus house cut
  const winningBets = allBets.filter((b) => b.side === input.outcome);
  const houseCut = round(losingPool * (market.house_cut_pct / 100));
  const distributable = round(losingPool - houseCut);

  for (const bet of winningBets) {
    const share = bet.amount / winningPool;
    const payout = round(bet.amount + distributable * share);

    await creditBalance(bet.telegram_id, payout, {
      reason: "prediction_market_win",
      referenceType: "prediction_market",
      referenceId: input.marketId,
      idempotencyKey: `pmwin:${input.marketId}:${bet.telegram_id}`,
    });

    await supabase.from("prediction_market_bets").update({ payout }).eq("id", bet.id);
    payouts.push({ telegram_id: bet.telegram_id, payout });
  }

  // Mark resolved
  const { data: resolved, error: resolveError } = await supabase
    .from("prediction_markets")
    .update({ status: "resolved", outcome: input.outcome, resolved_at: new Date().toISOString() })
    .eq("id", input.marketId)
    .select("*")
    .single();
  if (resolveError) throw resolveError;

  return { market: resolved as PredictionMarket, payouts };
}
