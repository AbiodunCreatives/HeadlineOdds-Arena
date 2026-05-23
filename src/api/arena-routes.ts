/**
 * REST + WebSocket API for the HOArena mobile app.
 * Auth: Privy JWT (Bearer token). User identity mapped to internal numeric ID.
 * All routes are under /api/v1.
 */
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Application, Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.ts";
import { supabase } from "../db/client.ts";
import {
  listOpenFantasyGames,
  listActiveFantasyGames,
  getFantasyGameById,
  getFantasyGameByCode,
  getFantasyGameMember,
  getFantasyLeaderboard,
  createFantasyGameWithEntry,
  joinFantasyGameWithEntry,
  placeFantasyTradeWithDebit,
  updateFantasyGame,
} from "../db/fantasy.ts";
import { getBalance } from "../db/balances.ts";
import {
  getFantasyWalletByTelegramId,
  requestSolanaWithdrawal,
  listFantasyWalletLedger,
  listRecentFantasyWalletWithdrawals,
} from "../db/wallets.ts";
import { upsertUserProfile } from "../db/users.ts";
import { getCurrentRoundSnapshot } from "../bayse-market.ts";
import { ensureFantasyWallet, syncFantasyWalletDeposits } from "../solana-wallet.ts";
import { handleSupportQuestion } from "../bot/handlers/support.ts";

// ---------------------------------------------------------------------------
// Constants (from fantasy-league.ts)
// ---------------------------------------------------------------------------
const FANTASY_ENTRY_MULTIPLIER = 100;   // virtual_start_balance = entry_fee * 100
const FANTASY_COMMISSION_RATE = 0.08;
const FANTASY_MIN_ENTRY_FEE = 1;
const FANTASY_MAX_ENTRY_FEE = 10;
const FANTASY_TRADE_AMOUNTS = [10, 25, 50, 100] as const;
const FANTASY_DEFAULT_DURATION_HOURS = 24;

// ---------------------------------------------------------------------------
// Privy JWT verification
// ---------------------------------------------------------------------------

const PRIVY_JWKS_URL = "https://auth.privy.io/api/v1/apps/{appId}/jwks.json";

function getPrivyJwks() {
  const appId = (config as Record<string, unknown>)["PRIVY_APP_ID"] as string | undefined;
  if (!appId) throw new Error("PRIVY_APP_ID not configured");
  return createRemoteJWKSet(new URL(PRIVY_JWKS_URL.replace("{appId}", appId)));
}

async function verifyPrivyToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, getPrivyJwks(), { issuer: "privy.io" });
  if (!payload.sub) throw new Error("Missing sub in JWT");
  return payload.sub;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request { privyUserId?: string; }
  }
}

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing Bearer token" }); return; }
  try {
    req.privyUserId = await verifyPrivyToken(auth.slice(7));
    next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
}

// ---------------------------------------------------------------------------
// Privy user → internal numeric ID (stable synthetic ID, stored in fantasy_users)
// ---------------------------------------------------------------------------

async function getOrCreateInternalId(privyUserId: string): Promise<number> {
  const { data } = await supabase
    .from("fantasy_users")
    .select("telegram_id")
    .eq("privy_user_id", privyUserId)
    .maybeSingle();

  if (data) return (data as { telegram_id: number }).telegram_id;

  // Stable synthetic ID in negative range (avoids collision with real Telegram IDs)
  const hash = [...privyUserId].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0);
  const syntheticId = -Math.abs(hash || 1);
  const username = `app_${privyUserId.slice(-8)}`;

  await upsertUserProfile(syntheticId, username);
  await supabase
    .from("fantasy_users")
    .update({ privy_user_id: privyUserId })
    .eq("telegram_id", syntheticId);

  return syntheticId;
}

// ---------------------------------------------------------------------------
// WebSocket arena rooms
// ---------------------------------------------------------------------------

type ArenaClient = { ws: WebSocket; arenaId: string };
const arenaClients = new Map<string, Set<ArenaClient>>();

