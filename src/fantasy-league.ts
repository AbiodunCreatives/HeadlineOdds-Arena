import { Api, InlineKeyboard } from "grammy";
import { getCurrentRoundSnapshot, getEventPricing, getTradeQuote, type RoundPricing } from "./bayse-market.ts";
import { config } from "./config.ts";
import {
  getFantasyGameById,
  getFantasyGameByCode,
  getFantasyGameMember,
  getFantasyLeaderboard,
  getFantasyTradeForMemberEvent,
  placeFantasyTradeWithDebit,
  updateFantasyMemberRoundTracking,
  type FantasyGame,
  type FantasyTradeDirection,
} from "./db/fantasy.ts";
import {
  formatCompactDuration,
  formatMoney,
  formatProbabilityPrice,
  formatRoundCountdown,
  formatWholeMoney,
  getGameRoundNumber,
  getVirtualReturnPct,
} from "./fantasy-ui.ts";
import { loadFantasyTradeReference, saveFantasyTradeReference } from "./fantasy-state.ts";

// ── Re-exports from split files ───────────────────────────────────────────────
export type { FantasyTradeRefPayload, OfframpSessionState, CrossChainSession } from "./fantasy-state.ts";
export {
  fantasyTradeRefKey,
  fantasyJoinPendingKey,
  fantasyCustomFundKey,
  fantasyWithdrawStateKey,
  fantasyJoinCodeStateKey,
  fantasyRoundReminderKey,
  fantasyRoundReminderMsgKey,
  fantasyMidRoundNudgeKey,
  fantasyCustomArenaFeeKey,
  offrampSessionKey,
  crossChainSessionKey,
  saveWithdrawState,
  loadWithdrawState,
  clearWithdrawState,
  savePendingJoinCodeEntry,
  hasPendingJoinCodeEntry,
  clearPendingJoinCodeEntry,
  savePendingFantasyLeagueJoin,
  loadPendingFantasyLeagueJoin,
  clearPendingFantasyLeagueJoin,
  savePendingFantasyCustomFundAmount,
  hasPendingFantasyCustomFundAmount,
  clearPendingFantasyCustomFundAmount,
  savePendingCustomArenaFee,
  hasPendingCustomArenaFee,
  clearPendingCustomArenaFee,
  saveOfframpSession,
  loadOfframpSession,
  clearOfframpSession,
  saveCrossChainSession,
  loadCrossChainSession,
  clearCrossChainSession,
  saveFantasyTradeReference,
  loadFantasyTradeReference,
  saveFantasyNextRoundReminder,
  consumeFantasyNextRoundReminder,
} from "./fantasy-state.ts";
export type {
  FantasyRoundSettlementSummary,
} from "./fantasy-round.ts";
export {
  isUsableBtcPrice,
  getCachedBinanceBtcPrice,
  getRoundCurrentPrice,
  sendFantasyStartingSoonPings,
  activateDueFantasyGames,
  processFantasyLeagueRound,
  processPendingRefunds,
  settleFantasyLeagueTrades,
  sendFantasyRoundReengagements,
  finalizeFantasyGames,
} from "./fantasy-round.ts";
export type {
  FantasyLeagueJoinPreview,
  FantasyArenaLobbyCard,
  FantasyArenaLobbySnapshot,
  FantasyLeagueStatusView,
} from "./fantasy-game.ts";
export {
  createFantasyLeagueGame,
  joinFantasyLeagueGame,
  getFantasyLeagueJoinPreview,
  getFantasyLeagueDetailsByCode,
  listFantasyLeagueSnapshots,
  listFantasyArenaLobby,
  getFantasyLeagueStatusView,
  getFantasyLeagueBoardText,
  getFantasyLeagueJoinSummary,
} from "./fantasy-game.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const FANTASY_ASSET = "BTC" as const;
export const FANTASY_ENTRY_MULTIPLIER = 100;
export const FANTASY_COMMISSION_RATE = 0.08;
export const FANTASY_MIN_ENTRY_FEE = 1;
export const FANTASY_MAX_ENTRY_FEE = 10;
export const FANTASY_TRADE_AMOUNTS = [10, 25, 50, 100] as const;
export const FANTASY_DEFAULT_DURATION_HOURS = 24;

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function getVirtualStartBalance(entryFee: number): number {
  return roundMoney(entryFee * FANTASY_ENTRY_MULTIPLIER);
}

