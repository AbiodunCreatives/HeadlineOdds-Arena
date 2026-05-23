/**
 * Game creation, joining, lobby, and status views.
 */
import {
  createFantasyGameWithEntry,
  createFreeTrialGame,
  getActiveArenaForUser,
  getFantasyGameByCode,
  getFantasyGameById,
  getFantasyGameMember,
  getFantasyLeaderboard,
  getLatestFantasyTradeForMember,
  hasUsedFreeTrial,
  joinFantasyGameWithEntry,
  joinFreeTrialGame,
  awardHloPoints,
  listFantasyTradesForGame,
  listUserFantasyGames,
  type FantasyGame,
  type FantasyLeaderboardEntry,
} from "./db/fantasy.ts";
import { upsertUserProfile } from "./db/users.ts";
import {
  ARENA_DURATION_HOURS_OPTIONS,
  anonymizePlayer,
  formatDurationHours,
  formatMediumDateTime,
  formatMoney,
  formatWholeMoney,
  formatCompactDuration,
  formatSignedPercent,
  getApproxRoundsLeft,
  getGameDurationHours,
  getGameRoundNumber,
  getPrizeAwardPreview,
  getProjectedPrizeForUser,
  getVirtualReturnPct,
} from "./fantasy-ui.ts";
import {
  ensureFantasyWallet,
  getFantasyWalletOnChainUsdcBalance,
  syncFantasyWalletDeposits,
  transferUsdcForArenaEntry,
  transferUsdcFromTreasury,
} from "./solana-wallet.ts";
import { getBalance } from "./db/balances.ts";
import { redis } from "./utils/rateLimit.ts";
import { isDevUser, DEV_MIN_ENTRY_FEE, DEV_VIRTUAL_BANKROLL } from "./utils/devOverrides.ts";
import { withUserWalletOperationLock } from "./utils/user-wallet-operation-lock.ts";
import { config } from "./config.ts";
import {
  FANTASY_COMMISSION_RATE,
  FANTASY_DEFAULT_DURATION_HOURS,
  FANTASY_ENTRY_MULTIPLIER,
  FANTASY_MAX_ENTRY_FEE,
  FANTASY_MIN_ENTRY_FEE,
  getPrizePoolBreakdown,
  getPrizeSplits,
  roundMoney,
  getVirtualStartBalance,
  type FantasyGameSnapshot,
} from "./fantasy-league.ts";
import { randomBytes } from "crypto";
import { seedBotsIntoFreeTrialGame } from "./arena-bots.ts";

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface FantasyLeagueJoinPreview {
  game: FantasyGame;
  memberCount: number;
  projectedPrizePool: number;
  projectedFirstPrize: number;
  currentLeaderName: string | null;
  currentLeaderReturnPct: number | null;
}

export interface FantasyArenaLobbyCard {
  game: FantasyGame;
  memberCount: number;
  state: "LIVE" | "FILLING" | "OPEN";
  topLeaderName: string | null;
  topLeaderReturnPct: number | null;
}

export interface FantasyArenaLobbySnapshot {
  live: FantasyArenaLobbyCard[];
  filling: FantasyArenaLobbyCard[];
  open: FantasyArenaLobbyCard[];
}

export interface FantasyLeagueStatusView {
  game: FantasyGame;
  leaderboard: FantasyLeaderboardEntry[];
  memberCount: number;
  me: FantasyLeaderboardEntry | null;
  prizeIfEndedNow: number;
  roundsLeft: number;
  roundsPlayed: number;
  lastTrade: import("./db/fantasy.ts").FantasyTrade | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFantasyDurationMs(durationHours: number): number {
  return durationHours * 60 * 60 * 1000;
}

function normalizeFantasyDurationHours(durationHours: number): number {
  const normalizedHours = Math.round(durationHours);
  if (!Number.isInteger(normalizedHours) || !ARENA_DURATION_HOURS_OPTIONS.includes(normalizedHours as (typeof ARENA_DURATION_HOURS_OPTIONS)[number])) {
    throw new Error(`Duration must be one of ${ARENA_DURATION_HOURS_OPTIONS.map((h) => formatDurationHours(h)).join(", ")}.`);
  }
  return normalizedHours;
}

function shortCode(): string {
  const buf = randomBytes(6);
  const left = buf.readUIntBE(0, 3).toString(36).padStart(3, "0").slice(-3).toUpperCase();
  const right = buf.readUIntBE(3, 3).toString(36).padStart(3, "0").slice(-3).toUpperCase();
  return `${left}-${right}`;
}

async function generateUniqueFantasyGameCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = shortCode();
    const existing = await getFantasyGameByCode(code);
    if (!existing) return code;
  }
  throw new Error("Unable to generate a unique arena code.");
}

