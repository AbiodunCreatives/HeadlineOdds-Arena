import { createServer } from "http";
import { timingSafeEqual } from "crypto";

import express from "express";
import { Bot, type Context } from "grammy";

import { registerAdminDashboard } from "./admin-dashboard.ts";
import { registerBtcChartMenuPage } from "./btc-chart-menu.ts";
import {
  handleBoard,
  handleChart,
  handleCreate,
  handleFundNgn,
  handleOfframpNgn,
  handleFantasyLeagueUiAction,
  handleFantasyJoinConfirm,
  handleFantasyJoinDecline,
  handleFantasyLeagueTrade,
  handleFantasyTextInput,
  handleHelp,
  handleJoin,
  handleLeague,
  handleLive,
  handleStart,
  handleStatus,
  handleWithdraw,
  handleWallet,
  handleAdminWithdraw,
  handleCreateMarket,
  handleResolveMarket,
  handleMarketBet,
  handleMarketBetAmount,
  handleMarketBetCustom,
} from "./bot/handlers/league.ts";
import { handleSupportQuestion } from "./bot/handlers/support.ts";
import { config } from "./config.ts";
import { supabase } from "./db/client.ts";
import { upsertUserProfile } from "./db/users.ts";
import { startFantasyMonitor, stopFantasyMonitor } from "./fantasy-monitor.ts";
import { createRateLimitMiddleware } from "./http-security.ts";
import { reconcilePajCashWebhook } from "./pajcash.ts";
import {
  startFantasySettlementMonitor,
  stopFantasySettlementMonitor,
} from "./fantasy-settlement.ts";
import {
  startSolanaWalletMonitor,
  stopSolanaWalletMonitor,
} from "./solana-wallet-monitor.ts";
import { redis } from "./utils/rateLimit.ts";
import { getCurrentRoundSnapshot } from "./bayse-market.ts";
import { getFantasyLeagueStatusView } from "./fantasy-game.ts";
import { getLatestFantasyTradeForMember } from "./db/fantasy.ts";
import { saveFantasyTradeReference } from "./fantasy-state.ts";
import { placeFantasyTradeFromCallbackData } from "./fantasy-league.ts";
import { sendAdminAlert } from "./utils/alert.ts";

const bot = new Bot(config.BOT_TOKEN);
const app = express();
const healthRateLimit = createRateLimitMiddleware({
  keyPrefix: "health-route",
  limit: 30,
  windowSeconds: 60,
  message: "Too many health checks. Please wait a minute.",
});
const pajcashWebhookRateLimit = createRateLimitMiddleware({
  keyPrefix: "pajcash-webhook",
  limit: 60,
  windowSeconds: 60,
  message: "Too many PajCash webhook requests. Please wait a minute.",
});
const telegramWebhookRateLimit = createRateLimitMiddleware({
  keyPrefix: "telegram-webhook",
  limit: 180,
  windowSeconds: 60,
  message: "Too many Telegram webhook requests. Please wait a minute.",
});

// Replay protection for webhook updates — Redis-backed with 24h TTL
const REPLAY_KEY_PREFIX = "webhook:seen:";
const REPLAY_TTL_SECONDS = 86400; // 24 hours

async function isReplayedUpdate(updateId: number): Promise<boolean> {
  const key = `${REPLAY_KEY_PREFIX}${updateId}`;
  const result = await redis.set(key, "1", "EX", REPLAY_TTL_SECONDS, "NX");
  return result === null; // null means key already existed
}

app.set("trust proxy", true);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
registerAdminDashboard(app);
registerBtcChartMenuPage(app);

bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    await upsertUserProfile(ctx.from.id, ctx.from.username).catch((error) => {
      console.warn("[bot] Failed to upsert user profile:", error);
    });
  }

  await next();
});

