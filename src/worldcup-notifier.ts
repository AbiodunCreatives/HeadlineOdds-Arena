import { InlineKeyboard } from "grammy";
import { bot } from "./index.ts";
import { listBayseEvents } from "./bayse-trading.ts";
import { listAllUsers } from "./prediction-market.ts";

// 8:00 AM WAT = 07:00 UTC  (daily WC markets digest)
const NOTIFY_HOUR_UTC = 7;
const NOTIFY_MINUTE_UTC = 0;

// 7:30 AM WAT = 06:30 UTC  (one-time update announcement)
const UPDATE_BLAST_HOUR_UTC = 6;
const UPDATE_BLAST_MINUTE_UTC = 30;
const UPDATE_BLAST_REDIS_KEY = "wc:update-blast:sent-2026-06-14";

let _timer: ReturnType<typeof setTimeout> | null = null;
let _blastTimer: ReturnType<typeof setTimeout> | null = null;

function isWorldCupEvent(title: string): boolean {
  const t = title.toLowerCase();
  return t.includes("world cup") || t.includes("fifa") || t.includes("wc 2026") || t.includes("wc2026");
}

function msUntilNextNotify(): number {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    NOTIFY_HOUR_UTC,
    NOTIFY_MINUTE_UTC,
    0,
    0,
  ));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function msUntilBlast(): number {
  const now = new Date();
  // Target: tomorrow at 06:30 UTC
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    UPDATE_BLAST_HOUR_UTC,
    UPDATE_BLAST_MINUTE_UTC,
    0,
    0,
  ));
  return Math.max(0, next.getTime() - now.getTime());
}

async function sendUpdateBlast(): Promise<void> {
  try {
    const { redis } = await import("./utils/rateLimit.ts");
    const alreadySent = await redis.get(UPDATE_BLAST_REDIS_KEY);
    if (alreadySent) {
      console.log("[wc-blast] Update blast already sent — skipping.");
      return;
    }

    const text =
      `🌍 <b>FIFA World Cup 2026 markets are now live on HeadlineOdds Arena!</b>\n\n` +
      `Trade on who wins the Cup, Group Winners, Top Scorer, and more — all in Naira.\n\n` +
      `├ Connect your account → /connectbayse\n` +
      `└ Tap 📊 Markets → 🏆 World Cup to start trading\n\n` +
      `💰 Min bet ₦100. Win big if you're right.`;

    const keyboard = new InlineKeyboard().text("🏆 Trade World Cup", "bm:cat:WORLD CUP");

    const users = await listAllUsers();
    let sent = 0;
    for (const user of users) {
      try {
        await bot.api.sendMessage(user.telegram_id, text, { parse_mode: "HTML", reply_markup: keyboard });
        sent++;
      } catch { /* blocked or not found */ }
    }

    await redis.set(UPDATE_BLAST_REDIS_KEY, "1", "EX", 60 * 60 * 24 * 7); // idempotent for 7 days
    console.log(`[wc-blast] Update blast sent to ${sent}/${users.length} users.`);
  } catch (err) {
    console.error("[wc-blast] Failed:", err instanceof Error ? err.message : err);
  }
}

async function sendWorldCupNotifications(): Promise<void> {
  try {
    const events = await listBayseEvents({ size: 100 });
    const wcEvents = events.filter(
      (e) => e.category?.toUpperCase() === "WORLD CUP" && Array.isArray(e.markets) && e.markets.length > 0
    );

    if (wcEvents.length === 0) {
      console.log("[wc-notify] No live World Cup markets today — skipping broadcast.");
      return;
    }

    const lines = ["⚽ <b>FIFA World Cup 2026 — Today's Markets</b>\n"];
    for (const e of wcEvents.slice(0, 8)) {
      lines.push(`📌 ${e.title}`);
    }
    lines.push("\nTrade YES or NO on today's World Cup matches 👇");
    const text = lines.join("\n");

    const keyboard = new InlineKeyboard().text("⚽ Trade Now", "bm:cat:SPORTS");

    const users = await listAllUsers();
    let sent = 0;
    for (const user of users) {
      try {
        await bot.api.sendMessage(user.telegram_id, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
        sent++;
      } catch {
        // User blocked the bot or chat not found — skip
      }
    }
    console.log(`[wc-notify] Broadcast sent to ${sent}/${users.length} users.`);
  } catch (err) {
    console.error("[wc-notify] Failed to send notifications:", err instanceof Error ? err.message : err);
  }
}

function scheduleNext(): void {
  const delay = msUntilNextNotify();
  console.log(`[wc-notify] Next notification in ${Math.round(delay / 60_000)}m`);
  _timer = setTimeout(() => {
    void sendWorldCupNotifications();
    scheduleNext();
  }, delay);
}

export function startWorldCupNotifier(): void {
  if (_timer) return;
  scheduleNext();

  // One-time update blast tomorrow at 7:30 AM WAT
  const blastDelay = msUntilBlast();
  console.log(`[wc-blast] Update blast scheduled in ${Math.round(blastDelay / 60_000)}m`);
  _blastTimer = setTimeout(() => void sendUpdateBlast(), blastDelay);
}

export function stopWorldCupNotifier(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_blastTimer) { clearTimeout(_blastTimer); _blastTimer = null; }
}
