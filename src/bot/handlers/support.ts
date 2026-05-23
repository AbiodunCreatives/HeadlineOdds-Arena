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
HeadlineOdds Arena is a fantasy BTC trading game on Telegram. You can start with a free trial arena (no deposit needed) or pay an entry fee for real money arenas. You get virtual funds to trade with and compete against other players and AI bots over 1-24 hours trading 15-minute BTC price markets. The player with the highest virtual bankroll at the end wins real USDC from the prize pool. Think of it like fantasy football but for crypto markets.

**Can I try it for free before depositing money?**
Yes! Every new user gets one free trial arena. No deposit required — just tap "Free Trial" in the bot. You get $1,000 virtual funds to trade for 1 hour against 10 AI bots with different strategies. It's the perfect way to learn how the game works before playing with real money.

**What are the AI bots and how do they trade?**
The AI bots are automated players with distinct trading personalities. There are 10 different bots: Phiona 🔥 (aggressive), Danfo_Dave 🛡 (conservative), Fave 🎲 (random), Mallam_Odds 📈 (trend-following), Alhaji_Pump ↩️ (contrarian), Razor 🔪 (scalper), Bullet 🚀 (momentum-only), Bouncer 🏀 (mean-revert), Bookman 📖 (odds-follower), and Zen 🧘 (balanced). They analyze market signals and make trades automatically each round, giving you consistent competition.

**Do the AI bots have an unfair advantage?**
No. The AI bots use the same market data you see and make the same YES/NO decisions you do. They follow programmed strategies but can't predict the future any better than humans. In fact, human players often outperform the bots because you can adapt and use intuition while the bots stick to their rigid strategies.

**What happens after I complete my free trial?**
You earn 50 HLO points for completing your first arena, regardless of your ranking. These points unlock future features and rewards. You can then join real money arenas starting at just $1 entry fee to compete for actual USDC prizes.

**How long do arenas last?**
Free trial arenas last 1 hour with 4 trading rounds. Real money arenas last 24 hours with roughly 96 trading rounds. You can check the exact duration when creating or joining an arena.

**Can I create my own arena with friends?**
Yes! Use /league create [fee] to create an arena with any entry fee from $1 to $100. Share the arena code with friends so they can join. You can also join free trial arenas that other players create — no deposit needed.

**Do I need to know about crypto to play?**
No. You do not need any crypto knowledge to get started. You deposit naira from your Nigerian bank account, the bot handles everything else. The only decision you make each round is whether BTC will go UP or DOWN in the next 15 minutes — anyone can do that.

**Is this gambling or is it a game?**
It is a skill-based competitive game, not gambling. You are not betting against a house. You are competing against other players. Your entry fee is fixed and that is the maximum you can lose. The winner is the person who makes the best trading decisions over 24 hours, not the luckiest person on one bet.

**Is my money safe in this bot?**
Yes. Every user has their own individual Solana USDC wallet inside the bot. Your real money only moves twice — when you pay your entry fee and when you receive your winnings. During the game you only trade with virtual funds, not real money. Your deposit sits in your personal wallet until you withdraw it.

**How do I know this is not a scam?**
HeadlineOdds Arena is built by a Superteam Nigeria member, featured in the SuperteamNG Nigerian Solana ecosystem recap, and submitted to the Colosseum Frontier Hackathon. The naira onramp is powered by Paj Cash, a legitimate Nigerian crypto onramp. Real users have deposited real naira and withdrawn real USDC. You can verify activity on Solscan using your wallet address from the /wallet command.

**How do I put money in the bot?**
Send /fundngn in the bot to deposit naira. You will receive a bank account number to transfer to. Once your transfer is confirmed by Paj Cash, your USDC balance updates automatically inside the bot. You can also send USDC directly to your Solana wallet address shown in /wallet.

**Can I deposit with my GTBank or Access Bank account?**
Yes. Any Nigerian bank account works — GTBank, Access Bank, First Bank, Zenith, OPay, Kuda, and all major Nigerian banks. Send /fundngn to get your deposit account details and transfer from any bank you use.

