/**
 * Redis state helpers for fantasy league sessions and pending operations.
 */
import { redis } from "./utils/rateLimit.ts";

const FANTASY_JOIN_PENDING_TTL_SECONDS = 5 * 60;
const FANTASY_TRADE_REF_TTL_SECONDS = 15 * 60;
const FANTASY_CUSTOM_FUND_TTL_SECONDS = 10 * 60;
const FANTASY_NEXT_ROUND_REMINDER_TTL_SECONDS = 2 * 60 * 60;
const OFFRAMP_SESSION_TTL_SECONDS = 10 * 60;
const CROSS_CHAIN_SESSION_TTL_SECONDS = 20 * 60;

import { getFantasyGameByCode, getFantasyGameMember } from "./db/fantasy.ts";
import { Api } from "grammy";
import { config } from "./config.ts";

const tgApi = new Api(config.BOT_TOKEN);

// ── Key builders ─────────────────────────────────────────────────────────────

export function fantasyTradeRefKey(ref: string): string {
  return `fantasy:trade:${ref}`;
}

export function fantasyJoinPendingKey(telegramId: number): string {
  return `fantasy:join:pending:${telegramId}`;
}

export function fantasyCustomFundKey(telegramId: number): string {
  return `fantasy:fund:custom:${telegramId}`;
}

export function fantasyWithdrawStateKey(telegramId: number): string {
  return `fantasy:withdraw:state:${telegramId}`;
}

export function fantasyJoinCodeStateKey(telegramId: number): string {
  return `fantasy:join:code:${telegramId}`;
}

export function fantasyRoundReminderKey(gameId: string, telegramId: number): string {
  return `fantasy:remind:${gameId}:${telegramId}`;
}

export function fantasyRoundReminderMsgKey(gameId: string, telegramId: number): string {
  return `fantasy:remind:msg:${gameId}:${telegramId}`;
}

export function fantasyMidRoundNudgeKey(gameId: string, eventId: string, telegramId: number): string {
  return `${gameId}:${eventId}:${telegramId}`;
}

export function fantasyCustomArenaFeeKey(telegramId: number): string {
  return `fantasy:arena:custom_fee:${telegramId}`;
}

export function offrampSessionKey(telegramId: number): string {
  return `fantasy:offramp:session:${telegramId}`;
}

export function crossChainSessionKey(telegramId: number): string {
  return `cross_chain_session:${telegramId}`;
}

// ── Withdraw state ────────────────────────────────────────────────────────────

export async function saveWithdrawState(
  telegramId: number,
  state: { step: "amount" } | { step: "address"; amount: number }
): Promise<void> {
  await redis.set(fantasyWithdrawStateKey(telegramId), JSON.stringify(state), "EX", FANTASY_CUSTOM_FUND_TTL_SECONDS);
}

export async function loadWithdrawState(
  telegramId: number
): Promise<{ step: "amount" } | { step: "address"; amount: number } | null> {
  const raw = await redis.get(fantasyWithdrawStateKey(telegramId));
  if (!raw) return null;
  try { return JSON.parse(raw) as { step: "amount" } | { step: "address"; amount: number }; }
  catch { return null; }
}

export async function clearWithdrawState(telegramId: number): Promise<void> {
  await redis.del(fantasyWithdrawStateKey(telegramId));
}

// ── Join code state ───────────────────────────────────────────────────────────

export async function savePendingJoinCodeEntry(telegramId: number): Promise<void> {
  await redis.set(fantasyJoinCodeStateKey(telegramId), "1", "EX", FANTASY_CUSTOM_FUND_TTL_SECONDS);
}

export async function hasPendingJoinCodeEntry(telegramId: number): Promise<boolean> {
  return Boolean(await redis.get(fantasyJoinCodeStateKey(telegramId)));
}

export async function clearPendingJoinCodeEntry(telegramId: number): Promise<void> {
  await redis.del(fantasyJoinCodeStateKey(telegramId));
}

// ── Pending join ──────────────────────────────────────────────────────────────

export async function savePendingFantasyLeagueJoin(telegramId: number, code: string): Promise<void> {
  await redis.set(
    fantasyJoinPendingKey(telegramId),
    JSON.stringify({ code: code.trim().toUpperCase() }),
    "EX",
    FANTASY_JOIN_PENDING_TTL_SECONDS
  );
}