bot.command("start", wrap(handleStart));
bot.command("help", wrap(handleHelp));
bot.command("ask", wrap(async (ctx) => {
  if (!ctx.from) return;
  const question = (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();
  if (!question) {
    await ctx.reply("What would you like to know? Just type your question and I'll answer instantly.");
    return;
  }
  await ctx.api.sendChatAction(ctx.chat?.id ?? ctx.from.id, "typing").catch(() => null);
  const answer = await handleSupportQuestion(question, ctx.from.id);
  const sent = await ctx.reply(answer, { parse_mode: "Markdown" });
  setTimeout(() => {
    ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => null);
  }, 60_000);
}));
bot.command("chart", wrap(handleChart));
bot.command("league", wrap(handleLeague));
bot.command("create", wrap(handleCreate));
bot.command("join", wrap(handleJoin));
bot.command("live", wrap(handleLive));
bot.command("board", wrap(handleBoard));
bot.command("status", wrap(handleStatus));
bot.command("wallet", wrap(handleWallet));
bot.command("fundngn", wrap(handleFundNgn));
bot.command("offrampngn", wrap(handleOfframpNgn));
bot.command("withdraw", wrap(handleWithdraw));
bot.command("adminwithdraw", wrap(handleAdminWithdraw));
bot.command("createmarket", wrap(handleCreateMarket));
bot.command("resolvemarket", wrap(handleResolveMarket));
bot.callbackQuery(/^pm:(yes|no):/, wrap(handleMarketBet));
bot.callbackQuery(/^pma:/, wrap(handleMarketBetAmount));
bot.callbackQuery(/^flt:/, wrap(handleFantasyLeagueTrade));
bot.callbackQuery(/^(start|lobby|arena|funds|wallet|offramp|cc):/, wrap(handleFantasyLeagueUiAction));
bot.callbackQuery("fantasy:join:confirm", wrap(handleFantasyJoinConfirm));
bot.callbackQuery("fantasy:join:decline", wrap(handleFantasyJoinDecline));
bot.on("message:text", async (ctx, next) => {
  const handled = await handleFantasyTextInput(ctx);
  if (handled) return;

  // Prediction market custom bet amount
  if (await handleMarketBetCustom(ctx)) return;

  // Plain-text messages that aren't commands or handled inputs go to support agent
  const text = ctx.message?.text ?? "";
  if (!text.startsWith("/") && ctx.from) {
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    const answer = await handleSupportQuestion(text, ctx.from.id);
    const sent = await ctx.reply(answer, { parse_mode: "Markdown" });
    setTimeout(() => {
      ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => null);
    }, 60_000);
    return;
  }

  await next();
});

