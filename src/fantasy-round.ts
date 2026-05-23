/**
 * Round lifecycle: BTC price fetching, round processing, settlement, finalization.
 */
import { InlineKeyboard } from "grammy";
import { Api } from "grammy";
import { config } from "./config.ts";
import {
  getCurrentRoundSnapshot,
  getEvent,
  getEventPricing,
  getTradeQuote,
  type Round,
  type RoundPricing,
} from "./bayse-market.ts";
import { creditBalance } from "./db/balances.ts";
import {
  awardFantasyPrize,
  getFantasyGameById,
  getFantasyGameMember,
  getFantasyLeaderboard,
  getFantasyTradeForMemberEvent,
  incrementRefundRetry,
  listActiveFantasyGames,
  listDueOpenFantasyGames,
  listFantasyGameMembers,
  listFantasyPayouts,
  listFantasyTradesForGame,
  listFantasyTradesForGameEvent,
  listFinalizableFantasyGames,
  listPendingFantasyTrades,
  listPendingFantasyTradesForGame,
  listPendingRefunds,
  markRefundCompleted,
  markRefundFailed,
  recalculateFantasyPrizePool,
  settleFantasyTradeAtomically,
  syncFantasyPrizeAwards,
  updateFantasyGame,
  updateFantasyMemberRoundTracking,
  type FantasyGame,
  type FantasyGameMember,
  type FantasyLeaderboardEntry,
  type FantasyTrade,
  type FantasyTradeDirection,
} from "./db/fantasy.ts";
import { recordRevenueOnce } from "./db/revenue.ts";
import {
  anonymizePlayer,
  buildShareResultUrl,
  formatCompactDuration,
  formatDurationHours,
  formatMediumDateTime,
  formatMoney,
  formatRankMovement,
  formatSignedPercent,
  formatWholeMoney,
  getApproxRoundsLeft,
  getGameDurationHours,
  getGameRoundNumber,
  getPrizeAwardPreview,
  getProjectedPrizeForUser,
  getVirtualReturnPct,
} from "./fantasy-ui.ts";
import { redis } from "./utils/rateLimit.ts";
import { escapeMarkdown } from "./utils/escape.ts";
import {
  consumeFantasyNextRoundReminder,
  fantasyMidRoundNudgeKey,
  fantasyRoundReminderKey,
  loadFantasyTradeReference,
  saveFantasyTradeReference,
  type FantasyTradeRefPayload,
} from "./fantasy-state.ts";
import {
  FANTASY_ASSET,
  FANTASY_COMMISSION_RATE,
  FANTASY_ENTRY_MULTIPLIER,
  FANTASY_TRADE_AMOUNTS,
  buildRoundBroadcastPayload,
  getPrizePoolBreakdown,
  getPrizeSplits,
  roundMoney,
  schedulePromptCountdown,
} from "./fantasy-league.ts";
import { runBotTradesForRound } from "./arena-bots.ts";

const tgApi = new Api(config.BOT_TOKEN);
let cachedBotUsername: string | null = null;

// ── In-memory nudge timers ────────────────────────────────────────────────────
const activeMidRoundNudges = new Map<string, NodeJS.Timeout>();

// ── BTC price cache ───────────────────────────────────────────────────────────
const BINANCE_BTC_PRICE_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const BINANCE_BTC_PRICE_CACHE_TTL_MS = 10_000;
const BINANCE_BTC_PRICE_TIMEOUT_MS = 5_000;
const BINANCE_BTC_PRICE_FAILURE_TTL_MS = 60_000;
const BINANCE_BTC_PRICE_STALE_MAX_AGE_MS = 5 * 60_000;
const MIN_VALID_BTC_PRICE_USD = 1_000;

let cachedBinanceBtcPrice: { value: number; fetchedAt: number } | null = null;
let cachedBinanceBtcPriceFailure: { failedAt: number; message: string } | null = null;

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isUsableBtcPrice(value: number | null | undefined): value is number {
  return Number.isFinite(value) && (value ?? 0) >= MIN_VALID_BTC_PRICE_USD;
}

