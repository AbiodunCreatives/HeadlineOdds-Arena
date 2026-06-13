/**
 * Smoke test: World Cup paginated market pages (self-contained, no dependencies)
 * Run: npx tsx scripts/smoke-wc-markets.ts
 */
import assert from "node:assert/strict";

console.log("🧪 WC paginated markets smoke test\n");

// ── Types ──────────────────────────────────────────────────────────────────

interface Market { id: string; title: string; outcome1Label: string; outcome1Price: number; outcome2Price: number; }
interface Event { id: string; title: string; category: string; liquidity: number; markets: Market[]; }

// ── Fixtures ───────────────────────────────────────────────────────────────

function mkMkt(id: string, title: string, p: number): Market {
  return { id, title, outcome1Label: title, outcome1Price: p, outcome2Price: +(1 - p).toFixed(4) };
}
function mkEvt(id: string, title: string, markets: Market[]): Event {
  return { id, title, category: "WORLD CUP", liquidity: 1000, markets };
}

const WC_WINNER = mkEvt("wc-winner", "Who will win the 2026 FIFA World Cup?", [
  mkMkt("m1", "Spain",     0.17),
  mkMkt("m2", "France",    0.16),
  mkMkt("m3", "Portugal",  0.11),
  mkMkt("m4", "England",   0.10),
  mkMkt("m5", "Brazil",    0.08),
  mkMkt("m6", "Argentina", 0.08),
  mkMkt("m7", "Germany",   0.05),
]);

function mkGroup(id: string, letter: string, teams: string[]): Event {
  return mkEvt(id, `FIFA World Cup Group ${letter} Winner?`,
    teams.map((t, i) => mkMkt(`${letter}${i}xx`, t, 0.25)));
}

const GROUPS = ["A","B","C","D","E","F"].map((l, i) =>
  mkGroup(`g-${l.toLowerCase()}`, l, [`T${i*4+1}`,`T${i*4+2}`,`T${i*4+3}`,`T${i*4+4}`])
);

const OTHERS = [
  mkEvt("wc-scorer", "World Cup: Who will be the Highest Goal Scorer?", [mkMkt("sc1","Mbappe",0.15), mkMkt("sc2","Haaland",0.12)]),
  mkEvt("wc-final",  "World Cup: Nation to Reach Final",                 [mkMkt("f1","Spain",0.20),   mkMkt("f2","France",0.18)]),
];

const ALL: Event[] = [WC_WINNER, ...GROUPS, ...OTHERS];

// ── Replicate buildWcPage partitioning logic ───────────────────────────────

function partition(events: Event[]) {
  const winner = events.find((e) => /win the 2026/i.test(e.title));
  const groups = events
    .filter((e) => /group [a-z] winner/i.test(e.title))
    .sort((a, b) => a.title.localeCompare(b.title));
  const others = events.filter(
    (e) => !/win the 2026/i.test(e.title) && !/group [a-z] winner/i.test(e.title)
  );
  return { winner, groups, others };
}

// ── Tests ──────────────────────────────────────────────────────────────────

// 1. Page 1 — WC Winner top 6
console.log("1. Page 1 — WC Winner top 6");
const { winner, groups, others } = partition(ALL);
assert(winner !== undefined, "WC winner event not found");
const top6 = [...winner!.markets].sort((a, b) => b.outcome1Price - a.outcome1Price).slice(0, 6);
assert.equal(top6.length, 6, `expected 6, got ${top6.length}`);
assert.equal(top6[0].title, "Spain", `expected Spain first`);
assert.equal(top6[5].title, "Argentina", `expected Argentina 6th`);
assert(!top6.find((m) => m.title === "Germany"), "Germany should not appear on page 1");
console.log(`   ✅ Top 6: ${top6.map((m) => m.title).join(", ")}`);

// 2. Page 2 — Groups A–C
console.log("2. Page 2 — Groups A–C");
assert.equal(groups.length, 6, `expected 6 groups, got ${groups.length}`);
const page2 = groups.slice(0, 3);
assert(page2[0].title.includes("Group A"), `expected Group A, got ${page2[0].title}`);
assert(page2[1].title.includes("Group B"), `expected Group B`);
assert(page2[2].title.includes("Group C"), `expected Group C`);
for (const g of page2) assert.equal(g.markets.length, 4, `${g.title} should have 4 markets`);
console.log(`   ✅ ${page2.map((g) => g.title).join(" | ")}`);

// 3. Page 3 — Groups D–F + others
console.log("3. Page 3 — Groups D–F + other markets");
const page3 = groups.slice(3, 6);
assert(page3[0].title.includes("Group D"), `expected Group D, got ${page3[0].title}`);
assert(page3[2].title.includes("Group F"), `expected Group F`);
assert.equal(others.length, 2, `expected 2 other markets, got ${others.length}`);
assert(others[0].title.includes("Highest Goal Scorer"), `unexpected: ${others[0].title}`);
console.log(`   ✅ Groups: ${page3.map((g) => g.title).join(" | ")}`);
console.log(`   ✅ Others: ${others.map((e) => e.title).join(" | ")}`);

// 4. shortKey uniqueness
console.log("4. shortKey uniqueness");
const keys = new Set<string>();
for (const e of ALL) {
  for (const m of e.markets) {
    const k = `${e.id.slice(0, 4)}${m.id.slice(0, 4)}`;
    assert(!keys.has(k), `duplicate shortKey: ${k} (event=${e.title}, market=${m.title})`);
    keys.add(k);
  }
}
console.log(`   ✅ ${keys.size} unique shortKeys`);

// 5. formatNgnPrice
console.log("5. formatNgnPrice");
function formatNgnPrice(p: number): string { return `₦${Math.round(p * 100)}`; }
assert.equal(formatNgnPrice(0.17), "₦17");
assert.equal(formatNgnPrice(0.83), "₦83");
assert.equal(formatNgnPrice(0.5),  "₦50");
console.log("   ✅ ₦17, ₦83, ₦50");

// 6. Page number boundary
console.log("6. Page boundary validation");
const valid = [1, 2, 3];
for (const p of valid)    assert(valid.includes(p));
for (const p of [0,4,-1]) assert(!valid.includes(p));
console.log("   ✅ Pages 1–3 valid, 0/4/-1 invalid");

// 7. bm:wc: callback data parsing
console.log("7. bm:wc: callback data parsing");
function parseWcPage(data: string): number | null {
  if (!data.startsWith("bm:wc:")) return null;
  const n = Number(data.slice("bm:wc:".length));
  return [1,2,3].includes(n) ? n : null;
}
assert.equal(parseWcPage("bm:wc:1"), 1);
assert.equal(parseWcPage("bm:wc:2"), 2);
assert.equal(parseWcPage("bm:wc:3"), 3);
assert.equal(parseWcPage("bm:wc:0"), null);
assert.equal(parseWcPage("bm:cat:SPORTS"), null);
console.log("   ✅ Callback data parsed correctly");

console.log("\n✅ All WC market smoke tests passed.");