async function collectArenaEntryUsdc(input: { telegramId: number; amount: number }): Promise<void> {
  const normalizedAmount = roundMoney(input.amount);
  const wallet = await ensureFantasyWallet(input.telegramId);
  await syncFantasyWalletDeposits(wallet);
  const [internalBalance, onChainBalance] = await Promise.all([
    getBalance(input.telegramId),
    getFantasyWalletOnChainUsdcBalance({ wallet }),
  ]);
  if (internalBalance < normalizedAmount) throw new Error(`Insufficient play balance. Available: ${internalBalance} USDC.`);
  if (onChainBalance < normalizedAmount) throw new Error(`Insufficient on-chain in-bot wallet balance. Available on-chain: ${onChainBalance} USDC.`);
  await transferUsdcForArenaEntry({ telegramId: input.telegramId, amount: normalizedAmount });
}

async function refundArenaEntryUsdcToUser(input: { telegramId: number; amount: number }): Promise<void> {
  await transferUsdcFromTreasury({ telegramId: input.telegramId, amount: roundMoney(input.amount) });
}

function getArenaLobbyState(game: FantasyGame, memberCount: number): "LIVE" | "FILLING" | "OPEN" {
  if (game.status === "active" && Date.parse(game.end_at) > Date.now()) return "LIVE";
  if (game.status === "open" && memberCount > 1) return "FILLING";
  return "OPEN";
}

function getFirstPrizeProjection(prizePool: number, playerCount: number): number {
  const preview = getPrizeAwardPreview(
    Array.from({ length: Math.max(1, playerCount) }, (_, i) => ({
      place: i + 1, telegram_id: i + 1, username: null, virtual_balance: 0,
      wins: 0, losses: 0, total_trades: 0, accuracy_pct: 0, prize_awarded: 0,
      joined_at: new Date(0).toISOString(),
    })),
    prizePool
  );
  return preview[0]?.amount ?? 0;
}

function countRoundsPlayed(trades: import("./db/fantasy.ts").FantasyTrade[]): number {
  return new Set(trades.map((t) => t.event_id)).size;
}

// ── Exported functions ────────────────────────────────────────────────────────

// ── Free Trial Arena ──────────────────────────────────────────────────────────

const FREE_TRIAL_DURATION_HOURS = 1;
const FREE_TRIAL_VIRTUAL_BALANCE = 1000;
const FREE_TRIAL_HLO_PRIZE = 250;

export async function createFreeTrialArena(creatorTelegramId: number): Promise<FantasyGame> {
  await upsertUserProfile(creatorTelegramId);
  if (await hasUsedFreeTrial(creatorTelegramId)) {
    throw new Error("You have already used your free trial arena.");
  }
  const existing = await getActiveArenaForUser(creatorTelegramId);
  if (existing) throw new Error(`You're already in arena ${existing.code}. Finish it before creating a new one.`);
  const lobbyWaitMs = 10 * 60 * 1000;
  const startAt = new Date(Date.now() + lobbyWaitMs).toISOString();
  const endAt = new Date(Date.parse(startAt) + getFantasyDurationMs(FREE_TRIAL_DURATION_HOURS)).toISOString();
  const code = await generateUniqueFantasyGameCode();
  const game = await createFreeTrialGame({ code, creatorTelegramId, virtualStartBalance: FREE_TRIAL_VIRTUAL_BALANCE, startAt, endAt });
  // Seed 5 AI bots as members (fire-and-forget, non-fatal)
  seedBotsIntoFreeTrialGame(game).catch((e) => {
    console.warn(`[arena-bots] Failed to seed bots into free trial arena ${game.code}:`, e);
  });
  return game;
}

