import { supabase } from "./db/client.ts";
import { creditBalance } from "./db/balances.ts";
import { getBaysePortfolio, sellBaysePosition, ngnToUsdc } from "./bayse-trading.ts";
import { getBayseCredentials } from "./db/bayse-credentials.ts";
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
  status: "pending" | "open" | "won" | "lost" | "sold" | "refunded";
  payout_ngn: number | null;
  payout_usdc: number | null;
  stop_loss_price: number | null;    // probability (0–1); sell if currentValue/cost drops below this
  take_profit_price: number | null;  // probability (0–1); sell if currentValue/cost rises above this
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

export async function getUserBaysePositions(telegramId: number): Promise<BaysePositionRow[]> {
  const { data, error } = await supabase
    .from("bayse_positions")
    .select("*")
    .eq("telegram_id", telegramId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as BaysePositionRow[];
}

export async function closeBaysePosition(
  positionId: string,
  payoutUsdc: number,
  status: "sold" | "refunded" = "refunded"
): Promise<void> {
  await supabase
    .from("bayse_positions")
    .update({
      status,
      payout_usdc: payoutUsdc,
      payout_ngn: null,
      settled_at: new Date().toISOString(),
    })
    .eq("id", positionId);
}

export async function setBaysePositionSlTp(
  positionId: string,
  stopLossPrice: number | null,
  takeProfitPrice: number | null
): Promise<void> {
  const { error } = await supabase
    .from("bayse_positions")
    .update({ stop_loss_price: stopLossPrice, take_profit_price: takeProfitPrice })
    .eq("id", positionId);
  if (error) throw error;
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

// ── SL/TP monitor ─────────────────────────────────────────────────────────────

let slTpMonitorRunning = false;
let slTpMonitorTimer: NodeJS.Timeout | null = null;
const SL_TP_POLL_INTERVAL_MS = 3 * 60 * 1000; // every 3 minutes

async function runSlTpTick(): Promise<void> {
  // Only check positions that actually have SL or TP set
  const { data, error } = await supabase
    .from("bayse_positions")
    .select("*")
    .in("status", ["open"])
    .or("stop_loss_price.not.is.null,take_profit_price.not.is.null");
  if (error) throw error;
  const positions = (data ?? []) as BaysePositionRow[];
  if (positions.length === 0) return;

  const byUser = new Map<number, BaysePositionRow[]>();
  for (const pos of positions) {
    const list = byUser.get(pos.telegram_id) ?? [];
    list.push(pos);
    byUser.set(pos.telegram_id, list);
  }

  for (const [telegramId, userPositions] of byUser) {
    const userKeys = await getBayseCredentials(telegramId).catch(() => null);
    if (!userKeys) continue;

    const portfolio = await getBaysePortfolio({ pub: userKeys.publicKey, sec: userKeys.secretKey }).catch(() => []);
    const portfolioByOutcome = new Map(portfolio.map((p) => [p.outcomeId, p]));

    for (const position of userPositions) {
      const live = portfolioByOutcome.get(position.outcome_id);
      if (!live || live.balance <= 0 || live.cost <= 0) continue;

      // Ratio of current value to cost (>1 means profit, <1 means loss)
      const ratio = live.currentValue / live.cost;

      const hitSl = position.stop_loss_price !== null && ratio <= position.stop_loss_price;
      const hitTp = position.take_profit_price !== null && ratio >= position.take_profit_price;

      if (!hitSl && !hitTp) continue;

      const trigger = hitSl ? "stop-loss" : "take-profit";
      console.log(`[sl-tp] ${trigger} triggered for position ${position.id} (ratio=${ratio.toFixed(4)})`);

      try {
        const sellAmountNgn = live.currentValue > 0 ? live.currentValue : live.cost;
        const result = await sellBaysePosition({
          eventId: live.market.event.id,
          marketId: live.market.id,
          outcomeId: live.outcomeId,
          amountNgn: sellAmountNgn,
          shares: live.balance,
          keys: { pub: userKeys.publicKey, sec: userKeys.secretKey },
        });
        const proceedsNgn = result.order?.amount ?? result.amount ?? sellAmountNgn;
        await closeBaysePosition(position.id, ngnToUsdc(proceedsNgn), "sold");
        console.log(`[sl-tp] Sold position ${position.id} via ${trigger}. Proceeds: ₦${proceedsNgn}`);
        void sendAdminAlert(
          `[sl-tp] ${trigger.toUpperCase()} fired for user ${telegramId} on "${position.event_title}". Proceeds: ₦${Math.round(proceedsNgn)}`
        );
      } catch (err) {
        console.error(`[sl-tp] Failed to sell position ${position.id}:`, err);
        void sendAdminAlert(
          `[sl-tp] Failed to sell position ${position.id} for user ${telegramId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}

export function startSlTpMonitor(): void {
  if (slTpMonitorRunning) return;
  slTpMonitorRunning = true;

  const tick = async () => {
    try { await runSlTpTick(); } catch (err) {
      console.error("[sl-tp] Tick failed:", err);
    }
    if (slTpMonitorRunning) slTpMonitorTimer = setTimeout(tick, SL_TP_POLL_INTERVAL_MS);
  };

  void tick();
  console.log("[sl-tp] Monitor started (3m interval).");
}

export function stopSlTpMonitor(): void {
  slTpMonitorRunning = false;
  if (slTpMonitorTimer) { clearTimeout(slTpMonitorTimer); slTpMonitorTimer = null; }
}

// ── Settlement monitor ────────────────────────────────────────────────────────

let monitorRunning = false;
let monitorTimer: NodeJS.Timeout | null = null;
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

async function runSettlementTick(): Promise<void> {
  const openPositions = await getOpenBaysePositions();
  if (openPositions.length === 0) return;

  // Group positions by telegram_id so we fetch each user's portfolio once with their own keys
  const byUser = new Map<number, BaysePositionRow[]>();
  for (const pos of openPositions) {
    const list = byUser.get(pos.telegram_id) ?? [];
    list.push(pos);
    byUser.set(pos.telegram_id, list);
  }

  for (const [telegramId, positions] of byUser) {
    const userKeys = await getBayseCredentials(telegramId).catch(() => null);
    // Skip users with no stored keys — we cannot check their portfolio
    if (!userKeys) {
      console.warn(`[bayse-settlement] No keys for user ${telegramId}, skipping ${positions.length} position(s)`);
      continue;
    }

    const portfolio = await getBaysePortfolio({ pub: userKeys.publicKey, sec: userKeys.secretKey }).catch(() => []);
    const portfolioByOutcome = new Map(portfolio.map((p) => [p.outcomeId, p]));

    for (const position of positions) {
      const entry = portfolioByOutcome.get(position.outcome_id);
      if (!entry) continue;

      const isResolved = entry.payoutIfOutcomeWins > 0 && entry.currentValue === 0;
      if (!isResolved) continue;

      const won = entry.payoutIfOutcomeWins > 0;
      const payoutNgn = won ? entry.payoutIfOutcomeWins : 0;

      try {
        await settlePosition(position, won ? "won" : "lost", payoutNgn);
        console.log(
          `[bayse-settlement] Settled position ${position.id} for user ${telegramId}: ${won ? "WON" : "LOST"} ₦${payoutNgn}`
        );
      } catch (err) {
        console.error(`[bayse-settlement] Failed to settle position ${position.id}:`, err);
        void sendAdminAlert(
          `[bayse-settlement] Failed to settle position ${position.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
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