**What is the minimum amount I need to start?**
The minimum entry fee is $1 which is roughly ₦1,500 to ₦1,600 at current rates. You need at least that amount in your bot balance to join an arena. There is no maximum deposit limit.

**How long does it take for my naira deposit to show up?**
Usually between 2 and 10 minutes after your bank transfer completes. Paj Cash processes the conversion from naira to USDC and the bot credits your balance automatically. If it takes longer than 15 minutes tap Refresh deposits in the bot or contact @bioduncrypt.

**How do I withdraw my winnings back to my bank account?**
Send /offrampngn to withdraw your USDC winnings directly to your Nigerian bank account in naira. You will need a minimum of 0.50 USDC to offramp. Enter your bank details, confirm the amount, and the naira will arrive in your account. You can also withdraw USDC directly to any Solana wallet using /withdraw.

**What is a 15-minute BTC market and how do I trade it?**
Every 15 minutes a new BTC price market opens. The market asks one question: will BTC be above or below a target price when this 15-minute window closes? You pick YES it will be above or NO it will be below, choose how much of your virtual funds to stake, and wait for the result. That is one round. An arena runs for 24 hours so you get roughly 96 rounds to grow your virtual bankroll.

**What does YES and NO mean when I am trading?**
YES means you think BTC will be at or above the target price when the round closes. NO means you think BTC will be below the target price. The price shown in the round prompt tells you the probability — for example YES at 34 cents means traders think there is a 34% chance BTC goes up. If you are right you win a payout proportional to your stake and the odds.

**What happens if I miss a round and don't trade?**
Nothing bad happens. Your virtual balance stays the same for that round. You simply do not earn or lose anything. The next round opens in 15 minutes and you can trade then. Missing rounds does hurt your ranking if other players are actively trading and growing their bankrolls, so try to trade as many rounds as you can.

**How is the winner decided at the end of an arena?**
The player with the highest virtual balance when the 24-hour arena ends wins first place. If two players have the same balance, the one with the higher trade accuracy wins. Prize splits are: 1 player gets 100%, 2 players get 60% and 40%, 3 or more players get 50%, 30%, and 20%.

**Can I lose more than my entry fee?**
No. Your entry fee is the maximum you can ever lose. All trading during the arena uses virtual funds, not real money. Even if your virtual balance drops to zero you only lose the entry fee you paid to join. Your other balance in the bot is completely safe.

**How much can I win from a $1 arena?**
It depends on how many players join. With 10 players in a $1 arena the net prize pool is $9.20 after 8% platform commission. First place wins $4.60, second wins $2.76, third wins $1.84. The more players who join, the bigger the prize pool. You can check the current prize pool at any time with /league board [code].

**When do I get paid after an arena ends?**
Payouts are processed automatically within minutes of the arena ending. Your winnings are credited directly to your bot wallet balance. You will receive a settlement message showing your final rank, payout amount, and confirmation that it has been added to your balance.

**Why did I not get the full prize pool when I won?**
The platform takes an 8% commission from the gross prize pool before distributing prizes. This covers operational costs. The prize pool shown in the bot is always the net amount after commission so what you see is what you get. There are no hidden fees beyond the 8% commission.

**Can I play alone or do I need other players to join?**
You can create an arena alone. If no one joins, you play solo for 24 hours and receive the net prize pool back minus the 8% commission. It is better with more players because the prize pool grows with each entry fee and the competition makes it more exciting.

**What happens to my money if the bot goes down or crashes?**
Your USDC is held in your individual Solana wallet on the blockchain, not inside the bot. Even if the bot goes offline your funds are safe and accessible. When the bot comes back online your balance will be exactly as you left it. For any urgent issues contact @bioduncrypt directly.

---

COMMANDS REFERENCE:
/start — open the bot and see your balance
/league — browse and manage arenas (includes free trial option)
/league create [fee] — create a new arena e.g. /league create 5
/league join [code] — join an arena with a code (works for free trials too)
/league board [code] — see the leaderboard for an arena
/wallet — see your USDC wallet address and balance
/fundngn — deposit naira via Paj Cash (not needed for free trial)
/offrampngn — withdraw winnings to your Nigerian bank account
/withdraw — withdraw USDC to any Solana wallet
/chart — open the live BTC price chart

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