bot.on("message:web_app_data", wrap(async (ctx) => {
  if (!ctx.from) return;
  const raw = ctx.message?.web_app_data?.data ?? "";
  let payload: { action?: string; direction?: string; amount?: number; ref?: string };
  try { payload = JSON.parse(raw); } catch { return; }
  if (payload.action !== "trade" || !payload.direction || !payload.amount || !payload.ref) return;

  const callbackData = `flt:d:${payload.amount}:${payload.direction}:r:${payload.ref}`;
  try {
    const result = await placeFantasyTradeFromCallbackData({ telegramId: ctx.from.id, callbackData });
    await ctx.reply(
      `✅ Trade placed! ${result.direction === "UP" ? "↑ YES" : "↓ NO"} · ${result.stake} USDC · Round #${result.roundNumber}\nBalance: $${result.remainingBalance.toFixed(2)}`,
      { parse_mode: undefined }
    );
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : "Trade failed. Please try again."}`);
  }
}));

bot.catch((error) => {
  console.error(
    `[bot] Unhandled error for update ${error.ctx.update.update_id}:`,
    error.error
  );
  void sendAdminAlert(`[bot] Unhandled error for update ${error.ctx.update.update_id}: ${error.error instanceof Error ? error.error.message : String(error.error)}`);
  error.ctx.reply("Something went wrong. Please try again in a moment.").catch(() => null);
});

// Per-user bot command rate limit: 20 commands per 60 seconds
const BOT_USER_RATE_LIMIT = 20;
const BOT_USER_RATE_WINDOW = 60;

async function checkUserRateLimit(telegramId: number): Promise<boolean> {
  const key = `rate_limit:bot_user:${telegramId}`;
  try {
    const current = await redis.incr(key);
    if (current === 1) await redis.expire(key, BOT_USER_RATE_WINDOW);
    return current <= BOT_USER_RATE_LIMIT;
  } catch {
    return true; // fail open on Redis error
  }
}

function wrap(
  handler: (ctx: Context) => Promise<void>
): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => null);
    }

    const userId = ctx.from?.id;
    if (userId && !(await checkUserRateLimit(userId))) {
      await ctx.reply("⏳ Slow down — you're sending commands too fast. Try again in a moment.").catch(() => null);
      return;
    }

    const updateId = ctx.update.update_id;
    const handlerName = handler.name || "(anonymous)";
    console.log(`[bot] update=${updateId} handler=${handlerName}`);

    try {
      await handler(ctx);
      console.log(`[bot] update=${updateId} handler=${handlerName} - done`);
    } catch (error) {
      console.error(
        `[bot] update=${updateId} handler=${handlerName} - failed:`,
        error
      );
      await ctx.reply("Something went wrong. Please try again.").catch(() => null);
    }
  };
}

function safeEqual(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) {
      timingSafeEqual(aBuf, aBuf);
      return false;
    }
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function normalizeAuthHeader(value: string | undefined): string {
  return (value ?? "").trim();
}

function matchesHealthCheckToken(
  headerValue: string | undefined,
  queryValue: unknown,
  secret: string
): boolean {
  const normalizedHeader = normalizeAuthHeader(headerValue);
  const normalizedQuery =
    typeof queryValue === "string" ? queryValue.trim() : "";

  return (
    safeEqual(normalizedHeader, secret) ||
    safeEqual(normalizedHeader, `Bearer ${secret}`) ||
    (config.NODE_ENV !== "production" && safeEqual(normalizedQuery, secret))
  );
}

app.get("/", (_req, res) => {
  res.status(200).send("HeadlineOdds Arena bot is running. Use /health for health checks.");
});

app.get("/health", healthRateLimit, async (req, res) => {
  if (
    config.HEALTH_CHECK_TOKEN &&
    !matchesHealthCheckToken(
      req.header("x-health-check-token") ?? req.header("authorization"),
      req.query["token"],
      config.HEALTH_CHECK_TOKEN
    )
  ) {
    res.sendStatus(403);
    return;
  }

  const [gamesResult, redisResult] = await Promise.allSettled([
    supabase.from("fantasy_games").select("*", { count: "exact", head: true }),
    redis.dbsize(),
  ]);

  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    fantasy_games:
      gamesResult.status === "fulfilled" ? (gamesResult.value.count ?? 0) : null,
    redis_keys: redisResult.status === "fulfilled" ? redisResult.value : null,
  });
});

app.get("/api/trade-state", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const tgId = Number(req.query["tgId"]);
  const code = String(req.query["code"] ?? "").trim().toUpperCase();
  if (!tgId || !code) { res.status(400).json({ error: "tgId and code required" }); return; }

  try {
    const [view, snapshot] = await Promise.all([
      getFantasyLeagueStatusView(tgId, code),
      getCurrentRoundSnapshot("BTC"),
    ]);

    const me = view.me;
    if (!me) { res.status(403).json({ error: "Not a member of this arena" }); return; }

    const pricing = snapshot?.pricing ?? null;
    const round = snapshot?.round ?? null;
    const roundOpenMs = round ? Date.parse(round.openingDate) : null;
    const roundCloseMs = round ? Date.parse(round.closingDate) : null;
    const tradeWindowOpen = roundOpenMs !== null && roundCloseMs !== null
      ? Date.now() < roundOpenMs + (roundCloseMs - roundOpenMs) * 0.2
      : false;

    const lastTrade = await getLatestFantasyTradeForMember(view.game.id, tgId);
    const lockedThisRound = lastTrade && round
      ? lastTrade.event_id === round.eventId
      : false;

    let ref = "";
    if (tradeWindowOpen && !lockedThisRound && pricing && round) {
      const { getRoundCurrentPrice } = await import("./fantasy-round.ts");
      const currentPrice = await getRoundCurrentPrice(pricing);
      ref = await saveFantasyTradeReference({
        gameId: view.game.id, eventId: round.eventId, marketId: pricing.marketId,
        openingDate: round.openingDate, closingDate: round.closingDate,
        currentPrice, referencePrice: pricing.eventThreshold,
        upPrice: pricing.upPrice, downPrice: pricing.downPrice,
        upOutcomeId: pricing.upOutcomeId, downOutcomeId: pricing.downOutcomeId,
      });
    }

    res.json({
      gameCode: view.game.code,
      roundNumber: view.roundsPlayed + 1,
      btcPrice: pricing?.eventThreshold ?? round?.eventThreshold ?? null,
      referencePrice: pricing?.eventThreshold ?? round?.eventThreshold ?? null,
      upPrice: pricing?.upPrice ?? 0.5,
      downPrice: pricing?.downPrice ?? 0.5,
      roundClosingDate: round?.closingDate ?? null,
      arenaEndAt: view.game.end_at,
      virtualBalance: me.virtual_balance,
      virtualStartBalance: view.game.virtual_start_balance,
      place: me.place,
      memberCount: view.memberCount,
      prizeIfEndedNow: view.prizeIfEndedNow,
      tradeWindowOpen,
      lockedDirection: lockedThisRound ? lastTrade!.direction : null,
      lockedAmount: lockedThisRound ? lastTrade!.stake : null,
      ref,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    res.status(500).json({ error: msg });
  }
});

app.post("/webhook/pajcash/:secret", pajcashWebhookRateLimit, async (req, res) => {
  const configuredSecret = config.PAJCASH_WEBHOOK_PATH_SECRET?.trim() ?? "";

  if (!configuredSecret) {
    res.sendStatus(404);
    return;
  }

  if (!safeEqual(String(req.params["secret"] ?? ""), configuredSecret)) {
    console.warn("[pajcash] Rejected webhook with invalid path secret");
    res.sendStatus(403);
    return;
  }

  try {
    await reconcilePajCashWebhook(req.body as Record<string, unknown> as any);
    res.status(200).json({ received: true });
  } catch (error) {
    console.error("[pajcash] Failed to reconcile webhook:", error);
    res.status(200).json({ received: true });
  }
});

app.post("/webhook/:secret", telegramWebhookRateLimit, async (req, res) => {
  if (!safeEqual(String(req.params["secret"] ?? ""), config.WEBHOOK_PATH_SECRET)) {
    console.warn("[webhook] Rejected request with invalid path secret");
    res.sendStatus(403);
    return;
  }

  const headerSecret = req.header("x-telegram-bot-api-secret-token") ?? "";
  if (config.WEBHOOK_SECRET && !safeEqual(headerSecret, config.WEBHOOK_SECRET)) {
    console.warn("[webhook] Rejected request with invalid secret token header");
    res.sendStatus(403);
    return;
  }

  // Replay protection: check if we've already processed this update
  const updateId = req.body?.update_id;
  if (typeof updateId === "number") {
    const replayed = await isReplayedUpdate(updateId).catch(() => false);
    if (replayed) {
      console.warn(`[webhook] Ignoring duplicate update_id: ${updateId}`);
      res.sendStatus(200);
      return;
    }
  }

  res.sendStatus(200);

  bot.handleUpdate(req.body).catch((error) => {
    console.error("[webhook] Unhandled error in handleUpdate:", error);
  });
});

const server = createServer(app);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `[server] Port ${config.PORT} is already in use. Set a different PORT in .env.`
    );
    process.exit(1);
  }

  throw error;
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`[server] ${signal} received. Shutting down gracefully...`);

  stopFantasyMonitor();
  stopFantasySettlementMonitor();
  stopSolanaWalletMonitor();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  try {
    await redis.quit();
    console.log("[redis] Connection closed.");
  } catch {
    redis.disconnect();
  }

  bot.stop();
  console.log("[server] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main(): Promise<void> {
  console.log("[server] Starting fantasy bot...");

  if (config.DASHBOARD_ONLY_MODE) {
    server.listen(config.PORT, () => {
      console.log(
        `[server] Dashboard-only mode enabled.\n` +
          `[server] Listening on port ${config.PORT}\n` +
          `[server] Ready:\n` +
          `  GET /health\n` +
          `  GET /admin/dashboard\n` +
          `  GET /admin/api/dashboard`
      );
    });

    return;
  }

  await redis.ping();
  console.log("[redis] Startup ping OK.");

  await bot.init();
  console.log(`[bot] Initialized as @${bot.botInfo.username}`);

  await bot.api.setMyCommands([
    {
      command: "start",
      description: "Open HeadlineOdds Arena and browse arenas",
    },
    {
      command: "help",
      description: "Show every bot command",
    },
    {
      command: "chart",
      description: "Open the BTC 15m chart link",
    },
    {
      command: "league",
      description: "Create, join, and view fantasy arenas",
    },
    {
      command: "create",
      description: "Create a new fantasy arena",
    },
    {
      command: "join",
      description: "Join an arena by code",
    },
    {
      command: "live",
      description: "View the live round for an arena",
    },
    {
      command: "board",
      description: "Open an arena leaderboard",
    },
    {
      command: "status",
      description: "View arena status details",
    },
    {
      command: "wallet",
      description: "View your Solana USDC wallet and withdraw",
    },
    {
      command: "fundngn",
      description: "Create a Naira top-up order",
    },
    {
      command: "offrampngn",
      description: "Offramp USDC to Naira via PajCash",
    },
    {
      command: "withdraw",
      description: "Withdraw USDC to a Solana wallet",
    },
  ]);

  const tradeMenuUrl = config.ARENA_URL ? `${config.ARENA_URL}/trade` : null;

  if (tradeMenuUrl) {
    await bot.api.setChatMenuButton({
      menu_button: {
        type: "web_app",
        text: "Trade",
        web_app: {
          url: tradeMenuUrl,
        },
      },
    });
  } else {
    await bot.api.setChatMenuButton({
      menu_button: {
        type: "commands",
      },
    });
  }

  startFantasyMonitor();
  startFantasySettlementMonitor();
  startSolanaWalletMonitor();

  if (config.WEBHOOK_URL) {
    const webhookUrl = `${config.WEBHOOK_URL}/webhook/${config.WEBHOOK_PATH_SECRET}`;

    await bot.api.setWebhook(webhookUrl, {
      ...(config.WEBHOOK_SECRET ? { secret_token: config.WEBHOOK_SECRET } : {}),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });

    // Log webhook URL without exposing secrets
    const sanitizedUrl = `${config.WEBHOOK_URL}/webhook/[REDACTED]`;
    console.log(`[bot] Webhook registered -> ${sanitizedUrl}`);

    server.listen(config.PORT, () => {
      console.log(
        `[server] Listening on port ${config.PORT}\n` +
          `[server] Ready:\n` +
          `  POST /webhook/:secret\n` +
          `  GET  /health`
      );
    });

    return;
  }

  console.log("[bot] WEBHOOK_URL not set. Using long polling.");

  await bot.api.deleteWebhook().catch((error) =>
    console.warn("[bot] deleteWebhook failed:", (error as Error).message)
  );

  server.listen(config.PORT, () => {
    console.log(
      `[server] Listening on port ${config.PORT}\n` +
        `[server] Ready:\n` +
        `  GET /health`
    );
  });

  bot
    .start({
      onStart: (info) => {
        console.log(`[bot] Long polling started (@${info.username}).`);
      },
    })
    .catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("409")) {
        console.warn(
          "[bot] 409 conflict on startup - another instance was still running."
        );
        process.exit(0);
      }

      console.error("[bot] Fatal polling error:", error);
      void sendAdminAlert(`[bot] Fatal polling error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

main().catch((error) => {
  console.error("[server] Fatal startup error:", error);
  void sendAdminAlert(`[server] Fatal startup error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});


