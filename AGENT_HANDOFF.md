# HeadlineOdds Arena — Agent Handoff Codex

## Project
Telegram bot (grammy + TypeScript + Supabase + Solana USDC) for BTC prediction arenas.
Repo: https://github.com/AbiodunCreatives/HeadlineOdds-Arena
Stack: Node.js, TypeScript, pnpm, Supabase (Postgres), Redis, Solana, Render (hosting)

---

## What was built in this session

### 1. Free Trial Arena (`migrations/004_free_trial_hlo_points.sql`)
- `is_free_trial BOOLEAN` column on `fantasy_games`
- `hlo_points` table: `(telegram_id, amount, reason, reference_id, created_at)`
- `create_free_trial_game` SQL RPC — inserts game + member, entry_fee=0, no wallet debit
- `join_free_trial_game` SQL RPC — joins free trial game, no wallet debit

### 2. AI Arena Bots (`migrations/005_ai_arena_bots.sql`)
- `is_bot BOOLEAN` on `fantasy_users`
- `ai_arena_bots` table: `(telegram_id, display_name, style)`
- 5 bots seeded with negative telegram_ids (-1001 to -1005):

| telegram_id | Name | Style |
|---|---|---|
| -1001 | Phiona | aggressive |
| -1002 | Danfo_Dave | conservative |
| -1003 | Fave | random |
| -1004 | Mallam_Odds | trend |
| -1005 | Alhaji_Pump | contrarian |

### 3. Key source files added/modified

| File | What changed |
|---|---|
| `src/agent-signals.ts` | NEW — BTC momentum, RSI(14), oddsDrift signals, all [-1,+1] |
| `src/arena-bots.ts` | NEW — bot seeding, Kelly-criterion decision, auto-trade per round |
| `src/db/fantasy.ts` | Added `is_free_trial` to FantasyGame, createFreeTrialGame, joinFreeTrialGame, hasUsedFreeTrial, awardHloPoints, getHloPoints |
| `src/fantasy-game.ts` | Added createFreeTrialArena, joinFreeTrialArena, awardFreeTrialHloPoints |
| `src/fantasy-league.ts` | Re-exports all new functions |
| `src/fantasy-round.ts` | Calls runBotTradesForRound for free trial games each round, passes previousUpPrice |
| `src/bot/handlers/league.ts` | /start shows free trial CTA for users who haven't used it; arena:free_trial callback |
| `scripts/smoke-free-trial.ts` | E2E smoke test (all passing) |

### 4. Free trial flow
1. User hits `/start` → if balance=0 AND never used free trial → free trial welcome screen
2. Taps `🎮 Try Free Arena` → `createFreeTrialArena` → game created, 5 bots seeded
3. Each 15-min round → `processFantasyLeagueRound` → bots auto-trade using live signals
4. Game ends → call `awardFreeTrialHloPoints(telegramId, gameId)` for each real member (250 HLO each)
5. **TODO**: `awardFreeTrialHloPoints` is NOT yet wired into `finalizeFantasyGames` — next agent must do this

### 5. Agent signal architecture (`src/agent-signals.ts`)
```
momentumSignal()   — 4x15m Binance klines slope, normalised to ±1% range
rsiSignal()        — RSI(14) on 15m candles, overbought/oversold mapped to [-1,+1]
oddsDriftSignal()  — upPrice delta vs previous round, capped at ±0.1
composite          — 40% momentum + 30% RSI + 30% oddsDrift
```

### 6. Bot decision logic (`src/arena-bots.ts` — `botDecision`)
Each style uses Kelly criterion for stake sizing:
- **Phiona (aggressive)**: follows signal always, Kelly cap 40%, confidence threshold 0
- **Danfo_Dave (conservative)**: follows signal only if |composite| > 0.3, Kelly cap 10%
- **Fave (random)**: ignores signal, random direction + random stake
- **Mallam_Odds (trend)**: follows signal if |composite| > 0.1, Kelly cap 20%
- **Alhaji_Pump (contrarian)**: fades the signal (bets opposite), Kelly cap 25%

---

## Next steps for the next agent

### Priority 1 — Wire HLO points into game finalization
In `src/fantasy-round.ts`, function `finalizeFantasyGames`:
- After `updateFantasyGame({ status: "completed" })`, loop through real members (filter out bots: `telegram_id > 0`)
- Call `awardFreeTrialHloPoints(member.telegram_id, game.id)` for each
- Import from `./fantasy-league.ts`

```typescript
// In finalizeFantasyGames, after updateFantasyGame completed:
if (completedGame.is_free_trial) {
  for (const member of members.filter(m => m.telegram_id > 0)) {
    await awardFreeTrialHloPoints(member.telegram_id, completedGame.id).catch(console.error);
  }
}
```

### Priority 2 — Player-owned agent arena (paid)
The vision: players pick one of the 5 agents, fund it with USDC, and it competes in a paid arena.

Architecture:
1. Add `agent_style TEXT` column to `fantasy_game_members` — which agent the player chose
2. New Telegram flow: `/start` → `🤖 Agent Arena` → pick style → pay entry → agent trades for you
3. In `processFantasyLeagueRound`, for paid games: check if member has `agent_style` set → call `botDecision` for them automatically
4. Player watches the leaderboard — their agent trades, they win/lose real USDC

Key constraint: agent-owned members still need a real `telegram_id` (the owner's) so they receive settlement messages. The `agent_style` field just means "trade automatically for this member".

### Priority 3 — x402 agent API (developer audience)
Expose REST endpoints so external agents can join arenas and trade autonomously:
- `POST /api/arena/join` — returns 402 with Solana payment payload if not paid
- `POST /api/arena/trade` — place a trade (requires valid arena membership)
- `GET /api/arena/state/:code` — current round pricing + leaderboard

Use `x402-express` middleware (npm package). Each endpoint wraps with:
```typescript
import { paymentMiddleware } from "x402-express";
app.post("/api/arena/join", paymentMiddleware({ amount: entryFee, asset: "USDC", network: "solana" }), handler);
```

### Priority 4 — Signal improvement
Current signals are simple. To improve bot performance:
- Add volume signal: Binance 15m volume spike = momentum confirmation
- Add funding rate signal: Binance perpetual funding rate (positive = longs paying = bearish)
- Add VWAP deviation: price vs VWAP = mean reversion signal
- Backtest: run `scripts/smoke-free-trial.ts` style test against historical Binance data

---

## Running the project
```bash
pnpm install
npx tsc --noEmit          # type check
npx tsx scripts/smoke-free-trial.ts  # e2e smoke test
```

## DB migrations to apply (in order)
```
migrations/001_fantasy_safety.sql
migrations/002_revenue_idempotency.sql
migrations/003_prize_ledger_idempotency.sql
migrations/004_free_trial_hlo_points.sql   ← NEW this session
migrations/005_ai_arena_bots.sql           ← NEW this session
```

## Environment variables (see .env.example)
All required vars are documented. Key ones:
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — Postgres
- `REDIS_URL` — Redis (or `REDIS_MODE=memory` for local)
- `BOT_TOKEN` — Telegram bot token
- `SOLANA_*` — treasury wallet + RPC

## Commit history (this session)
- `bce988a` — feat: free trial arena + AI bot players
- `2a1f23e` — fix: show free trial button for all users who haven't used it yet
- (pending) — feat: signal-based agent training with Kelly criterion
