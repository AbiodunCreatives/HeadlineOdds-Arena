/**
 * AI arena bots — ghost players that auto-trade in free trial arenas.
 * Each bot has a style that determines direction + stake selection.
 */
import { supabase } from "./db/client.ts";
import {
  getFantasyGameMember,
  placeFantasyTradeWithDebit,
  type FantasyGame,
} from "./db/fantasy.ts";
import { getTradeQuote } from "./bayse-market.ts";
import { FANTASY_TRADE_AMOUNTS, roundMoney } from "./fantasy-league.ts";
import type { RoundPricing } from "./bayse-market.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

type BotStyle = "aggressive" | "conservative" | "random" | "trend" | "contrarian";

interface ArenaBotRow {
  telegram_id: number;
  display_name: string;
  style: BotStyle;
}

// ── Bot decision logic ────────────────────────────────────────────────────────

/**
 * Each style picks a direction and stake amount.
 * `upPrice` < 0.5 means market leans DOWN (UP is the underdog).
 */
function botDecision(
  style: BotStyle,
  pricing: RoundPricing,
  virtualBalance: number
): { direction: "UP" | "DOWN"; stake: number } {
  const marketLeanUp = pricing.upPrice <= 0.5; // market thinks UP is more likely
  const amounts = FANTASY_TRADE_AMOUNTS;

  switch (style) {
    case "aggressive":
      // Always bets big on the market favourite
      return { direction: marketLeanUp ? "UP" : "DOWN", stake: amounts[3] };

    case "conservative":
      // Bets small on the market favourite
      return { direction: marketLeanUp ? "UP" : "DOWN", stake: amounts[0] };

    case "random": {
      const dir = Math.random() < 0.5 ? "UP" : "DOWN";
      const stake = amounts[Math.floor(Math.random() * amounts.length)];
      return { direction: dir as "UP" | "DOWN", stake };
    }

    case "trend":
      // Follows the favourite with a medium stake
      return { direction: marketLeanUp ? "UP" : "DOWN", stake: amounts[1] };

    case "contrarian":
      // Bets against the market favourite
      return { direction: marketLeanUp ? "DOWN" : "UP", stake: amounts[2] };
  }
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
 * Each bot that hasn't traded yet places a trade based on its style.
 */
export async function runBotTradesForRound(
  game: FantasyGame,
  pricing: RoundPricing
): Promise<void> {
  const bots = await loadArenaBots();

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

        const { direction, stake } = botDecision(bot.style, pricing, member.virtual_balance);
        if (member.virtual_balance < stake) return; // can't afford, skip

        // Get a real quote so shares are calculated correctly
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
        // Non-fatal: log and continue so one bot failure doesn't block others
        console.warn(`[arena-bots] Bot ${bot.telegram_id} (${bot.style}) failed to trade round ${pricing.eventId}:`, error);
      }
    })
  );
}
