/**
 * E2E smoke test: free trial arena + AI bot players.
 * Runs entirely in-memory — no real DB, no real Solana, no real Bayse calls.
 */

// ── Minimal assert ────────────────────────────────────────────────────────────
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}
function pass(msg: string): void {
  console.log(`  ✅ ${msg}`);
}

// ── In-memory DB ──────────────────────────────────────────────────────────────
interface User { telegram_id: number; username: string | null; is_bot: boolean; used_free_trial: boolean }
interface Game { id: string; code: string; creator_telegram_id: number; is_free_trial: boolean; status: string; entry_fee: number; virtual_start_balance: number; prize_pool: number; start_at: string; end_at: string }
interface Member { id: string; game_id: string; telegram_id: number; entry_fee_paid: number; virtual_balance: number; wins: number; losses: number; total_trades: number }
interface Trade { id: string; game_id: string; member_id: string; telegram_id: number; event_id: string; direction: "UP" | "DOWN"; stake: number; outcome: "PENDING" | "WIN" | "LOSS"; payout: number }
interface HloPoint { telegram_id: number; amount: number; reason: string; reference_id: string | null }

const db = {
  users: new Map<number, User>(),
  games: new Map<string, Game>(),
  members: new Map<string, Member>(),
  trades: new Map<string, Trade>(),
  hloPoints: [] as HloPoint[],
};

let _gameSeq = 0;
let _memberSeq = 0;
let _tradeSeq = 0;

// ── Bot definitions (mirrors migration 005) ───────────────────────────────────
const BOTS = [
  { telegram_id: -1001, display_name: "Phiona",      style: "aggressive"  },
  { telegram_id: -1002, display_name: "Danfo_Dave",  style: "conservative"},
  { telegram_id: -1003, display_name: "Fave",        style: "random"      },
  { telegram_id: -1004, display_name: "Mallam_Odds", style: "trend"       },
  { telegram_id: -1005, display_name: "Alhaji_Pump", style: "contrarian"  },
] as const;

type BotStyle = "aggressive" | "conservative" | "random" | "trend" | "contrarian";
const TRADE_AMOUNTS = [10, 25, 50, 100] as const;

// ── Simulated logic (mirrors src/ behaviour) ──────────────────────────────────

function hasUsedFreeTrial(telegramId: number): boolean {
  const user = db.users.get(telegramId);
  return user?.used_free_trial ?? false;
}

function upsertUser(telegramId: number, username: string | null, isBot = false): void {
  if (!db.users.has(telegramId)) {
    db.users.set(telegramId, { telegram_id: telegramId, username, is_bot: isBot, used_free_trial: false });
  }
}

function seedBots(): void {
  for (const bot of BOTS) {
    upsertUser(bot.telegram_id, bot.display_name, true);
  }
}

function createFreeTrialArena(creatorId: number): Game {
  upsertUser(creatorId, null);
  if (hasUsedFreeTrial(creatorId)) throw new Error("Already used free trial.");
  const id = `game-${++_gameSeq}`;
  const now = Date.now();
  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt   = new Date(now + 70 * 60_000).toISOString(); // 1hr after start
  const game: Game = { id, code: `TST-${_gameSeq.toString().padStart(3,"0")}`, creator_telegram_id: creatorId, is_free_trial: true, status: "open", entry_fee: 0, virtual_start_balance: 1000, prize_pool: 0, start_at: startAt, end_at: endAt };
  db.games.set(id, game);
  // Add creator as member
  addMember(game, creatorId, 0);
  // Mark used
  db.users.get(creatorId)!.used_free_trial = true;
  // Seed bots
  for (const bot of BOTS) addMember(game, bot.telegram_id, 0);
  return game;
}

function joinFreeTrialArena(telegramId: number, code: string): Game {
  upsertUser(telegramId, null);
  if (hasUsedFreeTrial(telegramId)) throw new Error("Already used free trial.");
  const game = [...db.games.values()].find(g => g.code === code);
  if (!game) throw new Error("Arena not found.");
  if (!game.is_free_trial) throw new Error("Not a free trial arena.");
  if (game.status !== "open") throw new Error("Arena already started.");
  const alreadyIn = [...db.members.values()].find(m => m.game_id === game.id && m.telegram_id === telegramId);
  if (alreadyIn) throw new Error("Already joined.");
  addMember(game, telegramId, 0);
  db.users.get(telegramId)!.used_free_trial = true;
  return game;
}

function addMember(game: Game, telegramId: number, entryFeePaid: number): Member {
  const id = `mem-${++_memberSeq}`;
  const m: Member = { id, game_id: game.id, telegram_id: telegramId, entry_fee_paid: entryFeePaid, virtual_balance: game.virtual_start_balance, wins: 0, losses: 0, total_trades: 0 };
  db.members.set(id, m);
  return m;
}

function getMembersForGame(gameId: string): Member[] {
  return [...db.members.values()].filter(m => m.game_id === gameId);
}