async function fetchBinanceBtcTicker(): Promise<number | null> {
  const response = await fetch(BINANCE_BTC_PRICE_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(BINANCE_BTC_PRICE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Binance API ${response.status}: ${text || response.statusText}`);
  }
  const payload = (await response.json()) as { price?: unknown };
  const parsedPrice = parseOptionalNumber(payload.price);
  return isUsableBtcPrice(parsedPrice) ? parsedPrice : null;
}

export async function getCachedBinanceBtcPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedBinanceBtcPrice && now - cachedBinanceBtcPrice.fetchedAt < BINANCE_BTC_PRICE_CACHE_TTL_MS) {
    return cachedBinanceBtcPrice.value;
  }
  if (cachedBinanceBtcPriceFailure && now - cachedBinanceBtcPriceFailure.failedAt < BINANCE_BTC_PRICE_FAILURE_TTL_MS) {
    if (cachedBinanceBtcPrice && now - cachedBinanceBtcPrice.fetchedAt < BINANCE_BTC_PRICE_STALE_MAX_AGE_MS) {
      return cachedBinanceBtcPrice.value;
    }
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsedPrice = await fetchBinanceBtcTicker();
      if (!isUsableBtcPrice(parsedPrice)) throw new Error("Binance returned an invalid BTC price");
      cachedBinanceBtcPrice = { value: parsedPrice, fetchedAt: now };
      cachedBinanceBtcPriceFailure = null;
      return parsedPrice;
    } catch (error) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue; }
      cachedBinanceBtcPriceFailure = { failedAt: now, message: error instanceof Error ? error.message : String(error) };
      console.warn(`[fantasy] Failed to load BTC price from Binance after 2 attempts; backing off for ${Math.round(BINANCE_BTC_PRICE_FAILURE_TTL_MS / 1000)}s: ${cachedBinanceBtcPriceFailure.message}`);
    }
  }
  if (cachedBinanceBtcPrice && now - cachedBinanceBtcPrice.fetchedAt < BINANCE_BTC_PRICE_STALE_MAX_AGE_MS) {
    return cachedBinanceBtcPrice.value;
  }
  return null;
}

async function getBinanceBtcKlinesPrice(): Promise<number | null> {
  try {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", "BTCUSDT");
    url.searchParams.set("interval", "1m");
    url.searchParams.set("limit", "1");
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(BINANCE_BTC_PRICE_TIMEOUT_MS) });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload) || !Array.isArray(payload[0]) || payload[0].length < 5) return null;
    const closePrice = parseOptionalNumber(payload[0][4]);
    return isUsableBtcPrice(closePrice) ? closePrice : null;
  } catch { return null; }
}

export async function getRoundCurrentPrice(pricing: RoundPricing): Promise<number | null> {
  const binancePrice = await getCachedBinanceBtcPrice();
  if (isUsableBtcPrice(binancePrice)) return binancePrice;

  const outcomeId = pricing.upOutcomeId ?? pricing.downOutcomeId;
  if (outcomeId) {
    try {
      const quote = await getTradeQuote({ eventId: pricing.eventId, marketId: pricing.marketId, outcomeId, amount: FANTASY_TRADE_AMOUNTS[0], currency: "USD" });
      const baysePrice = parseOptionalNumber(quote?.currentMarketPrice);
      if (isUsableBtcPrice(baysePrice)) return baysePrice;
    } catch (error) {
      console.warn(`[fantasy] Failed to load fallback BTC price from Bayse for ${pricing.eventId}:`, error);
    }
  }

  const klinesPrice = await getBinanceBtcKlinesPrice();
  if (isUsableBtcPrice(klinesPrice)) return klinesPrice;
  if (isUsableBtcPrice(pricing.eventThreshold)) return pricing.eventThreshold;
  return null;
}

async function getRoundClosePrice(closingDate: string | null): Promise<number | null> {
  const closingMs = closingDate ? Date.parse(closingDate) : Number.NaN;
  if (!Number.isFinite(closingMs)) return null;
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", "BTCUSDT");
  url.searchParams.set("interval", "15m");
  url.searchParams.set("limit", "1");
  url.searchParams.set("endTime", String(Math.max(0, closingMs - 1)));
  try {
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) { const text = await response.text(); throw new Error(`Binance API ${response.status}: ${text || response.statusText}`); }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return null;
    const candle = payload[0];
    if (!Array.isArray(candle) || candle.length < 5) return null;
    const closePrice = parseOptionalNumber(candle[4]);
    return isUsableBtcPrice(closePrice) ? closePrice : null;
  } catch (error) {
    console.warn("[fantasy] Failed to load BTC round close price from Binance:", error);
    return null;
  }
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function inferResolvedDirection(payload: unknown): FantasyTradeDirection | null {
  const record = payload as { status?: unknown; markets?: Array<{ status?: unknown; resolvedOutcome?: unknown }> };
  const eventStatus = typeof record.status === "string" ? record.status.toLowerCase() : "";
  const market = record.markets?.[0];
  const marketStatus = typeof market?.status === "string" ? market.status.toLowerCase() : "";
  const resolvedOutcome = typeof market?.resolvedOutcome === "string" ? market.resolvedOutcome.toUpperCase() : "";
  if (eventStatus !== "resolved" || marketStatus !== "resolved") return null;
  if (resolvedOutcome === "YES") return "UP";
  if (resolvedOutcome === "NO") return "DOWN";
  return null;
}

function extractEventWindow(payload: unknown): { openingDate: string | null; closingDate: string | null } {
  const record = payload as { openingDate?: unknown; closingDate?: unknown };
  return {
    openingDate: typeof record.openingDate === "string" && record.openingDate.trim() ? record.openingDate : null,
    closingDate: typeof record.closingDate === "string" && record.closingDate.trim() ? record.closingDate : null,
  };
}

async function getBotUsername(): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername;
  const me = await tgApi.getMe();
  cachedBotUsername = me.username;
  return cachedBotUsername;
}

async function safeSendMessage(chatId: number, text: string, keyboard?: InlineKeyboard, parseMode?: "MarkdownV2") {
  await tgApi.sendMessage(chatId, text, {
    ...(keyboard ? { reply_markup: keyboard } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
  }).catch((error) => { console.warn(`[fantasy] Failed to send message to ${chatId}:`, error); });
}

async function safeSendMessageAndReturn(chatId: number, text: string, keyboard?: InlineKeyboard) {
  return tgApi.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : undefined)
    .catch((error) => { console.warn(`[fantasy] Failed to send message to ${chatId}:`, error); return null; });
}

function buildTradeNowKeyboard(gameCode: string): InlineKeyboard {
  return new InlineKeyboard().text("Trade Now", `arena:trade:${gameCode}`);
}

function formatLiveRoundPromptBtcPrice(value: number | null): string {
  if (!isUsableBtcPrice(value)) return "loading...";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildRoundCloseNotificationText(input: {
  roundNumber: number;
  closePrice: number | null;
  referencePrice: number | null;
  resolvedDirection: FantasyTradeDirection;
  trade: FantasyTrade | null;
  virtualBalance: number;
  rank: number;
  totalParticipants: number;
}): string {
  const targetStr = formatLiveRoundPromptBtcPrice(input.referencePrice);
  const closeStr = formatLiveRoundPromptBtcPrice(input.closePrice);
  const directionLine = input.resolvedDirection === "UP"
    ? `BTC closed above ${targetStr} at ${closeStr} ✅`
    : `BTC closed below ${targetStr} at ${closeStr} ❌`;
  const tradeLine = input.trade === null
    ? "You didn't trade this round."
    : input.trade.outcome === "WIN"
      ? `Your call: ${input.trade.direction} ✓  +${formatMoney(input.trade.payout - input.trade.stake)} profit`
      : `Your call: ${input.trade.direction} ✗`;
  return [
    `Round ${input.roundNumber} closed.`,
    directionLine,
    tradeLine,
    `Balance: ${formatWholeMoney(input.virtualBalance)}  ·  Rank #${input.rank} of ${input.totalParticipants}`,
  ].join("\n");
}

function buildFinalArenaMessage(input: {
  game: FantasyGame;
  leaderboard: FantasyLeaderboardEntry[];
  viewerTelegramId: number;
  roundsPlayed: number;
}): string {
  const standings = input.leaderboard.map((entry) => {
    const medal = entry.place === 1 ? "🥇" : entry.place === 2 ? "🥈" : entry.place === 3 ? "🥉" : "  ";
    const name = anonymizePlayer(entry.telegram_id, input.viewerTelegramId, entry.username);
    const payoutText = entry.prize_awarded > 0 ? formatMoney(entry.prize_awarded) : "—";
    return `${medal}  ${name.padEnd(8)} ${formatWholeMoney(entry.virtual_balance)}   ${formatSignedPercent(getVirtualReturnPct(input.game, entry.virtual_balance))}   → ${payoutText}`;
  });
  const me = input.leaderboard.find((e) => e.telegram_id === input.viewerTelegramId) ?? null;
  const payout = me?.prize_awarded ?? 0;
  return [
    `🏁 Arena ${input.game.code} — FINAL`,
    "",
    `Duration: ${formatDurationHours(getGameDurationHours(input.game))}  •  ${input.roundsPlayed} rounds played`,
    "",
    ...standings,
    "",
    payout > 0 ? `Your payout: ${formatMoney(payout)} ✅` : "Your payout: —",
    payout > 0 ? "Added to your balance." : "No payout this time.",
  ].join("\n");
}

function scheduleMidRoundNudge(input: {
  game: FantasyGame;
  member: FantasyGameMember;
  eventId: string;
  roundNumber: number;
  delayMs: number;
}): void {
  const key = fantasyMidRoundNudgeKey(input.game.id, input.eventId, input.member.telegram_id);
  const existing = activeMidRoundNudges.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    activeMidRoundNudges.delete(key);
    void (async () => {
      try {
        const existingTrade = await getFantasyTradeForMemberEvent(input.game.id, input.member.id, input.eventId);
        if (existingTrade) return;
        await safeSendMessage(input.member.telegram_id, buildMidRoundNudgeText(input.roundNumber), buildTradeNowKeyboard(input.game.code));
      } catch (error) {
        console.warn(`[fantasy] Failed to send mid-round nudge for arena ${input.game.code}:`, error);
      }
    })();
  }, Math.max(0, input.delayMs));
  activeMidRoundNudges.set(key, timer);
}