export async function joinFreeTrialArena(telegramId: number, code: string): Promise<FantasyGame> {
  await upsertUserProfile(telegramId);
  if (await hasUsedFreeTrial(telegramId)) {
    throw new Error("You have already used your free trial arena.");
  }
  const game = await getFantasyGameByCode(code.trim().toUpperCase());
  if (!game) throw new Error("Arena not found.");
  if (!game.is_free_trial) throw new Error("This is not a free trial arena.");
  const existing = await getActiveArenaForUser(telegramId);
  if (existing && existing.code !== game.code) throw new Error(`You're already in arena ${existing.code}. Finish it before joining a new one.`);
  return joinFreeTrialGame({ code: code.trim().toUpperCase(), telegramId });
}

export async function awardFreeTrialHloPoints(telegramId: number, gameId: string): Promise<void> {
  await awardHloPoints({ telegramId, amount: FREE_TRIAL_HLO_PRIZE, reason: "free_trial_completion", referenceId: gameId });
}

export async function createFantasyLeagueGame(creatorTelegramId: number, entryFee: number, durationHours = FANTASY_DEFAULT_DURATION_HOURS): Promise<FantasyGame> {
  return withUserWalletOperationLock({ telegramId: creatorTelegramId, reason: "arena_create", task: async () => {
    const normalizedEntryFee = roundMoney(entryFee);
    const normalizedDurationHours = normalizeFantasyDurationHours(durationHours);
    const devUser = isDevUser(creatorTelegramId);
    const minFee = devUser ? DEV_MIN_ENTRY_FEE : FANTASY_MIN_ENTRY_FEE;
    if (normalizedEntryFee < minFee || normalizedEntryFee > FANTASY_MAX_ENTRY_FEE || (!devUser && !Number.isInteger(normalizedEntryFee))) {
      throw new Error(`Entry fee must be a whole number between $${FANTASY_MIN_ENTRY_FEE} and $${FANTASY_MAX_ENTRY_FEE}.`);
    }
    const lobbyWaitMs = normalizedDurationHours === 1 ? 10 * 60 * 1000 : 30 * 60 * 1000;
    const startAt = new Date(Date.now() + lobbyWaitMs).toISOString();
    const endAt = new Date(Date.parse(startAt) + getFantasyDurationMs(normalizedDurationHours)).toISOString();
    const virtualStartBalance = devUser ? DEV_VIRTUAL_BANKROLL : getVirtualStartBalance(normalizedEntryFee);
    const code = await generateUniqueFantasyGameCode();
    await upsertUserProfile(creatorTelegramId);
    if (!isDevUser(creatorTelegramId) && creatorTelegramId !== config.ADMIN_USER_ID) {
      const existing = await getActiveArenaForUser(creatorTelegramId);
      if (existing) throw new Error(`You're already in arena ${existing.code}. Finish it before creating a new one.`);
    }
    const lockKey = `arena:entry:lock:${creatorTelegramId}:${code}`;
    const lockAcquired = await redis.set(lockKey, "1", "EX", 60, "NX");
    if (!lockAcquired) throw new Error("Entry already in progress. Please wait a moment and try again.");
    try {
      await collectArenaEntryUsdc({ telegramId: creatorTelegramId, amount: normalizedEntryFee });
      try {
        return await createFantasyGameWithEntry({ code, creatorTelegramId, entryFee: normalizedEntryFee, virtualStartBalance, startAt, endAt, commissionRate: FANTASY_COMMISSION_RATE });
      } catch (error) {
        try { await refundArenaEntryUsdcToUser({ telegramId: creatorTelegramId, amount: normalizedEntryFee }); }
        catch (refundError) { console.error(`[fantasy] CRITICAL: arena create refund failed for user ${creatorTelegramId} code ${code} amount ${normalizedEntryFee}:`, refundError); throw new Error(`Arena entry could not be completed, and the on-chain refund back to your in-bot wallet also failed. Contact support with arena code ${code}.`); }
        throw error;
      }
    } finally { await redis.del(lockKey); }
  }});
}

