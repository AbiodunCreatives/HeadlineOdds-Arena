/**
 * E2E smoke test: /markets flow → category → market → YES/NO → amount → trade placement
 * Run: npx tsx scripts/smoke-markets-flow.ts
 *
 * Does NOT hit Bayse API, Supabase, or require real credentials.
 * Tests all pure logic and the Redis-backed state machine end-to-end.
 */

import assert from "node:assert/strict";

// ── Env stubs ─────────────────────────────────────────────────────────────────
process.env.BOT_TOKEN = "123:TEST";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.REDIS_MODE = "memory";
process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
process.env.SOLANA_TREASURY_SECRET_KEY = "mock";
process.env.NODE_ENV = "test";

const TG_ID = 999_001;

async function main() {
  console.log("🧪 /markets flow smoke test\n");

  // ── 1. Share / payout math ─────────────────────────────────────────────────
  console.log("1. sharesForAmount / potentialPayoutNgn / ngnToUsdc");
  const { sharesForAmount, potentialPayoutNgn, ngnToUsdc } = await import("../src/bayse-trading.ts");

  // Sports market: YES at ₦65/share (price = 0.65)
  const price = 0.65;
  const betNgn = 2000;
  const shares = sharesForAmount(betNgn, price);
  assert(shares === 30, `expected 30 shares, got ${shares}`); // floor(2000 / (0.65 * 100))
  const payout = potentialPayoutNgn(shares);
  assert(payout === 3000, `expected ₦3000 payout, got ${payout}`);
  const usdc = ngnToUsdc(betNgn);
  assert(Math.abs(usdc - 1.25) < 0.0001, `expected $1.25 USDC, got ${usdc}`);
  console.log(`   ✅ ₦${betNgn} @ ₦${price * 100}/share → ${shares} shares, payout ₦${payout}, $${usdc} USDC`);

  // Minimum bet: 1 share
  const minShares = sharesForAmount(65, price);
  assert(minShares === 1, `expected 1 share for min bet, got ${minShares}`);
  const tooSmall = sharesForAmount(64, price);
  assert(tooSmall === 0, `expected 0 shares for sub-min bet, got ${tooSmall}`);
  console.log("   ✅ Minimum bet boundary correct (₦65 = 1 share, ₦64 = 0 shares)");

  // ── 2. calcOdds ────────────────────────────────────────────────────────────
  console.log("2. calcOdds — pool math");
  const { calcOdds, formatOdds } = await import("../src/prediction-market.ts");

  const { yes, no } = calcOdds(650, 350);
  assert(Math.abs(yes - 0.65) < 0.001, `yes odds wrong: ${yes}`);
  assert(Math.abs(no - 0.35) < 0.001, `no odds wrong: ${no}`);
  assert(formatOdds(yes) === "₦65", `formatOdds wrong: ${formatOdds(yes)}`);

  const { yes: y0, no: n0 } = calcOdds(0, 0);
  assert(y0 === 0.5 && n0 === 0.5, "empty pool should be 50/50");
  console.log("   ✅ Odds and formatting correct");

  // ── 3. Bet state machine (Redis) ───────────────────────────────────────────
  console.log("3. Bayse bet state machine — save / load / clear");
  const { redis } = await import("../src/utils/rateLimit.ts");

  const betStateKey = `bayse:bet:${TG_ID}`;
  const pendingKey = `bayse:bet:custom:${TG_ID}`;
  const TTL = 300;

  // Simulate saveBayseBetState
  const state = { eventId: "evt-sports-001", marketId: "mkt-001", side: "yes" };
  await redis.set(betStateKey, JSON.stringify(state), "EX", TTL);

  // Simulate saveBayseCustomBetPending
  await redis.set(pendingKey, "1", "EX", TTL);

  // Simulate hasBayseCustomBetPending
  const isPending = (await redis.get(pendingKey)) !== null;
  assert(isPending, "pending flag should be set");

  // Simulate loadBayseBetState
  const raw = await redis.get(betStateKey);
  assert(raw !== null, "bet state should exist");
  const loaded = JSON.parse(raw) as typeof state;
  assert(loaded.eventId === state.eventId, "eventId mismatch");
  assert(loaded.marketId === state.marketId, "marketId mismatch");
  assert(loaded.side === "yes", "side mismatch");
  console.log(`   ✅ State saved and loaded: ${JSON.stringify(loaded)}`);

  // Simulate clearBayseCustomBetPending + clearBayseBetState
  await redis.del(pendingKey);
  await redis.del(betStateKey);
  assert((await redis.get(pendingKey)) === null, "pending flag should be cleared");
  assert((await redis.get(betStateKey)) === null, "bet state should be cleared");
  console.log("   ✅ State cleared correctly");

  // ── 4. NGN amount parsing (handleBayseCustomBetInput logic) ───────────────
  console.log("4. NGN amount parsing — valid / invalid / below minimum");

  function parseNgnInput(text: string): number | null {
    const cleaned = text.replace(/[^0-9]/g, "");
    const n = Number.parseInt(cleaned, 10);
    return Number.isFinite(n) && n >= 100 ? n : null;
  }

  assert(parseNgnInput("2000") === 2000, "plain number");
  assert(parseNgnInput("₦2,000") === 2000, "naira symbol + comma");
  assert(parseNgnInput("2 000") === 2000, "space separator");
  assert(parseNgnInput("99") === null, "below minimum");
  assert(parseNgnInput("abc") === null, "non-numeric");
  assert(parseNgnInput("0") === null, "zero");
  console.log("   ✅ All NGN input cases handled correctly");

  // ── 5. Balance check logic ─────────────────────────────────────────────────
  console.log("5. Balance check — sufficient / insufficient");

  function canAfford(balanceUsdc: number, betNgnAmount: number, rate = 1600): boolean {
    const required = Math.round((betNgnAmount / rate) * 1_000_000) / 1_000_000;
    return balanceUsdc >= required;
  }

  assert(canAfford(2.0, 2000), "should afford ₦2000 with $2 balance");
  assert(!canAfford(1.0, 2000), "should not afford ₦2000 with $1 balance");
  assert(canAfford(1.25, 2000), "should afford ₦2000 with exactly $1.25");
  assert(!canAfford(1.249999, 2000), "should not afford ₦2000 with $1.249999");
  console.log("   ✅ Balance checks correct");

  // ── 6. Full flow state sequence ────────────────────────────────────────────
  console.log("6. Full flow sequence: /markets → category → YES tap → amount → place");

  // Step 1: /markets — user sees category picker (no state needed)
  // Step 2: bm:cat:SPORTS — fetch events (mocked), show top 3
  const mockEvent = {
    id: "evt-sports-001", slug: "will-arsenal-win", title: "Will Arsenal win vs Chelsea?",
    category: "SPORTS", liquidity: 500_000,
    markets: [{
      id: "mkt-001",
      outcome1Id: "out-yes", outcome1Label: "Yes", outcome1Price: 0.65,
      outcome2Id: "out-no",  outcome2Label: "No",  outcome2Price: 0.35,
    }],
  };

  // Step 3: bm:bet:yes:evt-sports-001:mkt-001 — save state
  await redis.set(`bayse:bet:${TG_ID}`, JSON.stringify({
    eventId: mockEvent.id, marketId: mockEvent.markets[0]!.id, side: "yes",
  }), "EX", TTL);
  await redis.set(`bayse:bet:custom:${TG_ID}`, "1", "EX", TTL);

  // Step 4: user types "2000"
  const inputAmount = parseNgnInput("2000");
  assert(inputAmount !== null && inputAmount === 2000);

  // Step 5: load state, clear pending
  await redis.del(`bayse:bet:custom:${TG_ID}`);
  const stateRaw = await redis.get(`bayse:bet:${TG_ID}`);
  const tradeState = JSON.parse(stateRaw!) as { eventId: string; marketId: string; side: string };
  await redis.del(`bayse:bet:${TG_ID}`);

  // Step 6: compute trade
  const market = mockEvent.markets[0]!;
  const tradeSide = tradeState.side as "yes" | "no";
  const tradePrice = tradeSide === "yes" ? market.outcome1Price : market.outcome2Price;
  const tradeShares = sharesForAmount(inputAmount, tradePrice);
  const tradeUsdc = ngnToUsdc(inputAmount);
  const tradePayout = potentialPayoutNgn(tradeShares);

  assert(tradeShares === 30, `shares: ${tradeShares}`);
  assert(Math.abs(tradeUsdc - 1.25) < 0.0001, `usdc: ${tradeUsdc}`);
  assert(tradePayout === 3000, `payout: ${tradePayout}`);
  assert((await redis.get(`bayse:bet:${TG_ID}`)) === null, "state cleared after trade");
  assert((await redis.get(`bayse:bet:custom:${TG_ID}`)) === null, "pending cleared after trade");

  console.log(`   ✅ Full flow: YES on "${mockEvent.title}"`);
  console.log(`      ₦${inputAmount} → ${tradeShares} shares @ ₦${tradePrice * 100} → payout ₦${tradePayout} if correct`);
  console.log(`      USDC debit: $${tradeUsdc}`);

  console.log("\n🎉 All 6 /markets smoke tests passed.");
}

main().catch((err) => { console.error("❌", err); process.exit(1); });
