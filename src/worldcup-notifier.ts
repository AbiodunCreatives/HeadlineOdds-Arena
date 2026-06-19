import { InlineKeyboard } from "grammy";
import { bot } from "./index.ts";
import { listBayseEvents, type BayseEvent } from "./bayse-trading.ts";
import { listAllUsers } from "./prediction-market.ts";
import { redis } from "./utils/rateLimit.ts";

// 8:00 AM WAT = 07:00 UTC  (daily WC markets digest)
const NOTIFY_HOUR_UTC = 7;
const NOTIFY_MINUTE_UTC = 0;

// 7:30 AM WAT = 06:30 UTC  (one-time update announcement)
const UPDATE_BLAST_HOUR_UTC = 6;
const UPDATE_BLAST_MINUTE_UTC = 30;
const UPDATE_BLAST_REDIS_KEY = "wc:update-blast:sent-2026-06-14";

// Pre-kickoff alert: 3 hours before each match
const KICKOFF_ALERT_MS = 3 * 60 * 60 * 1000;
// Poll every 10 minutes to pick up newly listed matches
const MATCH_POLL_INTERVAL_MS = 10 * 60 * 1000;

let _timer: ReturnType<typeof setTimeout> | null = null;
let _blastTimer: ReturnType<typeof setTimeout> | null = null;
let _matchPollTimer: ReturnType<typeof setTimeout> | null = null;
const _matchAlertTimers = new Map<string, ReturnType<typeof setTimeout>>();

function isMatchEvent(e: BayseEvent): boolean {
  return /\bvs\.?\b/i.test(e.title);
}

function msUntilNextNotify(): number {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    NOTIFY_HOUR_UTC, NOTIFY_MINUTE_UTC, 0, 0,
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function msUntilBlast(): number {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
    UPDATE_BLAST_HOUR_UTC, UPDATE_BLAST_MINUTE_UTC, 0, 0,
  ));
  return Math.max(0, next.getTime() - now.getTime());
}

async function broadcastToAllUsers(text: string, keyboard: InlineKeyboard): Promise<void> {
  const users = await listAllUsers();
  for (const user of users) {
    try {
      await bot.api.sendMessage(user.telegram_id, text, { parse_mode: "HTML", reply_markup: keyboard });
    } catch { /* blocked or not found */ }
  }
}

async function sendMatchKickoffAlert(e: BayseEvent): Promise<void> {
  const redisKey = `wc:kickoff-alert:${e.id}`;
  if (await redis.get(redisKey).catch(() => null)) return;

  const markets = e.markets.slice(0, 3);
  const outcomeLines = markets.map((m) => {
    const label = m.title?.trim() && !/^(yes|no)$/i.test(m.title.trim())
      ? m.title.trim()
      : (m.outcome1Label && !/^(yes|no)$/i.test(m.outcome1Label) ? m.outcome1Label : "Draw");
    return { label, price: Math.round(m.outcome1Price * 100), prob: Math.round(m.outcome1Price * 100) };
  });

  // Deterministic template pick: even/odd last char of event ID
  const useAnalytical = e.id.charCodeAt(e.id.length - 1) % 2 === 0;

  let text: string;
  let buttonLabel: string;

  if (useAnalytical) {
    // Template 2 — Cold/Analytical
    const probLines = outcomeLines
      .map((o) => `${o.label}: ${o.prob}%`)
      .join("  |  ");
    const [first, ...rest] = outcomeLines;
    const restStr = rest.map((o) => `${o.label}: ${o.prob}%`).join("  |  ");
    text =
      `<b>${e.title}</b>\n` +
      `Kickoff: 3 hours.\n\n` +
      `${first?.label ?? ""} implied win probability: ${first?.prob ?? 0}%\n` +
      `${restStr}\n\n` +
      `The numbers say it's almost a coin flip.\n` +
      `The payout says otherwise.\n\n` +
      `└ Min bet ₦100`;
    buttonLabel = "📈 Trade the Odds";
  } else {
    // Template 1 — Direct/Blunt
    const priceLines = outcomeLines.map((o) => `${o.label}: ₦${o.price} YES.`).join("\n");
    text =
      `3 hours to <b>${e.title}</b>.\n\n` +
      `${priceLines}\n\n` +
      `Pick one. Bet ₦100+. Win big if right.\n` +
      `Simple as that.\n\n` +
      `└ Tap below to trade 👇`;
    buttonLabel = "⚽ Open Market";
  }

  const keyboard = new InlineKeyboard().text(buttonLabel, "bm:cat:WORLD CUP");

  try {
    await broadcastToAllUsers(text, keyboard);
    await redis.set(redisKey, "1", "EX", 60 * 60 * 8);
    console.log(`[wc-kickoff] Alert sent for "${e.title}" (template: ${useAnalytical ? "analytical" : "blunt"})`);
  } catch (err) {
    console.error(`[wc-kickoff] Failed for "${e.title}":`, err instanceof Error ? err.message : err);
  }
}