function buildMidRoundNudgeText(roundNumber: number): string {
  return [`⏳ 7 minutes left in Round ${roundNumber}.`, "You haven't placed a trade yet — you're leaving points on the table."].join("\n");
}

// ── Exported round functions ──────────────────────────────────────────────────

export interface FantasyRoundSettlementSummary {
  game: FantasyGame;
  leaderboard: FantasyLeaderboardEntry[];
  roundNumber: number;
  leaderGainPoints: number;
}

export async function sendFantasyStartingSoonPings(): Promise<void> {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const { listOpenFantasyGames } = await import("./db/fantasy.ts");
  const openGames = await listOpenFantasyGames();
  for (const game of openGames) {
    const msUntilStart = Date.parse(game.start_at) - now;
    if (msUntilStart > windowMs || msUntilStart <= 0) continue;
    const pingKey = `arena:starting_soon:${game.id}`;
    const alreadySent = await redis.set(pingKey, "1", "EX", 3600, "NX");
    if (!alreadySent) continue;
    const members = await listFantasyGameMembers(game.id);
    const startsAt = new Date(game.start_at);
    await Promise.all(members.map(async (member) => {
      for (let i = 0; i < 3; i++) {
        if (Date.parse(game.start_at) <= Date.now()) break;
        const minutesLeft = Math.max(1, Math.round((startsAt.getTime() - Date.now()) / 60_000));
        const text = `⚡️ *Arena ${escapeMarkdown(game.code)} starts in ~${minutesLeft} min\\!*\n_Make sure you're ready — trading begins when the arena goes live\\._`;
        await safeSendMessage(member.telegram_id, text, undefined, "MarkdownV2");
        if (i < 2) await new Promise((r) => setTimeout(r, 10_000));
      }
    }));
  }
}

