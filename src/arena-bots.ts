/**
 * AI arena bots — ghost players that auto-trade in free trial arenas.
 * Each bot has a style that determines direction + stake selection.
 */
import { supabase } from "./db/client.ts";
import {
  getFantasyGameMember,
  listFantasyGameMembers,
  placeFantasyTradeWithDebit,
  type FantasyGame,
  type FantasyGameMember,
} from "./db/fantasy.ts";
import { getTradeQuote } from "./bayse-market.ts";
import { FANTASY_TRADE_AMOUNTS, roundMoney } from "./fantasy-league.ts";
import type { RoundPricing } from "./bayse-market.ts";
import { getMarketSignals } from "./agent-signals.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

type BotStyle = "aggressive" | "conservative" | "random" | "trend" | "contrarian";

interface ArenaBotRow {
  telegram_id: number;
  display_name: string;
  style: BotStyle;
}

// ── Kelly stake sizing ────────────────────────────────────────────────────────

/**
 * Kelly fraction: f = (bp - q) / b
 *   b = odds - 1 (payout ratio), p = win probability, q = 1 - p
 * Returns a fraction of bankroll [0, 1], capped per style.
 */
function kellyStake(
  winProbability: number,
  entryPrice: number,
  virtualBalance: number,
  maxFraction: number
): number {
  const b = (1 / Math.max(0.01, entryPrice)) - 1; // net odds
  const p = Math.max(0.01, Math.min(0.99, winProbability));
  const q = 1 - p;
  const fraction = Math.max(0, (b * p - q) / b);
  const capped = Math.min(fraction, maxFraction);
  const raw = capped * virtualBalance;
  // Snap to nearest valid trade amount
  const amounts = FANTASY_TRADE_AMOUNTS;
  return amounts.reduce((best, amt) =>
    Math.abs(amt - raw) < Math.abs(best - raw) ? amt : best
  , amounts[0]);
}

// ── Bot decision logic ────────────────────────────────────────────────────────

/**
 * Signal-based decision per agent style.
 *
 * composite signal in [-1,+1]:
 *   > 0  → UP signal
 *   < 0  → DOWN signal
 *
 * Each style interprets the signal differently:
 *   aggressive   — follows signal strongly, high Kelly cap (40% bankroll)
 *   conservative — follows signal only when confident, low Kelly cap (10%)
 *   trend        — follows signal with medium Kelly cap (20%)
 *   contrarian   — fades the signal (bets opposite), medium Kelly cap (25%)
 *   random       — ignores signal, random direction, random stake
 */