export async function loadPendingFantasyLeagueJoin(telegramId: number): Promise<string | null> {
  const raw = await redis.get(fantasyJoinPendingKey(telegramId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { code?: unknown };
    if (typeof parsed.code !== "string" || !parsed.code.trim()) return null;
    return parsed.code.trim().toUpperCase();
  } catch { return null; }
}

export async function clearPendingFantasyLeagueJoin(telegramId: number): Promise<void> {
  await redis.del(fantasyJoinPendingKey(telegramId));
}

// ── Custom fund amount ────────────────────────────────────────────────────────

export async function savePendingFantasyCustomFundAmount(telegramId: number): Promise<void> {
  await redis.set(fantasyCustomFundKey(telegramId), "1", "EX", FANTASY_CUSTOM_FUND_TTL_SECONDS);
}

export async function hasPendingFantasyCustomFundAmount(telegramId: number): Promise<boolean> {
  return Boolean(await redis.get(fantasyCustomFundKey(telegramId)));
}

export async function clearPendingFantasyCustomFundAmount(telegramId: number): Promise<void> {
  await redis.del(fantasyCustomFundKey(telegramId));
}

// ── Custom arena fee ──────────────────────────────────────────────────────────

export async function savePendingCustomArenaFee(telegramId: number): Promise<void> {
  await redis.set(fantasyCustomArenaFeeKey(telegramId), "1", "EX", FANTASY_CUSTOM_FUND_TTL_SECONDS);
}

export async function hasPendingCustomArenaFee(telegramId: number): Promise<boolean> {
  return Boolean(await redis.get(fantasyCustomArenaFeeKey(telegramId)));
}

export async function clearPendingCustomArenaFee(telegramId: number): Promise<void> {
  await redis.del(fantasyCustomArenaFeeKey(telegramId));
}

// ── Offramp session ───────────────────────────────────────────────────────────

export interface OfframpSessionState {
  step: "awaiting_bank_account" | "awaiting_usdc_amount" | "pending_confirm";
  bankId?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  usdcAmount?: number;
}

export async function saveOfframpSession(telegramId: number, state: OfframpSessionState): Promise<void> {
  await redis.set(offrampSessionKey(telegramId), JSON.stringify(state), "EX", OFFRAMP_SESSION_TTL_SECONDS);
}

export async function loadOfframpSession(telegramId: number): Promise<OfframpSessionState | null> {
  const raw = await redis.get(offrampSessionKey(telegramId));
  if (!raw) return null;
  try { return JSON.parse(raw) as OfframpSessionState; } catch { return null; }
}

export async function clearOfframpSession(telegramId: number): Promise<void> {
  await redis.del(offrampSessionKey(telegramId));
}

// ── Cross-chain session ───────────────────────────────────────────────────────

export interface CrossChainSession {
  step: "awaiting_amount" | "pending_confirm";
  chainId: string;
  chainName: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amount?: string;
  expiresAt?: number;
}

export async function saveCrossChainSession(telegramId: number, state: CrossChainSession): Promise<void> {
  const stamped = { ...state, expiresAt: Date.now() + CROSS_CHAIN_SESSION_TTL_SECONDS * 1000 };
  await redis.set(crossChainSessionKey(telegramId), JSON.stringify(stamped), "EX", CROSS_CHAIN_SESSION_TTL_SECONDS);
}

export async function loadCrossChainSession(telegramId: number): Promise<CrossChainSession | null> {
  const raw = await redis.get(crossChainSessionKey(telegramId));
  if (!raw) return null;
  try { return JSON.parse(raw) as CrossChainSession; } catch { return null; }
}

export async function clearCrossChainSession(telegramId: number): Promise<void> {
  await redis.del(crossChainSessionKey(telegramId));
}

// ── Trade reference ───────────────────────────────────────────────────────────

export interface FantasyTradeRefPayload {
  gameId: string;
  eventId: string;
  marketId: string;
  openingDate: string;
  closingDate: string;
  currentPrice: number | null;
  referencePrice: number | null;
  upPrice: number;
  downPrice: number;
  upOutcomeId: string | null;
  downOutcomeId: string | null;
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function saveFantasyTradeReference(payload: FantasyTradeRefPayload): Promise<string> {
  const ref = `${payload.gameId}:${payload.eventId}:${payload.marketId}`
    .replace(/[^a-zA-Z0-9:]/g, "")
    .slice(0, 32);
  const uniqueRef = `${ref}:${Date.now().toString(36)}`.slice(0, 48);
  await redis.set(fantasyTradeRefKey(uniqueRef), JSON.stringify(payload), "EX", FANTASY_TRADE_REF_TTL_SECONDS);
  return uniqueRef;
}

export async function loadFantasyTradeReference(ref: string): Promise<FantasyTradeRefPayload | null> {
  const cached = await redis.get(fantasyTradeRefKey(ref));
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached) as FantasyTradeRefPayload & { currentPrice?: unknown };
    if (
      !parsed.gameId || !parsed.eventId || !parsed.marketId ||
      !parsed.openingDate || !parsed.closingDate ||
      !Number.isFinite(parsed.upPrice) || !Number.isFinite(parsed.downPrice) ||
      !isOptionalString(parsed.upOutcomeId) || !isOptionalString(parsed.downOutcomeId)
    ) return null;
    return { ...parsed, currentPrice: parseOptionalNumber(parsed.currentPrice) };
  } catch { return null; }
}