export async function activateDueFantasyGames(): Promise<void> {
  const dueGames = await listDueOpenFantasyGames(new Date().toISOString());
  for (const game of dueGames) {
    const lockKey = `arena:activating:${game.id}`;
    const acquired = await redis.set(lockKey, "1", "EX", 60, "NX");
    if (!acquired) continue;
    const members = await listFantasyGameMembers(game.id);
    await recalculateFantasyPrizePool(game.id, FANTASY_COMMISSION_RATE);
    await updateFantasyGame({ gameId: game.id, status: "active" });
    const refreshed = (await getFantasyGameById(game.id)) ?? game;
    const leaderboard = await getFantasyLeaderboard(game.id);
    const message = [
      `🏆 HEADLINEODDS ARENA ${refreshed.code} IS LIVE`, "",
      `Players: ${leaderboard.length}`,
      ...buildPrizePoolLines(refreshed.entry_fee, leaderboard.length),
      `Virtual bankroll: ${formatMoney(refreshed.virtual_start_balance)}`, "",
      `Duration: ${formatDurationHours(getGameDurationHours(refreshed))}`,
      "You will receive a BTC round prompt for each 15M round until the arena ends.",
    ].join("\n");
    await Promise.all(members.map((m) => safeSendMessage(m.telegram_id, message)));
  }
}

