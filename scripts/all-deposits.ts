import { supabase } from "../src/db/client.ts";

async function main() {
  const { data: users } = await supabase.from("fantasy_users").select("telegram_id,username");
  const userMap = new Map((users ?? []).map((u: any) => [Number(u.telegram_id), u.username as string]));
  const name = (id: number) => (userMap.get(id) ?? String(id)).padEnd(20);
  const dt = (s: string) => new Date(s).toISOString().slice(0, 16) + " UTC";

  const [{ data: onramps }, { data: dex }, { data: direct }] = await Promise.all([
    supabase.from("fantasy_pajcash_onramps").select("telegram_id,amount_usdc,status,created_at").order("created_at", { ascending: false }),
    supabase.from("fantasy_dextopus_deposits").select("telegram_id,usdc_amount,status,created_at").order("created_at", { ascending: false }),
    supabase.from("fantasy_wallet_deposits").select("telegram_id,amount,created_at").order("created_at", { ascending: false }),
  ]);

  console.log("\n=== PajCash Onramps ===");
  if (!onramps?.length) console.log("(none)");
  for (const r of onramps ?? [])
    console.log(name(Number(r.telegram_id)), `$${Number(r.amount_usdc).toFixed(6)}`, r.status.padEnd(12), dt(r.created_at));

  console.log("\n=== Dextopus Cross-chain Deposits ===");
  if (!dex?.length) console.log("(none)");
  for (const r of dex ?? [])
    console.log(name(Number(r.telegram_id)), `$${Number(r.usdc_amount).toFixed(6)}`, r.status.padEnd(12), dt(r.created_at));

  console.log("\n=== Direct USDC Wallet Deposits ===");
  if (!direct?.length) console.log("(none)");
  for (const r of direct ?? [])
    console.log(name(Number(r.telegram_id)), `$${Number(r.amount).toFixed(6)}`, dt(r.created_at));
}

main().catch((e) => { console.error(e); process.exit(1); });
