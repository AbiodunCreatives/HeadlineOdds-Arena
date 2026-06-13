import { InlineKeyboard } from "grammy";
import { bot } from "./index.ts";
import { listBayseEvents } from "./bayse-trading.ts";
import { listAllUsers } from "./prediction-market.ts";

// 8:00 AM WAT = 07:00 UTC
const NOTIFY_HOUR_UTC = 7;
const NOTIFY_MINUTE_UTC = 0;

let _timer: ReturnType<typeof setTimeout> | null = null;

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

async function sendWorldCupNotifications(): Promise<void> {
  try {
    const events = await listBayseEvents({ size: 100 });
    const wcEvents = events.filter(
      (e) => e.category?.toUpperCase() === "SPORTS" && isWorldCupEvent(e.title)
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
}

export function stopWorldCupNotifier(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}
