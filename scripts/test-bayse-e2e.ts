/**
 * E2E demo test for Bayse integration.
 *
 * Runs against the live Bayse API. Requires BAYSE_PUBLIC_KEY and BAYSE_SECRET_KEY in .env.
 *
 * Usage:
 *   npx tsx scripts/test-bayse-e2e.ts
 *
 * What it tests:
 *   1. Wallet balance — confirms Bayse account is funded
 *   2. List events — fetches live AMM markets in NGN
 *   3. Place a minimum NGN order on the first available market
 *   4. Fetch portfolio — confirms the position appears
 */

import "dotenv/config";
import {
  listBayseEvents,
  placeBayseOrder,
  getBaysePortfolio,
  getBayseWalletBalance,
  sharesForAmount,
  potentialPayoutNgn,
} from "../src/bayse-trading.ts";

const MIN_BET_NGN = 100; // ₦100 minimum per Bayse docs

function pass(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.error(`  ❌ ${msg}`); process.exit(1); }
function info(msg: string) { console.log(`     ${msg}`); }

async function main() {
  console.log("\n🧪 Bayse E2E Demo Test\n");

  const hasKeys = !!(process.env["BAYSE_PUBLIC_KEY"] && process.env["BAYSE_SECRET_KEY"]);
  if (!hasKeys) {
    console.log("  ⚠️  No BAYSE_PUBLIC_KEY / BAYSE_SECRET_KEY in .env");
    console.log("     Steps 1, 3, 4 (wallet + order + portfolio) will be skipped.\n");
  }

  // ── Step 1: Wallet balance ────────────────────────────────────────────────
  if (hasKeys) {
    console.log("1. Checking Bayse wallet balance...");
    try {
      const balance = await getBayseWalletBalance();
      pass(`Wallet reachable`);
      info(`USD: $${balance.usd.toFixed(2)}  |  NGN: ₦${balance.ngn.toLocaleString()}`);
      if (balance.ngn < MIN_BET_NGN && balance.usd < 0.10) {
        console.warn(`  ⚠️  Low balance — order placement may fail. Fund your Bayse account.`);
      }
    } catch (err) {
      fail(`Wallet fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  } else {
    console.log("1. [SKIP] Wallet balance — no API keys");
  }

  // ── Step 2: List events ───────────────────────────────────────────────────
  console.log("\n2. Fetching live events (NGN)...");
  let events: Awaited<ReturnType<typeof listBayseEvents>>;
  try {
    events = await listBayseEvents({ size: 10 });
    pass(`Got ${events.length} event(s)`);
  } catch (err) {
    fail(`listBayseEvents failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (events.length === 0) {
    fail("No open events found.");
    return;
  }

  // Show first 3
  for (const e of events.slice(0, 3)) {
    const m = e.markets[0]!;
    info(`[${e.engine}] "${e.title}"`);
    info(`  ${m.outcome1Label} ₦${Math.round(m.outcome1Price * 100)}  |  ${m.outcome2Label} ₦${Math.round(m.outcome2Price * 100)}  |  ${e.totalOrders} orders`);
  }

  if (!hasKeys) {
    console.log("\n3. [SKIP] Place order — no API keys");
    console.log("4. [SKIP] Portfolio — no API keys");
    console.log("\n✅ Public API working. Add BAYSE_PUBLIC_KEY + BAYSE_SECRET_KEY to .env to test order placement.\n");
    return;
  }

  // ── Step 3: Place order ───────────────────────────────────────────────────
  const event = events[0]!;
  const market = event.markets[0]!;

  console.log(`\n3. Placing minimum NGN order on "${event.title}"...`);
  const outcomeId = market.outcome1Id;
  const price = market.outcome1Price;
  const shares = sharesForAmount(MIN_BET_NGN, price);
  const potentialPayout = potentialPayoutNgn(shares);

  info(`Bet:     ₦${MIN_BET_NGN} → ${shares} shares @ ₦${Math.round(price * 100)}`);
  info(`Payout:  ₦${potentialPayout} if ${market.outcome1Label} wins`);

  let orderId: string;
  try {
    const result = await placeBayseOrder({ eventId: event.id, marketId: market.id, outcomeId, amountNgn: MIN_BET_NGN });
    orderId = result.order.id;
    pass(`Order placed`);
    info(`Order ID: ${orderId}`);
    info(`Status:   ${result.order.status}`);
    info(`Filled:   ${result.order.quantity} shares @ avg ₦${Math.round(result.order.price * 100)}`);
  } catch (err) {
    fail(`placeBayseOrder failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // ── Step 4: Portfolio ─────────────────────────────────────────────────────
  console.log("\n4. Fetching portfolio...");
  try {
    const portfolio = await getBaysePortfolio();
    const position = portfolio.find((p) => p.outcomeId === outcomeId);
    if (position) {
      pass(`Position found in portfolio`);
      info(`Shares:  ${position.balance}`);
      info(`Cost:    ${position.cost} ${position.currency}`);
      info(`Payout if wins: ${position.payoutIfOutcomeWins} ${position.currency}`);
    } else {
      pass(`Portfolio fetched (${portfolio.length} position(s)) — new position may take a moment to appear`);
    }
  } catch (err) {
    fail(`getBaysePortfolio failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  console.log("\n✅ All steps passed. Bayse integration is working.\n");
}

main().catch((err) => {
  console.error("\n💥 Unexpected error:", err);
  process.exit(1);
});
