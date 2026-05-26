import { supabase } from "../src/db/client.ts";

async function main() {
  const { data, error } = await supabase
    .from("fantasy_wallet_ledger")
    .select("telegram_id, entry_type, direction, amount, metadata, created_at")
    .eq("direction", "credit")
    .order("created_at", { ascending: false });

  if (error) throw error;

  const { data: users } = await supabase
    .from("fantasy_users")
    .select("telegram_id, username");

  const userMap = new Map((users ?? []).map((u: any) => [Number(u.telegram_id), u.username]));

  console.log("\nDeposit History (credits only)");
  console.log("=".repeat(100));
  console.log("username".padEnd(20) + "amount".padEnd(12) + "method".padEnd(30) + "date (UTC)");
  console.log("-".repeat(100));

  for (const r of data ?? []) {
    const meta = r.metadata as any ?? {};
    let method = r.entry_type;
    if (r.entry_type === "deposit") method = "direct USDC transfer";
    else if (r.entry_type === "pajcash_onramp" || r.entry_type === "onramp") method = "offramp/onramp (PajCash)";
    else if (r.entry_type === "dextopus_deposit") method = "cross-chain (Dextopus)";

    const date = new Date(r.created_at).toLocaleString("en-GB", { timeZone: "UTC", hour12: false }) + " UTC";
    const username = userMap.get(Number(r.telegram_id)) ?? String(r.telegram_id);
    console.log(
      username.padEnd(20) +
      `$${Number(r.amount).toFixed(6)}`.padEnd(12) +
      method.padEnd(30) +
      date
    );
  }
  console.log("-".repeat(100));
}

main().catch((e) => { console.error(e); process.exit(1); });
