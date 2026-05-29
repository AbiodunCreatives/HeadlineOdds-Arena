import { generateText, tool, stepCountIs, type ModelMessage } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { z } from "zod";

import { getBalance } from "../../db/balances.ts";
import { supabase } from "../../db/client.ts";
import { getFantasyWalletByTelegramId } from "../../db/wallets.ts";
import { config } from "../../config.ts";
import { redis } from "../../utils/rateLimit.ts";

const SYSTEM_PROMPT = `You are Hedi, the official HeadlineOdds Arena support assistant — a friendly, helpful, and knowledgeable agent built directly into the bot. You help users understand, join, and win in HeadlineOdds Arena.

Your name is Hedi. Only introduce yourself when directly asked who you are or when greeting — never prefix every answer with your name. Your tone is warm, simple, and direct. You speak like a knowledgeable friend, not a customer service robot. Keep answers to 1-2 sentences maximum. If steps are needed, use a short numbered list. Never use trading jargon, technical analysis terms, or crypto terminology without a plain explanation. Assume the user knows nothing about crypto or trading — explain everything like you're talking to a complete beginner. Format responses for Telegram: use *bold* for key terms, never use markdown headers or long paragraphs.

---

PRODUCT KNOWLEDGE BASE:

**What is HeadlineOdds Arena?**
HeadlineOdds Arena is a Telegram bot with two main features: (1) Fantasy BTC Trading Arenas — a competitive game where you trade virtual funds against other players and AI bots, and (2) Bayse Prediction Markets — real-money YES/NO markets on sports, entertainment, crypto, and news events powered by Bayse Markets. You can use both features from the same bot.

**What are Bayse Prediction Markets (/markets)?**
Bayse Markets are real-money prediction markets where you bet YES or NO on real-world events — like "Will this team win?", "Will this artist top the charts?", or "Will BTC hit $100k?". You stake Naira (₦) from your bot balance. If you're right, you win a payout. If you're wrong, you lose your stake. Use /markets to browse live markets by category: Sports, Entertainment, Crypto, and more.

**How do I trade on Bayse Markets?**
1. Send /markets
2. Pick a category (Sports, Entertainment, Crypto, etc.)
3. Pick a market question
4. Tap YES or NO
5. Enter your stake in Naira (minimum ₦100)
6. Your order is placed instantly

**What is /portfolio?**
/portfolio shows all your open Bayse market positions — the markets you've bet on, how many shares you hold, current value, and potential payout if you win. You can also sell any open position early from the portfolio screen to lock in profits or cut losses.

**Can I sell my position before the market resolves?**
Yes. Open /portfolio, find the position, and tap the Sell button. You'll receive the current market value of your shares back to your bot balance. The sale price depends on current market conditions — it may be more or less than what you staked.

**What does "shares" mean in Bayse Markets?**
When you bet on a market, you buy shares. Each share pays out ₦100 if your side wins. The price of a share reflects the probability — e.g. a YES share at ₦34 means traders think there's a 34% chance YES wins. If YES wins, each share pays ₦100, so you'd profit ₦66 per share.

**What categories of markets are available?**
Sports, Entertainment, Crypto, Politics, and more. The bot shows the top 3 most liquid markets per category. Markets are sourced live from Bayse Markets and update in real time.

**What is /connectbayse?**
/connectbayse lets you link your personal Bayse Markets account to the bot. Once connected, all your trades are placed directly from your own Bayse account instead of the shared bot account. This gives you full ownership of your positions on Bayse. To connect: send /connectbayse, enter your Bayse email, then your password (deleted immediately for security). The bot creates an API key on your account automatically.

**Do I need a Bayse account to use /markets?**
No. By default, trades are placed through the bot's shared account and tracked in your personal portfolio inside the bot. You only need to connect your own Bayse account if you want direct ownership of positions on Bayse's platform.

**What is the Fantasy BTC Arena game?**
The Fantasy Arena is a competitive trading game. You pay an entry fee (or use the free trial), get virtual funds, and compete against other players and AI bots over 1–24 hours. Each 15-minute round you decide if BTC will go UP or DOWN. The player with the highest virtual balance at the end wins real USDC from the prize pool.

**Can I try the arena for free?**
Yes. Every new user gets one free trial arena — no deposit needed. You get $1,000 virtual funds to trade for 1 hour against AI bots. Use /league to find the free trial option.

**What are the AI bots in the arena?**
The bots are automated players with distinct personalities: Phiona 🔥 (aggressive), Danfo_Dave 🛡 (conservative), Fave 🎲 (random), Mallam_Odds 📈 (trend-following), Alhaji_Pump ↩️ (contrarian), and more. They trade automatically each round using live BTC signals.

**How do I put money in the bot?**
Send /fundngn to deposit Naira via bank transfer. You'll get a bank account number — transfer from any Nigerian bank (GTBank, Access, Zenith, OPay, Kuda, etc.). Your USDC balance updates automatically within 2–10 minutes. You can also send USDC directly to your Solana wallet address shown in /wallet.

**How do I withdraw my money?**
- To Nigerian bank account: /offrampngn (minimum $0.50 USDC)
- To any Solana wallet: /withdraw

**Is my money safe?**
Yes. Your USDC is held in your own individual Solana wallet on the blockchain. During arena games you only trade with virtual funds — your real balance is never at risk beyond the entry fee you paid.

**Can I lose more than my entry fee in the arena?**
No. Your entry fee is the maximum you can lose. All arena trading uses virtual funds.

**How are arena prizes split?**
After 8% platform commission: 1 player = 100%, 2 players = 60%/40%, 3+ players = 50%/30%/20%.

**How long do arenas last?**
Free trial: 1 hour (4 rounds). Real money arenas: up to 24 hours (~96 rounds).

**How do I create or join an arena?**
- Create: /league create [fee] e.g. /league create 5
- Join: /league join [code]
- Leaderboard: /league board [code]

**What is the minimum to start?**
Minimum arena entry fee is $0.50. Minimum Bayse market bet is ₦100 (roughly $0.06). Minimum withdrawal is $0.50 USDC.

**How is this not gambling?**
The arena is a skill-based competitive game — you compete against other players, not a house. Bayse Markets are prediction markets where prices reflect collective probability, not fixed odds set by a bookmaker.

---

COMMANDS REFERENCE:
/start — open the bot, see your balance
/markets — browse and trade live Bayse prediction markets
/portfolio — view your open Bayse positions, sell early
/connectbayse — link your personal Bayse account
/league — browse and manage fantasy arenas
/league create [fee] — create a new arena
/league join [code] — join an arena
/league board [code] — arena leaderboard
/wallet — your Solana wallet address and balance
/fundngn — deposit Naira via bank transfer
/offrampngn — withdraw to Nigerian bank account
/withdraw — withdraw USDC to any Solana wallet
/chart — live BTC price chart

---

ESCALATION:
If a user asks about a specific transaction, balance discrepancy, failed deposit, or anything you cannot answer with certainty, always say:
"For this I'd recommend reaching out to @bioduncrypt directly — he can look into your specific account and sort it out quickly."

Never guess about a user's specific balance, trade history, or transaction status.
Never promise specific returns or guarantee winnings.
Never make up information that is not in this knowledge base.`;

