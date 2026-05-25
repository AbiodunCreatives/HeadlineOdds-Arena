import { supabase } from "./db/client.ts";
import { creditBalance } from "./db/balances.ts";
import { getBaysePortfolio, ngnToUsdc } from "./bayse-trading.ts";
import { sendAdminAlert } from "./utils/alert.ts";

// ── DB helpers ────────────────────────────────────────────────────────────────

export interface BaysePositionRow {
  id: string;
  telegram_id: number;
  event_id: string;
  event_slug: string;
  event_title: string;
  market_id: string;
  outcome_id: string;
  outcome_label: string;
  amount_ngn: number;
  amount_usdc: number;
  shares: number;
  price_at_bet: number;
  bayse_order_id: string | null;
  status: "pending" | "open" | "won" | "lost" | "refunded";
  payout_ngn: number | null;
  payout_usdc: number | null;
  created_at: string;
  settled_at: string | null;
}

export async function insertBaysePosition(input: {
  telegramId: number;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  marketId: string;
  outcomeId: string;
  outcomeLabel: string;
  amountNgn: number;
  amountUsdc: number;
  shares: number;
  priceAtBet: number;
}): Promise<BaysePositionRow> {
  const { data, error } = await supabase
    .from("bayse_positions")
    .insert({
      telegram_id: input.telegramId,
      event_id: input.eventId,
      event_slug: input.eventSlug,
      event_title: input.eventTitle,
      market_id: input.marketId,
      outcome_id: input.outcomeId,
      outcome_label: input.outcomeLabel,
      amount_ngn: input.amountNgn,
      amount_usdc: input.amountUsdc,
      shares: input.shares,
      price_at_bet: input.priceAtBet,
      status: "open",
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as BaysePositionRow;
}

export async function getOpenBaysePositions(): Promise<BaysePositionRow[]> {
  const { data, error } = await supabase
    .from("bayse_positions")
    .select("*")
    .in("status", ["pending", "open"]);
  if (error) throw error;
  return (data ?? []) as BaysePositionRow[];
}

async function settlePosition(
  position: BaysePositionRow,
  outcome: "won" | "lost",
  payoutNgn: number
): Promise<void> {
  const payoutUsdc = ngnToUsdc(payoutNgn);

  if (outcome === "won" && payoutUsdc > 0) {
    await creditBalance(position.telegram_id, payoutUsdc, {
      reason: "bayse_market_win",
      referenceType: "bayse_position",
      referenceId: position.id,
      idempotencyKey: `baysewin:${position.id}`,
    });
  }

  await supabase
    .from("bayse_positions")
    .update({
      status: outcome,
      payout_ngn: payoutNgn,
      payout_usdc: payoutUsdc,
      settled_at: new Date().toISOString(),
    })
    .eq("id", position.id);
}

// ── Settlement monitor ────────────────────────────────────────────────────────

let monitorRunning = false;
let monitorTimer: NodeJS.Timeout | null = null;
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

async function runSettlementTick(): Promise<void> {
  const openPositions = await getOpenBaysePositions();
  if (openPositions.length === 0) return;

  const portfolio = await getBaysePortfolio();
  // Index by outcomeId — that's what we store in bayse_positions
  const portfolioByOutcome = new Map(portfolio.map((p) => [p.outcomeId, p]));

  for (const position of openPositions) {
    const entry = portfolioByOutcome.get(position.outcome_id);
    if (!entry) continue;

    // A position is resolved when payoutIfOutcomeWins is non-zero and cost is 0
    // (Bayse settles by zeroing cost and setting payout). Use market event engine
    // to detect resolution — simplest signal: payout > 0 means won, check if
    // the market is no longer open by re-fetching would be ideal, but we use
    // the portfolio payout field as the oracle.
    const isResolved = entry.payoutIfOutcomeWins > 0 && entry.currentValue === 0;
    if (!isResolved) continue;

    const won = entry.payoutIfOutcomeWins > 0;
    const payoutNgn = won ? entry.payoutIfOutcomeWins : 0;

    try {
      await settlePosition(position, won ? "won" : "lost", payoutNgn);
      console.log(
        `[bayse-settlement] Settled position ${position.id} for user ${position.telegram_id}: ${won ? "WON" : "LOST"} ₦${payoutNgn}`
      );
    } catch (err) {
      console.error(`[bayse-settlement] Failed to settle position ${position.id}:`, err);
      void sendAdminAlert(
        `[bayse-settlement] Failed to settle position ${position.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

export function startBayseSettlementMonitor(): void {
  if (monitorRunning) return;
  monitorRunning = true;

  const tick = async () => {
    try {
      await runSettlementTick();
    } catch (err) {
      console.error("[bayse-settlement] Tick failed:", err);
      void sendAdminAlert(`[bayse-settlement] Tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (monitorRunning) {
      monitorTimer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  void tick();
  console.log("[bayse-settlement] Started (6h interval).");
}

export function stopBayseSettlementMonitor(): void {
  monitorRunning = false;
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
  console.log("[bayse-settlement] Stopped.");
}