function buildPrizePoolLines(entryFee: number, playerCount: number): string[] {
  const breakdown = getPrizePoolBreakdown(entryFee, playerCount);
  return [
    `Gross entry pool: ${formatMoney(breakdown.grossPrizePool)}`,
    `Bot commission (8%): ${formatMoney(breakdown.commissionAmount)}`,
    `Net prize pool: ${formatMoney(breakdown.netPrizePool)}`,
  ];
}

export async function processFantasyLeagueRound(round: Round, pricing: RoundPricing): Promise<void> {
  if (Date.parse(round.closingDate) <= Date.now()) return;
  await activateDueFantasyGames().catch((e) => { console.warn("[fantasy-monitor] Inline activation pass failed:", e); });
  const activeGames = await listActiveFantasyGames(new Date().toISOString());
  for (const game of activeGames) {
    if (game.last_round_event_id === pricing.eventId) continue;
    if (Date.parse(round.openingDate) >= Date.parse(game.end_at)) continue;
    const members = await listFantasyGameMembers(game.id);
    const leaderboard = await getFantasyLeaderboard(game.id);
    const currentPrice = await getRoundCurrentPrice(pricing);
    const roundRef = await saveFantasyTradeReference({
      gameId: game.id, eventId: pricing.eventId, marketId: pricing.marketId,
      openingDate: round.openingDate, closingDate: round.closingDate,
      currentPrice, referencePrice: pricing.eventThreshold,
      upPrice: pricing.upPrice, downPrice: pricing.downPrice,
      upOutcomeId: pricing.upOutcomeId, downOutcomeId: pricing.downOutcomeId,
    });
    const roundNumber = getGameRoundNumber(game, round.openingDate);
    const midRoundDelayMs = Math.max(0, Math.floor((Date.parse(round.closingDate) - Date.parse(round.openingDate)) / 2));
    const deliveryResults = await Promise.all(members.map(async (member) => {
      const rank = leaderboard.find((e) => e.telegram_id === member.telegram_id)?.place ?? null;
      if (rank === null) return false;
      scheduleMidRoundNudge({ game, member, eventId: pricing.eventId, roundNumber, delayMs: midRoundDelayMs });
      const prompt = buildRoundBroadcastPayload({ game, round, pricing, currentPrice, rank, memberCount: leaderboard.length, virtualBalance: member.virtual_balance, ref: roundRef });
      const reminderActive = await consumeFantasyNextRoundReminder(game.id, member.telegram_id);
      const sent = await safeSendMessageAndReturn(member.telegram_id, reminderActive ? ["🔔 Don't miss this round.", "", prompt.text].join("\n") : prompt.text, prompt.keyboard);
      if (sent) {
        schedulePromptCountdown({ ...prompt.state, chatId: member.telegram_id, messageId: sent.message_id, telegramId: member.telegram_id });
        return true;
      }
      return false;
    }));
    if (!deliveryResults.some(Boolean)) { console.warn(`[fantasy] No round prompts delivered for arena ${game.code} on ${pricing.eventId}.`); continue; }
    await updateFantasyGame({ gameId: game.id, lastRoundEventId: pricing.eventId });
    // Bots auto-trade in free trial arenas
    if (game.is_free_trial) {
      const prevRef = game.last_round_event_id
        ? await loadFantasyTradeReference(game.last_round_event_id).catch(() => null)
        : null;
      runBotTradesForRound(game, pricing, prevRef?.upPrice ?? null).catch((e) => {
        console.warn(`[arena-bots] Auto-trade failed for arena ${game.code}:`, e);
      });
    }
  }
}