// ── Round reminder ────────────────────────────────────────────────────────────

export async function saveFantasyNextRoundReminder(
  telegramId: number,
  code: string,
  confirmationMessageId?: number
): Promise<boolean> {
  const game = await getFantasyGameByCode(code.trim().toUpperCase());
  if (!game) return false;
  const member = await getFantasyGameMember(game.id, telegramId);
  if (!member) return false;

  await redis.set(fantasyRoundReminderKey(game.id, telegramId), "1", "EX", FANTASY_NEXT_ROUND_REMINDER_TTL_SECONDS);

  if (confirmationMessageId) {
    await redis.set(
      fantasyRoundReminderMsgKey(game.id, telegramId),
      String(confirmationMessageId),
      "EX",
      FANTASY_NEXT_ROUND_REMINDER_TTL_SECONDS
    );
  }
  return true;
}

export async function consumeFantasyNextRoundReminder(gameId: string, telegramId: number): Promise<boolean> {
  const msgIdStr = await redis.get(fantasyRoundReminderMsgKey(gameId, telegramId));
  const [deleted] = await Promise.all([
    redis.del(fantasyRoundReminderKey(gameId, telegramId)),
    redis.del(fantasyRoundReminderMsgKey(gameId, telegramId)),
  ]);
  if (msgIdStr) {
    const msgId = Number(msgIdStr);
    if (msgId) tgApi.deleteMessage(telegramId, msgId).catch(() => undefined);
  }
  return deleted > 0;
}

// ── Prediction market pending bet ─────────────────────────────────────────────

const PM_BET_PENDING_TTL = 5 * 60;

export interface PendingMarketBet {
  marketId: string;
  side: "YES" | "NO";
}

export async function savePendingMarketBet(telegramId: number, bet: PendingMarketBet): Promise<void> {
  await redis.set(`pm:bet:pending:${telegramId}`, JSON.stringify(bet), "EX", PM_BET_PENDING_TTL);
}

export async function loadPendingMarketBet(telegramId: number): Promise<PendingMarketBet | null> {
  const raw = await redis.get(`pm:bet:pending:${telegramId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as PendingMarketBet; } catch { return null; }
}

export async function clearPendingMarketBet(telegramId: number): Promise<void> {
  await redis.del(`pm:bet:pending:${telegramId}`);
}

export async function savePendingMarketBetCustom(telegramId: number): Promise<void> {
  await redis.set(`pm:bet:custom:${telegramId}`, "1", "EX", PM_BET_PENDING_TTL);
}

export async function hasPendingMarketBetCustom(telegramId: number): Promise<boolean> {
  return Boolean(await redis.get(`pm:bet:custom:${telegramId}`));
}

export async function clearPendingMarketBetCustom(telegramId: number): Promise<void> {
  await redis.del(`pm:bet:custom:${telegramId}`);
}