export function getPrizeSplits(playerCount: number): number[] {
  if (playerCount <= 2) return [1];
  return [0.5, 0.3, 0.2];
}

export function getPrizePoolBreakdown(entryFee: number, playerCount: number): {
  grossPrizePool: number;
  commissionAmount: number;
  netPrizePool: number;
} {
  const grossPrizePool = roundMoney(entryFee * playerCount);
  const commissionAmount = roundMoney(Math.max(0, grossPrizePool * FANTASY_COMMISSION_RATE));
  return { grossPrizePool, commissionAmount, netPrizePool: roundMoney(Math.max(0, grossPrizePool - commissionAmount)) };
}

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface FantasyGameSnapshot {
  game: FantasyGame;
  memberCount: number;
  yourRank: number | null;
  yourVirtualBalance: number | null;
}

export interface FantasyTradePlacementResult {
  game: FantasyGame;
  stake: number;
  direction: FantasyTradeDirection;
  roundNumber: number;
  entryPrice: number;
  shares: number;
  remainingBalance: number;
  stackIfWin: number;
  stackIfLoss: number;
  closesAt: string;
}

export interface FantasyTradeStakeSelectionView {
  game: FantasyGame;
  direction: FantasyTradeDirection;
  directionPrice: number;
  roundNumber: number;
  closesAt: string;
  currentPrice: number | null;
  referencePrice: number | null;
  upPrice: number;
  downPrice: number;
}

export interface PromptState {
  game: FantasyGame;
  telegramId: number;
  messageId: number;
  chatId: number;
  displayMode: "openAlert" | "livePrompt";
  memberCount: number;
  rank: number;
  virtualBalance: number;
  roundNumber: number;
  closingDate: string;
  currentPrice: number | null;
  referencePrice: number | null;
  upPrice: number;
  downPrice: number;
  ref: string;
  stage: "direction" | "stake";
  selectedDirection: FantasyTradeDirection | null;
  selectedStake: number | null;
}

export interface FantasyTradePromptPayload {
  text: string;
  keyboard: InlineKeyboard;
  state: PromptState;
}


// ── Prompt state ──────────────────────────────────────────────────────────────

const tgApi = new Api(config.BOT_TOKEN);
const activePromptStates = new Map<string, PromptState>();
const activePromptTimers = new Map<string, NodeJS.Timeout>();

function promptStateKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function clearPromptTimer(key: string): void {
  const timer = activePromptTimers.get(key);
  if (timer) { clearTimeout(timer); activePromptTimers.delete(key); }
}

function clearPromptState(key: string): void {
  clearPromptTimer(key);
  activePromptStates.delete(key);
}