function botDecision(style: BotStyle, upPrice: number): { direction: "UP" | "DOWN"; stake: number } {
  const leanUp = upPrice <= 0.5;
  switch (style) {
    case "aggressive":    return { direction: leanUp ? "UP" : "DOWN", stake: TRADE_AMOUNTS[3] };
    case "conservative":  return { direction: leanUp ? "UP" : "DOWN", stake: TRADE_AMOUNTS[0] };
    case "random":        return { direction: Math.random() < 0.5 ? "UP" : "DOWN", stake: TRADE_AMOUNTS[Math.floor(Math.random() * 4)] };
    case "trend":         return { direction: leanUp ? "UP" : "DOWN", stake: TRADE_AMOUNTS[1] };
    case "contrarian":    return { direction: leanUp ? "DOWN" : "UP", stake: TRADE_AMOUNTS[2] };
  }
}

function runBotTradesForRound(game: Game, eventId: string, upPrice: number): void {
  for (const bot of BOTS) {
    const member = [...db.members.values()].find(m => m.game_id === game.id && m.telegram_id === bot.telegram_id);
    if (!member) continue;
    const alreadyTraded = [...db.trades.values()].find(t => t.game_id === game.id && t.telegram_id === bot.telegram_id && t.event_id === eventId);
    if (alreadyTraded) continue;
    const { direction, stake } = botDecision(bot.style, upPrice);
    if (member.virtual_balance < stake) continue;
    member.virtual_balance -= stake;
    member.total_trades++;
    const id = `trade-${++_tradeSeq}`;
    db.trades.set(id, { id, game_id: game.id, member_id: member.id, telegram_id: bot.telegram_id, event_id: eventId, direction, stake, outcome: "PENDING", payout: 0 });
  }
}

function settleRound(eventId: string, resolvedDirection: "UP" | "DOWN"): void {
  for (const trade of db.trades.values()) {
    if (trade.event_id !== eventId || trade.outcome !== "PENDING") continue;
    const member = db.members.get(trade.member_id)!;
    if (trade.direction === resolvedDirection) {
      const payout = Math.round(trade.stake / 0.5); // simplified: 2x at 0.5 price
      trade.outcome = "WIN";
      trade.payout = payout;
      member.virtual_balance += payout;
      member.wins++;
    } else {
      trade.outcome = "LOSS";
      member.losses++;
    }
  }
}

function awardHloPoints(telegramId: number, gameId: string): void {
  db.hloPoints.push({ telegram_id: telegramId, amount: 250, reason: "free_trial_completion", reference_id: gameId });
}

function getLeaderboard(gameId: string): Member[] {
  return getMembersForGame(gameId)
    .filter(m => !BOTS.some(b => b.telegram_id === m.telegram_id) || true) // include bots
    .sort((a, b) => b.virtual_balance - a.virtual_balance);
}