export function broadcastToArena(arenaId: string, message: unknown) {
  const clients = arenaClients.get(arenaId);
  if (!clients) return;
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerArenaRoutes(app: Application, server: ReturnType<typeof createServer>) {
  const wss = new WebSocketServer({ server, path: "/ws/arena" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const arenaId = url.searchParams.get("arenaId") ?? "";
    const token = url.searchParams.get("token") ?? "";

    if (!arenaId) { ws.close(4000, "Missing arenaId"); return; }

    verifyPrivyToken(token).then(() => {
      const client: ArenaClient = { ws, arenaId };
      if (!arenaClients.has(arenaId)) arenaClients.set(arenaId, new Set());
      arenaClients.get(arenaId)!.add(client);
      ws.on("close", () => arenaClients.get(arenaId)?.delete(client));
      ws.send(JSON.stringify({ type: "connected", arenaId }));
    }).catch(() => ws.close(4001, "Unauthorized"));
  });

  // --- Arenas ---

  // GET /api/v1/arenas — lobby: open + active arenas
  app.get("/api/v1/arenas", requireAuth, async (_req, res) => {
    try {
      const now = new Date().toISOString();
      const [open, active] = await Promise.all([
        listOpenFantasyGames(),
        listActiveFantasyGames(now),
      ]);
      res.json([...active, ...open].map(toArenaDto));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // GET /api/v1/arenas/:id
  app.get("/api/v1/arenas/:id", requireAuth, async (req, res) => {
    try {
      const game = await getFantasyGameById(String(req.params.id));
      if (!game) { res.status(404).json({ error: "Not found" }); return; }
      res.json(toArenaDto(game));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // POST /api/v1/arenas — create arena
  app.post("/api/v1/arenas", requireAuth, async (req, res) => {
    try {
      const userId = await getOrCreateInternalId(req.privyUserId!);
      const { entry_fee, duration_hours } = req.body as { entry_fee: number; duration_hours?: number };

      if (!entry_fee || entry_fee < FANTASY_MIN_ENTRY_FEE || entry_fee > FANTASY_MAX_ENTRY_FEE) {
        res.status(400).json({ error: `Entry fee must be $${FANTASY_MIN_ENTRY_FEE}–$${FANTASY_MAX_ENTRY_FEE}` });
        return;
      }

      const balance = await getBalance(userId);
      if (balance < entry_fee) {
        res.status(400).json({ error: `Insufficient balance. Available: $${balance} USDC` });
        return;
      }

      const durationHours = duration_hours ?? FANTASY_DEFAULT_DURATION_HOURS;
      const now = new Date();
      const end = new Date(now.getTime() + durationHours * 60 * 60 * 1000);
      const code = Math.random().toString(36).slice(2, 6).toUpperCase();
      const virtualStartBalance = entry_fee * FANTASY_ENTRY_MULTIPLIER;

      const game = await createFantasyGameWithEntry({
        code,
        creatorTelegramId: userId,
        entryFee: entry_fee,
        virtualStartBalance,
        startAt: now.toISOString(),
        endAt: end.toISOString(),
        commissionRate: FANTASY_COMMISSION_RATE,
      });

      res.status(201).json(toArenaDto(game));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // POST /api/v1/arenas/join
  app.post("/api/v1/arenas/join", requireAuth, async (req, res) => {
    try {
      const userId = await getOrCreateInternalId(req.privyUserId!);
      const { code } = req.body as { code: string };
      if (!code) { res.status(400).json({ error: "code is required" }); return; }

      const preview = await getFantasyGameByCode(code.trim().toUpperCase());
      if (!preview) { res.status(404).json({ error: "Arena not found" }); return; }
      if (preview.status !== "open") { res.status(400).json({ error: "Arena is not open for joining" }); return; }

      const balance = await getBalance(userId);
      if (balance < preview.entry_fee) {
        res.status(400).json({ error: `Insufficient balance. Need $${preview.entry_fee} USDC` });
        return;
      }

      const game = await joinFantasyGameWithEntry({
        code: code.trim().toUpperCase(),
        telegramId: userId,
        commissionRate: FANTASY_COMMISSION_RATE,
      });

      res.json({ ok: true, arena: toArenaDto(game) });
    } catch (e) { res.status(400).json({ error: String(e) }); }
  });

  // --- Live round ---

  // GET /api/v1/arenas/:id/round
  app.get("/api/v1/arenas/:id/round", requireAuth, async (req, res) => {
    try {
      const userId = await getOrCreateInternalId(req.privyUserId!);
      const game = await getFantasyGameById(String(req.params.id));
      if (!game) { res.status(404).json({ error: "Not found" }); return; }

      const member = await getFantasyGameMember(game.id, userId);
      const snapshot = await getCurrentRoundSnapshot("BTC");

      if (!snapshot) { res.status(503).json({ error: "No active round available" }); return; }

      res.json({
        round_number: 1,
        total_rounds: Math.round((new Date(game.end_at).getTime() - new Date(game.start_at).getTime()) / (15 * 60 * 1000)),
        direction: null,
        btc_price_open: snapshot.pricing?.eventThreshold ?? 0,
        btc_price_current: snapshot.pricing?.eventThreshold ?? 0,
        round_ends_at: snapshot.round.closingDate,
        bankroll: member?.virtual_balance ?? game.virtual_start_balance,
        event_id: snapshot.round.eventId,
        market_id: snapshot.pricing?.marketId ?? null,
        up_price: snapshot.pricing?.upPrice ?? null,
        down_price: snapshot.pricing?.downPrice ?? null,
        up_outcome_id: snapshot.pricing?.upOutcomeId ?? null,
        down_outcome_id: snapshot.pricing?.downOutcomeId ?? null,
        pct_elapsed: snapshot.round.pctElapsed,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // --- Trade ---

  // POST /api/v1/arenas/:id/trade
  app.post("/api/v1/arenas/:id/trade", requireAuth, async (req, res) => {
    try {
      const userId = await getOrCreateInternalId(req.privyUserId!);
      const { direction, stake, event_id, market_id, outcome_id } = req.body as {
        direction: "UP" | "DOWN";
        stake: number;
        event_id: string;
        market_id: string;
        outcome_id: string;
      };

      if (!["UP", "DOWN"].includes(direction)) {
        res.status(400).json({ error: "direction must be UP or DOWN" });
        return;
      }

      const validStake = (FANTASY_TRADE_AMOUNTS as readonly number[]).includes(stake);
      if (!validStake) {
        res.status(400).json({ error: `stake must be one of ${FANTASY_TRADE_AMOUNTS.join(", ")}` });
        return;
      }

      const game = await getFantasyGameById(String(req.params.id));
      if (!game) { res.status(404).json({ error: "Arena not found" }); return; }
      if (game.status !== "active") { res.status(400).json({ error: "Arena is not active" }); return; }

      const member = await getFantasyGameMember(game.id, userId);
      if (!member) { res.status(403).json({ error: "Not a member of this arena" }); return; }
      if (member.virtual_balance < stake) {
        res.status(400).json({ error: "Insufficient virtual balance" });
        return;
      }

      // Get current pricing to determine entry_price and shares
      const snapshot = await getCurrentRoundSnapshot("BTC");
      const pricing = snapshot?.pricing;
      const entryPrice = direction === "UP"
        ? (pricing?.upPrice ?? 0.5)
        : (pricing?.downPrice ?? 0.5);
      const shares = entryPrice > 0 ? stake / entryPrice : stake;

      const trade = await placeFantasyTradeWithDebit({
        gameId: game.id,
        memberId: member.id,
        telegramId: userId,
        eventId: event_id ?? snapshot?.round.eventId ?? "",
        marketId: market_id ?? pricing?.marketId ?? "",
        direction: direction as "UP" | "DOWN",
        stake,
        entryPrice,
        shares,
      });

      broadcastToArena(game.id, { type: "trade_placed", payload: { direction, userId, stake } });
      res.json({ ok: true, trade_id: trade.id });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // --- Leaderboard ---

  // GET /api/v1/arenas/:id/leaderboard
  app.get("/api/v1/arenas/:id/leaderboard", requireAuth, async (req, res) => {
    try {
      const entries = await getFantasyLeaderboard(String(req.params.id));
      res.json(entries.map((e) => ({
        rank: e.place,
        username: e.username ?? `player_${Math.abs(e.telegram_id) % 10000}`,
        bankroll: e.virtual_balance,
        trades_won: e.wins,
        accuracy_pct: e.accuracy_pct,
      })));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // --- Wallet ---

  // GET /api/v1/wallet
  app.get("/api/v1/wallet", requireAuth, async (req, res) => {
    try {
      const userId = await getOrCreateInternalId(req.privyUserId!);
      const wallet = await ensureFantasyWallet(userId);
      await syncFantasyWalletDeposits(wallet);
      const [balance, ledger, withdrawals] = await Promise.all([
        getBalance(userId),
        listFantasyWalletLedger(userId, 10),
        listRecentFantasyWalletWithdrawals(userId, 5),
      ]);
      res.json({
        address: wallet.owner_address,
        usdc_ata: wallet.usdc_ata,
        balance_usdc: balance,
        balance_ngn: 0,
        recent_ledger: ledger,
        recent_withdrawals: withdrawals,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // POST /api/v1/wallet/withdraw
  app.post("/api/v1/wallet/withdraw", requireAuth, async (req, res) => {
    try {
      const userId = await getOrCreateInternalId(req.privyUserId!);
      const { to_address, amount_usdc } = req.body as { to_address: string; amount_usdc: number };
      if (!to_address || !amount_usdc) { res.status(400).json({ error: "to_address and amount_usdc required" }); return; }
      await requestSolanaWithdrawal({ telegramId: userId, destinationAddress: to_address, amount: amount_usdc });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: String(e) }); }
  });

  // POST /api/v1/wallet/fund-ngn
  app.post("/api/v1/wallet/fund-ngn", requireAuth, async (req, res) => {
    try {
      const userId = await getOrCreateInternalId(req.privyUserId!);
      const { amount } = req.body as { amount: number };
      if (!amount || amount <= 0) { res.status(400).json({ error: "amount required" }); return; }
      const { createFantasyPajCashOnramp } = await import("../pajcash.ts");
      const record = await createFantasyPajCashOnramp({ telegramId: userId, fiatAmount: amount });
      res.json({
        account_number: record.account_number,
        bank_name: record.bank_name,
        amount: record.fiat_amount,
        reference: record.order_id,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // POST /api/v1/wallet/offramp-ngn
  app.post("/api/v1/wallet/offramp-ngn", requireAuth, async (req, res) => {
    try {
      const userId = await getOrCreateInternalId(req.privyUserId!);
      const { amount, bank_id, account_number } = req.body as { amount: number; bank_id: string; account_number: string };
      if (!amount || !bank_id || !account_number) {
        res.status(400).json({ error: "amount, bank_id, and account_number required" });
        return;
      }
      const { createFantasyPajCashOfframp } = await import("../pajcash.ts");
      await createFantasyPajCashOfframp({ telegramId: userId, usdcAmount: amount, bankId: bank_id, accountNumber: account_number });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // --- Support ---

  // POST /api/v1/support/ask
  app.post("/api/v1/support/ask", requireAuth, async (req, res) => {
    try {
      const userId = await getOrCreateInternalId(req.privyUserId!);
      const { question } = req.body as { question: string };
      if (!question) { res.status(400).json({ error: "question required" }); return; }
      const answer = await handleSupportQuestion(question, userId);
      res.json({ answer });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });
}

// ---------------------------------------------------------------------------
// DTO helpers
// ---------------------------------------------------------------------------

type FantasyGame = Awaited<ReturnType<typeof getFantasyGameById>>;

function toArenaDto(game: NonNullable<FantasyGame>) {
  return {
    id: game.id,
    code: game.code,
    name: `Arena ${game.code}`,
    entry_fee: game.entry_fee,
    status: game.status === "open" ? "pending" : game.status === "active" ? "active" : "ended",
    player_count: 0,
    prize_pool: game.prize_pool,
    start_at: game.start_at,
    end_at: game.end_at,
  };
}