export function botDecision(
  style: BotStyle,
  pricing: RoundPricing,
  virtualBalance: number,
  compositeSignal: number  // [-1, +1]
): { direction: "UP" | "DOWN"; stake: number } {
  const amounts = FANTASY_TRADE_AMOUNTS;

  if (style === "random") {
    return {
      direction: Math.random() < 0.5 ? "UP" : "DOWN",
      stake: amounts[Math.floor(Math.random() * amounts.length)]!,
    };
  }

  // Determine direction from signal
  let signalDir: "UP" | "DOWN";
  let winProbability: number;
  let maxKellyFraction: number;
  let confidenceThreshold: number;

  switch (style) {
    case "aggressive":
      signalDir = compositeSignal >= 0 ? "UP" : "DOWN";
      winProbability = 0.5 + Math.abs(compositeSignal) * 0.2; // 50–70%
      maxKellyFraction = 0.40;
      confidenceThreshold = 0.0; // always trades
      break;
    case "conservative":
      signalDir = compositeSignal >= 0 ? "UP" : "DOWN";
      winProbability = 0.5 + Math.abs(compositeSignal) * 0.15;
      maxKellyFraction = 0.10;
      confidenceThreshold = 0.3; // only trades when signal is clear
      break;
    case "trend":
      signalDir = compositeSignal >= 0 ? "UP" : "DOWN";
      winProbability = 0.5 + Math.abs(compositeSignal) * 0.18;
      maxKellyFraction = 0.20;
      confidenceThreshold = 0.1;
      break;
    case "contrarian":
      // Fades the signal
      signalDir = compositeSignal >= 0 ? "DOWN" : "UP";
      winProbability = 0.5 + Math.abs(compositeSignal) * 0.12;
      maxKellyFraction = 0.25;
      confidenceThreshold = 0.2;
      break;
  }

  // Fall back to market favourite if signal is below confidence threshold
  if (Math.abs(compositeSignal) < confidenceThreshold) {
    signalDir = pricing.upPrice <= 0.5 ? "UP" : "DOWN";
    winProbability = 0.52; // slight edge assumed
  }

  const entryPrice = signalDir === "UP" ? pricing.upPrice : pricing.downPrice;
  const stake = kellyStake(winProbability, entryPrice, virtualBalance, maxKellyFraction);

  return { direction: signalDir, stake };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function loadArenaBots(): Promise<ArenaBotRow[]> {
  const { data, error } = await supabase
    .from("ai_arena_bots")
    .select("telegram_id, display_name, style")
    .order("telegram_id", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ArenaBotRow[];
}

/** Adds all 5 bots as members of a free trial game (idempotent). */
export async function seedBotsIntoFreeTrialGame(game: FantasyGame): Promise<void> {
  const bots = await loadArenaBots();
  for (const bot of bots) {
    const existing = await getFantasyGameMember(game.id, bot.telegram_id);
    if (existing) continue;
    const { error } = await supabase.from("fantasy_game_members").insert({
      game_id: game.id,
      telegram_id: bot.telegram_id,
      entry_fee_paid: 0,
      virtual_balance: game.virtual_start_balance,
    });
    if (error && !error.message.includes("unique")) throw error;
  }
}

// ── Auto-trade ────────────────────────────────────────────────────────────────

/**
 * Called each round for a free trial game.
 * Fetches live market signals once, then each bot decides independently.
 */
export async function runBotTradesForRound(
  game: FantasyGame,
  pricing: RoundPricing,
  previousUpPrice: number | null = null
): Promise<void> {
  const bots = await loadArenaBots();

  // Fetch signals once for all bots (shared market view)
  const signals = await getMarketSignals(pricing.upPrice, previousUpPrice).catch(() => ({
    momentum: 0, rsi: 0, oddsDrift: 0, composite: 0,
  }));

  await Promise.all(
    bots.map(async (bot) => {
      try {
        const member = await getFantasyGameMember(game.id, bot.telegram_id);
        if (!member) return;

        // Skip if already traded this round
        const { count } = await supabase
          .from("fantasy_trades")
          .select("id", { count: "exact", head: true })
          .eq("game_id", game.id)
          .eq("telegram_id", bot.telegram_id)
          .eq("event_id", pricing.eventId);
        if ((count ?? 0) > 0) return;

        const { direction, stake } = botDecision(
          bot.style as BotStyle,
          pricing,
          member.virtual_balance,
          signals.composite
        );
        if (member.virtual_balance < stake) return;

        const outcomeId = direction === "UP" ? pricing.upOutcomeId : pricing.downOutcomeId;
        if (!outcomeId) return;

        const quote = await getTradeQuote({
          eventId: pricing.eventId,
          marketId: pricing.marketId,
          outcomeId,
          amount: stake,
          currency: "USD",
        });
        if (!quote) return;

        const entryPrice = direction === "UP" ? pricing.upPrice : pricing.downPrice;
        const shares = roundMoney(quote.quantity ?? stake / Math.max(0.01, entryPrice));

        await placeFantasyTradeWithDebit({
          gameId: game.id,
          memberId: member.id,
          telegramId: bot.telegram_id,
          eventId: pricing.eventId,
          marketId: pricing.marketId,
          direction,
          stake,
          entryPrice,
          shares,
        });
      } catch (error) {
        console.warn(`[arena-bots] Bot ${bot.telegram_id} (${bot.style}) failed round ${pricing.eventId}:`, error);
      }
    })
  );
}


// ── Player-owned agent auto-trade ─────────────────────────────────────────────

/**
 * For paid arenas: auto-trade on behalf of members who have agent_style set.
 * Called each round alongside (or instead of) the free-trial bot pass.
 */
export async function runAgentTradesForRound(
  game: FantasyGame,
  pricing: RoundPricing,
  previousUpPrice: number | null = null
): Promise<void> {
  const members = await listFantasyGameMembers(game.id);
  const agentMembers = members.filter(
    (m): m is FantasyGameMember & { agent_style: string } =>
      m.agent_style !== null && m.telegram_id > 0
  );
  if (agentMembers.length === 0) return;

  const signals = await getMarketSignals(pricing.upPrice, previousUpPrice).catch(() => ({
    momentum: 0, rsi: 0, oddsDrift: 0, composite: 0,
  }));

  await Promise.all(
    agentMembers.map(async (member) => {
      try {
        // Skip if already traded this round
        const { count } = await supabase
          .from("fantasy_trades")
          .select("id", { count: "exact", head: true })
          .eq("game_id", game.id)
          .eq("telegram_id", member.telegram_id)
          .eq("event_id", pricing.eventId);
        if ((count ?? 0) > 0) return;

        const { direction, stake } = botDecision(
          member.agent_style as BotStyle,
          pricing,
          member.virtual_balance,
          signals.composite
        );
        if (member.virtual_balance < stake) return;

        const outcomeId = direction === "UP" ? pricing.upOutcomeId : pricing.downOutcomeId;
        if (!outcomeId) return;

        const quote = await getTradeQuote({
          eventId: pricing.eventId,
          marketId: pricing.marketId,
          outcomeId,
          amount: stake,
          currency: "USD",
        });
        if (!quote) return;

        const entryPrice = direction === "UP" ? pricing.upPrice : pricing.downPrice;
        const shares = roundMoney(quote.quantity ?? stake / Math.max(0.01, entryPrice));

        await placeFantasyTradeWithDebit({
          gameId: game.id,
          memberId: member.id,
          telegramId: member.telegram_id,
          eventId: pricing.eventId,
          marketId: pricing.marketId,
          direction,
          stake,
          entryPrice,
          shares,
        });
      } catch (error) {
        console.warn(`[arena-bots] Agent trade failed for member ${member.telegram_id} (${member.agent_style}) in arena ${game.code}:`, error);
      }
    })
  );
}