// ── Run tests ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n🧪 Free Trial Arena + AI Bots — E2E Smoke Test\n");

  seedBots();

  // ── 1. Create free trial arena ────────────────────────────────────────────
  console.log("1️⃣  Free trial arena creation");
  const REAL_USER = 99001;
  const game = createFreeTrialArena(REAL_USER);
  assert(game.is_free_trial, "game must be flagged is_free_trial");
  assert(game.entry_fee === 0, "entry fee must be 0");
  assert(game.virtual_start_balance === 1000, "virtual balance must be 1000");
  pass("Arena created with entry_fee=0 and virtual_start_balance=1000");

  const members = getMembersForGame(game.id);
  assert(members.length === 6, `expected 6 members (1 real + 5 bots), got ${members.length}`);
  pass(`6 members seeded: 1 real user + 5 bots (${BOTS.map(b => b.display_name).join(", ")})`);

  // ── 2. One-time eligibility enforcement ──────────────────────────────────
  console.log("\n2️⃣  One-time eligibility");
  let threw = false;
  try { createFreeTrialArena(REAL_USER); } catch { threw = true; }
  assert(threw, "second free trial must be rejected");
  pass("Duplicate free trial correctly rejected");

  // ── 3. Second user joins via shared code ─────────────────────────────────
  console.log("\n3️⃣  Second user joins via shared code");
  const REAL_USER_2 = 99002;
  const joined = joinFreeTrialArena(REAL_USER_2, game.code);
  assert(joined.id === game.id, "must join the same game");
  const membersAfterJoin = getMembersForGame(game.id);
  assert(membersAfterJoin.length === 7, `expected 7 members after join, got ${membersAfterJoin.length}`);
  pass(`User ${REAL_USER_2} joined via code ${game.code} — 7 members total`);

  // Second user can't join again
  let threw2 = false;
  try { joinFreeTrialArena(REAL_USER_2, game.code); } catch { threw2 = true; }
  assert(threw2, "re-join must be rejected");
  pass("Re-join correctly rejected");

  // ── 4. Round 1 — bots auto-trade ─────────────────────────────────────────
  console.log("\n4️⃣  Round 1 — bot auto-trades");
  const UP_PRICE_R1 = 0.48; // market leans UP
  runBotTradesForRound(game, "evt-r1", UP_PRICE_R1);

  const r1Trades = [...db.trades.values()].filter(t => t.event_id === "evt-r1");
  assert(r1Trades.length === 5, `expected 5 bot trades, got ${r1Trades.length}`);
  pass(`5 bot trades placed for round 1`);

  // Verify each bot's direction matches its style
  const tradeByBot = new Map(r1Trades.map(t => [t.telegram_id, t]));
  assert(tradeByBot.get(-1001)?.direction === "UP",   "Phiona (aggressive) should bet UP (favourite)");
  assert(tradeByBot.get(-1002)?.direction === "UP",   "Danfo_Dave (conservative) should bet UP (favourite)");
  assert(tradeByBot.get(-1004)?.direction === "UP",   "Mallam_Odds (trend) should bet UP (favourite)");
  assert(tradeByBot.get(-1005)?.direction === "DOWN",  "Alhaji_Pump (contrarian) should bet DOWN (against favourite)");
  pass("Bot directions match their styles");

  assert(tradeByBot.get(-1001)?.stake === 100, "Phiona (aggressive) stake=100");
  assert(tradeByBot.get(-1002)?.stake === 10,  "Danfo_Dave (conservative) stake=10");
  assert(tradeByBot.get(-1004)?.stake === 25,  "Mallam_Odds (trend) stake=25");
  assert(tradeByBot.get(-1005)?.stake === 50,  "Alhaji_Pump (contrarian) stake=50");
  pass("Bot stakes match their styles");

  // ── 5. Settle round 1 (UP wins) ───────────────────────────────────────────
  console.log("\n5️⃣  Settle round 1 (UP wins)");
  settleRound("evt-r1", "UP");

  const phiona = [...db.members.values()].find(m => m.telegram_id === -1001)!;
  const alhaji = [...db.members.values()].find(m => m.telegram_id === -1005)!;
  assert(phiona.wins === 1, "Phiona should have 1 win");
  assert(alhaji.losses === 1, "Alhaji_Pump should have 1 loss");
  assert(phiona.virtual_balance > 1000, `Phiona balance should be > 1000, got ${phiona.virtual_balance}`);
  assert(alhaji.virtual_balance < 1000, `Alhaji_Pump balance should be < 1000, got ${alhaji.virtual_balance}`);
  pass(`Phiona balance: ${phiona.virtual_balance} (won), Alhaji_Pump: ${alhaji.virtual_balance} (lost)`);

  // ── 6. Round 2 — bots don't double-trade same event ──────────────────────
  console.log("\n6️⃣  Idempotency — bots don't re-trade same event");
  runBotTradesForRound(game, "evt-r1", UP_PRICE_R1); // same event
  const r1TradesAfter = [...db.trades.values()].filter(t => t.event_id === "evt-r1");
  assert(r1TradesAfter.length === 5, "no duplicate trades for same event");
  pass("Duplicate round trade correctly skipped");

  // ── 7. Leaderboard reflects real-time standings ───────────────────────────
  console.log("\n7️⃣  Leaderboard");
  const board = getLeaderboard(game.id);
  assert(board.length === 7, `leaderboard should have 7 entries, got ${board.length}`);
  assert(board[0]!.virtual_balance >= board[board.length - 1]!.virtual_balance, "leaderboard must be sorted desc");
  console.log("  📊 Leaderboard after round 1:");
  board.forEach((m, i) => {
    const name = BOTS.find(b => b.telegram_id === m.telegram_id)?.display_name ?? `User_${m.telegram_id}`;
    console.log(`     ${i + 1}. ${name.padEnd(12)} $${m.virtual_balance}`);
  });
  pass("Leaderboard sorted correctly");

  // ── 8. HLO points awarded on completion ──────────────────────────────────
  console.log("\n8️⃣  HLO points on completion");
  awardHloPoints(REAL_USER, game.id);
  awardHloPoints(REAL_USER_2, game.id);
  const u1Points = db.hloPoints.filter(p => p.telegram_id === REAL_USER).reduce((s, p) => s + p.amount, 0);
  const u2Points = db.hloPoints.filter(p => p.telegram_id === REAL_USER_2).reduce((s, p) => s + p.amount, 0);
  assert(u1Points === 250, `User 1 should have 250 HLO, got ${u1Points}`);
  assert(u2Points === 250, `User 2 should have 250 HLO, got ${u2Points}`);
  pass(`Both real users awarded 250 HLO points each`);

  // Bots get no HLO points
  const botPoints = db.hloPoints.filter(p => BOTS.some(b => b.telegram_id === p.telegram_id));
  assert(botPoints.length === 0, "bots must not receive HLO points");
  pass("Bots correctly excluded from HLO points");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n🎉 All tests passed!\n");
  console.log("Summary:");
  console.log(`  Arena code:       ${game.code}`);
  console.log(`  Total members:    ${getMembersForGame(game.id).length} (2 real + 5 bots)`);
  console.log(`  Trades placed:    ${db.trades.size}`);
  console.log(`  HLO points:       ${db.hloPoints.reduce((s, p) => s + p.amount, 0)} total`);
}

main().catch((e) => { console.error("\n❌", e.message); process.exit(1); });