export async function processPendingRefunds(): Promise<void> {
  const pending = await listPendingRefunds();
  for (const refund of pending) {
    const nextRetry = refund.retry_count + 1;
    try {
      await creditBalance(refund.telegram_id, refund.amount, { entryType: "arena_entry_refund", referenceType: "fantasy_game", referenceId: refund.game_code, idempotencyKey: `refund:${refund.id}` });
      await markRefundCompleted(refund.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (nextRetry >= 3) {
        await markRefundFailed(refund.id, reason, nextRetry).catch(() => undefined);
        console.error(`[fantasy] CRITICAL: pending refund ${refund.id} permanently failed after ${nextRetry} attempts — user ${refund.telegram_id} amount ${refund.amount} game ${refund.game_code}: ${reason}`);
      } else {
        await incrementRefundRetry(refund.id, nextRetry).catch(() => undefined);
        console.warn(`[fantasy] Pending refund ${refund.id} retry ${nextRetry}/3 failed: ${reason}`);
      }
    }
  }
}

export async function settleFantasyLeagueTrades(): Promise<FantasyRoundSettlementSummary[]> {
  const pendingTrades = await listPendingFantasyTrades();
  const settledRounds: FantasyRoundSettlementSummary[] = [];
  const eventCache = new Map<string, unknown>();
  const tradesByRound = new Map<string, FantasyTrade[]>();
  for (const trade of pendingTrades) {
    const roundKey = `${trade.game_id}:${trade.event_id}`;
    const group = tradesByRound.get(roundKey) ?? [];
    group.push(trade);
    tradesByRound.set(roundKey, group);
  }
  for (const [roundKey, roundTrades] of tradesByRound) {
    const trade = roundTrades[0];
    if (!trade) continue;
    try {
      let eventPayload = eventCache.get(trade.event_id);
      if (eventPayload === undefined) { eventPayload = await getEvent(trade.event_id); eventCache.set(trade.event_id, eventPayload); }
      if (!eventPayload) { console.warn(`[fantasy] Could not fetch event ${trade.event_id} for settlement, will retry next tick.`); continue; }
      const resolvedDirection = inferResolvedDirection(eventPayload);
      if (!resolvedDirection) { console.log(`[fantasy] Event ${trade.event_id} not yet resolved, will retry next tick.`); continue; }
      const eventWindow = extractEventWindow(eventPayload);
      const game = await getFantasyGameById(trade.game_id);
      if (!game) continue;
      const previousLeaderboard = await getFantasyLeaderboard(game.id);
      const previousBalances = new Map(previousLeaderboard.map((e) => [e.telegram_id, e.virtual_balance] as const));
      let settlementFailed = false;
      for (const pendingTrade of roundTrades) {
        const outcome = resolvedDirection === pendingTrade.direction ? "WIN" : "LOSS";
        const payout = outcome === "WIN" ? roundMoney(pendingTrade.shares) : 0;
        try {
          const settled = await settleFantasyTradeAtomically({ tradeId: pendingTrade.id, outcome, payout });
          if (!settled) continue;
        } catch (error) { settlementFailed = true; console.error(`[fantasy] Failed to settle fantasy trade ${pendingTrade.id}:`, error); }
      }
      if (settlementFailed) continue;
      const allTradesForRound = await listFantasyTradesForGameEvent(trade.game_id, trade.event_id);
      if (allTradesForRound.some((e) => e.outcome === "PENDING")) continue;
      const members = await listFantasyGameMembers(game.id);
      const refreshedLeaderboard = await getFantasyLeaderboard(game.id);
      const roundNumber = getGameRoundNumber(game, eventWindow.openingDate ?? trade.created_at);
      const closePrice = await getRoundClosePrice(eventWindow.closingDate);
      const refPayload = await loadFantasyTradeReference(trade.event_id).catch(() => null);
      const referencePrice = refPayload?.referencePrice ?? null;
      const tradesByMemberId = new Map(allTradesForRound.map((e) => [e.member_id, e] as const));
      const leaderboardRanks = new Map(refreshedLeaderboard.map((e) => [e.telegram_id, e.place] as const));
      const leader = refreshedLeaderboard[0] ?? null;
      const leaderGainPoints = leader ? Math.max(0, Math.round(leader.virtual_balance - (previousBalances.get(leader.telegram_id) ?? leader.virtual_balance))) : 0;
      await Promise.all(members.map(async (member) => {
        const tradeForMember = tradesByMemberId.get(member.id) ?? null;
        const rank = leaderboardRanks.get(member.telegram_id) ?? refreshedLeaderboard.length;
        const nextMissedRounds = tradeForMember ? 0 : member.consecutive_missed_rounds + 1;
        await updateFantasyMemberRoundTracking({ memberId: member.id, lastTradedRound: tradeForMember ? roundNumber : member.last_traded_round, consecutiveMissedRounds: nextMissedRounds }).catch((e) => { console.warn(`[fantasy] Failed to update settlement round tracking for ${member.telegram_id}:`, e); });
        await safeSendMessage(member.telegram_id, buildRoundCloseNotificationText({ roundNumber, closePrice, referencePrice, resolvedDirection, trade: tradeForMember, virtualBalance: member.virtual_balance, rank, totalParticipants: refreshedLeaderboard.length }),
          tradeForMember?.outcome === "WIN"
            ? new InlineKeyboard().text("🏆 Leaderboard", `arena:board:${game.code}`).text("🏟 Lobby", "lobby")
            : new InlineKeyboard().text("🏆 Leaderboard", `arena:board:${game.code}`)
        );
      }));
      settledRounds.push({ game, leaderboard: refreshedLeaderboard, roundNumber, leaderGainPoints });
    } catch (error) { console.error(`[fantasy] Failed to settle fantasy round ${roundKey}:`, error); }
  }
  return settledRounds;
}

export async function sendFantasyRoundReengagements(settledRounds: FantasyRoundSettlementSummary[]): Promise<void> {
  for (const settledRound of settledRounds) {
    if (Date.parse(settledRound.game.end_at) <= Date.now()) continue;
    const leader = settledRound.leaderboard[0] ?? null;
    const members = await listFantasyGameMembers(settledRound.game.id);
    const timeRemaining = formatCompactDuration(Math.max(0, Date.parse(settledRound.game.end_at) - Date.now()));
    await Promise.all(members.map(async (member) => {
      if (member.consecutive_missed_rounds !== 2) return;
      const rank = settledRound.leaderboard.find((e) => e.telegram_id === member.telegram_id)?.place ?? settledRound.leaderboard.length;
      const currentGap = leader ? Math.max(0, Math.round(leader.virtual_balance - member.virtual_balance)) : 0;
      const pointsGap = settledRound.leaderGainPoints > 0 ? settledRound.leaderGainPoints : currentGap;
      await safeSendMessage(member.telegram_id, [`You're in ${rank} place but haven't traded in 2 rounds.`, `The leader just gained ${pointsGap.toLocaleString("en-US")} points.`, `Arena closes in ${timeRemaining}.`].join("\n"), buildTradeNowKeyboard(settledRound.game.code));
    }));
  }
}

export async function finalizeFantasyGames(): Promise<void> {
  const dueGames = await listFinalizableFantasyGames(new Date().toISOString());
  for (const game of dueGames) {
    const pendingTrades = await listPendingFantasyTradesForGame(game.id);
    if (pendingTrades.length > 0) continue;
    const members = await listFantasyGameMembers(game.id);
    const netPrizePool = await recalculateFantasyPrizePool(game.id, FANTASY_COMMISSION_RATE);
    const settledGame = (await getFantasyGameById(game.id)) ?? ({ ...game, prize_pool: netPrizePool } as FantasyGame);
    const leaderboard = await getFantasyLeaderboard(game.id);
    const breakdown = getPrizePoolBreakdown(game.entry_fee, members.length);
    const existingPayouts = await listFantasyPayouts(game.id);
    const paidTelegramIds = new Set(existingPayouts.map((e) => e.telegram_id));
    const awards = getPrizeAwardPreview(leaderboard, settledGame.prize_pool);
    let payoutFailed = false;
    for (const award of awards) {
      if (paidTelegramIds.has(award.telegramId)) continue;
      const amount = roundMoney(award.amount);
      if (amount <= 0) continue;
      const member = await getFantasyGameMember(game.id, award.telegramId);
      if (!member) continue;
      try {
        await awardFantasyPrize({ gameId: game.id, memberId: member.id, telegramId: award.telegramId, place: award.place, amount, referenceId: game.code });
      } catch (error) { payoutFailed = true; console.error(`[fantasy] Prize credit failed for game ${game.code} user ${award.telegramId} amount ${amount}:`, error); }
    }
    if (payoutFailed) continue;
    await syncFantasyPrizeAwards(game.id);
    const refreshedLeaderboard = await getFantasyLeaderboard(game.id);
    const roundsPlayed = countRoundsPlayed(await listFantasyTradesForGame(game.id));
    const botUsername = await getBotUsername();
    await recordRevenueOnce({ telegramId: game.creator_telegram_id, type: `fantasy_commission:${game.code}`, amount: breakdown.commissionAmount });
    await updateFantasyGame({ gameId: game.id, status: "completed", completedAt: new Date().toISOString() });
    const completedGame = ((await getFantasyGameById(game.id)) ?? { ...game, status: "completed", completed_at: new Date().toISOString() }) as FantasyGame;
    await Promise.all(members.map(async (member) => {
      const me = refreshedLeaderboard.find((e) => e.telegram_id === member.telegram_id) ?? null;
      const leader = refreshedLeaderboard[0] ?? null;
      const shareUrl = me && leader ? buildShareResultUrl({ botUsername, entryFee: completedGame.entry_fee, finishPlace: me.place, fieldSize: refreshedLeaderboard.length, returnPct: getVirtualReturnPct(completedGame, me.virtual_balance), leaderReturnPct: getVirtualReturnPct(completedGame, leader.virtual_balance) }) : null;
      const keyboard = new InlineKeyboard().text("▶ Play again", "arena:create");
      if (shareUrl) keyboard.url("📤 Share result", shareUrl);
      await safeSendMessage(member.telegram_id, buildFinalArenaMessage({ game: completedGame, leaderboard: refreshedLeaderboard, viewerTelegramId: member.telegram_id, roundsPlayed }), keyboard);
    }));
  }
}

function countRoundsPlayed(trades: FantasyTrade[]): number {
  return new Set(trades.map((t) => t.event_id)).size;
}