function scheduleMatchAlert(e: BayseEvent): void {
  if (_matchAlertTimers.has(e.id)) return;

  const kickoffMs = e.openingDate ? Date.parse(e.openingDate) : Date.parse(e.closingDate ?? "");
  if (!Number.isFinite(kickoffMs)) return;

  const delay = kickoffMs - KICKOFF_ALERT_MS - Date.now();
  // Skip if already past, or more than 48h away (next poll will catch it)
  if (delay <= 0 || delay > 48 * 60 * 60 * 1000) return;

  const handle = setTimeout(() => {
    _matchAlertTimers.delete(e.id);
    void sendMatchKickoffAlert(e);
  }, delay);

  _matchAlertTimers.set(e.id, handle);
  console.log(`[wc-kickoff] "${e.title}" alert in ${Math.round(delay / 60_000)}m`);
}

async function pollAndScheduleMatchAlerts(): Promise<void> {
  try {
    const events = await listBayseEvents({ size: 200 });
    const wcMatches = events.filter(
      (e) => e.category?.toUpperCase() === "WORLD CUP" && isMatchEvent(e)
    );
    for (const e of wcMatches) scheduleMatchAlert(e);
  } catch (err) {
    console.error("[wc-kickoff] Poll failed:", err instanceof Error ? err.message : err);
  }
  _matchPollTimer = setTimeout(() => void pollAndScheduleMatchAlerts(), MATCH_POLL_INTERVAL_MS);
}

async function sendUpdateBlast(): Promise<void> {
  try {
    if (await redis.get(UPDATE_BLAST_REDIS_KEY)) return;

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
      try { await bot.api.sendMessage(user.telegram_id, text, { parse_mode: "HTML", reply_markup: keyboard }); sent++; }
      catch { /* blocked */ }
    }
    await redis.set(UPDATE_BLAST_REDIS_KEY, "1", "EX", 60 * 60 * 24 * 7);
    console.log(`[wc-blast] Sent to ${sent}/${users.length} users.`);
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
      console.log("[wc-notify] No live World Cup markets today — skipping.");
      return;
    }

    const lines = ["⚽ <b>FIFA World Cup 2026 — Today's Markets</b>\n"];
    for (const e of wcEvents.slice(0, 8)) lines.push(`📌 ${e.title}`);
    lines.push("\nTrade YES or NO on today's World Cup matches 👇");

    const keyboard = new InlineKeyboard().text("🏆 Trade World Cup", "bm:cat:WORLD CUP");
    const users = await listAllUsers();
    let sent = 0;
    for (const user of users) {
      try { await bot.api.sendMessage(user.telegram_id, lines.join("\n"), { parse_mode: "HTML", reply_markup: keyboard }); sent++; }
      catch { /* blocked */ }
    }
    console.log(`[wc-notify] Broadcast sent to ${sent}/${users.length} users.`);
  } catch (err) {
    console.error("[wc-notify] Failed:", err instanceof Error ? err.message : err);
  }
}

function scheduleNext(): void {
  const delay = msUntilNextNotify();
  console.log(`[wc-notify] Next in ${Math.round(delay / 60_000)}m`);
  _timer = setTimeout(() => { void sendWorldCupNotifications(); scheduleNext(); }, delay);
}

export function startWorldCupNotifier(): void {
  if (_timer) return;
  scheduleNext();

  const blastDelay = msUntilBlast();
  console.log(`[wc-blast] Scheduled in ${Math.round(blastDelay / 60_000)}m`);
  _blastTimer = setTimeout(() => void sendUpdateBlast(), blastDelay);

  // 3-hour pre-kickoff alerts
  void pollAndScheduleMatchAlerts();
}

export function stopWorldCupNotifier(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_blastTimer) { clearTimeout(_blastTimer); _blastTimer = null; }
  if (_matchPollTimer) { clearTimeout(_matchPollTimer); _matchPollTimer = null; }
  for (const handle of _matchAlertTimers.values()) clearTimeout(handle);
  _matchAlertTimers.clear();
}