export async function joinFantasyLeagueGame(telegramId: number, code: string): Promise<FantasyGame> {
  return withUserWalletOperationLock({ telegramId, reason: "arena_join", task: async () => {
    await upsertUserProfile(telegramId);
    const game = await getFantasyGameByCode(code.trim().toUpperCase());
    if (!game) throw new Error("Arena not found.");
    if (telegramId !== config.ADMIN_USER_ID) {
      const existing = await getActiveArenaForUser(telegramId);
      if (existing && existing.code !== game.code) throw new Error(`You're already in arena ${existing.code}. Finish it before joining a new one.`);
    }
    const lockKey = `arena:entry:lock:${telegramId}:${game.code}`;
    const lockAcquired = await redis.set(lockKey, "1", "EX", 60, "NX");
    if (!lockAcquired) throw new Error("Entry already in progress. Please wait a moment and try again.");
    try {
      await collectArenaEntryUsdc({ telegramId, amount: game.entry_fee });
      try {
        return await joinFantasyGameWithEntry({ code: code.trim().toUpperCase(), telegramId, commissionRate: FANTASY_COMMISSION_RATE });
      } catch (error) {
        try { await refundArenaEntryUsdcToUser({ telegramId, amount: game.entry_fee }); }
        catch (refundError) { console.error(`[fantasy] CRITICAL: arena join refund failed for user ${telegramId} code ${game.code} amount ${game.entry_fee}:`, refundError); throw new Error(`Arena entry could not be completed, and the on-chain refund back to your in-bot wallet also failed. Contact support with arena code ${game.code}.`); }
        throw error;
      }
    } finally { await redis.del(lockKey); }
  }});
}

export async function getFantasyLeagueJoinPreview(telegramId: number, code: string): Promise<FantasyLeagueJoinPreview> {
  const game = await getFantasyGameByCode(code.trim().toUpperCase());
  if (!game) throw new Error("Arena not found.");
  if (game.status !== "open" || Date.parse(game.start_at) <= Date.now()) throw new Error("This arena has already started.");
  const existingMember = await getFantasyGameMember(game.id, telegramId);
  if (existingMember) throw new Error("You already joined this arena.");
  const leaderboard = await getFantasyLeaderboard(game.id);
  const leader = leaderboard[0] ?? null;
  const projectedPrizePool = getPrizePoolBreakdown(game.entry_fee, leaderboard.length + 1).netPrizePool;
  return {
    game, memberCount: leaderboard.length, projectedPrizePool,
    projectedFirstPrize: getFirstPrizeProjection(projectedPrizePool, leaderboard.length + 1),
    currentLeaderName: leader ? anonymizePlayer(leader.telegram_id, telegramId, leader.username) : null,
    currentLeaderReturnPct: leader ? getVirtualReturnPct(game, leader.virtual_balance) : null,
  };
}

export async function getFantasyLeagueDetailsByCode(code: string): Promise<{ game: FantasyGame; leaderboard: FantasyLeaderboardEntry[]; memberCount: number }> {
  const game = await getFantasyGameByCode(code.trim().toUpperCase());
  if (!game) throw new Error("Arena not found.");
  const leaderboard = await getFantasyLeaderboard(game.id);
  return { game, leaderboard, memberCount: leaderboard.length };
}

export async function listFantasyLeagueSnapshots(telegramId: number): Promise<FantasyGameSnapshot[]> {
  const games = await listUserFantasyGames(telegramId);
  const snapshots: FantasyGameSnapshot[] = [];
  for (const game of games.slice(0, 10)) {
    const leaderboard = await getFantasyLeaderboard(game.id);
    const me = leaderboard.find((e) => e.telegram_id === telegramId);
    snapshots.push({ game, memberCount: leaderboard.length, yourRank: me?.place ?? null, yourVirtualBalance: me?.virtual_balance ?? null });
  }
  return snapshots;
}

export async function listFantasyArenaLobby(): Promise<FantasyArenaLobbySnapshot> {
  const { listActiveFantasyGames, listOpenFantasyGames } = await import("./db/fantasy.ts");
  const [activeGames, openGames] = await Promise.all([listActiveFantasyGames(new Date().toISOString()), listOpenFantasyGames()]);
  const cards: FantasyArenaLobbyCard[] = [];
  for (const game of [...activeGames, ...openGames]) {
    if (game.status === "completed" || game.status === "cancelled") continue;
    const leaderboard = await getFantasyLeaderboard(game.id);
    const state = getArenaLobbyState(game, leaderboard.length);
    const leader = leaderboard[0] ?? null;
    cards.push({ game, memberCount: leaderboard.length, state, topLeaderName: leader ? anonymizePlayer(leader.telegram_id, undefined, leader.username) : null, topLeaderReturnPct: leader ? getVirtualReturnPct(game, leader.virtual_balance) : null });
  }
  return {
    live: cards.filter((c) => c.state === "LIVE").slice(0, 3),
    filling: cards.filter((c) => c.state === "FILLING").slice(0, 3),
    open: cards.filter((c) => c.state === "OPEN").slice(0, 3),
  };
}

