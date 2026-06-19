# Agent Handoff — HeadlineOdds Arena

**Date:** 2026-06-19  
**Handoff reason:** context limit approaching  
**Next agent should pick up from:** Spec 1 Task 4 (24h delta indicators) and Spec 2 Task 7 (automated tests)

---

## What was done this session

### Spec 2 — World Cup Balance Routing Fix ✅ MOSTLY COMPLETE

**Root cause confirmed:** Two bugs combined to break WC trades:
1. `worldcup-notifier.ts` was routing the "Trade Now" button to `bm:cat:SPORTS` instead of `bm:cat:WORLD CUP` — users never reached WC screens.
2. The `bm:bet:` callback had no guard for missing Bayse credentials — users without a connected account would silently fail at the amount-input step.

**Changes made:**

| File | Change |
|------|--------|
| `src/worldcup-notifier.ts` | Both keyboard buttons (update blast + daily digest) now point to `"bm:cat:WORLD CUP"` |
| `src/bot/handlers/league.ts` | Added `CATEGORY_BALANCE_SOURCE` config map + exported `getBalanceSource(category)` resolver |
| `src/bot/handlers/league.ts` | `bm:bet:` callback now calls `getBalanceSource` and shows "connect your Bayse account" prompt when user has no credentials (instead of falling through to silent failure) |
| `src/bot/handlers/balance-routing.test.ts` | New test file — 4 tests covering Sports, World Cup, Crypto, and unknown categories — all expect `connected_base_market_balance` |

**Still needed (Spec 2):**
- [ ] Task 7: Install deps (`pnpm install`) and run `npm test` to confirm `balance-routing.test.ts` passes
- [ ] Task 8: Audit DB for any existing WC positions under old in-bot-balance path (check `prediction_market_bets` table for WC market IDs)
- [ ] Task 9-10: Staging + prod deploy + monitor

---

### Spec 1 — Jupiter-Style Market UI ✅ SCREENS A/B/C BUILT

**Changes made:**

| File | Change |
|------|--------|
| `src/bot/handlers/league.ts` | Added `buildTrendingText` + `buildTrendingKeyboard` (Screen A) |
| `src/bot/handlers/league.ts` | Added `buildMarketOverviewText` + `buildMarketOverviewKeyboard` (Screen B) |
| `src/bot/handlers/league.ts` | Added `buildOutcomeDetailText` + `buildOutcomeDetailKeyboard` (Screen C) |
| `src/bot/handlers/league.ts` | `handleMarketsCallback` now handles `jm:trending:`, `jm:overview:`, `jm:detail:` callbacks |
| `src/bot/handlers/league.ts` | `bm:cat:WORLD CUP` now routes into Screen B (market overview) for top WC event instead of old `buildWcPage` |
| `src/bot/handlers/league.ts` | Added exported `handleTrending` command handler |
| `src/bot/handlers/league.ts` | Start keyboards (`buildStartWelcomeKeyboard`, `buildStartOnboardingKeyboard`) now include "🔥 Trending" button → `jm:trending:1` |
| `src/index.ts` | Registered `bot.command("trending", wrap(handleTrending))` |
| `src/index.ts` | Registered `bot.callbackQuery(/^jm:/, wrap(handleMarketsCallback))` |

**Navigation flow now:**
```
/start or /trending
  → Screen A: 🔥 Trending (numbered list, paginated, quick-jump [1][2][3][4][5])
      → tap number → Screen B: Market Overview (outcomes ranked, More/Back)
          → tap outcome row → Screen C: Outcome Detail (prices, stats, timeline, top traders)
              → [🟢 YES] / [🔴 NO] → amount input (Bayse path)
              → [← Back] → returns to Screen B at same page

/markets → Categories picker
  → World Cup → Screen B directly (top liquidity WC event)
  → Sports/Crypto/etc → existing market list
```

**Still needed (Spec 1):**
- [x] Task 4: 24h price-delta (▲/▼) on Screen B — **DONE**. Redis snapshot approach: `snapshotMarketPrices()` fires on every fresh Bayse fetch, storing `bayse:snap:<marketId>` with 25h TTL + NX flag (only sets on first fetch). `get24hDelta()` reads snapshot and shows `▲ ₦N` / `▼ ₦N` inline next to YES price. No snapshot = silent omit.
- [ ] Task 7: Point "Today's Markets" pinned message (if any) at new Screen B template
- [ ] Task 8: QA pass — side-by-side with Jupiter Predict Bot screenshots
- [ ] Task 9: Regression test non-WC categories are unaffected

---

## Codebase orientation

```
src/
  index.ts                    — Bot entry, all command + callback registrations
  bot/handlers/league.ts      — ALL bot UI: 4500+ lines, all screens live here
  bot/handlers/balance-routing.test.ts  — NEW: balance source tests
  bayse-trading.ts            — Bayse API client (listBayseEvents, placeBayseOrder, etc.)
  bayse-market.ts             — BTC 15m round/pricing helpers
  worldcup-notifier.ts        — Daily WC digest + update blast scheduler
  prediction-market.ts        — Legacy in-bot prediction market (NOT used for WC anymore)
  fantasy-league.ts           — Arena game logic
  db/balances.ts              — In-bot USDC balance (getBalance, debitBalance, creditBalance)
  db/bayse-credentials.ts     — getBayseCredentials, saveBayseCredentials
```

**Key callback prefixes:**
- `bm:` — markets/categories/bet flow (existing)
- `jm:` — Jupiter-style screens A/B/C (new this session)
- `flt:` — fantasy league trade
- `arena:` / `start:` / `wallet:` — arena/wallet UI

**Redis keys used by new code:**
- `bayse:mkt:<shortKey>` → `eventId:marketId` (8-char shortKey, 1h TTL) — existing, reused by Screen C
- `bayse:bet:<telegramId>` → pending bet state (5m TTL)
- `bayse:bet:custom:<telegramId>` → awaiting amount input flag

**Environment:** Node 24, TypeScript, grammy bot framework, Supabase (Postgres), Redis, Bayse Markets API, PajCash, Solana

---

## How to run

```bash
pnpm install          # first time
npm run dev           # local dev with tsx watch
npm test              # vitest run (needs deps installed)
npm run typecheck     # tsc --noEmit
```

Deploy: fly.io via `fly deploy` (see `FLY_IO_DEPLOY.md`)

---

## Immediate next actions for next agent

1. `pnpm install` to restore node_modules
2. `npm test` — confirm `balance-routing.test.ts` passes (4 tests)
3. `npm run typecheck` — confirm no TS errors in new code
4. Implement 24h delta for Screen B (see Task 4 options above — Redis snapshot approach is simplest)
5. Deploy to staging and run end-to-end WC trade test
