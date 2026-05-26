import { supabase } from "../src/db/client.ts";

async function main() {
  const { data: users } = await supabase.from("fantasy_users").select("telegram_id, username");
  const userMap = new Map((users ?? []).map((u: any) => [Number(u.telegram_id), u.username]));

  // Check pajcash onramps
  const { data: onramps, error: e1 } = await supabase
    .from("pajcash_onramps")
    .select("telegram_id, amount, status, created_at")
    .order("created_at", { ascending: false });

  // Check all ledger credits including any onramp types
  const { data: ledger, error: e2 } = await supabase
    .from("fantasy_wallet_ledger")
    .select("telegram_id, entry_type, amount, created_at")
    .eq("direction", "credit")
    .order("created_at", { ascending: false });

  console.log("\n=== PajCash Onramps ===");
  if (e1) console.log("Error:", e1.message);
  else if (!onramps?.length) console.log("(none)");
  else for (const r of onramps) {
    const date = new Date(r.created_at).toLocaleString("en-GB", { timeZone: "UTC", hour12: false }) + " UTC";
    console.log(`${(userMap.get(Number(r.telegram_id)) ?? r.telegram_id).toString().padEnd(20)} $${Number(r.amount).toFixed(6).padEnd(12)} ${r.status.padEnd(15)} ${date}`);
  }

  console.log("\n=== All Ledger Credits (by entry_type) ===");
  const grouped: Record<string, { username: string; amount: number; date: string }[]> = {};
  for (const r of ledger ?? []) {
    const key = r.entry_type;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({
      username: userMap.get(Number(r.telegram_id)) ?? String(r.telegram_id),
      amount: Number(r.amount),
      date: new Date(r.created_at).toLocaleString("en-GB", { timeZone: "UTC", hour12: false }) + " UTC",
    });
  }
  for (const [type, rows] of Object.entries(grouped)) {
    console.log(`\n[${type}]`);
    for (const r of rows) console.log(`  ${r.username.padEnd(20)} $${r.amount.toFixed(6)}  ${r.date}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