function getPromptStateFromMessage(chatId: number | undefined, messageId: number | undefined): { key: string; state: PromptState } | null {
  if (chatId === undefined || messageId === undefined) return null;
  const key = promptStateKey(chatId, messageId);
  const state = activePromptStates.get(key);
  return state ? { key, state } : null;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function formatRoundPromptBtcTarget(value: number | null): string {
  if (!Number.isFinite(value)) return "N/A";
  return `$${(value ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRoundPromptChance(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100)) : "0";
}

function formatRoundPromptPrice(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100)) : "0";
}

function formatRoundPromptMultiplier(value: number): string {
  return Number.isFinite(value) && value > 0 ? (1 / value).toFixed(1) : "0.0";
}

function formatRoundPromptBalanceDelta(game: FantasyGame, virtualBalance: number): string {
  const returnPct = getVirtualReturnPct(game, virtualBalance);
  const rounded = Math.round((returnPct + Number.EPSILON) * 10) / 10;
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(1)}`;
}

function formatLiveRoundPromptBtcPrice(value: number | null): string {
  if (!Number.isFinite(value) || (value ?? 0) < 1000) return "loading...";
  return `$${value!.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatLiveRoundPromptSignedMoney(value: number): string {
  const rounded = roundMoney(value);
  return `${rounded >= 0 ? "+" : "-"}$${Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatFantasyTradeDirection(direction: FantasyTradeDirection): string {
  return direction === "UP" ? "Buy YES" : "Buy NO";
}

function buildLiveRoundQuestion(referencePrice: number | null): string {
  if (!Number.isFinite(referencePrice)) return "Will Bitcoin finish above the target price when this round closes?";
  return `Will Bitcoin be above ${formatLiveRoundPromptBtcPrice(referencePrice)} when this round closes?`;
}

function getProjectedPrizeForRank(rank: number, memberCount: number, prizePool: number): number {
  const split = getPrizeSplits(memberCount)[rank - 1] ?? 0;
  return roundMoney(prizePool * split);
}

function getFantasyDirectionPrice(direction: FantasyTradeDirection, upPrice: number, downPrice: number): number {
  return direction === "UP" ? upPrice : downPrice;
}

function getFantasyProjectedProfit(price: number, amount: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return roundMoney(amount / price - amount);
}

// ── Keyboard builders ─────────────────────────────────────────────────────────

function buildFantasyTradeDirectionButtonData(direction: FantasyTradeDirection, ref: string): string {
  return `flt:b:${direction}:r:${ref}`;
}

function buildFantasyTradeStakeButtonData(amount: number, direction: FantasyTradeDirection, ref: string): string {
  return `flt:d:${amount}:${direction}:r:${ref}`;
}

function buildFantasyTradeBuyKeyboard(input: { ref: string; upPrice: number; downPrice: number }): InlineKeyboard {
  return new InlineKeyboard()
    .text(`⬆ YES  ${formatRoundPromptPrice(input.upPrice)}¢`, buildFantasyTradeDirectionButtonData("UP", input.ref))
    .text(`⬇ NO  ${formatRoundPromptPrice(input.downPrice)}¢`, buildFantasyTradeDirectionButtonData("DOWN", input.ref));
}

function buildFantasyTradeStakeKeyboard(input: { direction: FantasyTradeDirection; ref: string }): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const dirLabel = input.direction === "UP" ? "⬆ YES" : "⬇ NO";
  FANTASY_TRADE_AMOUNTS.forEach((amount, index) => {
    keyboard.text(`${amount} USDC`, buildFantasyTradeStakeButtonData(amount, input.direction, input.ref));
    if (index % 2 === 1 && index < FANTASY_TRADE_AMOUNTS.length - 1) keyboard.row();
  });
  keyboard.row().text(`↩ Change (picked ${dirLabel})`, `flt:reset:r:${input.ref}`);
  return keyboard;
}

function buildRoundPromptKeyboard(state: PromptState): InlineKeyboard {
  return state.stage === "stake" && state.selectedDirection !== null
    ? buildFantasyTradeStakeKeyboard({ direction: state.selectedDirection, ref: state.ref })
    : buildFantasyTradeBuyKeyboard({ ref: state.ref, upPrice: state.upPrice, downPrice: state.downPrice });
}


// ── Prompt text builders ──────────────────────────────────────────────────────

function buildLiveRoundPromptText(state: PromptState): string {
  const yesChance = formatRoundPromptChance(state.upPrice).padStart(3, " ");
  const noChance = formatRoundPromptChance(state.downPrice).padStart(3, " ");
  const yesPrice = formatRoundPromptPrice(state.upPrice).padStart(3, " ");
  const noPrice = formatRoundPromptPrice(state.downPrice).padStart(3, " ");
  const arenaTimeLeft = formatCompactDuration(Math.max(0, Date.parse(state.game.end_at) - Date.now()));
  const selectedPrice = state.selectedDirection === null
    ? null
    : getFantasyDirectionPrice(state.selectedDirection, state.upPrice, state.downPrice);
  const stageLines = state.stage === "stake" && state.selectedDirection !== null && selectedPrice !== null
    ? [
        `You picked ${state.selectedDirection === "UP" ? "⬆ YES" : "⬇ NO"} at ${formatRoundPromptPrice(selectedPrice)}¢`,
        `If correct: win ${formatLiveRoundPromptSignedMoney(getFantasyProjectedProfit(selectedPrice, 100))} on $100`,
        "How many USDC do you want to play?",
      ]
    : [];
  return [
    "━━━━━━━━━━━━━━━━━━",
    `⚡ ROUND ${state.roundNumber}  •  LIVE`,
    "━━━━━━━━━━━━━━━━━━",
    buildLiveRoundQuestion(state.referencePrice),
    "",
    `Current BTC: ${formatLiveRoundPromptBtcPrice(state.currentPrice)}`,
    "",
    `⬆ YES   ${yesChance}%   ${yesPrice}¢   wins ${formatLiveRoundPromptSignedMoney(getFantasyProjectedProfit(state.upPrice, 100))} on $100`,
    `⬇ NO    ${noChance}%   ${noPrice}¢   wins ${formatLiveRoundPromptSignedMoney(getFantasyProjectedProfit(state.downPrice, 100))} on $100`,
    "",
    "━━━━━━━━━━━━━━━━━━",
    `🏆 Rank #${state.rank}  •  Stack ${formatWholeMoney(state.virtualBalance)} (${formatRoundPromptBalanceDelta(state.game, state.virtualBalance)}%)`,
    `💰 Prize now: ${formatMoney(getProjectedPrizeForRank(state.rank, state.memberCount, state.game.prize_pool))}`,
    `⏱ Round: ${formatRoundCountdown(state.closingDate)}  •  Arena: ${arenaTimeLeft}`,
    ...(stageLines.length > 0 ? ["", ...stageLines] : []),
  ].join("\n");
}

function buildClosedPromptText(state: PromptState): string {
  return [
    `Round ${state.roundNumber} is closed in Arena ${state.game.code}.`,
    "",
    state.stage === "stake" && state.selectedDirection !== null
      ? `Your ${formatFantasyTradeDirection(state.selectedDirection)} order did not lock before the bell.`
      : "No trade was locked for this round.",
    "No problem. I will send the next BTC prompt shortly.",
  ].join("\n");
}

function buildLivePromptPayload(state: PromptState): FantasyTradePromptPayload {
  return { text: buildLiveRoundPromptText(state), keyboard: buildRoundPromptKeyboard(state), state };
}

// ── Countdown scheduler ───────────────────────────────────────────────────────

async function closePromptMessage(key: string): Promise<void> {
  const state = activePromptStates.get(key);
  if (!state) return;
  clearPromptState(key);
  try {
    await tgApi.editMessageText(state.chatId, state.messageId, buildClosedPromptText(state), { reply_markup: new InlineKeyboard() });
  } catch (error) {
    console.warn("[fantasy] Failed to close prompt message:", error);
  }
}

async function refreshPromptMessage(key: string): Promise<void> {
  const state = activePromptStates.get(key);
  if (!state) return;
  if (Date.parse(state.closingDate) <= Date.now()) { await closePromptMessage(key); return; }
  if (state.displayMode === "livePrompt") {
    try {
      await tgApi.editMessageText(state.chatId, state.messageId, buildLiveRoundPromptText(state), { reply_markup: buildRoundPromptKeyboard(state) });
    } catch (error) {
      console.warn("[fantasy] Failed to refresh prompt countdown:", error);
      clearPromptState(key);
      return;
    }
  }
  const msRemaining = Date.parse(state.closingDate) - Date.now();
  if (msRemaining <= 0) { clearPromptState(key); return; }
  activePromptTimers.set(key, setTimeout(() => { void refreshPromptMessage(key); }, Math.min(60_000, msRemaining)));
}

export function schedulePromptCountdown(state: PromptState): void {
  const key = promptStateKey(state.chatId, state.messageId);
  activePromptStates.set(key, state);
  clearPromptTimer(key);
  const msRemaining = Date.parse(state.closingDate) - Date.now();
  if (msRemaining <= 0) { clearPromptState(key); return; }
  activePromptTimers.set(key, setTimeout(
    () => { void refreshPromptMessage(key); },
    state.displayMode === "openAlert" ? msRemaining : Math.min(60_000, msRemaining)
  ));
}

export function buildRoundBroadcastPayload(input: {
  game: FantasyGame;
  round: { openingDate: string; closingDate: string };
  pricing: RoundPricing;
  currentPrice: number | null;
  rank: number;
  memberCount: number;
  virtualBalance: number;
  ref: string;
}): FantasyTradePromptPayload {
  const state: PromptState = {
    game: input.game, telegramId: 0, messageId: 0, chatId: 0,
    displayMode: "livePrompt", memberCount: input.memberCount, rank: input.rank,
    virtualBalance: input.virtualBalance,
    roundNumber: getGameRoundNumber(input.game, input.round.openingDate),
    closingDate: input.round.closingDate, currentPrice: input.currentPrice,
    referencePrice: input.pricing.eventThreshold,
    upPrice: input.pricing.upPrice, downPrice: input.pricing.downPrice,
    ref: input.ref, stage: "direction", selectedDirection: null, selectedStake: null,
  };
  return buildLivePromptPayload(state);
}


// ── Exported prompt + trade functions ─────────────────────────────────────────

export async function prepareFantasyTradePromptForArena(input: {
  telegramId: number;
  code: string;
}): Promise<FantasyTradePromptPayload> {
  const game = await getFantasyGameByCode(input.code);
  if (!game || game.status !== "active" || Date.parse(game.end_at) <= Date.now())
    throw new Error("This league is not active right now.");
  const member = await getFantasyGameMember(game.id, input.telegramId);
  if (!member) throw new Error("You are not a member of this league.");
  const snapshot = await getCurrentRoundSnapshot(FANTASY_ASSET);
  if (!snapshot?.pricing || Date.parse(snapshot.round.closingDate) <= Date.now())
    throw new Error("This fantasy round is no longer available.");
  const leaderboard = await getFantasyLeaderboard(game.id);
  const rank = leaderboard.find((e) => e.telegram_id === input.telegramId)?.place ?? null;
  if (rank === null) throw new Error("Unable to load your arena rank right now.");
  const { getRoundCurrentPrice } = await import("./fantasy-round.ts");
  const currentPrice = await getRoundCurrentPrice(snapshot.pricing);
  const ref = await saveFantasyTradeReference({
    gameId: game.id, eventId: snapshot.pricing.eventId, marketId: snapshot.pricing.marketId,
    openingDate: snapshot.round.openingDate, closingDate: snapshot.round.closingDate,
    currentPrice, referencePrice: snapshot.pricing.eventThreshold,
    upPrice: snapshot.pricing.upPrice, downPrice: snapshot.pricing.downPrice,
    upOutcomeId: snapshot.pricing.upOutcomeId, downOutcomeId: snapshot.pricing.downOutcomeId,
  });
  const state: PromptState = {
    game, telegramId: input.telegramId, messageId: 0, chatId: 0,
    displayMode: "livePrompt", memberCount: leaderboard.length, rank,
    virtualBalance: member.virtual_balance,
    roundNumber: getGameRoundNumber(game, snapshot.round.openingDate),
    closingDate: snapshot.round.closingDate, currentPrice,
    referencePrice: snapshot.pricing.eventThreshold,
    upPrice: snapshot.pricing.upPrice, downPrice: snapshot.pricing.downPrice,
    ref, stage: "direction", selectedDirection: null, selectedStake: null,
  };
  return buildLivePromptPayload(state);
}

export function registerFantasyTradePromptDelivery(input: {
  chatId: number;
  messageId: number;
  telegramId: number;
  state: PromptState;
}): void {
  schedulePromptCountdown({ ...input.state, chatId: input.chatId, messageId: input.messageId, telegramId: input.telegramId });
}

export async function getFantasyTradeStakeSelectionView(input: {
  telegramId: number;
  callbackData: string;
}): Promise<FantasyTradeStakeSelectionView> {
  const parts = input.callbackData.split(":");
  if (parts.length < 5 || parts[0] !== "flt" || parts[1] !== "b" || parts[3] !== "r")
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  const direction = parts[2];
  const ref = parts.slice(4).join(":");
  if (!ref || (direction !== "UP" && direction !== "DOWN"))
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  const payload = await loadFantasyTradeReference(ref);
  if (!payload || Date.parse(payload.closingDate) <= Date.now())
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  const game = await getFantasyGameById(payload.gameId);
  if (!game || game.status !== "active" || Date.parse(game.end_at) <= Date.now())
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  const member = await getFantasyGameMember(game.id, input.telegramId);
  if (!member) throw new Error("You are not a member of this arena.");
  return {
    game, direction: direction as FantasyTradeDirection,
    directionPrice: direction === "UP" ? payload.upPrice : payload.downPrice,
    roundNumber: getGameRoundNumber(game, payload.openingDate),
    closesAt: payload.closingDate, currentPrice: payload.currentPrice,
    referencePrice: payload.referencePrice, upPrice: payload.upPrice, downPrice: payload.downPrice,
  };
}

export async function buildFantasyTradeStakeSelection(input: {
  telegramId: number;
  callbackData: string;
  chatId?: number;
  messageId?: number;
}): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const selection = await getFantasyTradeStakeSelectionView({ telegramId: input.telegramId, callbackData: input.callbackData });
  const parts = input.callbackData.split(":");
  const direction = parts[2] as FantasyTradeDirection;
  const ref = parts.slice(4).join(":");
  const promptState = getPromptStateFromMessage(input.chatId, input.messageId);
  if (promptState) {
    promptState.state.stage = "stake";
    promptState.state.displayMode = "livePrompt";
    promptState.state.currentPrice = selection.currentPrice;
    promptState.state.referencePrice = selection.referencePrice;
    promptState.state.selectedDirection = direction;
    promptState.state.selectedStake = null;
    promptState.state.telegramId = input.telegramId;
    schedulePromptCountdown(promptState.state);
    return { text: buildLiveRoundPromptText(promptState.state), keyboard: buildRoundPromptKeyboard(promptState.state) };
  }
  return {
    text: [
      buildLiveRoundQuestion(selection.referencePrice), "",
      `Current price: ${formatLiveRoundPromptBtcPrice(selection.currentPrice)}`,
      `Target price: ${formatLiveRoundPromptBtcPrice(selection.referencePrice)}`,
      `↑ UP  ${formatProbabilityPrice(selection.upPrice)}   •   ↓ DOWN  ${formatProbabilityPrice(selection.downPrice)}`,
      "", `⏱ ${formatRoundCountdown(selection.closesAt)} remaining`,
    ].join("\n"),
    keyboard: buildFantasyTradeStakeKeyboard({ direction, ref }),
  };
}

export function clearFantasyTradePromptState(chatId?: number, messageId?: number): void {
  const promptState = getPromptStateFromMessage(chatId, messageId);
  if (promptState) clearPromptState(promptState.key);
}

export function resetFantasyTradePromptToDirection(
  ref: string, chatId?: number, messageId?: number
): { text: string; keyboard: InlineKeyboard } | null {
  const promptState = getPromptStateFromMessage(chatId, messageId);
  if (promptState) {
    promptState.state.stage = "direction";
    promptState.state.selectedDirection = null;
    promptState.state.selectedStake = null;
    schedulePromptCountdown(promptState.state);
    return { text: buildLiveRoundPromptText(promptState.state), keyboard: buildRoundPromptKeyboard(promptState.state) };
  }
  return { text: "Pick your direction:", keyboard: buildFantasyTradeBuyKeyboard({ ref, upPrice: 0.5, downPrice: 0.5 }) };
}

export async function placeFantasyTradeFromCallbackData(input: {
  telegramId: number;
  callbackData: string;
}): Promise<FantasyTradePlacementResult> {
  const parts = input.callbackData.split(":");
  if (parts.length < 6 || parts[0] !== "flt" || parts[1] !== "d" || parts[4] !== "r")
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  const stake = roundMoney(Number.parseFloat(parts[2] ?? ""));
  const direction = parts[3];
  const ref = parts.slice(5).join(":");
  if (!Number.isFinite(stake) || stake <= 0 || !ref || (direction !== "UP" && direction !== "DOWN"))
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  const payload = await loadFantasyTradeReference(ref);
  if (!payload || Date.parse(payload.closingDate) <= Date.now())
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  const game = await getFantasyGameById(payload.gameId);
  if (!game || game.status !== "active") throw new Error("This league is not active right now.");
  if (Date.parse(game.end_at) <= Date.now()) throw new Error("This league has already ended.");
  const member = await getFantasyGameMember(game.id, input.telegramId);
  if (!member) throw new Error("You are not a member of this league.");
  const existingTrade = await getFantasyTradeForMemberEvent(game.id, member.id, payload.eventId);
  if (existingTrade) throw new Error("You already placed a fantasy trade for this round.");
  const pricing = await getEventPricing(payload.eventId, payload.marketId);
  if (!pricing) throw new Error("This fantasy round is no longer available.");
  const outcomeId = direction === "UP"
    ? (payload.upOutcomeId ?? pricing.upOutcomeId)
    : (payload.downOutcomeId ?? pricing.downOutcomeId);
  if (!outcomeId) throw new Error("Pricing is unavailable for this fantasy round.");
  const quote = await getTradeQuote({ eventId: payload.eventId, marketId: payload.marketId, outcomeId, amount: stake, currency: "USD" });
  if (!quote) throw new Error("This fantasy round is no longer available.");
  if (quote.tradeGoesOverMaxLiability) throw new Error("That stake is too large for this fantasy round right now.");
  const entryPrice = quote.price;
  const shares = quote.quantity;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(shares) || shares <= 0)
    throw new Error("Pricing is unavailable for this fantasy round.");
  await placeFantasyTradeWithDebit({
    gameId: game.id, memberId: member.id, telegramId: input.telegramId,
    eventId: payload.eventId, marketId: payload.marketId,
    direction, stake, entryPrice, shares,
  });
  await updateFantasyMemberRoundTracking({
    memberId: member.id,
    lastTradedRound: getGameRoundNumber(game, payload.openingDate),
    consecutiveMissedRounds: 0,
  }).catch((e) => { console.warn(`[fantasy] Failed to update round tracking for ${member.telegram_id}:`, e); });
  const refreshedMember = await getFantasyGameMember(game.id, input.telegramId);
  return {
    game, stake, direction: direction as FantasyTradeDirection,
    roundNumber: getGameRoundNumber(game, payload.openingDate),
    entryPrice, shares,
    remainingBalance: refreshedMember?.virtual_balance ?? 0,
    stackIfWin: roundMoney((refreshedMember?.virtual_balance ?? 0) + shares),
    stackIfLoss: refreshedMember?.virtual_balance ?? 0,
    closesAt: payload.closingDate,
  };
}
