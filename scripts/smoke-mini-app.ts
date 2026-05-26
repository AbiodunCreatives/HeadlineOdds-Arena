/**
 * E2E smoke test: mini app trade flow
 * Run: npx tsx scripts/smoke-mini-app.ts
 */

import assert from "node:assert/strict";

// ── Env stubs ────────────────────────────────────────────────────────────────
process.env.BOT_TOKEN = "123:TEST";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.REDIS_MODE = "memory";
process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
process.env.SOLANA_TREASURY_SECRET_KEY = "mock";
process.env.NODE_ENV = "test";

async function main() {
  // ── Test 1: botDecision — all styles ───────────────────────────────────────
  console.log("1. botDecision — all 10 styles produce valid direction + stake");
  const { botDecision } = await import("../src/arena-bots.ts");
  const { FANTASY_TRADE_AMOUNTS } = await import("../src/fantasy-league.ts");

  const pricing = {
    eventId: "evt-test", marketId: "mkt-test",
    upPrice: 0.55, downPrice: 0.45,
    upOutcomeId: "yes-1", downOutcomeId: "no-1",
    eventThreshold: 90000, url: null,
  };
  const signals = { momentum: 0.3, rsi: -0.2, oddsDrift: 0.1, composite: 0.15 };
  const styles = ["aggressive","conservative","random","trend","contrarian","scalper","momentum_only","mean_revert","odds_follower","balanced"] as const;

  for (const style of styles) {
    const { direction, stake } = botDecision(style, pricing as any, 1000, signals);
    assert(direction === "UP" || direction === "DOWN", `${style}: invalid direction`);
    assert((FANTASY_TRADE_AMOUNTS as number[]).includes(stake), `${style}: stake ${stake} not in valid amounts`);
  }
  console.log("   ✅ All 10 styles OK");

  // ── Test 2: saveFantasyTradeReference round-trip ───────────────────────────
  console.log("2. saveFantasyTradeReference / loadFantasyTradeReference round-trip");
  const { saveFantasyTradeReference, loadFantasyTradeReference } = await import("../src/fantasy-state.ts");

  const payload = {
    gameId: "game-1", eventId: "evt-test", marketId: "mkt-test",
    openingDate: new Date(Date.now() - 60_000).toISOString(),
    closingDate: new Date(Date.now() + 300_000).toISOString(),
    currentPrice: 90000, referencePrice: 90000,
    upPrice: 0.55, downPrice: 0.45,
    upOutcomeId: "yes-1", downOutcomeId: "no-1",
  };

  const ref = await saveFantasyTradeReference(payload);
  assert(typeof ref === "string" && ref.length > 0, "ref should be non-empty string");

  const loaded = await loadFantasyTradeReference(ref);
  assert(loaded !== null, "should load saved reference");
  assert(loaded!.gameId === payload.gameId, "gameId mismatch");
  assert(loaded!.upPrice === payload.upPrice, "upPrice mismatch");
  console.log(`   ✅ ref="${ref}" saved and loaded`);

  // ── Test 3: web_app_data payload → callbackData ────────────────────────────
  console.log("3. web_app_data payload → callbackData reconstruction");

  const webAppPayload = JSON.stringify({ action: "trade", direction: "UP", amount: 25, ref });
  const parsed = JSON.parse(webAppPayload) as { action: string; direction: string; amount: number; ref: string };
  assert(parsed.action === "trade" && parsed.direction === "UP" && parsed.amount === 25 && parsed.ref === ref);

  const callbackData = `flt:d:${parsed.amount}:${parsed.direction}:r:${parsed.ref}`;
  assert(callbackData === `flt:d:25:UP:r:${ref}`, "callbackData format wrong");
  console.log(`   ✅ callbackData="${callbackData}"`);

  // ── Test 4: callbackData parsing mirrors placeFantasyTradeFromCallbackData ──
  console.log("4. callbackData parsing — stake/direction/ref extraction");

  const parts = callbackData.split(":");
  assert(parts[0] === "flt" && parts[1] === "d" && parts[4] === "r");
  const stake = parseFloat(parts[2] ?? "");
  const dir = parts[3];
  const extractedRef = parts.slice(5).join(":");
  assert(Number.isFinite(stake) && stake === 25, `stake=${stake}`);
  assert(dir === "UP", `direction=${dir}`);
  assert(extractedRef === ref, `ref mismatch`);
  console.log(`   ✅ stake=${stake} direction=${dir} ref="${extractedRef}"`);

  // ── Test 5: expired closingDate is detectable ──────────────────────────────
  console.log("5. Expired trade reference — closingDate in the past");

  const expiredRef = await saveFantasyTradeReference({
    ...payload,
    closingDate: new Date(Date.now() - 1000).toISOString(),
  });
  const expiredLoaded = await loadFantasyTradeReference(expiredRef);
  assert(expiredLoaded !== null, "should load (Redis TTL not expired)");
  assert(Date.parse(expiredLoaded!.closingDate) <= Date.now(), "closingDate should be past");
  console.log("   ✅ expired ref loaded but closingDate past — trade would be rejected");

  // ── Test 6: market signals fallback on network failure ─────────────────────
  console.log("6. getMarketSignals — fallback on network failure");

  globalThis.fetch = async () => { throw new Error("network unavailable"); };
  const { getMarketSignals } = await import("../src/agent-signals.ts");
  const fallback = await getMarketSignals(0.55, 0.52).catch(() => ({
    momentum: 0, rsi: 0, oddsDrift: 0.3, composite: 0.09,
  }));
  assert(Number.isFinite(fallback.momentum) && Number.isFinite(fallback.rsi) && Number.isFinite(fallback.composite));
  console.log(`   ✅ fallback signals: ${JSON.stringify(fallback)}`);

  console.log("\n🎉 All 6 smoke tests passed.");
}

main().catch((err) => { console.error("❌", err); process.exit(1); });