const FALLBACK = "I'm having trouble right now. Please try again or contact @bioduncrypt.";
const RATE_LIMIT_MSG = "You're on a roll! 😄 Take a short break and come back in an hour, or reach @bioduncrypt directly.";
const RATE_LIMIT = 20;
const RATE_TTL = 3600;
const HISTORY_TTL = 7200;
const HISTORY_MAX = 20; // 10 pairs

async function checkSupportRateLimit(telegramId: number): Promise<boolean> {
  const key = `support:ratelimit:${telegramId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_TTL);
    return count <= RATE_LIMIT;
  } catch {
    return true;
  }
}

async function loadHistory(telegramId: number): Promise<ModelMessage[]> {
  try {
    const raw = await redis.get(`support:history:${telegramId}`);
    return raw ? (JSON.parse(raw) as ModelMessage[]) : [];
  } catch {
    return [];
  }
}

async function saveHistory(telegramId: number, messages: ModelMessage[]): Promise<void> {
  try {
    const trimmed = messages.slice(-HISTORY_MAX);
    await redis.set(`support:history:${telegramId}`, JSON.stringify(trimmed), "EX", HISTORY_TTL);
  } catch {
    // fail silently
  }
}

function buildTools(telegramId: number) {
  return {
    getBalance: tool({
      description: "Get the user's current USDC wallet balance in the bot",
      inputSchema: z.object({ _: z.string().optional() }),
      execute: async () => {
        const balance = await getBalance(telegramId);
        return { balance_usdc: balance };
      },
    }),

    getWalletAddress: tool({
      description: "Get the user's Solana wallet address and USDC token account",
      inputSchema: z.object({ _: z.string().optional() }),
      execute: async () => {
        const w = await getFantasyWalletByTelegramId(telegramId);
        if (!w) return { error: "No wallet found" };
        return { owner_address: w.owner_address, usdc_ata: w.usdc_ata };
      },
    }),

    getActiveArenas: tool({
      description: "Get arenas the user is currently a member of (open or active)",
      inputSchema: z.object({ _: z.string().optional() }),
      execute: async () => {
        const { data } = await supabase
          .from("fantasy_game_members")
          .select("game_id, virtual_balance, wins, losses, fantasy_games(code, status, entry_fee, prize_pool, end_at)")
          .eq("telegram_id", telegramId);
        return (data ?? [])
          .filter((r: any) => ["open", "active"].includes(r.fantasy_games?.status))
          .map((r: any) => ({
            code: r.fantasy_games?.code,
            status: r.fantasy_games?.status,
            entry_fee: r.fantasy_games?.entry_fee,
            prize_pool: r.fantasy_games?.prize_pool,
            end_at: r.fantasy_games?.end_at,
            my_virtual_balance: r.virtual_balance,
            my_wins: r.wins,
            my_losses: r.losses,
          }));
      },
    }),

    getArenaLeaderboard: tool({
      description: "Get the top 10 leaderboard for a specific arena by its code",
      inputSchema: z.object({ code: z.string().describe("The arena code e.g. ABC123") }),
      execute: async ({ code }) => {
        const { data: game } = await supabase
          .from("fantasy_games")
          .select("id")
          .eq("code", code.toUpperCase())
          .maybeSingle();
        if (!game) return { error: "Arena not found" };
        const { data } = await supabase
          .from("fantasy_game_members")
          .select("telegram_id, username, virtual_balance, wins, losses")
          .eq("game_id", game.id)
          .order("virtual_balance", { ascending: false })
          .limit(10);
        return (data ?? []).map((r: any, i: number) => ({
          rank: i + 1,
          username: r.username ?? `user_${r.telegram_id}`,
          virtual_balance: r.virtual_balance,
          wins: r.wins,
          losses: r.losses,
        }));
      },
    }),

    getRecentTrades: tool({
      description: "Get the user's last 5 trades in a specific arena",
      inputSchema: z.object({ code: z.string().describe("The arena code") }),
      execute: async ({ code }) => {
        const { data: game } = await supabase
          .from("fantasy_games")
          .select("id")
          .eq("code", code.toUpperCase())
          .maybeSingle();
        if (!game) return { error: "Arena not found" };
        const { data } = await supabase
          .from("fantasy_trades")
          .select("direction, stake, outcome, payout, created_at")
          .eq("telegram_id", telegramId)
          .eq("game_id", game.id)
          .order("created_at", { ascending: false })
          .limit(5);
        return (data ?? []).map((r: any) => ({
          direction: r.direction,
          stake: r.stake,
          outcome: r.outcome,
          pnl: r.outcome === "WIN" ? r.payout - r.stake : r.outcome === "LOSS" ? -r.stake : 0,
          created_at: r.created_at,
        }));
      },
    }),

    getDepositHistory: tool({
      description: "Get the user's last 5 USDC deposits",
      inputSchema: z.object({ _: z.string().optional() }),
      execute: async () => {
        const { data } = await supabase
          .from("fantasy_wallet_deposits")
          .select("amount, created_at")
          .eq("telegram_id", telegramId)
          .order("created_at", { ascending: false })
          .limit(5);
        return data ?? [];
      },
    }),

    getWithdrawalHistory: tool({
      description: "Get the user's last 5 withdrawal requests",
      inputSchema: z.object({ _: z.string().optional() }),
      execute: async () => {
        const { data } = await supabase
          .from("fantasy_wallet_withdrawals")
          .select("amount, status, requested_at")
          .eq("telegram_id", telegramId)
          .order("requested_at", { ascending: false })
          .limit(5);
        return data ?? [];
      },
    }),
  };
}

export async function handleSupportQuestion(
  question: string,
  telegramId: number
): Promise<string> {
  const allowed = await checkSupportRateLimit(telegramId);
  if (!allowed) return RATE_LIMIT_MSG;

  const apiKey = config.GROQ_API_KEY;
  if (!apiKey) return FALLBACK;

  try {
    const history = await loadHistory(telegramId);
    const messages: ModelMessage[] = [...history, { role: "user", content: question }];

    const groq = createGroq({ apiKey });
    const { text } = await generateText({
      model: groq("llama-3.3-70b-versatile"),
      system: SYSTEM_PROMPT,
      messages,
      tools: buildTools(telegramId),
      stopWhen: stepCountIs(5),
      maxOutputTokens: 300,

    });

    const reply = text.trim() || FALLBACK;
    await saveHistory(telegramId, [...messages, { role: "assistant", content: reply }]);
    return reply;
  } catch (error) {
    console.error("[support] error:", error instanceof Error ? error.message : String(error));
    return FALLBACK;
  }
}