export async function getFantasyLeagueStatusView(telegramId: number, code: string): Promise<FantasyLeagueStatusView> {
  const { game, leaderboard, memberCount } = await getFantasyLeagueDetailsByCode(code);
  const me = leaderboard.find((e) => e.telegram_id === telegramId) ?? null;
  const trades = await listFantasyTradesForGame(game.id);
  return {
    game, leaderboard, memberCount, me,
    prizeIfEndedNow: getProjectedPrizeForUser(leaderboard, game.prize_pool, telegramId),
    roundsLeft: getApproxRoundsLeft(game.end_at),
    roundsPlayed: countRoundsPlayed(trades),
    lastTrade: await getLatestFantasyTradeForMember(game.id, telegramId),
  };
}

export async function getFantasyLeagueBoardText(code: string, viewerTelegramId: number): Promise<string> {
  const { game, leaderboard } = await getFantasyLeagueDetailsByCode(code);
  const timingLine = game.status === "completed" || game.status === "cancelled"
    ? `Ended: ${formatMediumDateTime(game.completed_at ?? game.end_at)}`
    : game.status === "open" ? `Starts: ${formatMediumDateTime(game.start_at)}`
    : `Ends in: ${formatCompactDuration(Date.parse(game.end_at) - Date.now())}`;
  const viewerEntry = leaderboard.find((e) => e.telegram_id === viewerTelegramId) ?? null;
  const summaryLine = game.status === "completed" || game.status === "cancelled"
    ? `Your payout prize - ${formatMoney(viewerEntry?.prize_awarded ?? 0)}`
    : `Prize if game ended now: ${formatMoney(getProjectedPrizeForUser(leaderboard, game.prize_pool, viewerTelegramId))}`;
  const rows = leaderboard.length === 0 ? ["No players yet."] : leaderboard.slice(0, 10).map((entry, i) => {
    const name = anonymizePlayer(entry.telegram_id, viewerTelegramId, entry.username);
    const badges = i === 0 ? "  🔥" : entry.virtual_balance < game.virtual_start_balance ? "  📉" : entry.telegram_id === viewerTelegramId ? "  ↑" : "";
    return `${entry.place}.  ${name.padEnd(8)} ${formatWholeMoney(entry.virtual_balance)}   ${formatSignedPercent(getVirtualReturnPct(game, entry.virtual_balance))}${badges}`;
  });
  return [`🏆 Arena ${game.code}  •  ${game.status === "active" ? "LIVE" : game.status.toUpperCase()}`, "", timingLine, `Net prize pool: ${formatMoney(game.prize_pool)}`, "", ...rows, "", summaryLine, "", "Player names are anonymised for privacy. You appear as 'you'."].join("\n");
}

export async function getFantasyLeagueJoinSummary(code: string): Promise<string> {
  const { game, leaderboard } = await getFantasyLeagueDetailsByCode(code);
  return [
    "🏆 BAYSE FANTASY ARENA", "",
    `League Code: ${game.code}`, `Asset: ${game.asset}`,
    `Entry Fee: ${formatMoney(game.entry_fee)}`,
    `Virtual Funds: ${formatMoney(game.virtual_start_balance)}`,
    `Prize Pool: ${formatMoney(game.prize_pool)}`,
    `Players joined: ${leaderboard.length}`,
    `Duration: ${formatDurationHours(getGameDurationHours(game))}`,
    `Starts: ${formatMediumDateTime(game.start_at)}`,
    `Ends: ${formatMediumDateTime(game.end_at)}`, "",
    "Arena play stays virtual during the game, but funding and payouts use your in-bot Solana USDC balance.",
  ].join("\n");
}
